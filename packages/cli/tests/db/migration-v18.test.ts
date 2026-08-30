import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { migrateV18 } from '../../src/db/migrations/v18.js'

describe('migration v18', () => {
  let db: Database.Database
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    db.prepare('DELETE FROM schema_version WHERE version = 18').run()
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    log.mockRestore()
    db.close()
  })

  function seedSnapshot(id: string, deviceInstanceId: string, ts: number): void {
    db.prepare(`
      INSERT INTO quota_snapshots (
        id, ts, tool, tier, utilization, resets_at, window_id, device, device_instance_id, created_at
      ) VALUES (?, ?, 'codex', 'five_hour', 40, NULL, 'w1', 'device-a', ?, ?)
    `).run(id, ts, deviceInstanceId, ts)
  }

  function seedCurrent(tier: string, deviceInstanceId: string): void {
    db.prepare(`
      INSERT INTO quota_current (
        tool, tier, device_instance_id, utilization, resets_at, window_id, ts,
        cred_status, last_success_at, last_error, last_error_kind, consecutive_errors,
        notified_level, notified_window_id, updated_at
      ) VALUES ('codex', ?, ?, 40, NULL, 'w1', 1000, 'valid', 1000, NULL, '', 0, 0, '', 1000)
    `).run(tier, deviceInstanceId)
  }

  function seedWindow(windowId: string, deviceInstanceId: string): void {
    db.prepare(`
      INSERT INTO quota_windows (
        window_id, tool, tier, device_instance_id, started_at, closed_at,
        resets_at, final_utilization, gap_detected
      ) VALUES (?, 'codex', 'five_hour', ?, 1000, NULL, NULL, NULL, 0)
    `).run(windowId, deviceInstanceId)
  }

  it('removes only the rows with an empty device instance id', () => {
    seedSnapshot('s-empty-1', '', 1_000)
    seedSnapshot('s-empty-2', '', 2_000)
    seedSnapshot('s-known', 'unknown', 3_000)
    seedCurrent('five_hour', '')
    seedCurrent('weekly_limit', 'unknown')
    seedWindow('w-empty', '')
    seedWindow('w-known', 'unknown')

    migrateV18(db)

    const snapshots = db.prepare(
      'SELECT id, device_instance_id AS dii FROM quota_snapshots ORDER BY id'
    ).all()
    expect(snapshots).toEqual([{ id: 's-known', dii: 'unknown' }])

    const current = db.prepare(
      'SELECT tier, device_instance_id AS dii FROM quota_current'
    ).all()
    expect(current).toEqual([{ tier: 'weekly_limit', dii: 'unknown' }])

    const windows = db.prepare(
      'SELECT window_id AS id, device_instance_id AS dii FROM quota_windows'
    ).all()
    expect(windows).toEqual([{ id: 'w-known', dii: 'unknown' }])

    expect(
      (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v
    ).toBe(18)
  })

  it('reports the count for each table before deleting', () => {
    seedSnapshot('s-empty-1', '', 1_000)
    seedSnapshot('s-empty-2', '', 2_000)
    seedCurrent('five_hour', '')

    migrateV18(db)

    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines).toEqual([
      '[migration v18] quota_snapshots: deleting 2 row(s) with an empty device_instance_id',
      '[migration v18] quota_current: deleting 1 row(s) with an empty device_instance_id',
      '[migration v18] quota_windows: deleting 0 row(s) with an empty device_instance_id',
    ])
  })

  it('says nothing when there is nothing to clean', () => {
    // Every new install runs this migration. Three "deleted 0" lines on first
    // launch would be noise that reads like something happened.
    seedSnapshot('s-known', 'unknown', 1_000)

    migrateV18(db)

    expect(log).not.toHaveBeenCalled()
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM quota_snapshots').get() as { n: number }).n
    ).toBe(1)
  })
})
