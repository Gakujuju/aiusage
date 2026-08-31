import type Database from 'better-sqlite3'
import {
  claimPendingNotifications,
  markNotificationFailed,
  markNotificationSent,
  WEBPUSH_CHANNEL,
} from '../db/notifications.js'
import {
  deletePushSubscription,
  listPushSubscriptions,
  markPushFailure,
  markPushSuccess,
} from '../db/push-subscriptions.js'
import { loadConfig, loadCredential, DEFAULT_VAPID_SUBJECT, VAPID_PRIVATE_KEY_CREDENTIAL } from '../config.js'
import { sendPushToAll } from './webpush.js'

/**
 * The push half of the outbox, alongside the Discord half.
 *
 * Same shape as runNotificationTick: claim inside the write queue, send
 * outside it, record inside it again. Kept in its own file because the two
 * channels share the decision that produced the rows and nothing else — a
 * webhook that is not configured has no bearing on whether a phone can be
 * reached, and the previous single tick made it so.
 */

export interface PushTickDeps {
  db: Database.Database
  runDbWrite: <T>(fn: () => T) => Promise<T>
  isParseInFlight: () => boolean
  now?: () => number
  fetchImpl?: typeof fetch
}

export interface PushTickResult {
  claimed: number
  sent: number
  failed: number
  /** Subscriptions the push service said no longer exist. */
  pruned: number
  skipped: string | null
}

const MAX_SENDS_PER_TICK = 5

export async function runPushNotificationTick(deps: PushTickDeps): Promise<PushTickResult> {
  const now = deps.now ?? Date.now
  const result: PushTickResult = { claimed: 0, sent: 0, failed: 0, pruned: 0, skipped: null }

  // better-sqlite3 holds the loop during a parse, so a fetch started now would
  // time out without ever being serviced.
  if (deps.isParseInFlight()) return { ...result, skipped: 'parse_in_flight' }

  const config = loadConfig()
  if (config?.notifications?.enabled !== true) return { ...result, skipped: 'disabled' }
  if (config?.notifications?.channels?.webpush !== true) return { ...result, skipped: 'channel_off' }

  const privateKey = loadCredential(VAPID_PRIVATE_KEY_CREDENTIAL)
  const publicKey = config?.vapid?.publicKey
  if (!privateKey || !publicKey) return { ...result, skipped: 'no_vapid_key' }

  const subscriptions = listPushSubscriptions(deps.db)
  if (subscriptions.length === 0) return { ...result, skipped: 'no_subscriptions' }

  const claimed = await deps.runDbWrite(() =>
    claimPendingNotifications(deps.db, now(), MAX_SENDS_PER_TICK, WEBPUSH_CHANNEL))
  result.claimed = claimed.length
  if (claimed.length === 0) return result

  const sender = {
    privateKey,
    publicKey,
    subject: config?.vapid?.subject?.trim() || DEFAULT_VAPID_SUBJECT,
  }

  const outcomes: Array<{
    id: string
    ok: boolean
    error: string | null
    gone: string[]
    delivered: string[]
    failedTo: Array<{ id: string; error: string }>
  }> = []

  for (const row of claimed) {
    const results = await sendPushToAll(subscriptions, {
      title: row.title,
      body: row.body,
      // One notification per subject: a session that changes twice replaces
      // its own notification rather than stacking a second one behind it.
      tag: `${row.subject_kind}:${row.subject_id}`,
      subjectKind: row.subject_kind,
    }, sender, deps.fetchImpl ?? fetch, now())

    const delivered = results.filter((r) => r.ok).map((r) => r.subscriptionId)
    const gone = results.filter((r) => r.gone).map((r) => r.subscriptionId)
    const failedTo = results
      .filter((r) => !r.ok && !r.gone)
      .map((r) => ({ id: r.subscriptionId, error: r.error ?? 'unknown error' }))

    outcomes.push({
      id: row.id,
      /**
       * One delivery is enough to call the notification sent.
       *
       * The alternative — failing the row because one of three devices is
       * unreachable — would retry it and notify the other two again. A
       * duplicate on two phones is worse than a gap on the one that is off.
       */
      ok: delivered.length > 0,
      error: delivered.length > 0
        ? null
        : (failedTo[0]?.error ?? (gone.length > 0 ? 'all subscriptions gone' : 'no subscriptions')),
      gone,
      delivered,
      failedTo,
    })
  }

  await deps.runDbWrite(() => {
    for (const outcome of outcomes) {
      if (outcome.ok) {
        markNotificationSent(deps.db, outcome.id, now())
        result.sent++
      } else {
        markNotificationFailed(deps.db, outcome.id, outcome.error ?? 'unknown error', now())
        result.failed++
      }
      for (const id of outcome.delivered) markPushSuccess(deps.db, id, now())
      for (const failure of outcome.failedTo) markPushFailure(deps.db, failure.id, failure.error, now())
      // 404 and 410 are the push service saying this registration no longer
      // exists. Nothing will ever be delivered to it again, so it goes.
      for (const id of outcome.gone) {
        if (deletePushSubscription(deps.db, id)) result.pruned++
      }
    }
  })

  return result
}
