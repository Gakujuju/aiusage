import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { recordQuotaSnapshot, computeWindowId, parseResetsAt } from '../../src/db/quota-history.js'
import type { QuotaResult } from '../../src/quota.js'

const DEVICE = 'device-a'
const DEVICE_ID = 'device-uuid-a'

function success(tool: string, tiers: Array<{ name: string; utilization: number; resetsAt: string | null }>): QuotaResult {
  return {
    tool,
    credentialStatus: 'valid',
    credentialMessage: null,
    success: true,
    tiers,
    error: null,
    queriedAt: Date.now(),
  }
}

function failure(tool: string, status: QuotaResult['credentialStatus'], error: string | null): QuotaResult {
  return {
    tool,
    credentialStatus: status,
    credentialMessage: error,
    success: false,
    tiers: [],
    error,
    queriedAt: Date.now(),
  }
}

function record(db: Database.Database, results: QuotaResult[], now: number) {
  return recordQuotaSnapshot(db, results, { device: DEVICE, deviceInstanceId: DEVICE_ID, now })
}

function countSnapshots(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM quota_snapshots').get() as { n: number }).n
}

describe('migration v13', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => db.close())

  it('applies and records its schema version', () => {
    const versions = (db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>)
      .map((r) => r.version)
    expect(versions).toContain(13)
  })

  it('creates the three quota tables', () => {
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'quota%'"
    ).all() as Array<{ name: string }>).map((r) => r.name).sort()
    expect(names).toEqual(['quota_current', 'quota_snapshots', 'quota_windows'])
  })

  it('creates the v_quota_snapshots view with ISO timestamp columns', () => {
    const view = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'v_quota_snapshots'"
    ).get()
    expect(view).toBeTruthy()

    record(db, [success('codex', [{ name: 'five_hour', utilization: 20, resetsAt: '2026-08-29T12:00:00.000Z' }])], 1_700_000_000_000)
    const row = db.prepare('SELECT timestamp, resets_timestamp FROM v_quota_snapshots').get() as {
      timestamp: string
      resets_timestamp: string
    }
    expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/)
    expect(row.resets_timestamp).toBe('2026-08-29 12:00:00Z')
  })

  it('carries the error-kind and gap columns', () => {
    const currentCols = (db.prepare('PRAGMA table_info(quota_current)').all() as any[]).map((c) => c.name)
    expect(currentCols).toContain('last_error_kind')

    const windowCols = (db.prepare('PRAGMA table_info(quota_windows)').all() as any[]).map((c) => c.name)
    expect(windowCols).toContain('gap_detected')
  })

  it('creates the expected indexes', () => {
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_quota%'"
    ).all() as Array<{ name: string }>).map((r) => r.name).sort()
    expect(names).toEqual([
      'idx_quota_snap_device',
      'idx_quota_snap_series',
      'idx_quota_snap_ts',
      'idx_quota_snap_window',
      'idx_quota_windows_series',
    ])
  })
})

describe('computeWindowId', () => {
  const OPENED = 500

  it('is stable for the same inputs', () => {
    const a = computeWindowId(DEVICE_ID, 'codex', 'five_hour', 1000, OPENED)
    const b = computeWindowId(DEVICE_ID, 'codex', 'five_hour', 1000, OPENED)
    expect(a).toBe(b)
    expect(a).toHaveLength(16)
  })

  it('changes when the reset time changes', () => {
    expect(computeWindowId(DEVICE_ID, 'codex', 'five_hour', 1000, OPENED))
      .not.toBe(computeWindowId(DEVICE_ID, 'codex', 'five_hour', 2000, OPENED))
  })

  it('changes when the same reset time opens a new window', () => {
    // Rule A rolls without the reset moving, so openedAt has to separate them.
    expect(computeWindowId(DEVICE_ID, 'codex', 'five_hour', 1000, OPENED))
      .not.toBe(computeWindowId(DEVICE_ID, 'codex', 'five_hour', 1000, OPENED + 1))
  })

  it('uses a stable placeholder for an unknown reset time', () => {
    expect(computeWindowId(DEVICE_ID, 'codex', 'five_hour', null, OPENED))
      .toBe(computeWindowId(DEVICE_ID, 'codex', 'five_hour', null, OPENED))
  })

  it('separates tools and tiers', () => {
    expect(computeWindowId(DEVICE_ID, 'codex', 'five_hour', 1000, OPENED))
      .not.toBe(computeWindowId(DEVICE_ID, 'claude-code', 'five_hour', 1000, OPENED))
    expect(computeWindowId(DEVICE_ID, 'codex', 'five_hour', 1000, OPENED))
      .not.toBe(computeWindowId(DEVICE_ID, 'codex', 'weekly_limit', 1000, OPENED))
  })
})

describe('parseResetsAt', () => {
  it('parses ISO strings to ms', () => {
    expect(parseResetsAt('2026-08-29T12:00:00.000Z')).toBe(Date.parse('2026-08-29T12:00:00.000Z'))
  })

  it('returns null for null, empty and garbage', () => {
    expect(parseResetsAt(null)).toBeNull()
    expect(parseResetsAt('')).toBeNull()
    expect(parseResetsAt('not a date')).toBeNull()
  })
})

describe('recordQuotaSnapshot', () => {
  let db: Database.Database
  const t0 = 1_700_000_000_000
  const RESET_A = '2026-08-29T12:00:00.000Z'
  const RESET_B = '2026-08-29T17:00:00.000Z'

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('inserts the first observation', () => {
    const summary = record(db, [success('codex', [{ name: 'five_hour', utilization: 20, resetsAt: RESET_A }])], t0)
    expect(summary.inserted).toBe(1)
    expect(summary.updated).toBe(1)
    expect(countSnapshots(db)).toBe(1)

    const current = db.prepare('SELECT * FROM quota_current').get() as any
    expect(current.tool).toBe('codex')
    expect(current.tier).toBe('five_hour')
    expect(current.utilization).toBe(20)
    expect(current.resets_at).toBe(Date.parse(RESET_A))
    expect(current.consecutive_errors).toBe(0)
    expect(current.last_success_at).toBe(t0)
  })

  it('does not append a row when the value has not moved', () => {
    const tiers = [{ name: 'five_hour', utilization: 20, resetsAt: RESET_A }]
    record(db, [success('codex', tiers)], t0)
    record(db, [success('codex', tiers)], t0 + 5 * 60_000)
    const summary = record(db, [success('codex', tiers)], t0 + 10 * 60_000)

    expect(summary.inserted).toBe(0)
    expect(countSnapshots(db)).toBe(1)
  })

  it('still refreshes quota_current on an unchanged poll', () => {
    const tiers = [{ name: 'five_hour', utilization: 20, resetsAt: RESET_A }]
    record(db, [success('codex', tiers)], t0)
    record(db, [success('codex', tiers)], t0 + 5 * 60_000)

    const current = db.prepare('SELECT ts, updated_at FROM quota_current').get() as any
    expect(current.ts).toBe(t0 + 5 * 60_000)
    expect(current.updated_at).toBe(t0 + 5 * 60_000)
  })

  it('appends a row once utilization moves by 0.1 or more', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 20, resetsAt: RESET_A }])], t0)
    record(db, [success('codex', [{ name: 'five_hour', utilization: 20.05, resetsAt: RESET_A }])], t0 + 60_000)
    expect(countSnapshots(db)).toBe(1)

    record(db, [success('codex', [{ name: 'five_hour', utilization: 20.1, resetsAt: RESET_A }])], t0 + 120_000)
    expect(countSnapshots(db)).toBe(2)
  })

  it('forces a row after an hour of no change so the series stays continuous', () => {
    const tiers = [{ name: 'five_hour', utilization: 20, resetsAt: RESET_A }]
    record(db, [success('codex', tiers)], t0)
    record(db, [success('codex', tiers)], t0 + 59 * 60_000)
    expect(countSnapshots(db)).toBe(1)

    record(db, [success('codex', tiers)], t0 + 60 * 60_000)
    expect(countSnapshots(db)).toBe(2)
  })

  it('rule A: rolls when utilization drops by 5 points or more', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 20, resetsAt: RESET_A }])], t0)
    record(db, [success('codex', [{ name: 'five_hour', utilization: 80, resetsAt: RESET_A }])], t0 + 60_000)
    const oldWindowId = (db.prepare('SELECT window_id FROM quota_current').get() as any).window_id

    // Same reset time, so only the drop can trigger this.
    const summary = record(db, [success('codex', [{ name: 'five_hour', utilization: 75, resetsAt: RESET_A }])], t0 + 120_000)

    expect(summary.windowsClosed).toBe(1)
    expect((db.prepare('SELECT window_id FROM quota_current').get() as any).window_id).not.toBe(oldWindowId)
    const closed = db.prepare('SELECT * FROM quota_windows WHERE window_id = ?').get(oldWindowId) as any
    expect(closed.final_utilization).toBe(80)
    expect(closed.gap_detected).toBe(0)
  })

  it('rule A: does not roll on a drop under 5 points', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 80, resetsAt: RESET_A }])], t0)
    const before = (db.prepare('SELECT window_id FROM quota_current').get() as any).window_id

    const summary = record(db, [success('codex', [{ name: 'five_hour', utilization: 76, resetsAt: RESET_A }])], t0 + 60_000)

    expect(summary.windowsClosed).toBe(0)
    expect((db.prepare('SELECT window_id FROM quota_current').get() as any).window_id).toBe(before)
  })

  it('rule B: rolls when resets_at jumps by half a window or more', () => {
    // five_hour is 5h, so a 3h forward jump clears the 2.5h threshold with the
    // utilization *rising* — rule A cannot explain this one.
    const first = '2026-08-29T12:00:00.000Z'
    const jumped = '2026-08-29T15:00:00.000Z'
    record(db, [success('codex', [{ name: 'five_hour', utilization: 40, resetsAt: first }])], t0)
    const before = (db.prepare('SELECT window_id FROM quota_current').get() as any).window_id

    const summary = record(db, [success('codex', [{ name: 'five_hour', utilization: 45, resetsAt: jumped }])], t0 + 60_000)

    expect(summary.windowsClosed).toBe(1)
    const after = (db.prepare('SELECT window_id FROM quota_current').get() as any).window_id
    expect(after).not.toBe(before)
    expect((db.prepare('SELECT gap_detected FROM quota_windows WHERE window_id = ?').get(before) as any).gap_detected).toBe(0)
  })

  it('rule B: does not roll on a jump under half a window', () => {
    const first = '2026-08-29T12:00:00.000Z'
    const nudged = '2026-08-29T14:00:00.000Z' // 2h < 2.5h
    record(db, [success('codex', [{ name: 'five_hour', utilization: 40, resetsAt: first }])], t0)
    const before = (db.prepare('SELECT window_id FROM quota_current').get() as any).window_id

    const summary = record(db, [success('codex', [{ name: 'five_hour', utilization: 45, resetsAt: nudged }])], t0 + 60_000)

    expect(summary.windowsClosed).toBe(0)
    expect((db.prepare('SELECT window_id FROM quota_current').get() as any).window_id).toBe(before)
    expect((db.prepare('SELECT resets_at FROM quota_current').get() as any).resets_at).toBe(Date.parse(nudged))
  })

  it('rule C: rolls and flags a gap after a window of no observations', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 40, resetsAt: RESET_A }])], t0)
    const before = (db.prepare('SELECT window_id FROM quota_current').get() as any).window_id

    // Five hours later, same reset, higher value — neither A nor B applies.
    const summary = record(
      db,
      [success('codex', [{ name: 'five_hour', utilization: 45, resetsAt: RESET_A }])],
      t0 + 5 * 3600_000,
    )

    expect(summary.windowsClosed).toBe(1)
    const closed = db.prepare('SELECT * FROM quota_windows WHERE window_id = ?').get(before) as any
    expect(closed.gap_detected).toBe(1)
    expect(closed.final_utilization).toBe(40)
  })

  it('rule C: does not roll just under a full window of silence', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 40, resetsAt: RESET_A }])], t0)
    const before = (db.prepare('SELECT window_id FROM quota_current').get() as any).window_id

    const summary = record(
      db,
      [success('codex', [{ name: 'five_hour', utilization: 45, resetsAt: RESET_A }])],
      t0 + 5 * 3600_000 - 1,
    )

    expect(summary.windowsClosed).toBe(0)
    expect((db.prepare('SELECT window_id FROM quota_current').get() as any).window_id).toBe(before)
  })

  it('applies only rule A to a tier with no known window length', () => {
    // Copilot's chat tier has no duration, so B and C cannot fire.
    const first = '2026-08-29T12:00:00.000Z'
    const jumped = '2026-10-29T12:00:00.000Z'
    record(db, [success('copilot', [{ name: 'chat', utilization: 40, resetsAt: first }])], t0)
    const before = (db.prepare('SELECT window_id FROM quota_current').get() as any).window_id

    // A two-month reset jump and a month of silence, but utilization rose.
    const summary = record(
      db,
      [success('copilot', [{ name: 'chat', utilization: 45, resetsAt: jumped }])],
      t0 + 30 * 86400000,
    )
    expect(summary.windowsClosed).toBe(0)
    expect((db.prepare('SELECT window_id FROM quota_current').get() as any).window_id).toBe(before)

    // A drop still rolls it.
    record(db, [success('copilot', [{ name: 'chat', utilization: 5, resetsAt: jumped }])], t0 + 31 * 86400000)
    expect((db.prepare('SELECT window_id FROM quota_current').get() as any).window_id).not.toBe(before)
  })

  it('rolls the window and closes the old one when a new window resets it', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 20, resetsAt: RESET_A }])], t0)
    record(db, [success('codex', [{ name: 'five_hour', utilization: 80, resetsAt: RESET_A }])], t0 + 60_000)
    const oldWindowId = (db.prepare('SELECT window_id FROM quota_current').get() as any).window_id

    const summary = record(db, [success('codex', [{ name: 'five_hour', utilization: 5, resetsAt: RESET_B }])], t0 + 120_000)

    expect(summary.windowsClosed).toBe(1)
    expect(summary.inserted).toBe(1)

    const newWindowId = (db.prepare('SELECT window_id FROM quota_current').get() as any).window_id
    expect(newWindowId).not.toBe(oldWindowId)

    const closed = db.prepare('SELECT * FROM quota_windows WHERE window_id = ?').get(oldWindowId) as any
    expect(closed.closed_at).toBe(t0 + 120_000)
    expect(closed.final_utilization).toBe(80)
    expect(closed.peak_utilization).toBe(80)
    expect(closed.sample_count).toBe(2)

    const open = db.prepare('SELECT * FROM quota_windows WHERE window_id = ?').get(newWindowId) as any
    expect(open.closed_at).toBeNull()
    expect(open.started_at).toBe(t0 + 120_000)
  })

  it('keeps one window when resets_at drifts forward without utilization dropping', () => {
    // Codex reports "now + 5h" as the reset for an untouched five_hour window,
    // so the reset time creeps forward on every poll. That must not fragment
    // the series — observed live on 2026-08-29.
    const drift = ['2026-08-29T12:00:00.000Z', '2026-08-29T12:00:02.000Z', '2026-08-29T12:00:04.000Z']
    drift.forEach((resetsAt, i) => {
      record(db, [success('codex', [{ name: 'five_hour', utilization: 0, resetsAt }])], t0 + i * 2000)
    })

    const windows = db.prepare('SELECT COUNT(*) AS n FROM quota_windows').get() as any
    expect(windows.n).toBe(1)
    expect(countSnapshots(db)).toBe(1)

    // The window still tracks the newest reset time.
    const current = db.prepare('SELECT resets_at FROM quota_current').get() as any
    expect(current.resets_at).toBe(Date.parse(drift[2]))
    const window = db.prepare('SELECT resets_at, sample_count FROM quota_windows').get() as any
    expect(window.resets_at).toBe(Date.parse(drift[2]))
    expect(window.sample_count).toBe(3)
  })

  it('keeps one window when resets_at drifts while utilization climbs', () => {
    // A drift under half a window, with the number going up — no rule fires.
    record(db, [success('codex', [{ name: 'five_hour', utilization: 10, resetsAt: '2026-08-29T12:00:00.000Z' }])], t0)
    record(db, [success('codex', [{ name: 'five_hour', utilization: 25, resetsAt: '2026-08-29T13:00:00.000Z' }])], t0 + 60_000)

    expect((db.prepare('SELECT COUNT(*) AS n FROM quota_windows').get() as any).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM quota_windows WHERE closed_at IS NOT NULL').get() as any).n).toBe(0)
    // Both readings land in the same series.
    expect(countSnapshots(db)).toBe(2)
    const windowIds = (db.prepare('SELECT DISTINCT window_id FROM quota_snapshots').all() as any[])
    expect(windowIds).toHaveLength(1)
  })

  it('reports each threshold once and remembers the highest announced', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 70, resetsAt: RESET_A }])], t0)
    const first = record(db, [success('codex', [{ name: 'five_hour', utilization: 85, resetsAt: RESET_A }])], t0 + 60_000)

    expect(first.crossings).toEqual([{
      tool: 'codex', tier: 'five_hour', windowId: expect.any(String),
      threshold: 80, utilization: 85, resetsAt: Date.parse(RESET_A),
    }])
    expect((db.prepare('SELECT notified_level FROM quota_current').get() as any).notified_level).toBe(80)

    // Still above 80, but 80 has already been said.
    const second = record(db, [success('codex', [{ name: 'five_hour', utilization: 90, resetsAt: RESET_A }])], t0 + 120_000)
    expect(second.crossings).toEqual([])
  })

  it('announces only the highest of several thresholds crossed at once', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 10, resetsAt: RESET_A }])], t0)
    // 10 → 97 clears both 80 and 95; three messages in one second would say
    // nothing the last one does not.
    const summary = record(db, [success('codex', [{ name: 'five_hour', utilization: 97, resetsAt: RESET_A }])], t0 + 60_000)
    expect(summary.crossings).toHaveLength(1)
    expect(summary.crossings[0].threshold).toBe(95)
  })

  it('starts announcing again in a new window', () => {
    // The first reading is only a baseline — we did not watch it cross
    // anything — so the announcement comes on the second.
    record(db, [success('codex', [{ name: 'five_hour', utilization: 40, resetsAt: RESET_A }])], t0 - 60_000)
    record(db, [success('codex', [{ name: 'five_hour', utilization: 90, resetsAt: RESET_A }])], t0)
    expect((db.prepare('SELECT notified_level FROM quota_current').get() as any).notified_level).toBe(80)

    // A rollover: utilization drops and the reset moves.
    const rolled = record(db, [success('codex', [{ name: 'five_hour', utilization: 5, resetsAt: RESET_B }])], t0 + 60_000)
    expect(rolled.resets).toHaveLength(1)
    expect((db.prepare('SELECT notified_level FROM quota_current').get() as any).notified_level).toBe(0)

    const again = record(db, [success('codex', [{ name: 'five_hour', utilization: 85, resetsAt: RESET_B }])], t0 + 120_000)
    expect(again.crossings[0].threshold).toBe(80)
  })

  it('tracks the current window on the notification state', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 50, resetsAt: RESET_A }])], t0)
    const windowId = (db.prepare('SELECT window_id FROM quota_current').get() as any).window_id
    expect((db.prepare('SELECT notified_window_id FROM quota_current').get() as any).notified_window_id)
      .toBe(windowId)
  })

  it('warns when it closes a window because polling stopped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    record(db, [success('codex', [{ name: 'five_hour', utilization: 40, resetsAt: RESET_A }])], t0)
    record(db, [success('codex', [{ name: 'five_hour', utilization: 45, resetsAt: RESET_A }])], t0 + 5 * 3600_000)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('no observation for a full window')
  })

  it('closes a window without warning when the rollover was observed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    record(db, [success('codex', [{ name: 'five_hour', utilization: 80, resetsAt: RESET_A }])], t0)
    record(db, [success('codex', [{ name: 'five_hour', utilization: 2, resetsAt: RESET_B }])], t0 + 60_000)

    expect(warn).not.toHaveBeenCalled()
  })

  it('does not write snapshots for a failed tool and keeps the last known value', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 42, resetsAt: RESET_A }])], t0)
    expect(countSnapshots(db)).toBe(1)

    const summary = record(db, [failure('codex', 'expired', 'Authentication failed (HTTP 401).')], t0 + 60_000)

    expect(summary.inserted).toBe(0)
    expect(summary.failedTools).toEqual(['codex'])
    expect(countSnapshots(db)).toBe(1)

    const current = db.prepare('SELECT * FROM quota_current').get() as any
    expect(current.utilization).toBe(42)
    expect(current.resets_at).toBe(Date.parse(RESET_A))
    expect(current.window_id).not.toBe('')
    expect(current.cred_status).toBe('expired')
    expect(current.last_error).toBe('Authentication failed (HTTP 401).')
    expect(current.last_error_kind).toBe('auth')
    expect(current.consecutive_errors).toBe(1)
    expect(current.last_success_at).toBe(t0)
  })

  it('records a network failure as network even though cred_status stays valid', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 42, resetsAt: RESET_A }])], t0)
    record(db, [{
      tool: 'codex',
      credentialStatus: 'valid',
      credentialMessage: null,
      success: false,
      tiers: [],
      error: 'Network error: TypeError: fetch failed',
      queriedAt: t0 + 60_000,
    }], t0 + 60_000)

    const current = db.prepare('SELECT cred_status, last_error_kind FROM quota_current').get() as any
    expect(current.cred_status).toBe('valid')
    expect(current.last_error_kind).toBe('network')
  })

  it('clears the error kind on the next success', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 42, resetsAt: RESET_A }])], t0)
    record(db, [failure('codex', 'expired', 'HTTP 401')], t0 + 60_000)
    expect((db.prepare('SELECT last_error_kind FROM quota_current').get() as any).last_error_kind).toBe('auth')

    record(db, [success('codex', [{ name: 'five_hour', utilization: 43, resetsAt: RESET_A }])], t0 + 120_000)
    expect((db.prepare('SELECT last_error_kind FROM quota_current').get() as any).last_error_kind).toBe('')
  })

  it('counts consecutive errors and clears them on the next success', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 42, resetsAt: RESET_A }])], t0)
    record(db, [failure('codex', 'expired', 'boom')], t0 + 60_000)
    record(db, [failure('codex', 'expired', 'boom')], t0 + 120_000)
    expect((db.prepare('SELECT consecutive_errors FROM quota_current').get() as any).consecutive_errors).toBe(2)

    record(db, [success('codex', [{ name: 'five_hour', utilization: 43, resetsAt: RESET_A }])], t0 + 180_000)
    const current = db.prepare('SELECT * FROM quota_current').get() as any
    expect(current.consecutive_errors).toBe(0)
    expect(current.last_error).toBeNull()
  })

  it('writes nothing for a tool that failed before it ever succeeded', () => {
    const summary = record(db, [failure('claude-code', 'not_found', null)], t0)
    expect(summary.inserted).toBe(0)
    expect(summary.updated).toBe(0)
    expect(summary.failedTools).toEqual(['claude-code'])
    expect(countSnapshots(db)).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM quota_current').get()).toEqual({ n: 0 })
  })

  it('handles a mixed round of successes and failures', () => {
    const summary = record(db, [
      failure('claude-code', 'not_found', null),
      success('codex', [
        { name: 'five_hour', utilization: 66, resetsAt: RESET_A },
        { name: 'weekly_limit', utilization: 54, resetsAt: '2026-09-04T04:18:42.000Z' },
      ]),
      failure('copilot', 'not_found', null),
    ], t0)

    expect(summary.inserted).toBe(2)
    expect(summary.failedTools).toEqual(['claude-code', 'copilot'])
    expect(countSnapshots(db)).toBe(2)
  })

  it('tracks tiers of the same tool independently', () => {
    record(db, [success('codex', [
      { name: 'five_hour', utilization: 10, resetsAt: RESET_A },
      { name: 'weekly_limit', utilization: 50, resetsAt: RESET_B },
    ])], t0)
    record(db, [success('codex', [
      { name: 'five_hour', utilization: 30, resetsAt: RESET_A },
      { name: 'weekly_limit', utilization: 50, resetsAt: RESET_B },
    ])], t0 + 60_000)

    expect(countSnapshots(db)).toBe(3)
    const rows = db.prepare('SELECT tier, utilization FROM quota_current ORDER BY tier').all() as any[]
    expect(rows).toEqual([
      { tier: 'five_hour', utilization: 30 },
      { tier: 'weekly_limit', utilization: 50 },
    ])
  })

  it('records a tier whose reset time is unknown', () => {
    const summary = record(db, [success('copilot', [{ name: 'chat', utilization: 12, resetsAt: null }])], t0)
    expect(summary.inserted).toBe(1)
    const row = db.prepare('SELECT resets_at, window_id FROM quota_snapshots').get() as any
    expect(row.resets_at).toBeNull()
    expect(row.window_id).toBe(computeWindowId(DEVICE_ID, 'copilot', 'chat', null, t0))
  })

  it('skips tiers with a non-numeric utilization', () => {
    const summary = record(db, [success('codex', [
      { name: 'five_hour', utilization: NaN as number, resetsAt: RESET_A },
      { name: 'weekly_limit', utilization: 50, resetsAt: RESET_B },
    ])], t0)
    expect(summary.inserted).toBe(1)
    expect((db.prepare('SELECT tier FROM quota_snapshots').get() as any).tier).toBe('weekly_limit')
  })

  it('returns an empty summary for an empty round', () => {
    expect(record(db, [], t0)).toEqual({
      attempted: 0, succeeded: 0, inserted: 0, updated: 0,
      windowsClosed: 0, failedTools: [], errorKinds: [],
      credentialFailures: [], crossings: [], resets: [],
    })
  })

  it('counts a tool that is not installed as neither attempted nor failed', () => {
    // not_found carries no error: the tool simply is not set up here. Counting
    // it would make an all-not_found machine look like a total outage.
    const summary = record(db, [
      failure('claude-code', 'not_found', null),
      failure('copilot', 'not_found', null),
    ], t0)

    expect(summary.attempted).toBe(0)
    expect(summary.succeeded).toBe(0)
    expect(summary.errorKinds).toEqual([])
    expect(summary.failedTools).toEqual(['claude-code', 'copilot'])
  })

  it('counts attempts and successes across a mixed round', () => {
    const summary = record(db, [
      failure('claude-code', 'not_found', null),
      success('codex', [
        { name: 'five_hour', utilization: 66, resetsAt: RESET_A },
        { name: 'weekly_limit', utilization: 54, resetsAt: RESET_B },
      ]),
      failure('copilot', 'expired', 'Authentication failed (HTTP 401).'),
    ], t0)

    expect(summary.attempted).toBe(2) // codex + copilot; claude-code is not set up
    expect(summary.succeeded).toBe(1)
    expect(summary.inserted).toBe(2)
    expect(summary.errorKinds).toEqual(['auth'])
  })

  it('reports every distinct error kind once, sorted, with no error text', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 10, resetsAt: RESET_A }])], t0)
    const summary = record(db, [
      {
        tool: 'codex', credentialStatus: 'valid', credentialMessage: null, success: false,
        tiers: [], error: 'Network error: TypeError: fetch failed', queriedAt: t0,
      },
      failure('copilot', 'expired', 'Authentication failed (HTTP 401).'),
      {
        tool: 'claude-code', credentialStatus: 'valid', credentialMessage: null, success: false,
        tiers: [], error: 'API error (HTTP 503): upstream unavailable', queriedAt: t0,
      },
    ], t0 + 60_000)

    expect(summary.attempted).toBe(3)
    expect(summary.succeeded).toBe(0)
    expect(summary.errorKinds).toEqual(['api', 'auth', 'network'])
    // Category names only — nothing here can carry a token, URL or message.
    for (const kind of summary.errorKinds) {
      expect(kind).toMatch(/^(auth|network|api|parse)$/)
    }
  })

  it('stores the device label alongside the instance id', () => {
    record(db, [success('codex', [{ name: 'five_hour', utilization: 20, resetsAt: RESET_A }])], t0)
    const row = db.prepare('SELECT device, device_instance_id FROM quota_snapshots').get() as any
    expect(row).toEqual({ device: DEVICE, device_instance_id: DEVICE_ID })
  })
})

describe('empty device instance id', () => {
  let db: Database.Database
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    db.close()
  })

  function recordWithId(deviceInstanceId: string, now: number) {
    return recordQuotaSnapshot(
      db,
      [success('codex', [{ name: 'five_hour', utilization: 40, resetsAt: null }])],
      { device: DEVICE, deviceInstanceId, now },
    )
  }

  it('writes nothing when there is no device instance id yet', () => {
    // '' means state.json does not exist, not that the device is unnamed.
    // Recording under '' guarantees the split that v18 had to clean up: the
    // moment state.json appears the same machine starts writing 'unknown'.
    const summary = recordWithId('', 1_000)

    expect(countSnapshots(db)).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM quota_current').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM quota_windows').get() as { n: number }).n).toBe(0)
    expect(summary.inserted).toBe(0)
    expect(summary.attempted).toBe(0)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('records normally once an id exists, with one series', () => {
    recordWithId('', 1_000)
    recordWithId('unknown', 2_000)
    recordWithId('unknown', 3_000)

    const ids = db.prepare(
      'SELECT DISTINCT device_instance_id AS id FROM quota_snapshots'
    ).all() as Array<{ id: string }>
    expect(ids).toEqual([{ id: 'unknown' }])
  })
})
