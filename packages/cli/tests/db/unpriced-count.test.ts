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

  /*
   * The band used to say "334 records" while every figure beside it was one
   * day's. The count was taken over the whole table no matter what the reader
   * had selected, so the number did not mean what it appeared to mean —
   * the same fault as counting lump totals as unpriced, one level up.
   */
  describe('the counts follow the same filters as the figures beside them', () => {
    const DAY = 24 * 60 * 60 * 1000
    const T0 = 1776700000000

    function seed() {
      // Two days, two tools, both causes present on each day.
      insertRecord(db, aRecord({
        id: 'old-noprice', ts: T0, model: 'codex-auto-review',
      }))
      insertRecord(db, aRecord({
        id: 'old-lump', ts: T0, breakdownMissing: true,
      }))
      insertRecord(db, aRecord({
        id: 'new-noprice', ts: T0 + DAY, model: 'codex-auto-review',
      }))
      insertRecord(db, aRecord({
        id: 'new-lump', ts: T0 + DAY, breakdownMissing: true,
      }))
      insertRecord(db, aRecord({
        id: 'new-other-tool', ts: T0 + DAY, tool: 'claude-code',
        model: 'some-unpriced-model',
      }))
    }

    it('counts everything when given no scope', () => {
      // What the startup warning means: this machine, all of it.
      seed()

      const summary = countUnpricedRecords(db)

      expect(summary.unpricedRecords).toBe(3)
      expect(summary.breakdownMissingRecords).toBe(2)
    })

    it('counts only the selected range', () => {
      seed()

      const summary = countUnpricedRecords(db, {
        recordsWhere: 'AND ts >= @start AND ts < @end',
        params: { start: T0 + DAY, end: T0 + 2 * DAY },
      })

      expect(summary.unpricedRecords).toBe(2)
      expect(summary.breakdownMissingRecords).toBe(1)
    })

    it('counts only the selected tool', () => {
      seed()

      const summary = countUnpricedRecords(db, {
        recordsWhere: 'AND tool = @tool',
        params: { tool: 'claude-code' },
      })

      expect(summary.unpricedRecords).toBe(1)
      expect(summary.unpricedModels).toEqual(['some-unpriced-model'])
      expect(summary.breakdownMissingRecords).toBe(0)
    })

    it('applies range and tool together', () => {
      seed()

      const summary = countUnpricedRecords(db, {
        recordsWhere: 'AND ts >= @start AND ts < @end AND tool = @tool',
        params: { start: T0 + DAY, end: T0 + 2 * DAY, tool: 'codex' },
      })

      expect(summary.unpricedRecords).toBe(1)
      expect(summary.breakdownMissingRecords).toBe(1)
    })

    it('returns nothing for a range with no records in it', () => {
      seed()

      const summary = countUnpricedRecords(db, {
        recordsWhere: 'AND ts >= @start AND ts < @end',
        params: { start: T0 + 10 * DAY, end: T0 + 11 * DAY },
      })

      expect(summary.unpricedRecords).toBe(0)
      expect(summary.unpricedModels).toEqual([])
      expect(summary.breakdownMissingRecords).toBe(0)
    })

    /**
     * Both halves take one pass over one scope, so they cannot end up
     * describing different sets of rows — which is how the two came apart in
     * the first place.
     */
    it('scopes both counts, not just one of them', () => {
      seed()

      const all = countUnpricedRecords(db)
      const oneDay = countUnpricedRecords(db, {
        recordsWhere: 'AND ts >= @start AND ts < @end',
        params: { start: T0, end: T0 + DAY },
      })

      expect(oneDay.unpricedRecords).toBeLessThan(all.unpricedRecords)
      expect(oneDay.breakdownMissingRecords).toBeLessThan(all.breakdownMissingRecords)
    })
  })
})
