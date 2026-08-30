import type Database from 'better-sqlite3'

/**
 * Where we have read up to in each agent log file.
 *
 * Codex has no hook mechanism, so its session lifecycle has to be read out of
 * the rollout logs it already writes (D18). Those files are appended to for
 * the life of a session and reach tens of megabytes, so the watcher reads
 * byte ranges rather than files — and the offset has to survive a restart, or
 * every serve start would replay the entire history as live events.
 *
 * `last_size` is the file size as of the last read. A file smaller than that
 * was truncated or replaced, which is the one case where the stored offset
 * points into nothing.
 */
export function migrateV19(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_log_cursors (
      source_file  TEXT PRIMARY KEY,
      tool         TEXT NOT NULL,
      byte_offset  INTEGER NOT NULL DEFAULT 0,
      last_size    INTEGER NOT NULL DEFAULT 0,
      updated_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_log_cursors_tool
      ON agent_log_cursors(tool, updated_at DESC);
  `)

  db.prepare('INSERT INTO schema_version (version) VALUES (19)').run()
}
