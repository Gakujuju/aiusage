import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { sessionIdFromPathLike, migrateV17 } from '../../src/db/migrations/v17.js'

/**
 * extractSessionId split paths on '/' only, so on Windows records.session_id
 * kept the whole path. This repairs what it wrote — and, more importantly,
 * leaves alone the ids that were never paths.
 */
describe('sessionIdFromPathLike', () => {
  it('reduces a Windows path to the bare id', () => {
    expect(sessionIdFromPathLike(
      'C:\\Users\\x\\.claude\\projects\\C--Users-x-aiusage\\02266b28-7698-434a-9f34-0740270f569d',
    )).toBe('02266b28-7698-434a-9f34-0740270f569d')
  })

  it('reduces a POSIX path the same way', () => {
    expect(sessionIdFromPathLike('/home/x/.claude/projects/p/abc-123')).toBe('abc-123')
  })

  it('strips a trailing .jsonl', () => {
    expect(sessionIdFromPathLike('/a/b/abc-123.jsonl')).toBe('abc-123')
    expect(sessionIdFromPathLike('C:\\a\\b\\abc-123.JSONL')).toBe('abc-123')
  })

  // A bare id is either already correct, or belongs to a tool that derives it
  // from something other than a filename (qoder uses the directory above
  // `segments`). Rewriting those would break them.
  it('leaves an id with no separator alone', () => {
    expect(sessionIdFromPathLike('02266b28-7698-434a-9f34-0740270f569d')).toBeNull()
    expect(sessionIdFromPathLike('rollout-abc')).toBeNull()
    expect(sessionIdFromPathLike('')).toBeNull()
  })

  it('leaves a value that would be emptied alone', () => {
    expect(sessionIdFromPathLike('/a/b/')).toBeNull()
    expect(sessionIdFromPathLike('/a/b/.jsonl')).toBeNull()
  })
})

describe('migration v17', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    db.prepare('DELETE FROM schema_version WHERE version = 17').run()
  })

  afterEach(() => db.close())

  const insert = (id: string, tool: string, sessionId: string) => {
    db.prepare(`
      INSERT INTO records (id, ts, ingested_at, updated_at, line_offset, tool, model, provider,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens,
        cost, cost_source, session_id, source_file, device, device_instance_id)
      VALUES (?, 1000, 1000, 1000, 0, ?, 'm', 'p', 1, 1, 0, 0, 0, 0, 'pricing', ?, '/f', 'd', 'unknown')
    `).run(id, tool, sessionId)
  }

  it('rewrites path-shaped ids and leaves bare ones untouched', () => {
    insert('r1', 'claude-code', 'C:\\Users\\x\\.claude\\projects\\p\\uuid-a')
    insert('r2', 'codex', '/home/x/.codex/sessions/rollout-uuid-b.jsonl')
    insert('r3', 'qoder', 'already-bare')

    migrateV17(db)

    const rows = db.prepare('SELECT id, session_id FROM records ORDER BY id').all() as any[]
    expect(rows).toEqual([
      { id: 'r1', session_id: 'uuid-a' },
      { id: 'r2', session_id: 'rollout-uuid-b' },
      { id: 'r3', session_id: 'already-bare' },
    ])
  })

  it('does not change how many records exist or what they total', () => {
    insert('r1', 'claude-code', 'C:\\a\\b\\uuid-a')
    insert('r2', 'claude-code', 'C:\\a\\b\\uuid-b')
    const before = db.prepare(
      'SELECT COUNT(*) n, SUM(input_tokens + output_tokens) t FROM records'
    ).get() as any

    migrateV17(db)

    expect(db.prepare('SELECT COUNT(*) n, SUM(input_tokens + output_tokens) t FROM records').get())
      .toEqual(before)
  })

  it('is a no-op on a database that has none', () => {
    insert('r1', 'qoder', 'bare-id')
    migrateV17(db)
    expect((db.prepare("SELECT session_id FROM records WHERE id='r1'").get() as any).session_id)
      .toBe('bare-id')
  })

  it('records its schema version', () => {
    migrateV17(db)
    const versions = (db.prepare('SELECT version FROM schema_version').all() as any[]).map((r) => r.version)
    expect(versions).toContain(17)
  })
})
