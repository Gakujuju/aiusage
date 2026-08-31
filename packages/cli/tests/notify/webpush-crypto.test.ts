import { describe, it, expect } from 'vitest'
import {
  audienceFor,
  buildVapidAuthorization,
  encryptPushPayload,
  generateVapidKeys,
  subscriptionId,
  vapidPublicKeyFrom,
  verifyVapidSignature,
  VAPID_TOKEN_TTL_SECONDS,
} from '../../src/notify/webpush-crypto.js'

/**
 * Cryptography that is wrong still runs. It produces bytes, the function
 * returns, nothing throws — and the notification simply never arrives, with
 * no way to tell a broken cipher from a broken network.
 *
 * So the test is not "does it produce output". RFC 8291 §5 fixes every input
 * of a worked example, including the salt and the sender's ephemeral key, so
 * the correct output is a published constant. Reproducing it byte for byte is
 * the only real evidence the implementation is right.
 */

// ── RFC 8291 §5, verbatim from the RFC ─────────────────────────────────────
// https://www.rfc-editor.org/rfc/rfc8291#section-5
const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  senderPrivateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

const b64 = (value: string) => Buffer.from(value, 'base64url')

describe('payload encryption (RFC 8291)', () => {
  it('reproduces the RFC 8291 §5 example byte for byte', () => {
    const encrypted = encryptPushPayload(
      RFC8291.plaintext,
      { p256dh: RFC8291.p256dh, auth: RFC8291.auth },
      { salt: b64(RFC8291.salt), senderPrivateKey: b64(RFC8291.senderPrivateKey) },
    )
    expect(encrypted.toString('base64url')).toBe(RFC8291.body)
  })

  it('derives the sender public key the RFC expects from that private key', () => {
    // If this fails the shared secret is wrong, and every message would be
    // undecryptable in a way that looks exactly like a delivery failure.
    expect(vapidPublicKeyFrom(RFC8291.senderPrivateKey)).toBe(RFC8291.senderPublicKey)
  })

  it('lays the body out as salt, record size, key length, key, ciphertext', () => {
    const encrypted = encryptPushPayload(
      RFC8291.plaintext,
      { p256dh: RFC8291.p256dh, auth: RFC8291.auth },
      { salt: b64(RFC8291.salt), senderPrivateKey: b64(RFC8291.senderPrivateKey) },
    )
    expect(encrypted.subarray(0, 16).toString('base64url')).toBe(RFC8291.salt)
    expect(encrypted.readUInt32BE(16)).toBe(4096)
    expect(encrypted.readUInt8(20)).toBe(65)
    expect(encrypted.subarray(21, 86).toString('base64url')).toBe(RFC8291.senderPublicKey)
  })

  it('uses a fresh salt and ephemeral key each time', () => {
    // Reusing either with the same subscriber leaks the plaintext relationship
    // between two messages.
    const keys = { p256dh: RFC8291.p256dh, auth: RFC8291.auth }
    const first = encryptPushPayload('same message', keys)
    const second = encryptPushPayload('same message', keys)
    expect(first.equals(second)).toBe(false)
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false)
  })

  it('grows with the message rather than truncating it', () => {
    const keys = { p256dh: RFC8291.p256dh, auth: RFC8291.auth }
    const short = encryptPushPayload('x', keys)
    const long = encryptPushPayload('x'.repeat(1000), keys)
    expect(long.length - short.length).toBe(999)
  })
})

describe('VAPID (RFC 8292)', () => {
  const keys = generateVapidKeys()

  function authorization(overrides: Partial<Parameters<typeof buildVapidAuthorization>[0]> = {}) {
    return buildVapidAuthorization({
      audience: 'https://fcm.googleapis.com',
      subject: 'https://github.com/Gakujuju/aiusage',
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      ...overrides,
    })
  }

  it('signs with a raw r||s pair, not DER', () => {
    // JWS requires the raw pair. A DER signature is rejected by the push
    // service with no diagnostic, which is a long afternoon to debug.
    const token = /vapid t=([^,]+)/.exec(authorization())![1]
    const signature = Buffer.from(token.split('.')[2], 'base64url')
    expect(signature.length).toBe(64)
  })

  it('verifies against its own public key', () => {
    expect(verifyVapidSignature(authorization(), keys.publicKey)).toBe(true)
  })

  it('does not verify against a different key', () => {
    expect(verifyVapidSignature(authorization(), generateVapidKeys().publicKey)).toBe(false)
  })

  it('carries the public key alongside the token, as the header requires', () => {
    expect(authorization()).toContain(`k=${keys.publicKey}`)
  })

  it('expires in the future and inside the 24 hours the spec allows', () => {
    const now = Date.UTC(2026, 0, 1)
    const token = /vapid t=([^,]+)/.exec(authorization({ now }))![1]
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    const seconds = Math.floor(now / 1000)
    expect(payload.exp).toBeGreaterThan(seconds)
    expect(payload.exp - seconds).toBeLessThanOrEqual(24 * 60 * 60)
    expect(VAPID_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(24 * 60 * 60)
  })

  it('sends only the origin as the audience, never the whole endpoint', () => {
    // The endpoint path is a bearer secret for that subscription. It has no
    // business in a token handed to a third party.
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123-secret-token'
    expect(audienceFor(endpoint)).toBe('https://fcm.googleapis.com')
    const token = /vapid t=([^,]+)/.exec(authorization({ audience: audienceFor(endpoint) }))![1]
    expect(token).not.toContain('abc123')
  })

  it('generates a usable pair', () => {
    const fresh = generateVapidKeys()
    expect(Buffer.from(fresh.publicKey, 'base64url').length).toBe(65)
    expect(vapidPublicKeyFrom(fresh.privateKey)).toBe(fresh.publicKey)
  })
})

describe('subscriptionId', () => {
  it('is stable for the same endpoint', () => {
    // Re-subscribing the same browser yields the same endpoint, and must
    // update the row rather than add a second one that also gets sent to.
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc'
    expect(subscriptionId(endpoint)).toBe(subscriptionId(endpoint))
  })

  it('differs between endpoints', () => {
    expect(subscriptionId('https://a.example/1')).not.toBe(subscriptionId('https://a.example/2'))
  })
})
