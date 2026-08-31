import type Database from 'better-sqlite3'

/**
 * Drop v_sessions.
 *
 * It aggregated cost and tokens per session straight from records, and no
 * code has ever selected from it — only a schema test asserting it exists.
 * It is there for someone opening the database by hand.
 *
 * That is exactly why it had to go rather than be left alone. It knew
 * nothing about counting a merged row once, and nothing about rows whose
 * logs gave no token breakdown, so it would have answered with the same
 * inflated figures the dashboard spent a day shedding. Nobody would have
 * caught it, because nothing reads it — an aggregate that drifts silently
 * is worse than no aggregate, and the person querying it by hand is the
 * one already trying to work out why a number looks wrong.
 *
 * v_agent_sessions is left in place. It is genuinely used, and it reads
 * records alone with no union, so it never double-counted.
 *
 * Dropping a view touches no data.
 */
export function migrateV23(db: Database.Database): void {
  db.exec('DROP VIEW IF EXISTS v_sessions')
  db.prepare('INSERT INTO schema_version (version) VALUES (23)').run()
}
