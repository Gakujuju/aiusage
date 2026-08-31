import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { getUnsyncedRecords, insertRecord, markRecordsSynced } from '../../src/db/records.js'
import { chunkSyncRecords, normalizeIncomingSyncRecord, MAX_SYNC_RECORDS_PER_REQUEST } from '../../src/sync/direct.js'
import { insertSyncedRecord } from '../../src/db/synced-records.js'
import { mergeSyncedRecordsIntoRecords } from '../../src/db/synced-records.js'

/**
 * Records handed straight from one machine to another over the tailnet.
 *
 * The two properties worth pinning down are that the watermark is per
 * destination — so uploading to a hub cannot mark records as sent to a
 * GitHub repository — and that a resend is a no-op rather than a duplicate.
 */

const { cfg } = vi.hoisted(() => ({ cfg: { value: null as Record<string, unknown> | null } }))
let credential: string | null = null

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js')
  return {
    ...actual,
    loadConfig: () => cfg.value,
    loadCredential: (key: string) =>
      key === actual.HUB_FORWARD_TOKEN_CREDENTIAL ? credential : null,
  }
})

const { runHubUpload, hubTarget } = await import('../../src/sync/hub-upload.js')

const HUB = 'https://desktop-abc.tail1234.ts.net'
const T0 = 1_700_000_000_000

function aRecord(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `rec-${n}`,
    ts: T0 + n * 1000,
    ingestedAt: T0,
    updatedAt: T0,
    lineOffset: n,
    tool: 'claude-code',
    model: 'claude-opus-4',
    provider: 'anthropic',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    cost: 0.01,
    costSource: 'pricing',
    sessionId: `sess-${n}`,
    sourceFile: `C:/Users/me/.claude/projects/work/${n}.jsonl`,
    cwd: 'C:/Users/me/work/client-a',
    device: '職場PC',
    deviceInstanceId: 'dev-work',
    platform: 'win32',
    ...overrides,
  } as never
}

function recordingFetch(status = 200) {
  const calls: Array<{ url: string; token: string | null; records: unknown[] }> = []
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { records: unknown[] }
    calls.push({
      url: String(url),
      token: new Headers(init.headers).get('X-Aiusage-Token'),
      records: body.records,
    })
    return new Response(JSON.stringify({ ok: true }), { status })
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('hub upload', () => {
  let db: Database.Database
  const runDbWrite = async <T,>(fn: () => T): Promise<T> => fn()

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    cfg.value = { hubForward: { url: HUB } }
    credential = 'hub-token'
  })

  const deps = (fetchImpl?: typeof fetch) => ({
    db, runDbWrite, fetchImpl, now: () => T0,
  })

  it('says why it did nothing, per reason', async () => {
    cfg.value = {}
    expect((await runHubUpload(deps())).skipped).toBe('no_hub')

    cfg.value = { hubForward: { url: HUB } }
    credential = null
    expect((await runHubUpload(deps())).skipped).toBe('no_token')

    credential = 'hub-token'
    expect((await runHubUpload(deps())).skipped).toBe('nothing_to_send')
  })

  it('sends only records that have not been sent to this hub', async () => {
    for (const r of [aRecord(1), aRecord(2)]) insertRecord(db, r)
    const { calls, impl } = recordingFetch()

    const first = await runHubUpload(deps(impl))
    expect(first.sent).toBe(2)
    expect(calls[0].url).toBe(`${HUB}/api/sync/records`)
    expect(calls[0].token).toBe('hub-token')

    // Nothing new since, so nothing goes.
    const second = await runHubUpload(deps(impl))
    expect(second.sent).toBe(0)
    expect(second.skipped).toBe('nothing_to_send')
    expect(calls).toHaveLength(1)
  })

  it('sends a record again once it changes', async () => {
    insertRecord(db, aRecord(1))
    const { calls, impl } = recordingFetch()
    await runHubUpload(deps(impl))

    db.prepare('UPDATE records SET updated_at = ? WHERE id = ?').run(T0 + 60_000, 'rec-1')
    const again = await runHubUpload(deps(impl))
    expect(again.sent).toBe(1)
    expect(calls).toHaveLength(2)
  })

  /**
   * sync_record_state is keyed on (record_id, target). Without that, uploading
   * to the hub would mark records as already sent to a GitHub repository that
   * has never seen them.
   */
  it('keeps a separate watermark per destination', async () => {
    for (const r of [aRecord(1), aRecord(2)]) insertRecord(db, r)
    const { impl } = recordingFetch()

    await runHubUpload(deps(impl))
    expect(getUnsyncedRecords(db, hubTarget(HUB))).toHaveLength(0)
    expect(getUnsyncedRecords(db, 'user/some-repo')).toHaveLength(2)

    markRecordsSynced(db, ['rec-1'], T0, 'user/some-repo')
    expect(getUnsyncedRecords(db, 'user/some-repo')).toHaveLength(1)
    expect(getUnsyncedRecords(db, hubTarget(HUB))).toHaveLength(0)
  })

  it('does not advance the watermark when the hub refuses', async () => {
    insertRecord(db, aRecord(1))
    const { impl } = recordingFetch(500)

    const result = await runHubUpload(deps(impl))
    expect(result.sent).toBe(0)
    expect(result.error).toBe('HTTP 500')
    expect(getUnsyncedRecords(db, hubTarget(HUB))).toHaveLength(1)
  })

  it('survives an unreachable hub and leaves the records for next time', async () => {
    insertRecord(db, aRecord(1))
    const impl = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch

    const result = await runHubUpload(deps(impl))
    expect(result.sent).toBe(0)
    expect(result.error).toContain('ENOTFOUND')
    expect(getUnsyncedRecords(db, hubTarget(HUB))).toHaveLength(1)
  })

  it('splits a batch bigger than the limit', async () => {
    const many = Array.from({ length: MAX_SYNC_RECORDS_PER_REQUEST + 20 }, (_, i) => aRecord(i))
    for (const r of many) insertRecord(db, r)
    const { calls, impl } = recordingFetch()

    const result = await runHubUpload(deps(impl))
    expect(result.batches).toBe(2)
    expect(calls[0].records).toHaveLength(MAX_SYNC_RECORDS_PER_REQUEST)
    expect(calls[1].records).toHaveLength(20)
    expect(result.sent).toBe(many.length)
  })
})

describe('what the hub accepts', () => {
  it('rejects anything it could not identify or attribute', () => {
    expect(normalizeIncomingSyncRecord(null)).toBeNull()
    expect(normalizeIncomingSyncRecord('nope')).toBeNull()
    expect(normalizeIncomingSyncRecord({ tool: 'claude-code', deviceInstanceId: 'd', ts: 1 })).toBeNull()
    expect(normalizeIncomingSyncRecord({ id: 'a', deviceInstanceId: 'd', ts: 1 })).toBeNull()
    expect(normalizeIncomingSyncRecord({ id: 'a', tool: 'claude-code', ts: 1 })).toBeNull()
    expect(normalizeIncomingSyncRecord({ id: 'a', tool: 'claude-code', deviceInstanceId: 'd' })).toBeNull()
  })

  it('fills in what it can rather than dropping a usable record', () => {
    const record = normalizeIncomingSyncRecord({
      id: 'a', tool: 'claude-code', deviceInstanceId: 'd', ts: T0,
    })
    expect(record?.inputTokens).toBe(0)
    expect(record?.costSource).toBe('pricing')
    // An unusable updatedAt must lose every comparison rather than look new.
    expect(record?.updatedAt).toBe(0)
  })

  it('accepts the timestamps older sync paths send as strings', () => {
    const record = normalizeIncomingSyncRecord({
      id: 'a', tool: 'claude-code', deviceInstanceId: 'd',
      ts: new Date(T0).toISOString(),
      updatedAt: String(T0),
    })
    expect(record?.ts).toBe(T0)
    expect(record?.updatedAt).toBe(T0)
  })

  it('chunks on the record count', () => {
    const records = Array.from({ length: 1200 }, (_, i) =>
      normalizeIncomingSyncRecord({ id: `r${i}`, tool: 'claude-code', deviceInstanceId: 'd', ts: T0 })!)
    const batches = chunkSyncRecords(records)
    expect(batches.map((b) => b.length)).toEqual([500, 500, 200])
  })
})

describe('what the hub does with them', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  const incoming = (overrides: Record<string, unknown> = {}) => normalizeIncomingSyncRecord({
    id: 'rec-1', ts: T0, tool: 'claude-code', model: 'claude-opus-4',
    provider: 'anthropic', inputTokens: 100, outputTokens: 50,
    cost: 0.01, costSource: 'pricing', sessionKey: 'k', device: '職場PC',
    deviceInstanceId: 'dev-work', platform: 'win32', updatedAt: T0,
    sourceFile: 'C:/logs/1.jsonl', cwd: 'C:/work',
    ...overrides,
  })!

  it('does not duplicate a record that arrives twice', () => {
    insertSyncedRecord(db, incoming())
    insertSyncedRecord(db, incoming())
    expect(db.prepare('SELECT COUNT(*) AS n FROM synced_records').get()).toEqual({ n: 1 })
  })

  it('refuses to let an older copy overwrite a newer one', () => {
    insertSyncedRecord(db, incoming({ updatedAt: T0 + 60_000, inputTokens: 999 }))
    insertSyncedRecord(db, incoming({ updatedAt: T0, inputTokens: 1 }))

    const row = db.prepare('SELECT input_tokens FROM synced_records WHERE id = ?').get('rec-1')
    expect(row).toEqual({ input_tokens: 999 })
  })

  /**
   * The path a directly-sent record takes to the dashboard is the same one a
   * record pulled from GitHub has always taken, so nothing downstream needs
   * to know which way it arrived.
   */
  it('reaches the dashboard through the merge serve already runs', () => {
    insertSyncedRecord(db, incoming())
    expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 0 })

    const merged = mergeSyncedRecordsIntoRecords(db)

    expect(merged).toBe(1)
    const row = db.prepare('SELECT device, cost FROM records WHERE id = ?').get('rec-1')
    expect(row).toEqual({ device: '職場PC', cost: 0.01 })
  })
})
