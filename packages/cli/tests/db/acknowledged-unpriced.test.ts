import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord, countUnpricedRecords } from '../../src/db/records.js'
import { recalcPricing } from '../../src/commands/recalc.js'
import type { StatsRecord } from '@aiusage/core'

/**
 * "Nobody publishes a rate" is a different statement from "you are missing a
 * price", and only one of them asks the reader to do something.
 *
 * codex-auto-review has no rate anywhere — not from OpenAI, not in LiteLLM,
 * not in the local model cache — so its 298 rows produced a red warning that
 * no edit to any price table could clear, and it grew by a few rows a day.
 * A warning that cannot be acted on teaches people to skip warnings, and the
 * next model that genuinely needs a price would arrive into the same red.
 *
 * Acknowledging moves those rows to a quiet statement of fact. It is not a
 * price and does not become one: cost stays 0, cost_source stays 'unknown'.
 * The rate may well be zero — automatic review might be included in the
 * subscription — but nobody here knows that, and this leaves the question
 * open rather than answering it with a guess.
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
    model: 'codex-auto-review',
    provider: 'openai',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    cost: 0,
    costSource: 'unknown',
    sessionId: 'sess-1',
    sourceFile: '/logs/rollout.jsonl',
    device: 'd',
    deviceInstanceId: 'dev-1',
    ...overrides,
  } as StatsRecord
}

const ACK = { acknowledgedModels: ['codex-auto-review'] }

describe('a model with no published rate stops being a warning', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('counts it as a warning until it is acknowledged', () => {
    insertRecord(db, aRecord({ id: 'a' }))
    insertRecord(db, aRecord({ id: 'b' }))

    const before = countUnpricedRecords(db)

    expect(before.unpricedRecords).toBe(2)
    expect(before.unpricedModels).toEqual(['codex-auto-review'])
    expect(before.acknowledgedUnpricedRecords).toBe(0)
  })

  it('moves it to the quiet count once acknowledged', () => {
    insertRecord(db, aRecord({ id: 'a' }))
    insertRecord(db, aRecord({ id: 'b' }))

    const after = countUnpricedRecords(db, ACK)

    expect(after.unpricedRecords).toBe(0)
    expect(after.unpricedModels).toEqual([])
    expect(after.acknowledgedUnpricedRecords).toBe(2)
    expect(after.acknowledgedUnpricedModels).toEqual(['codex-auto-review'])
  })

  /**
   * The point of doing this per model rather than switching the warning off.
   * Something new and unpriced still has to be able to raise its hand.
   */
  it('still warns about a different model that is not acknowledged', () => {
    insertRecord(db, aRecord({ id: 'a' }))
    insertRecord(db, aRecord({ id: 'new', model: 'some-new-model' }))

    const after = countUnpricedRecords(db, ACK)

    expect(after.unpricedRecords).toBe(1)
    expect(after.unpricedModels).toEqual(['some-new-model'])
    expect(after.acknowledgedUnpricedRecords).toBe(1)
  })

  it('does not touch the cost or the cost source', () => {
    insertRecord(db, aRecord({ id: 'a' }))

    countUnpricedRecords(db, ACK)

    const row = db.prepare('SELECT cost, cost_source FROM records WHERE id = ?').get('a') as any
    expect(row.cost).toBe(0)
    // Not 'pricing'. Acknowledging says nobody publishes a rate, not that the
    // rate is zero — entering 0 by hand is the bug D15 fixed.
    expect(row.cost_source).toBe('unknown')
  })

  it('survives a recalc', () => {
    // The acknowledgement lives in the config, and recalc rewrites records.
    // They cannot reach each other, which is half the reason it lives there.
    insertRecord(db, aRecord({ id: 'a' }))

    recalcPricing(db)

    const row = db.prepare('SELECT cost, cost_source FROM records WHERE id = ?').get('a') as any
    expect(row.cost).toBe(0)
    expect(row.cost_source).toBe('unknown')

    const after = countUnpricedRecords(db, ACK)
    expect(after.unpricedRecords).toBe(0)
    expect(after.acknowledgedUnpricedRecords).toBe(1)
  })

  it('keeps the lump-total count separate from both', () => {
    // Three reasons a cost is missing, three counts, one of them actionable.
    insertRecord(db, aRecord({ id: 'ack' }))
    insertRecord(db, aRecord({ id: 'lump', breakdownMissing: true }))
    insertRecord(db, aRecord({ id: 'needs-price', model: 'some-new-model' }))

    const after = countUnpricedRecords(db, ACK)

    expect(after.unpricedRecords).toBe(1)
    expect(after.acknowledgedUnpricedRecords).toBe(1)
    expect(after.breakdownMissingRecords).toBe(1)
  })

  it('acknowledging an unrelated model changes nothing', () => {
    insertRecord(db, aRecord({ id: 'a' }))

    const after = countUnpricedRecords(db, { acknowledgedModels: ['something-else'] })

    expect(after.unpricedRecords).toBe(1)
    expect(after.acknowledgedUnpricedRecords).toBe(0)
  })
})
