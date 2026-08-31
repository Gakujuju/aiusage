import type Database from 'better-sqlite3'

/**
 * Where browsers that want push notifications are remembered.
 *
 * The primary key is a hash of the endpoint rather than the endpoint itself:
 * a browser that re-subscribes produces the same endpoint, so hashing it
 * makes re-registration an update instead of a second row that also gets
 * sent to. The endpoint stays UNIQUE so that invariant is the database's
 * rather than the caller's.
 *
 * p256dh and auth are the subscriber's keys. They never leave this table —
 * not to the API, not to a log — for the same reason the Discord webhook
 * does not.
 */
export function migrateV20(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id                   TEXT PRIMARY KEY,
      endpoint             TEXT NOT NULL UNIQUE,
      p256dh               TEXT NOT NULL,
      auth                 TEXT NOT NULL,
      -- What the person called this browser, so a list of three is readable.
      label                TEXT NOT NULL DEFAULT '',
      user_agent           TEXT NOT NULL DEFAULT '',
      -- Which machine's dashboard registered it. Useful when the same
      -- account is open on more than one.
      device_instance_id   TEXT NOT NULL DEFAULT '',
      created_at           INTEGER NOT NULL,
      last_success_at      INTEGER,
      last_error           TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_created
      ON push_subscriptions(created_at DESC);
  `)

  db.prepare('INSERT INTO schema_version (version) VALUES (20)').run()
}
