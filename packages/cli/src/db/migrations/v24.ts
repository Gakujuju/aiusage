import type Database from 'better-sqlite3'

/**
 * Somewhere to record that a spoke is still there.
 *
 * The hub could tell when a machine last sent a record, which answers a
 * different question from the one that matters. A quiet spoke is either
 * broken or simply had nothing to report, and from the last record alone
 * those look identical — the same ambiguity the parse-stall detector was
 * built to remove, one level up.
 *
 * So a spoke says so even when it has nothing: one row per machine, stamped
 * every time it parses. Silence in this table means the machine stopped
 * talking, which is a fact worth having rather than a guess.
 *
 * last_records_sent is kept because "alive and sending nothing" and "alive
 * and sending plenty" are both normal but not the same, and the difference
 * is the first thing anyone would want when a figure looks wrong.
 */
export function migrateV24(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_heartbeats (
      device_instance_id TEXT PRIMARY KEY,
      device             TEXT NOT NULL DEFAULT '',
      last_heartbeat_at  INTEGER NOT NULL,
      last_records_sent  INTEGER NOT NULL DEFAULT 0,
      /* What the spoke's own parse detector last reported, so the hub can
         tell "not sending" from "sending, but its parsing has stopped". */
      last_parse_ok_at   INTEGER,
      updated_at         INTEGER NOT NULL
    )
  `)
  db.prepare('INSERT INTO schema_version (version) VALUES (24)').run()
}
