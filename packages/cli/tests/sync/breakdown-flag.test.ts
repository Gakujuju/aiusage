import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord, getUnsyncedRecords } from '../../src/db/records.js'
import { insertSyncedRecord, mergeSyncedRecordsIntoRecords } from '../../src/db/synced-records.js'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'
import { normalizeIncomingSyncRecord } from '../../src/sync/direct.js'
import { SYNC_FIELDS } from '../../src/config.js'

/**
 * A Codex desktop session reports a total and no split, so the whole step is
 * recorded as input and the row is flagged. The flag has to survive the trip
 * to the hub, or the hub shows a combined input+output figure labelled
 * "input" with nothing to say otherwise.
 *
 * This is the third field to make this journey. platform did not survive it —
 * the merge simply never named the column — so every hop is asserted here
 * rather than assumed.
 */

const T0 = 1_700_000_000_000

function aRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rec-1', ts: T0, ingestedAt: T0, updatedAt: T0, lineOffset: 0,
    tool: 'codex', model: 'gpt-4o', provider: 'openai',
    inputTokens: 4713175, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, thinkingTokens: 0,
    cost: 0, costSource: 'unknown', sessionId: 's1',
    sourceFile: 'C:/logs/rollout.jsonl', cwd: 'C:/work',
    device: 'ノートPC', deviceInstanceId: 'dev-note', platform: 'win32',
    breakdownMissing: true,
    ...overrides,
  } as never
}

describe('the breakdown-missing flag', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  it('is declared as something we send', () => {
    // The consent list has to match the wire; see D24.
    expect(SYNC_FIELDS).toContain('breakdownMissing')
  })

  it('survives being written to and read from records', () => {
    insertRecord(db, aRecord())
    const row = db.prepare('SELECT breakdown_missing AS f FROM records WHERE id = ?').get('rec-1')
    expect(row).toEqual({ f: 1 })
  })

  it('is off for an ordinary record', () => {
    insertRecord(db, aRecord({ id: 'rec-2', breakdownMissing: false }))
    expect(db.prepare('SELECT breakdown_missing AS f FROM records WHERE id = ?').get('rec-2'))
      .toEqual({ f: 0 })
  })

  it('reaches the wire through the mapper', () => {
    insertRecord(db, aRecord())
    const [local] = getUnsyncedRecords(db, 'direct:https://hub')
    expect(mapStatsRecordToSyncRecord(local).breakdownMissing).toBe(true)
  })

  it('survives the receiving end of a direct upload', () => {
    const wire = mapStatsRecordToSyncRecord(aRecord() as never)
    const received = normalizeIncomingSyncRecord(JSON.parse(JSON.stringify(wire)))
    expect(received?.breakdownMissing).toBe(true)
  })

  /**
   * The whole round trip: a spoke's record, serialised, received, stored in
   * the holding table, and merged into the table the dashboard reads. The
   * merge is where platform was lost.
   */
  it('survives the whole trip from spoke to the hub dashboard', () => {
    const wire = mapStatsRecordToSyncRecord(aRecord() as never)
    const received = normalizeIncomingSyncRecord(JSON.parse(JSON.stringify(wire)))!

    // The id on the wire is derived from (device, source file, offset), not
    // the local row id, so the hub is keyed on that.
    insertSyncedRecord(db, received)
    expect(db.prepare('SELECT breakdown_missing AS f FROM synced_records WHERE id = ?').get(wire.id))
      .toEqual({ f: 1 })

    expect(mergeSyncedRecordsIntoRecords(db)).toBe(1)
    expect(db.prepare('SELECT breakdown_missing AS f FROM records WHERE id = ?').get(wire.id))
      .toEqual({ f: 1 })
  })

  it('does not set the flag on rows that never had it', () => {
    const wire = mapStatsRecordToSyncRecord(aRecord({ breakdownMissing: false }) as never)
    const received = normalizeIncomingSyncRecord(JSON.parse(JSON.stringify(wire)))!
    insertSyncedRecord(db, received)
    mergeSyncedRecordsIntoRecords(db)
    expect(db.prepare('SELECT breakdown_missing AS f FROM records WHERE id = ?').get(wire.id))
      .toEqual({ f: 0 })
  })
})
