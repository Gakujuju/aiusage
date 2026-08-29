import type Database from 'better-sqlite3'

/**
 * Phase 7: notification outbox.
 *
 * Notifications are queued here rather than sent inline, for two reasons.
 * The obvious one is retries. The less obvious one is that the thing that
 * decides to notify runs inside a database transaction, and a webhook call
 * must never happen there — the write queue is serial, so one slow POST would
 * stall the parser, the sync and every other writer behind it.
 *
 * The queue also makes "why did I not get a notification?" answerable: every
 * decision leaves a row, including the ones that were deliberately dropped.
 *
 * dedupe_key is unique for all time. Repeat notifications that are genuinely
 * warranted carry the occurrence in the key — a session's status_since, a
 * quota window id, an escalation level — so they are different events rather
 * than duplicates of one.
 */
export function migrateV15(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id                 TEXT PRIMARY KEY,
      created_at         INTEGER NOT NULL,
      channel            TEXT NOT NULL DEFAULT 'discord',
      event_type         TEXT NOT NULL,
      subject_kind       TEXT NOT NULL,
      subject_id         TEXT NOT NULL,
      dedupe_key         TEXT NOT NULL,
      title              TEXT NOT NULL DEFAULT '',
      body               TEXT NOT NULL DEFAULT '',
      payload            TEXT NOT NULL DEFAULT '{}',
      state              TEXT NOT NULL DEFAULT 'pending',
      attempts           INTEGER NOT NULL DEFAULT 0,
      next_attempt_at    INTEGER,
      -- Past this, the news is stale enough that delivering it is worse than
      -- staying quiet. A "waiting for permission" from three hours ago is not
      -- information, it is noise about something already resolved.
      expires_at         INTEGER,
      last_error         TEXT,
      sent_at            INTEGER,
      device_instance_id TEXT NOT NULL DEFAULT ''
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe  ON notifications(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notifications(state, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_subject ON notifications(subject_kind, subject_id, created_at DESC);
  `)

  // Added separately: ALTER TABLE has no IF NOT EXISTS, and a database that
  // already carries the column would abort the whole migration.
  const columns = db.prepare('PRAGMA table_info(agent_sessions)').all() as Array<{ name: string }>
  if (!columns.some((c) => c.name === 'escalation_level')) {
    db.exec('ALTER TABLE agent_sessions ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0')
  }

  db.prepare('INSERT INTO schema_version (version) VALUES (15)').run()
}
