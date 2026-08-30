import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initializeDatabase } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrations/index.js'

/**
 * v19 reached the production database through a command meant only to inspect
 * a bundle's exports. It said nothing while it did so. The point of this log
 * is that the path is in front of you at the moment something starts changing
 * it, so a forgotten AIUSAGE_HOME is visible rather than silent.
 */
describe('migration logging', () => {
  let log: ReturnType<typeof vi.spyOn>
  let dir: string

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    dir = mkdtempSync(join(tmpdir(), 'migration-log-'))
  })

  afterEach(() => {
    log.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  function applyingLines(): string[] {
    return log.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.startsWith('[migration] applying'))
  }

  it('announces every migration it applies, and names the file', () => {
    const file = join(dir, 'cache.db')
    const db = new Database(file)
    try {
      runMigrations(db)

      const lines = applyingLines()
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(line).toContain(file)
        expect(line).toMatch(/^\[migration\] applying v\d+ to /)
      }
      // One per migration, in order, ending at the current schema version.
      const versions = lines.map((l) => Number(l.match(/applying v(\d+)/)![1]))
      expect(versions).toEqual([...versions].sort((a, b) => a - b))
      expect(versions[0]).toBe(1)
      expect(versions[versions.length - 1]).toBe(
        (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v,
      )
    } finally {
      db.close()
    }
  })

  it('says nothing when the schema is already current', () => {
    const db = new Database(':memory:')
    try {
      initializeDatabase(db)
      log.mockClear()

      runMigrations(db)

      expect(applyingLines()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('announces only the migrations that were missing', () => {
    const db = new Database(':memory:')
    try {
      initializeDatabase(db)
      const latest = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v
      db.prepare('DELETE FROM schema_version WHERE version >= ?').run(latest)
      log.mockClear()

      runMigrations(db)

      expect(applyingLines()).toEqual([`[migration] applying v${latest} to :memory:`])
    } finally {
      db.close()
    }
  })
})
