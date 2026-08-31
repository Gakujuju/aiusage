import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { countUnpricedRecords } from '../../src/db/records.js'

/**
 * The two branches the unit tests above do not reach.
 *
 * /api/summary picks a source from the device filter, and a union or a
 * synced-only query that does not parse would 500 the whole summary endpoint
 * — the home screen, not just the band. Worth pinning that they run.
 */

let db: Database.Database

describe('the scoped count runs against every source the summary uses', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('runs the union of local and other devices', () => {
    const summary = countUnpricedRecords(db, {
      source: 'union',
      recordsWhere: "AND ts >= @start AND ts < @end AND source_file NOT LIKE 'synced/%'",
      syncedWhere: 'AND device_instance_id != @currentDeviceId AND ts >= @start AND ts < @end',
      params: { start: 0, end: 9e15, currentDeviceId: 'device-123' },
    })

    expect(summary.unpricedRecords).toBe(0)
    expect(summary.breakdownMissingRecords).toBe(0)
  })

  it('runs against another device alone', () => {
    const summary = countUnpricedRecords(db, {
      source: 'synced',
      syncedWhere: 'AND device_instance_id = @deviceId AND ts >= @start AND ts < @end',
      params: { deviceId: 'other-device', start: 0, end: 9e15 },
    })

    expect(summary.unpricedRecords).toBe(0)
    expect(summary.breakdownMissingRecords).toBe(0)
  })
})
