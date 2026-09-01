import type Database from 'better-sqlite3'

/**
 * Which build each spoke is running.
 *
 * Three machines have to be updated by hand, and the thing that actually
 * goes wrong is forgetting which ones were done. Asking the machines is
 * better than remembering, and they are already talking to the hub every
 * few minutes.
 *
 * Both columns nullable: a spoke built without git, or one running an
 * older build that does not send them, is unknown rather than out of
 * date.
 */
export function migrateV25(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(device_heartbeats)').all() as Array<{ name: string }>
  if (!columns.some((c) => c.name === 'commit_hash')) {
    db.exec('ALTER TABLE device_heartbeats ADD COLUMN commit_hash TEXT')
  }
  if (!columns.some((c) => c.name === 'commit_time')) {
    db.exec('ALTER TABLE device_heartbeats ADD COLUMN commit_time INTEGER')
  }
  db.prepare('INSERT INTO schema_version (version) VALUES (25)').run()
}
