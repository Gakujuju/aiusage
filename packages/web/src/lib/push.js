/**
 * Web Push, from the browser's side.
 *
 * The permission prompt is never raised from here on its own. Every function
 * that can trigger one is called from a click handler, because a prompt that
 * appears because a page loaded is the fastest way to have push denied
 * permanently for the origin — and "denied" is not something a site can undo.
 */

/**
 * base64url → Uint8Array, for `applicationServerKey`.
 *
 * The subscribe call will not take the string form. atob wants standard
 * base64 with padding, so both are restored first.
 */
/** @param {string} value */
export function decodeBase64Url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** Uint8Array → base64url, for the keys we hand back to the server. */
/** @param {ArrayBuffer} buffer */
function encodeBase64Url(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * What this browser can do, without asking it for anything.
 *
 * `permission` is read, not requested — reading never prompts.
 */
export function pushSupport() {
  if (typeof window === 'undefined') return { supported: false, permission: 'default' }
  const supported = 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
  return {
    supported,
    permission: supported ? Notification.permission : 'default',
    /**
     * iOS only allows push from a home-screen app. Reported separately
     * because "not supported" there is a thing the user can fix, and the
     * settings screen should say how rather than just refusing.
     */
    standalone: typeof window.matchMedia === 'function'
      && window.matchMedia('(display-mode: standalone)').matches,
  }
}

/** The subscription this browser already holds, if any. */
export async function currentSubscription() {
  if (!pushSupport().supported) return null
  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration) return null
  return registration.pushManager.getSubscription()
}

/**
 * Ask for permission and subscribe. Must be called from a user gesture.
 *
 * Returns the shape /api/push/subscribe expects. Throws with a reason the
 * settings screen can show — including for "denied", which otherwise looks
 * exactly like a silent failure.
 */
/** @param {string} publicKey */
export async function subscribeToPush(publicKey) {
  const support = pushSupport()
  if (!support.supported) throw new Error('unsupported')

  const registration = await navigator.serviceWorker.ready

  // An existing subscription made against a different key would be rejected
  // at delivery time with no sign here, so it is replaced rather than reused.
  const existing = await registration.pushManager.getSubscription()
  if (existing) {
    const same = existing.options?.applicationServerKey
      && encodeBase64Url(existing.options.applicationServerKey) === publicKey
    if (same) return serialiseSubscription(existing)
    await existing.unsubscribe().catch(() => undefined)
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'denied' : 'dismissed')

  const subscription = await registration.pushManager.subscribe({
    // Required by every current implementation; a push that could be sent by
    // anyone who learned the endpoint is not something to offer.
    userVisibleOnly: true,
    applicationServerKey: decodeBase64Url(publicKey),
  })
  return serialiseSubscription(subscription)
}

/** PushSubscription → plain JSON, with the keys base64url encoded. */
/** @param {PushSubscription} subscription */
function serialiseSubscription(subscription) {
  const p256dh = subscription.getKey('p256dh')
  const auth = subscription.getKey('auth')
  if (!p256dh || !auth) throw new Error('no_keys')
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: encodeBase64Url(p256dh), auth: encodeBase64Url(auth) },
  }
}

/** Drop this browser's subscription locally. The server row is deleted separately. */
export async function unsubscribeLocally() {
  const subscription = await currentSubscription()
  if (!subscription) return false
  return subscription.unsubscribe().catch(() => false)
}

/**
 * The id the server will have given this browser's subscription.
 *
 * Derived the same way on both sides — sha256 of the endpoint, first 16 hex
 * characters — so the device list can mark "this device" without the server
 * ever returning an endpoint, and without anything being remembered locally.
 *
 * Requires a secure context, but so do service workers and push, so anything
 * that reaches this point already has one.
 */
export async function localSubscriptionId() {
  const subscription = await currentSubscription()
  if (!subscription) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
