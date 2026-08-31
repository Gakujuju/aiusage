import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { insertSyncedRecord, mergeSyncedRecordsIntoRecords } from '../../src/db/synced-records.js'
import type { StatsRecord } from '@aiusage/core'

/**
 * A correction made on a spoke has to reach the hub (D28).
 *
 * The merge only inserted — WHERE r.id IS NULL — so a row could arrive once
 * and never change again. Everything fixed on a spoke afterwards stopped at
 * synced_records: the platform backfill, recalculated costs, the codex token
 * fix. The hub went on showing the first version it ever saw, and nothing
 * anywhere said the two tables had drifted.
 *
 * Which copy wins is decided by updated_at, so a stale upload arriving late
 * cannot undo a newer correction.
 */

const HUB = 'hub-device'
const SPOKE = 'spoke-device'

let db: Database.Database

function aRecord(overrides: Partial<StatsRecord> = {}): StatsRecord {
  return {
    id: 'rec-1',
    ts: 1776738085346,
    ingestedAt: 1776738085700,
    updatedAt: 1000,
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
    sourceFile: 'C:/Users/someone/.claude/projects/app/a.jsonl',
    device: 'a-device',
    deviceInstanceId: SPOKE,
    platform: 'win32',
    ...overrides,
  } as StatsRecord
}

function onTheWire(record: StatsRecord) {
  const { sessionId, ...rest } = record
  return { ...rest, sessionKey: sessionId, cwd: '' }
}

const rowIn = (table: 'records' | 'synced_records', id: string) =>
  db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as any

describe('a spoke correction reaches the hub', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('updates a row when the arriving copy is newer', () => {
    insertRecord(db, aRecord({ updatedAt: 1000, cost: 1, inputTokens: 100 }))
    // The spoke recalculated: same row, later stamp, corrected numbers.
    insertSyncedRecord(db, onTheWire(
      aRecord({ updatedAt: 2000, cost: 0.5, inputTokens: 40 })) as never)

    mergeSyncedRecordsIntoRecords(db)

    const row = rowIn('records', 'rec-1')
    expect(row.cost).toBe(0.5)
    expect(row.input_tokens).toBe(40)
    expect(row.updated_at).toBe(2000)
  })

  it('leaves a row alone when the arriving copy is older', () => {
    // A correction already made here, and a stale upload turning up after.
    insertRecord(db, aRecord({ updatedAt: 5000, cost: 0.5 }))
    insertSyncedRecord(db, onTheWire(aRecord({ updatedAt: 2000, cost: 9 })) as never)

    mergeSyncedRecordsIntoRecords(db)

    expect(rowIn('records', 'rec-1').cost).toBe(0.5)
  })

  it('leaves a row alone when the stamps are equal', () => {
    insertRecord(db, aRecord({ updatedAt: 3000, cost: 0.5 }))
    insertSyncedRecord(db, onTheWire(aRecord({ updatedAt: 3000, cost: 9 })) as never)

    mergeSyncedRecordsIntoRecords(db)

    expect(rowIn('records', 'rec-1').cost).toBe(0.5)
  })

  /**
   * A spoke has no reason to send back a row the hub made, so this cannot
   * happen today. It is guarded anyway: "cannot happen today" is exactly
   * what was assumed about source_file, and that assumption cost a tenth of
   * every figure on the site.
   */
  it('never overwrites a row this machine produced itself', () => {
    insertRecord(db, aRecord({ id: 'own-1', deviceInstanceId: HUB, updatedAt: 1000, cost: 1 }))
    insertSyncedRecord(db, onTheWire(aRecord({
      id: 'own-1', deviceInstanceId: SPOKE, updatedAt: 9000, cost: 99,
    })) as never)

    mergeSyncedRecordsIntoRecords(db)

    const row = rowIn('records', 'own-1')
    expect(row.cost).toBe(1)
    expect(row.device_instance_id).toBe(HUB)
  })

  it('still inserts rows it has never seen', () => {
    // The half that already worked, kept honest.
    insertSyncedRecord(db, onTheWire(aRecord({ id: 'new-1' })) as never)

    mergeSyncedRecordsIntoRecords(db)

    expect(rowIn('records', 'new-1')).toBeTruthy()
  })

  it('carries a correction that only changes a flag', () => {
    // The shape the codex fix took: tokens unchanged, the flag set.
    insertRecord(db, aRecord({ updatedAt: 1000, breakdownMissing: false }))
    insertSyncedRecord(db, onTheWire(
      aRecord({ updatedAt: 2000, breakdownMissing: true })) as never)

    mergeSyncedRecordsIntoRecords(db)

    expect(rowIn('records', 'rec-1').breakdown_missing).toBe(1)
  })

  it('keeps when this machine first saw the row', () => {
    // A correction is not a new arrival; ingested_at should not move.
    insertRecord(db, aRecord({ updatedAt: 1000, ingestedAt: 777 }))
    insertSyncedRecord(db, onTheWire(aRecord({ updatedAt: 2000, cost: 0.5 })) as never)

    mergeSyncedRecordsIntoRecords(db)

    expect(rowIn('records', 'rec-1').ingested_at).toBe(777)
  })

  it('reports how many rows it touched', () => {
    insertRecord(db, aRecord({ id: 'a', updatedAt: 1000 }))
    insertSyncedRecord(db, onTheWire(aRecord({ id: 'a', updatedAt: 2000, cost: 2 })) as never)
    insertSyncedRecord(db, onTheWire(aRecord({ id: 'b' })) as never)

    // One inserted, one updated.
    expect(mergeSyncedRecordsIntoRecords(db)).toBe(2)
  })
})
