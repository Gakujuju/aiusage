import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord, countUnpricedRecords } from '../../src/db/records.js'
import type { StatsRecord } from '@aiusage/core'

/**
 * Two reasons a row shows no cost, and only one of them is anybody's to fix.
 *
 * A record with no price in the table is a real gap: edit the table and it
 * goes away. A record whose log gave a lump total with no token split has
 * nothing to multiply a price by, and is written at zero on purpose.
 *
 * Counting the second as the first produced a warning on the home screen
 * naming a model that already had a price — and no amount of editing that
 * price could make it stop. A warning whose stated remedy does not work is
 * worse than no warning: it spends attention on a task that cannot succeed.
 */

let db: Database.Database

function aRecord(overrides: Partial<StatsRecord> = {}): StatsRecord {
  return {
    id: 'rec-1',
    ts: 1776738085346,
    ingestedAt: 1776738085700,
    updatedAt: 1776738085700,
    lineOffset: 0,
    tool: 'codex',
    model: 'gpt-5.6-sol',
    provider: 'openai',
    inputTokens: 1000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    cost: 0,
    costSource: 'unknown',
    sessionId: 'sess-1',
    sourceFile: '/path/to/rollout.jsonl',
    device: 'test-device',
    deviceInstanceId: 'device-123',
    ...overrides,
  }
}

describe('countUnpricedRecords separates the two reasons a cost is missing', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('counts no unpriced records when every zero row is a lump total', () => {
    // The production case exactly: every row of this model was breakdown
    // missing, so the model was named in a pricing warning despite having a
    // price of its own.
    for (let i = 0; i < 3; i++) {
      insertRecord(db, aRecord({ id: `bm-${i}`, breakdownMissing: true }))
    }

    const summary = countUnpricedRecords(db)

    expect(summary.unpricedRecords).toBe(0)
    expect(summary.unpricedModels).toEqual([])
    expect(summary.breakdownMissingRecords).toBe(3)
  })

  it('still counts a row that has tokens, no cost and a real breakdown', () => {
    insertRecord(db, aRecord({ id: 'no-price', model: 'codex-auto-review' }))

    const summary = countUnpricedRecords(db)

    expect(summary.unpricedRecords).toBe(1)
    expect(summary.unpricedModels).toEqual(['codex-auto-review'])
    expect(summary.breakdownMissingRecords).toBe(0)
  })

  it('keeps the two apart when both are present', () => {
    insertRecord(db, aRecord({ id: 'no-price', model: 'codex-auto-review' }))
    insertRecord(db, aRecord({ id: 'lump-1', breakdownMissing: true }))
    insertRecord(db, aRecord({ id: 'lump-2', breakdownMissing: true }))

    const summary = countUnpricedRecords(db)

    // The model with a price does not appear in a warning about prices.
    expect(summary.unpricedRecords).toBe(1)
    expect(summary.unpricedModels).toEqual(['codex-auto-review'])
    expect(summary.breakdownMissingRecords).toBe(2)
  })

  it('leaves priced records out of both counts', () => {
    insertRecord(db, aRecord({
      id: 'priced', model: 'claude-sonnet-4-6', cost: 0.42, costSource: 'pricing',
    }))

    const summary = countUnpricedRecords(db)

    expect(summary.unpricedRecords).toBe(0)
    expect(summary.breakdownMissingRecords).toBe(0)
  })

  /**
   * The half of the condition that predates cost_source being set correctly:
   * old rows claim 'pricing' with a cost of zero, and the tokens are the only
   * evidence they were never costed.
   */
  it('still catches an old row that claims pricing but cost nothing', () => {
    insertRecord(db, aRecord({
      id: 'legacy', model: 'codex-auto-review', cost: 0, costSource: 'pricing',
    }))

    expect(countUnpricedRecords(db).unpricedRecords).toBe(1)
  })

  it('does not count a zero-token row as unpriced', () => {
    // Nothing was used, so nothing is missing.
    insertRecord(db, aRecord({
      id: 'empty', model: 'codex-auto-review', inputTokens: 0, costSource: 'pricing',
    }))

    expect(countUnpricedRecords(db).unpricedRecords).toBe(0)
  })
})
