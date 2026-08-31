import {
  audienceFor,
  buildVapidAuthorization,
  encryptPushPayload,
} from './webpush-crypto.js'
import type { PushSubscriptionRow } from '../db/push-subscriptions.js'

/**
 * Delivery, as distinct from the arithmetic in webpush-crypto.
 *
 * One notification goes to every browser that asked for it, and each of those
 * deliveries succeeds or fails on its own. A phone that has cleared its site
 * data must not stop a laptop from being told.
 */

/**
 * Push services reject bodies over 4096 bytes. Going over is our mistake, not
 * the subscriber's, so the message is cut here rather than discovered as a
 * 413 after the fact.
 */
export const MAX_PUSH_PAYLOAD_BYTES = 3800

/** How long the push service should hold the message for a phone that is off. */
const PUSH_TTL_SECONDS = 15 * 60

export interface PushMessage {
  title: string
  body: string
  /** Groups notifications about the same thing so they replace each other. */
  tag: string
  /** Read by the service worker to decide where a tap goes. */
  subjectKind: string
}

export interface PushDeliveryResult {
  subscriptionId: string
  ok: boolean
  status?: number
  error?: string
  /**
   * The push service says this subscription no longer exists. The only
   * outcome that justifies deleting it.
   */
  gone: boolean
}

export interface PushSenderConfig {
  privateKey: string
  publicKey: string
  subject: string
}

/**
 * Trim a message to fit, without producing something that reads as truncated
 * by accident. The body goes first — a title with no body is still useful,
 * a body with no title is not.
 */
export function buildPushPayload(message: PushMessage): string {
  const encode = (value: PushMessage) => JSON.stringify(value)
  let candidate = { ...message }
  if (Buffer.byteLength(encode(candidate)) <= MAX_PUSH_PAYLOAD_BYTES) return encode(candidate)

  // Binary search on the body length in characters; byte length is what
  // matters and Japanese is three bytes a character.
  let low = 0
  let high = candidate.body.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const trial = { ...candidate, body: candidate.body.slice(0, mid) + '…' }
    if (Buffer.byteLength(encode(trial)) <= MAX_PUSH_PAYLOAD_BYTES) low = mid
    else high = mid - 1
  }
  candidate = { ...candidate, body: candidate.body.slice(0, low) + '…' }
  if (Buffer.byteLength(encode(candidate)) <= MAX_PUSH_PAYLOAD_BYTES) return encode(candidate)

  // Nothing left to give: the title alone is over the limit, which means
  // something upstream is very wrong. Send what fits and let it be visible.
  return encode({ ...candidate, body: '', title: candidate.title.slice(0, 200) })
}

/** Deliver to one subscription. Never throws; the outcome is the return value. */
export async function sendPushTo(
  subscription: PushSubscriptionRow,
  message: PushMessage,
  config: PushSenderConfig,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<PushDeliveryResult> {
  try {
    const body = encryptPushPayload(
      buildPushPayload(message),
      { p256dh: subscription.p256dh, auth: subscription.auth },
    )

    const response = await fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        // Only the origin. The endpoint path is a bearer secret for this
        // subscription and has no business in a token sent to a third party.
        Authorization: buildVapidAuthorization({
          audience: audienceFor(subscription.endpoint),
          subject: config.subject,
          privateKey: config.privateKey,
          publicKey: config.publicKey,
          now,
        }),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: 'normal',
      },
      body: new Uint8Array(body),
    })

    if (response.ok) {
      return { subscriptionId: subscription.id, ok: true, status: response.status, gone: false }
    }

    // 404 and 410 mean the subscription is permanently gone. Everything else
    // — rate limits, outages, our own bad request — is a reason to try later,
    // not a reason to forget the device.
    const gone = response.status === 404 || response.status === 410
    return {
      subscriptionId: subscription.id,
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      gone,
    }
  } catch (error) {
    // A network failure says nothing about whether the subscription is valid.
    return {
      subscriptionId: subscription.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      gone: false,
    }
  }
}

/**
 * Deliver to all of them.
 *
 * Sequential rather than parallel, matching the Discord sender: a handful of
 * subscriptions is not worth the concurrency, and one slow endpoint holding
 * up the others is preferable to being rate limited by all of them at once.
 */
export async function sendPushToAll(
  subscriptions: readonly PushSubscriptionRow[],
  message: PushMessage,
  config: PushSenderConfig,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<PushDeliveryResult[]> {
  const results: PushDeliveryResult[] = []
  for (const subscription of subscriptions) {
    results.push(await sendPushTo(subscription, message, config, fetchImpl, now))
  }
  return results
}
