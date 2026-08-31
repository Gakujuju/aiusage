import type Database from 'better-sqlite3'
import { subscriptionId } from '../notify/webpush-crypto.js'

/**
 * The browsers that asked to be told.
 *
 * Two shapes leave this module. The full row, with the subscriber's keys, is
 * for the sender alone. The summary is what the API and the settings page
 * see: enough to recognise a device and to notice one that has stopped
 * working, and nothing that could be used to push to it.
 */

export interface PushSubscriptionRow {
  id: string
  endpoint: string
  p256dh: string
  auth: string
  label: string
  user_agent: string
  device_instance_id: string
  created_at: number
  last_success_at: number | null
  last_error: string | null
  consecutive_failures: number
}

/** What may be shown. No endpoint, no keys. */
export interface PushSubscriptionSummary {
  id: string
  label: string
  createdAt: number
  lastSuccessAt: number | null
  consecutiveFailures: number
}

export interface SaveSubscriptionInput {
  endpoint: string
  p256dh: string
  auth: string
  label?: string
  userAgent?: string
  deviceInstanceId?: string
}

/**
 * Remember a subscription, or refresh one already known.
 *
 * A browser re-subscribes on its own — after clearing site data, or when the
 * push service rotates the endpoint — and the id is derived from the endpoint
 * so the same browser lands on the same row. The failure counter resets:
 * whatever went wrong before, this is a fresh registration saying otherwise.
 */
export function savePushSubscription(
  db: Database.Database,
  input: SaveSubscriptionInput,
  now: number,
): string {
  const id = subscriptionId(input.endpoint)
  db.prepare(`
    INSERT INTO push_subscriptions (
      id, endpoint, p256dh, auth, label, user_agent, device_instance_id,
      created_at, last_success_at, last_error, consecutive_failures
    ) VALUES (
      @id, @endpoint, @p256dh, @auth, @label, @userAgent, @deviceInstanceId,
      @now, NULL, NULL, 0
    )
    ON CONFLICT(id) DO UPDATE SET
      endpoint             = excluded.endpoint,
      p256dh               = excluded.p256dh,
      auth                 = excluded.auth,
      label                = CASE WHEN excluded.label != '' THEN excluded.label ELSE label END,
      user_agent           = excluded.user_agent,
      device_instance_id   = excluded.device_instance_id,
      last_error           = NULL,
      consecutive_failures = 0
  `).run({
    id,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    label: input.label ?? '',
    userAgent: input.userAgent ?? '',
    deviceInstanceId: input.deviceInstanceId ?? '',
    now,
  })
  return id
}

/** Everything the sender needs, keys included. Never serialise this. */
export function listPushSubscriptions(db: Database.Database): PushSubscriptionRow[] {
  return db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all() as PushSubscriptionRow[]
}

/** What the API may return. */
export function summarisePushSubscriptions(db: Database.Database): PushSubscriptionSummary[] {
  const rows = db.prepare(`
    SELECT id, label, created_at, last_success_at, consecutive_failures
    FROM push_subscriptions ORDER BY created_at
  `).all() as Array<{
    id: string
    label: string
    created_at: number
    last_success_at: number | null
    consecutive_failures: number
  }>
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
    consecutiveFailures: row.consecutive_failures,
  }))
}

/** True when a row was actually removed. */
export function deletePushSubscription(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id).changes > 0
}

export function deletePushSubscriptionByEndpoint(db: Database.Database, endpoint: string): boolean {
  return deletePushSubscription(db, subscriptionId(endpoint))
}

export function markPushSuccess(db: Database.Database, id: string, now: number): void {
  db.prepare(`
    UPDATE push_subscriptions
    SET last_success_at = ?, last_error = NULL, consecutive_failures = 0
    WHERE id = ?
  `).run(now, id)
}

/**
 * Record a failure without giving up on the subscription.
 *
 * Deleting on a transient failure loses the registration silently: the person
 * stops being told, and nothing on the page says why or offers to fix it.
 * Only the push service saying the subscription is gone — 404 or 410 — is
 * grounds for removal, and that is the caller's decision, not this one's.
 */
export function markPushFailure(
  db: Database.Database,
  id: string,
  error: string,
  now: number,
): void {
  db.prepare(`
    UPDATE push_subscriptions
    SET last_error = ?, consecutive_failures = consecutive_failures + 1, last_success_at = last_success_at
    WHERE id = ?
  `).run(error.slice(0, 500), id)
  void now
}

/**
 * How many browsers are registered.
 *
 * Separate from listPushSubscriptions because the caller that needs this is
 * the enqueue path, which runs on every status change and has no business
 * loading every subscriber's keys to find out whether the number is zero.
 */
export function countPushSubscriptions(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n
}
