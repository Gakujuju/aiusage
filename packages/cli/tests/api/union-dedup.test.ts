import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { Readable } from 'node:stream'
import type { StatsRecord } from '@aiusage/core'

/**
 * One row, counted once, whichever table it happens to be sitting in.
 *
 * The all-devices views union records with synced_records and relied on
 * LOCAL_ONLY_FILTER — source_file NOT LIKE 'synced/%' — to keep a merged copy
 * out of the records side. That assumption is false: the merge keeps the
 * original source_file and only invents a 'synced/' one for rows that arrived
 * without any. Direct sync always sends one, so every merged row was counted
 * twice. On the hub that was 3829 rows and about a tenth of every figure.
 *
 * The other half matters just as much. The merge only runs during a parse, so
 * a freshly uploaded row lives in synced_records alone until the next one —
 * measured at 18.7 minutes on average here, 19.7 at worst, with 314 rows
 * observed in that state. Deduplicating by dropping the synced side would
 * have blanked them for that whole window. So both directions are pinned:
 * merged rows counted once, unmerged rows counted at all.
 */

const HUB = 'hub-device'
const SPOKE = 'spoke-device'

let db: Database.Database

const { initializeDatabase } = await import('../../src/db/index.js')
const { createApiServer } = await import('../../src/api/server.js')
const { insertRecord } = await import('../../src/db/records.js')
const { insertSyncedRecord } = await import('../../src/db/synced-records.js')

function aRecord(overrides: Partial<StatsRecord> = {}): StatsRecord {
  return {
    id: 'rec-1',
    ts: 1776738085346,
    ingestedAt: 1776738085700,
    updatedAt: 1776738085700,
    lineOffset: 0,
    tool: 'claude-code',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    cost: 1,
    costSource: 'pricing',
    sessionId: 'sess-1',
    // A real path, exactly as direct sync delivers it. This is the shape that
    // slipped past the old filter.
    sourceFile: 'C:/Users/someone/.claude/projects/app/a.jsonl',
    device: 'a-device',
    deviceInstanceId: SPOKE,
    ...overrides,
  }
}

async function get(url: string): Promise<any> {
  const server = createApiServer(db, {
    isLoopbackBind: true,
    currentDeviceInstanceId: HUB,
  })
  const req: any = Readable.from([])
  req.url = url
  req.method = 'GET'
  req.headers = { host: '127.0.0.1' }

  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const res: any = {
      statusCode: 200,
      headersSent: false,
      setHeader() {}, getHeader() { return undefined },
      writeHead(status: number) { this.statusCode = status; return this },
      write(chunk: any) { chunks.push(Buffer.from(chunk)); return true },
      end(chunk?: any) {
        if (chunk) chunks.push(Buffer.from(chunk))
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      },
      on() { return this }, once() { return this }, emit() { return false },
    }
    server.emit('request', req, res)
  })
}

/** synced_records names the session differently and carries cwd. */
function onTheWire(record: StatsRecord) {
  const { sessionId, ...rest } = record
  return { ...rest, sessionKey: sessionId, platform: 'win32', cwd: '' }
}

/** A row the merge has copied across: present in both tables under one id. */
function merged(id: string, overrides: Partial<StatsRecord> = {}) {
  const record = aRecord({ id, ...overrides })
  insertSyncedRecord(db, onTheWire(record) as never)
  insertRecord(db, record)
}

/** A row that has arrived but not been merged yet: synced_records alone. */
function unmerged(id: string, overrides: Partial<StatsRecord> = {}) {
  insertSyncedRecord(db, onTheWire(aRecord({ id, ...overrides })) as never)
}

describe('all-devices views count each row once', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('counts a merged row once, not once per table', async () => {
    merged('m-1')

    const summary = await get('/api/summary?range=all')

    expect(summary.totalTokens).toBe(110)
    expect(summary.totalCost).toBe(1)
  })

  it('still counts a row that has not been merged yet', async () => {
    // The 18-minute window. Dropping the synced side would lose this.
    unmerged('u-1')

    const summary = await get('/api/summary?range=all')

    expect(summary.totalTokens).toBe(110)
    expect(summary.totalCost).toBe(1)
  })

  it('adds merged and unmerged rows without counting either twice', async () => {
    merged('m-1')
    merged('m-2')
    unmerged('u-1')

    const summary = await get('/api/summary?range=all')

    expect(summary.totalTokens).toBe(330)
    expect(summary.totalCost).toBe(3)
  })

  it('keeps the hub own rows, which live in records alone', async () => {
    insertRecord(db, aRecord({ id: 'own-1', deviceInstanceId: HUB }))
    merged('m-1')

    const summary = await get('/api/summary?range=all')

    expect(summary.totalTokens).toBe(220)
  })

  it('makes the per-device totals add up to the all-devices total', async () => {
    insertRecord(db, aRecord({ id: 'own-1', deviceInstanceId: HUB }))
    merged('m-1')
    unmerged('u-1')

    const [all, hub, spoke] = await Promise.all([
      get('/api/summary?range=all'),
      get(`/api/summary?range=all&device=${HUB}`),
      get(`/api/summary?range=all&device=${SPOKE}`),
    ])

    expect(hub.totalTokens + spoke.totalTokens).toBe(all.totalTokens)
  })

  it('does not double the uncosted counts in the band', async () => {
    // The band read 594 while the startup log, which never unions, read 297.
    merged('m-1', { cost: 0, costSource: 'unknown' })
    merged('m-2', { cost: 0, costSource: 'unknown', breakdownMissing: true })

    const summary = await get('/api/summary?range=all')

    expect(summary.unpricedRecords).toBe(1)
    expect(summary.breakdownMissingRecords).toBe(1)
  })

  it('counts tokens once on /api/tokens', async () => {
    merged('m-1')
    unmerged('u-1')

    const result = await get('/api/tokens?range=all')
    const input = (result.data ?? []).reduce(
      (acc: number, d: any) => acc + d.inputTokens, 0)

    expect(input).toBe(200)
  })

  it('counts cost once on /api/cost', async () => {
    merged('m-1')
    unmerged('u-1')

    const result = await get('/api/cost?range=all')
    const total = Object.values(result.byTool ?? {})
      .reduce((a: number, b: any) => a + Number(b), 0)

    expect(total).toBe(2)
  })

  it('counts each session once on /api/tools', async () => {
    merged('m-1', { sessionId: 's-1' })
    merged('m-2', { sessionId: 's-2' })

    const result = await get('/api/tools?range=all')
    const claude = (result.tools ?? []).find((x: any) => x.tool === 'claude-code')

    expect(claude?.sessionCount).toBe(2)
  })
})
