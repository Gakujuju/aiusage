import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { recalcPricing } from '../../src/commands/recalc.js'
import { WatermarkManager, WatermarkCorruptError } from '../../src/watermark.js'

/**
 * Two ways the work already done gets undone.
 *
 * The parser refuses to price a row with no input/output split, because its
 * whole token count sits in input_tokens and multiplying that by the input
 * rate invents money. Recalculating has to refuse for the same reason — and
 * there are two recalculators, one for the CLI and one behind the dashboard
 * button, which is exactly the sort of pair where a fix lands on one of them.
 */

const T0 = 1_700_000_000_000

function aRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, ts: T0, ingestedAt: T0, updatedAt: T0, lineOffset: 0,
    tool: 'codex', model: 'gpt-4o', provider: 'openai',
    inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, thinkingTokens: 0,
    cost: 0, costSource: 'unknown', sessionId: 's1',
    sourceFile: 'C:/logs/a.jsonl', device: 'd', deviceInstanceId: 'dev-1',
    platform: 'win32', breakdownMissing: false,
    ...overrides,
  } as never
}

function priceGpt4o(db: Database.Database) {
  db.prepare(`
    INSERT INTO model_prices (model_key, provider, input, output, cache_read, cache_write,
                              currency, source, origin, status, created_at, updated_at)
    VALUES ('gpt-4o', 'openai', 4, 20, 0.4, 5, 'USD', 'test', 'builtin', 'active', ?, ?)
  `).run(T0, T0)
}

describe('a row with no breakdown is never priced', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    priceGpt4o(db)
  })

  afterEach(() => db.close())

  const costOf = (id: string) =>
    db.prepare('SELECT cost, cost_source FROM records WHERE id = ?').get(id) as
      { cost: number; cost_source: string }

  it('prices an ordinary row', () => {
    insertRecord(db, aRecord('plain'))
    recalcPricing(db)
    // 1M input at $4/M — the control, so a zero below means the flag worked
    // rather than the price being missing.
    expect(costOf('plain')).toEqual({ cost: 4, cost_source: 'pricing' })
  })

  it('leaves a flagged row at zero, though its model has a price', () => {
    insertRecord(db, aRecord('lump', { breakdownMissing: true }))
    recalcPricing(db)
    expect(costOf('lump')).toEqual({ cost: 0, cost_source: 'unknown' })
  })

  it('does not drift back on a second pass', () => {
    insertRecord(db, aRecord('lump', { breakdownMissing: true }))
    recalcPricing(db)
    recalcPricing(db)
    expect(costOf('lump')).toEqual({ cost: 0, cost_source: 'unknown' })
  })

  /**
   * The dashboard's "recalculate" button runs its own copy of this logic in
   * server.ts. Fixing only the CLI would have left the button inventing the
   * same $28.70 it invented in the dry run.
   */
  it('the dashboard recalculator agrees with the CLI one', async () => {
    insertRecord(db, aRecord('plain'))
    insertRecord(db, aRecord('lump', { breakdownMissing: true }))

    const { createApiServer } = await import('../../src/api/server.js')
    // Reach the same routine the button reaches.
    const server = createApiServer(db, { isLoopbackBind: true })
    const { Readable } = await import('node:stream')
    await new Promise<void>((resolve) => {
      const req: any = Readable.from([])
      req.url = '/api/pricing/recalc'
      req.method = 'POST'
      req.headers = { host: '127.0.0.1' }
      const res: any = {
        statusCode: 200, headersSent: false,
        setHeader() {}, getHeader() { return undefined },
        writeHead(s: number) { this.statusCode = s; return this },
        write() { return true },
        end() { resolve() },
        on() { return this }, once() { return this }, emit() { return false },
      }
      server.emit('request', req, res)
    })
    // The recalc runs in the background; give it a turn to finish.
    await new Promise((r) => setTimeout(r, 300))

    expect(costOf('lump')).toEqual({ cost: 0, cost_source: 'unknown' })
    expect(costOf('plain').cost).toBe(4)
  })
})

/**
 * An unreadable watermark used to mean "start from the beginning", and
 * starting from the beginning rewrites history rather than adding to it,
 * because insertRecord is INSERT OR REPLACE.
 */
describe('a corrupt watermark stops rather than resets', () => {
  let dir: string

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aiusage-wm-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('refuses to load, instead of reporting an empty position', () => {
    const path = join(dir, 'watermark.json')
    writeFileSync(path, '{"files": {"codex": {"a.jsonl": {"offset": 10,')  // truncated

    expect(() => new WatermarkManager(path)).toThrow(WatermarkCorruptError)
  })

  it('moves the damaged file aside so the next run can start clean', () => {
    const path = join(dir, 'watermark.json')
    writeFileSync(path, 'not json at all')

    expect(() => new WatermarkManager(path)).toThrow()

    const left = readdirSync(dir)
    expect(left.some((f) => f.startsWith('watermark.json.corrupt-'))).toBe(true)
    expect(left).not.toContain('watermark.json')
  })

  it('still treats a missing file as a fresh start', () => {
    // Never having had a watermark is not corruption — a new install reads
    // everything once, and that is correct.
    const wm = new WatermarkManager(join(dir, 'absent.json'))
    expect(wm.getEntry('codex' as never, 'anything')).toBeNull()
  })

  it('writes atomically, so a reader never sees half a file', () => {
    const path = join(dir, 'watermark.json')
    const wm = new WatermarkManager(path)
    wm.setEntry('codex' as never, 'a.jsonl', { offset: 10, size: 10, mtime: 1 })
    wm.save()

    // Parseable immediately after, and no temp file left behind.
    expect(() => JSON.parse(readFileSync(path, 'utf-8'))).not.toThrow()
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('keeps the position it saved', () => {
    const path = join(dir, 'watermark.json')
    const first = new WatermarkManager(path)
    first.setEntry('codex' as never, 'a.jsonl', { offset: 4242, size: 4242, mtime: 7 })
    first.save()

    const second = new WatermarkManager(path)
    expect(second.getEntry('codex' as never, 'a.jsonl')?.offset).toBe(4242)
  })
})
