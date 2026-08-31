import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { recalcPricing } from '../../src/commands/recalc.js'
import { createApiServer } from '../../src/api/server.js'
import { Readable } from 'node:stream'
import type { StatsRecord } from '@aiusage/core'
import { loadPricingRuntime } from '../../src/pricing-registry.js'
import { loadConfig } from '../../src/config.js'

/**
 * The two recalc paths must agree, row for row.
 *
 * `aiusage recalc` and the dashboard's button walk the table differently on
 * purpose — the API yields the event loop between batches so the server keeps
 * answering — but they have to reach the same table. They did not: both
 * carried the same defect that priced rows with no token breakdown, found and
 * fixed separately, and they had quietly drifted on how a model that fails
 * normalisation is named.
 *
 * Comparing what decideRecalc returns would prove nothing, since both call
 * the same function. So this runs each path end to end over identical
 * fixtures and compares the databases afterwards. Two independently computed
 * results agreeing is the check that has actually been catching things here.
 */

let cli: Database.Database
let api: Database.Database

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
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    thinkingTokens: 0,
    cost: 0,
    costSource: 'unknown',
    sessionId: 'sess-1',
    sourceFile: '/logs/a.jsonl',
    device: 'd',
    deviceInstanceId: 'dev-1',
    ...overrides,
  } as StatsRecord
}

/** Every shape that has ever been decided differently by the two paths. */
const FIXTURES: StatsRecord[] = [
  // Ordinary priceable row.
  aRecord({ id: 'a-normal' }),
  // No token split: must stay at zero, must not be priced.
  aRecord({ id: 'b-lump', breakdownMissing: true, inputTokens: 9000 }),
  // A logged cost, which outranks the price table.
  aRecord({ id: 'c-logged', cost: 4.2, costSource: 'log' }),
  // A logged cost of zero, which does not (issue #13).
  aRecord({ id: 'd-logged-zero', cost: 0, costSource: 'log' }),
  // A model with no price at all.
  aRecord({ id: 'e-unpriced', model: 'no-such-model-9000' }),
  // The divergence: normalisation cannot identify this, and one path used to
  // write 'unknown' over the real name while the other kept it.
  aRecord({ id: 'f-qoder', tool: 'qoder', model: 'something-unrecognised' }),
  aRecord({ id: 'g-qoder-known', tool: 'qoder', model: 'qoder-auto' }),
  // Already priced correctly: neither path should touch it.
  aRecord({ id: 'h-priced', cost: 0.0069, costSource: 'pricing' }),
  // Zero tokens.
  aRecord({ id: 'i-empty', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
]

function seed(db: Database.Database) {
  for (const record of FIXTURES) insertRecord(db, record)
}

/*
 * The price table is process-wide, so whichever database initialised last
 * leaves its state behind. In production each path loads pricing for its own
 * database before repricing — openWithoutMigrating does it for the CLI, and
 * the server does it when it opens. Doing the same here keeps the comparison
 * about the decision rather than about which fixture ran second.
 */
function withPricingLoaded(db: Database.Database) {
  loadPricingRuntime(db, loadConfig())
  return db
}

/** Everything the recalculation is allowed to change. */
const dump = (db: Database.Database) =>
  db.prepare('SELECT id, model, provider, cost, cost_source FROM records ORDER BY id').all()

function call(server: ReturnType<typeof createApiServer>, method: string, path: string): Promise<any> {
  const req: any = Readable.from([])
  req.url = path
  req.method = method
  req.headers = { host: '127.0.0.1' }

  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const res: any = {
      statusCode: 200, headersSent: false,
      setHeader() {}, getHeader() { return undefined },
      writeHead(s: number) { this.statusCode = s; return this },
      write(c: any) { chunks.push(Buffer.from(c)); return true },
      end(c?: any) {
        if (c) chunks.push(Buffer.from(c))
        const body = Buffer.concat(chunks).toString('utf-8')
        resolve(body ? JSON.parse(body) : null)
      },
      on() { return this }, once() { return this }, emit() { return false },
    }
    server.emit('request', req, res)
  })
}

/**
 * Press the button and wait for the work, not for the reply.
 *
 * POST returns as soon as the job is accepted — the whole point of the API's
 * separate loop is that it runs in the background while the server keeps
 * answering. Comparing the tables the moment the response lands compares a
 * finished CLI run against one that has barely started, which is what this
 * test did on its first attempt.
 */
async function pressTheButton(db: Database.Database): Promise<void> {
  const server = createApiServer(db, { isLoopbackBind: true })
  await call(server, 'POST', '/api/pricing/recalc')

  for (let i = 0; i < 200; i++) {
    const status = await call(server, 'GET', '/api/pricing/recalc')
    if (status?.finishedAt != null || status?.running === false) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error('recalc did not finish')
}

describe('both recalc paths reach the same table', () => {
  beforeEach(() => {
    cli = new Database(':memory:')
    api = new Database(':memory:')
    for (const db of [cli, api]) {
      initializeDatabase(db)
      seed(db)
    }
  })

  afterEach(() => {
    cli.close()
    api.close()
  })

  it('starts from identical fixtures', () => {
    // Otherwise the comparison below proves nothing.
    expect(dump(cli)).toEqual(dump(api))
  })

  it('leaves identical rows behind', async () => {
    recalcPricing(withPricingLoaded(cli))
    await pressTheButton(withPricingLoaded(api))

    expect(dump(api)).toEqual(dump(cli))
  })

  it('agrees that a lump-total row stays unpriced', async () => {
    recalcPricing(withPricingLoaded(cli))
    await pressTheButton(withPricingLoaded(api))

    for (const db of [cli, api]) {
      const row = db.prepare('SELECT cost, cost_source FROM records WHERE id = ?').get('b-lump') as any
      expect(row.cost).toBe(0)
      expect(row.cost_source).toBe('unknown')
    }
  })

  it('agrees not to overwrite a real model name with unknown', async () => {
    // The drift between the two paths, pinned.
    recalcPricing(withPricingLoaded(cli))
    await pressTheButton(withPricingLoaded(api))

    for (const db of [cli, api]) {
      const row = db.prepare('SELECT model FROM records WHERE id = ?').get('f-qoder') as any
      expect(row.model).not.toBe('unknown')
    }
  })

  it('agrees to leave a logged cost alone', async () => {
    recalcPricing(withPricingLoaded(cli))
    await pressTheButton(withPricingLoaded(api))

    for (const db of [cli, api]) {
      const row = db.prepare('SELECT cost, cost_source FROM records WHERE id = ?').get('c-logged') as any
      expect(row.cost).toBe(4.2)
      expect(row.cost_source).toBe('log')
    }
  })

  it('still agrees on a second pass, having nothing left to do', async () => {
    recalcPricing(withPricingLoaded(cli))
    await pressTheButton(withPricingLoaded(api))
    const afterFirst = dump(cli)

    recalcPricing(withPricingLoaded(cli))
    await pressTheButton(withPricingLoaded(api))

    expect(dump(cli)).toEqual(afterFirst)
    expect(dump(api)).toEqual(afterFirst)
  })
})
