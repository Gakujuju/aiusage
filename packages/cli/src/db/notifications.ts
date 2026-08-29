import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { NotificationEventType } from '@aiusage/core'

/**
 * The notification outbox.
 *
 * Everything queued here, nothing sent from here — see notify/discord.ts for
 * why the two are kept apart.
 */

/** How long a queued notification stays worth delivering. */
const TTL_MS: Record<string, number> = {
  session_status: 15 * 60_000,
  session_escalation: 15 * 60_000,
  quota_threshold: 60 * 60_000,
  quota_reset: 60 * 60_000,
  test: 15 * 60_000,
}

/** Waits before each retry. Length also caps how many times we try. */
export const RETRY_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000]

export type NotificationState = 'pending' | 'sending' | 'sent' | 'failed' | 'dropped'

export interface EnqueueInput {
  eventType: NotificationEventType
  subjectKind: 'agent_session' | 'quota' | 'system'
  subjectId: string
  dedupeKey: string
  title: string
  body: string
  payload?: Record<string, unknown>
  deviceInstanceId?: string
  /** Queue it but do not send — this machine is not the notifier. */
  drop?: boolean
  dropReason?: string
}

export interface NotificationRow {
  id: string
  created_at: number
  channel: string
  event_type: string
  subject_kind: string
  subject_id: string
  dedupe_key: string
  title: string
  body: string
  payload: string
  state: NotificationState
  attempts: number
  next_attempt_at: number | null
  expires_at: number | null
  last_error: string | null
  sent_at: number | null
  device_instance_id: string
}

function notificationId(dedupeKey: string): string {
  return createHash('sha256').update(dedupeKey).digest('hex').slice(0, 16)
}

/**
 * Queue one notification. A dedupe_key already present is silently ignored:
 * the key encodes the occurrence, so a collision means we have already
 * decided about this exact event.
 *
 * Returns true when a row was actually added.
 */
export function enqueueNotification(
  db: Database.Database,
  input: EnqueueInput,
  now: number,
): boolean {
  const ttl = TTL_MS[input.eventType] ?? TTL_MS.session_status
  const result = db.prepare(`
    INSERT OR IGNORE INTO notifications (
      id, created_at, channel, event_type, subject_kind, subject_id, dedupe_key,
      title, body, payload, state, attempts, next_attempt_at, expires_at,
      last_error, sent_at, device_instance_id
    ) VALUES (
      @id, @now, 'discord', @eventType, @subjectKind, @subjectId, @dedupeKey,
      @title, @body, @payload, @state, 0, @nextAttemptAt, @expiresAt,
      @lastError, NULL, @deviceInstanceId
    )
  `).run({
    id: notificationId(input.dedupeKey),
    now,
    eventType: input.eventType,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    dedupeKey: input.dedupeKey,
    title: input.title,
    body: input.body,
    payload: JSON.stringify(input.payload ?? {}),
    // A non-notifier machine still records the decision, so it stays possible
    // to see afterwards what happened where.
    state: input.drop ? 'dropped' : 'pending',
    nextAttemptAt: input.drop ? null : now,
    expiresAt: now + ttl,
    lastError: input.drop ? (input.dropReason ?? 'not the notifier device') : null,
    deviceInstanceId: input.deviceInstanceId ?? '',
  })
  return result.changes > 0
}

/**
 * Claim up to `limit` notifications for sending, marking them in flight.
 *
 * Claiming and sending are separate on purpose: this runs inside the write
 * queue, the HTTP call does not.
 */
export function claimPendingNotifications(
  db: Database.Database,
  now: number,
  limit: number,
): NotificationRow[] {
  // Anything past its expiry is dropped rather than delivered late.
  db.prepare(`
    UPDATE notifications
    SET state = 'dropped', last_error = 'expired before delivery'
    WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at < @now
  `).run({ now })

  const rows = db.prepare(`
    SELECT * FROM notifications
    WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
    ORDER BY created_at
    LIMIT @limit
  `).all({ now, limit }) as NotificationRow[]

  if (rows.length === 0) return []
  const claim = db.prepare("UPDATE notifications SET state = 'sending' WHERE id = ? AND state = 'pending'")
  const claimed: NotificationRow[] = []
  for (const row of rows) {
    if (claim.run(row.id).changes > 0) claimed.push(row)
  }
  return claimed
}

/**
 * Put back anything left mid-flight by a process that died.
 *
 * A notification is marked 'sending' before the POST and written back after
 * it. A crash, a Ctrl+C or a power cut in between leaves the row stuck: no
 * later claim will ever look at it again.
 *
 * Some of what this requeues was in fact delivered, so the recipient may see
 * one message twice. That is the right trade: a duplicate is a moment's
 * confusion, a notification lost forever is the failure this whole queue
 * exists to prevent. expires_at caps how stale a re-sent message can be.
 * Please do not "fix" the duplicate by removing this.
 */
export function requeueInFlightNotifications(db: Database.Database): number {
  return db.prepare("UPDATE notifications SET state = 'pending' WHERE state = 'sending'").run().changes
}

export function markNotificationSent(db: Database.Database, id: string, now: number): void {
  db.prepare(`
    UPDATE notifications
    SET state = 'sent', sent_at = @now, last_error = NULL, attempts = attempts + 1
    WHERE id = @id
  `).run({ id, now })
}

/**
 * Record a failed attempt and schedule the next one.
 *
 * `countsAsAttempt` is false for rate limiting: being told to slow down is not
 * the same as failing, and burning a retry on it would give up on a message
 * that never actually had a problem.
 */
export function markNotificationFailed(
  db: Database.Database,
  id: string,
  error: string,
  now: number,
  options: { countsAsAttempt?: boolean; retryAfterMs?: number } = {},
): void {
  const countsAsAttempt = options.countsAsAttempt !== false
  const row = db.prepare('SELECT attempts FROM notifications WHERE id = ?').get(id) as
    { attempts: number } | undefined
  if (!row) return

  const attempts = countsAsAttempt ? row.attempts + 1 : row.attempts
  const exhausted = countsAsAttempt && attempts > RETRY_BACKOFF_MS.length

  db.prepare(`
    UPDATE notifications
    SET state = @state, attempts = @attempts, last_error = @error, next_attempt_at = @nextAttemptAt
    WHERE id = @id
  `).run({
    id,
    state: exhausted ? 'failed' : 'pending',
    attempts,
    error,
    nextAttemptAt: exhausted
      ? null
      : now + (options.retryAfterMs ?? RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)]),
  })
}

/** Put a failed notification back in the queue, from the API. */
export function retryNotification(db: Database.Database, id: string, now: number): boolean {
  const result = db.prepare(`
    UPDATE notifications
    SET state = 'pending', attempts = 0, next_attempt_at = @now, last_error = NULL,
        expires_at = MAX(COALESCE(expires_at, 0), @expiresAt)
    WHERE id = @id AND state IN ('failed', 'dropped')
  `).run({ id, now, expiresAt: now + TTL_MS.session_status })
  return result.changes > 0
}

export interface ListNotificationsQuery {
  state?: string | null
  subjectKind?: string | null
  limit?: number
}

export function listNotifications(db: Database.Database, query: ListNotificationsQuery) {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (query.state) { where.push('state = @state'); params.state = query.state }
  if (query.subjectKind) { where.push('subject_kind = @subjectKind'); params.subjectKind = query.subjectKind }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(1, query.limit ?? 50), 500)

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM notifications ${clause}`).get(params) as { n: number }).n
  const rows = db.prepare(`
    SELECT * FROM notifications ${clause} ORDER BY created_at DESC LIMIT @limit
  `).all({ ...params, limit }) as NotificationRow[]

  return {
    total,
    limit,
    // The webhook never reaches these columns, and last_error is masked before
    // it is written, so nothing here can carry the URL.
    notifications: rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      channel: row.channel,
      eventType: row.event_type,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      title: row.title,
      body: row.body,
      state: row.state,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      expiresAt: row.expires_at,
      lastError: row.last_error,
      sentAt: row.sent_at,
      deviceInstanceId: row.device_instance_id,
    })),
  }
}

export function summariseNotifications(db: Database.Database, now: number) {
  const byState = db.prepare(
    'SELECT state, COUNT(*) AS n FROM notifications GROUP BY state'
  ).all() as Array<{ state: string; n: number }>

  const stateCounts: Record<string, number> = {}
  for (const row of byState) stateCounts[row.state] = row.n

  const recentFailures = db.prepare(`
    SELECT id, event_type, last_error, attempts, created_at
    FROM notifications
    WHERE state IN ('failed', 'dropped') AND last_error IS NOT NULL
    ORDER BY created_at DESC LIMIT 10
  `).all() as Array<Record<string, unknown>>

  return {
    stateCounts,
    recentFailures: recentFailures.map((f) => ({
      id: f.id,
      eventType: f.event_type,
      lastError: f.last_error,
      attempts: f.attempts,
      createdAt: f.created_at,
    })),
    generatedAt: now,
  }
}
