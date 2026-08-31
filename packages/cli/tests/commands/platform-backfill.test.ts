import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Every record in the production database had an empty platform.
 *
 * The parsers pass it, insertRecord writes it, and records has had the column
 * since v4 — but the value came only from config.platform, which is written
 * solely by `aiusage init` and was absent. Nothing failed; the device list
 * just fell back to guessing the OS from the device name, for 13,280 rows.
 *
 * The backfill below this had been in the tree the whole time, guarded by
 * `if (devicePlatform)`, and had therefore never run once.
 */

const { cfg, home } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return {
    home: process.env.AIUSAGE_HOME as string,
    cfg: { value: null as Record<string, unknown> | null },
  }
})

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js')
  // Only the config values. AIUSAGE_DIR is left alone: tests/setup.ts has
  // already pointed it at an isolated directory, and overriding it here
  // again was the second of three ways this suite isolated itself.
  return { ...actual, loadConfig: () => cfg.value }
})

/*
 * No real log files. runParse would otherwise scan this developer's own
 * Claude and Codex directories — tens of thousands of records — which makes
 * the test slow, machine-dependent, and nothing to do with what it asserts.
 * The backfills run over the database either way.
 */
vi.mock('../../src/discovery.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/discovery.js')>('../../src/discovery.js')
  return { ...actual, discoverLogFiles: () => [] }
})

const { initializeDatabase } = await import('../../src/db/index.js')
const { insertRecord } = await import('../../src/db/records.js')
// This file isolates by mocking AIUSAGE_DIR above, which is what runParse
// now defaults to — so it needs no directory argument of its own.
const { runParse } = await import('../../src/commands/parse.js')

const THIS_MACHINE = 'dev-this-machine'
const OTHER_MACHINE = 'dev-other-machine'

function record(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, ts: 1_700_000_000_000, ingestedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000, lineOffset: 0, tool: 'claude-code',
    model: 'm', provider: 'anthropic', inputTokens: 1, outputTokens: 1,
    cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0,
    cost: 0, costSource: 'pricing', sessionId: 's', sourceFile: '/logs/a.jsonl',
    device: 'この機', deviceInstanceId: THIS_MACHINE, platform: '',
    ...overrides,
  } as never
}

describe('platform backfill', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'state.json'), JSON.stringify({ deviceInstanceId: THIS_MACHINE }))
    writeFileSync(join(home, 'watermark.json'), JSON.stringify({}))
    cfg.value = { device: 'この機' }
  })

  afterEach(() => db.close())

  const platformOf = (id: string) =>
    (db.prepare('SELECT platform FROM records WHERE id = ?').get(id) as { platform: string }).platform

  const updatedAtOf = (id: string) =>
    (db.prepare('SELECT updated_at AS u FROM records WHERE id = ?').get(id) as { u: number }).u

  it('fills in this machine rows even when config says nothing about the OS', async () => {
    insertRecord(db, record('mine-1'))
    expect(platformOf('mine-1')).toBe('')

    await runParse(db)

    // Whatever this test is running on — the point is that it is not blank.
    expect(platformOf('mine-1')).toBe(process.platform)
  })

  /**
   * The old filter was `source_file NOT LIKE 'synced/%'`, a proxy for "came
   * from another machine". It stopped being one: a record that arrives with a
   * real source_file keeps that path, so the local OS would have been stamped
   * onto another machine's rows.
   */
  it('leaves another machine rows alone even when they look local', async () => {
    insertRecord(db, record('theirs-1', {
      deviceInstanceId: OTHER_MACHINE,
      device: '別の機',
      // A real path, not 'synced/...': exactly what a direct upload carries.
      sourceFile: 'C:/Users/them/.claude/projects/work/1.jsonl',
    }))

    await runParse(db)

    expect(platformOf('theirs-1')).toBe('')
  })

  it('respects an explicit config.platform over the OS', async () => {
    cfg.value = { device: 'この機', platform: 'linux' }
    insertRecord(db, record('mine-2'))

    await runParse(db)

    expect(platformOf('mine-2')).toBe('linux')
  })

  /**
   * Without the bump the row counts as already sent, so the corrected value
   * would never reach the hub.
   */
  it('moves updated_at so the correction propagates', async () => {
    insertRecord(db, record('mine-3'))
    const before = updatedAtOf('mine-3')

    await runParse(db)

    expect(updatedAtOf('mine-3')).toBeGreaterThan(before)
  })

  it('does not keep rewriting rows that already have a platform', async () => {
    insertRecord(db, record('mine-4', { platform: 'win32' }))
    await runParse(db)
    const after = updatedAtOf('mine-4')

    await runParse(db)

    expect(updatedAtOf('mine-4')).toBe(after)
  })
})

/**
 * The production install has no device UUID at all: state.json says
 * 'unknown' (D1 keeps it that way, and upstream never calls the function that
 * would generate one). A backfill that refused to match 'unknown' would have
 * skipped every row on the only machine that needed it.
 */
describe('platform backfill on a machine with no device id', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'state.json'), JSON.stringify({ deviceInstanceId: 'unknown' }))
    writeFileSync(join(home, 'watermark.json'), JSON.stringify({}))
    cfg.value = { device: 'この機' }
  })

  afterEach(() => db.close())

  const platformOf = (id: string) =>
    (db.prepare('SELECT platform FROM records WHERE id = ?').get(id) as { platform: string }).platform

  it('still fills in its own rows', async () => {
    insertRecord(db, record('mine', { deviceInstanceId: 'unknown' }))

    await runParse(db)

    expect(platformOf('mine')).toBe(process.platform)
  })

  /**
   * The one case the device id cannot separate: another install that is also
   * still 'unknown'. Its records arrive with a source_file under 'synced/',
   * which is what the second filter is for.
   */
  it('leaves rows that arrived from elsewhere alone', async () => {
    insertRecord(db, record('theirs', {
      deviceInstanceId: 'unknown',
      sourceFile: 'synced/some-other-machine',
    }))

    await runParse(db)

    expect(platformOf('theirs')).toBe('')
  })
})
