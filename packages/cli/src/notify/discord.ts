import type Database from 'better-sqlite3'
import { renderDiscordContent } from '@aiusage/core'
import { DISCORD_WEBHOOK_CREDENTIAL, loadConfig, loadCredential } from '../config.js'
import {
  DISCORD_CHANNEL,
  claimPendingNotifications,
  markNotificationFailed,
  markNotificationSent,
  type NotificationRow,
} from '../db/notifications.js'

/**
 * Delivery of queued notifications.
 *
 * The rule that shapes this file: **the HTTP call never happens inside
 * runDbWrite**. That queue is serial and shared with the parser, the sync and
 * every other writer — one slow webhook would stall all of them. So each tick
 * is three steps: claim inside the queue, POST outside it, record the result
 * back inside it.
 */

const SEND_TIMEOUT_MS = 10_000

/** Per tick. Discord rate-limits webhooks, and there is no hurry. */
export const MAX_SENDS_PER_TICK = 5

export const SENDER_INTERVAL_MS = 5_000

/**
 * Strip anything URL-shaped from text destined for the database or a log.
 *
 * fetch failures quote the URL they were given, so an unmasked error message
 * is a webhook leak into a file the user may well paste somewhere.
 */
export function maskUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, '<url>')
}

export interface SendOutcome {
  id: string
  ok: boolean
  status?: number
  error?: string
  retryAfterMs?: number
  /** False for rate limiting: being asked to wait is not a failure. */
  countsAsAttempt?: boolean
}

/** POST one notification. Never throws; every failure becomes an outcome. */
export async function postToDiscord(webhook: string, row: NotificationRow): Promise<SendOutcome> {
  const content = renderDiscordContent({ title: row.title, body: row.body })

  let response: Response
  try {
    response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch (error) {
    return {
      id: row.id,
      ok: false,
      error: maskUrls(error instanceof Error ? error.message : String(error)),
    }
  }

  if (response.status === 429) {
    // Discord answers with how long to wait. Honour it and do not spend a
    // retry — nothing is wrong with the message.
    let retryAfterMs = 5_000
    try {
      const body = await response.json() as { retry_after?: number }
      if (typeof body.retry_after === 'number' && body.retry_after > 0) {
        // Seconds in the JSON body, milliseconds in some responses; treat a
        // small number as seconds.
        retryAfterMs = body.retry_after < 1000 ? body.retry_after * 1000 : body.retry_after
      }
    } catch {
      const header = Number(response.headers.get('retry-after'))
      if (Number.isFinite(header) && header > 0) retryAfterMs = header * 1000
    }
    return { id: row.id, ok: false, status: 429, error: 'rate limited', retryAfterMs, countsAsAttempt: false }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return {
      id: row.id,
      ok: false,
      status: response.status,
      error: maskUrls(`HTTP ${response.status}: ${body.slice(0, 200)}`),
    }
  }

  return { id: row.id, ok: true, status: response.status }
}

export interface SenderDeps {
  db: Database.Database
  runDbWrite: <T>(task: () => T | Promise<T>) => Promise<T>
  /** Skipping a tick during a parse: better-sqlite3 blocks the event loop. */
  isParseInFlight: () => boolean
  now?: () => number
}

export interface TickResult {
  claimed: number
  sent: number
  failed: number
  skipped: 'parse_in_flight' | 'no_webhook' | 'disabled' | null
}

/**
 * One pass of the sender. Exported so a test can drive it without a timer.
 */
export async function runNotificationTick(deps: SenderDeps): Promise<TickResult> {
  const now = deps.now ?? Date.now
  const result: TickResult = { claimed: 0, sent: 0, failed: 0, skipped: null }

  // A parse holds the event loop, so a fetch started now would time out
  // without ever being serviced. The next tick is five seconds away.
  if (deps.isParseInFlight()) return { ...result, skipped: 'parse_in_flight' }

  const config = loadConfig()
  if (config?.notifications?.enabled !== true) return { ...result, skipped: 'disabled' }

  /**
   * A missing webhook used to end the tick.
   *
   * That was fine while Discord was the only way out. Now it would mean that
   * someone who uses push and never set up Discord gets nothing, with
   * "no_webhook" as the only explanation — for a channel they are not using.
   * Each channel decides for itself whether it can send.
   */
  const webhook = loadCredential(DISCORD_WEBHOOK_CREDENTIAL)

  // 1. Claim, inside the write queue. Per channel, so one that cannot send
  //    does not hold the other's messages in 'sending' forever.
  const claimed = webhook
    ? await deps.runDbWrite(() =>
      claimPendingNotifications(deps.db, now(), MAX_SENDS_PER_TICK, DISCORD_CHANNEL))
    : []
  result.claimed = claimed.length
  if (claimed.length === 0) {
    return webhook ? result : { ...result, skipped: 'no_webhook' }
  }

  // 2. Send, outside it. Sequential rather than parallel: five concurrent
  //    POSTs to one webhook is the fastest way to get rate limited.
  const outcomes: SendOutcome[] = []
  for (const row of claimed) {
    // Non-null by construction: nothing was claimed without a webhook.
    outcomes.push(await postToDiscord(webhook as string, row))
  }

  // 3. Record, back inside the queue.
  await deps.runDbWrite(() => {
    for (const outcome of outcomes) {
      if (outcome.ok) {
        markNotificationSent(deps.db, outcome.id, now())
        result.sent++
      } else {
        markNotificationFailed(deps.db, outcome.id, outcome.error ?? 'unknown error', now(), {
          countsAsAttempt: outcome.countsAsAttempt,
          retryAfterMs: outcome.retryAfterMs,
        })
        result.failed++
      }
    }
  })

  return result
}

/**
 * Timer around runNotificationTick. Overlapping ticks are skipped rather than
 * queued: a slow webhook must not build a backlog of senders.
 */
export class NotificationSender {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false

  constructor(private readonly deps: SenderDeps, private readonly intervalMs = SENDER_INTERVAL_MS) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const result = await runNotificationTick(this.deps)
      if (result.sent > 0) console.log(`[serve] sent ${result.sent} notification(s)`)
      if (result.failed > 0) console.warn(`[serve] ${result.failed} notification(s) failed to send`)
    } catch (err) {
      // Masked: an error from this path can quote the webhook URL.
      console.error('[serve] notification sender failed:', maskUrls(String(err)))
    } finally {
      this.inFlight = false
    }
  }
}
