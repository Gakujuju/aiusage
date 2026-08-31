import {
  createCipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as signWith,
  verify as verifyWith,
} from 'node:crypto'

/**
 * Web Push, from the specifications, using nothing but node:crypto.
 *
 * Two things are needed to push a message: a VAPID token that identifies this
 * server to the push service (RFC 8292), and a payload only the subscriber's
 * browser can read (RFC 8291). Neither has changed since 2017.
 *
 * Written here rather than taken from a package because the CLI is published
 * to npm — every dependency is one that everybody installing aiusage
 * installs — and because the arithmetic is checkable: RFC 8291 §5 fixes every
 * input including the salt and the ephemeral key, so the correct output is a
 * known constant. The test asserts that constant. Cryptography that is wrong
 * usually still runs, so "it produced some bytes" is not evidence of anything;
 * this is the only kind of evidence there is.
 */

/** Base64url without padding, which is what every field in these specs uses. */
function b64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url. Handed to the browser. */
  publicKey: string
  /** Raw scalar, base64url. Never leaves the machine. */
  privateKey: string
}

/** A fresh application-server identity. */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  // The last 65 bytes of the SPKI encoding are the uncompressed point.
  const publicDer = publicKey.export({ type: 'spki', format: 'der' })
  const privateJwk = privateKey.export({ format: 'jwk' }) as { d?: string }
  if (!privateJwk.d) throw new Error('generated key has no private scalar')
  return {
    publicKey: b64url(publicDer.subarray(publicDer.length - 65)),
    privateKey: privateJwk.d,
  }
}

/** The public half of a stored private key, for checking a pair matches. */
export function vapidPublicKeyFrom(privateKeyB64: string): string {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(fromB64url(privateKeyB64))
  return b64url(ecdh.getPublicKey())
}

export interface VapidTokenInput {
  /** Scheme and host of the push endpoint — not the full URL. */
  audience: string
  /** How this server can be contacted, per RFC 8292 §2.1. */
  subject: string
  privateKey: string
  publicKey: string
  now?: number
  /** Seconds. The spec caps this at 24 hours. */
  ttlSeconds?: number
}

/** RFC 8292 allows at most 24 hours; 12 leaves room for a slow clock. */
export const VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60

/**
 * The `Authorization: vapid t=<jwt>, k=<publicKey>` value.
 *
 * The signature has to be the raw r||s pair rather than the DER structure
 * OpenSSL produces by default — JWS says so, and a DER signature is silently
 * rejected by the push service with no clue as to why. Node will emit the
 * raw form directly when asked.
 */
export function buildVapidAuthorization(input: VapidTokenInput): string {
  const now = Math.floor((input.now ?? Date.now()) / 1000)
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = b64url(Buffer.from(JSON.stringify({
    aud: input.audience,
    exp: now + (input.ttlSeconds ?? VAPID_TOKEN_TTL_SECONDS),
    sub: input.subject,
  })))
  const signingInput = `${header}.${payload}`

  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: input.privateKey,
      // The public half is part of the JWK even when only signing.
      x: b64url(fromB64url(input.publicKey).subarray(1, 33)),
      y: b64url(fromB64url(input.publicKey).subarray(33, 65)),
    },
    format: 'jwk',
  })

  const signature = signWith('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  })

  return `vapid t=${signingInput}.${b64url(signature)}, k=${input.publicKey}`
}

/** Verifies a token this module produced. Only the tests need it. */
export function verifyVapidSignature(authorization: string, publicKeyB64: string): boolean {
  const token = /vapid t=([^,]+)/.exec(authorization)?.[1]
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const raw = fromB64url(publicKeyB64)
  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(raw.subarray(1, 33)),
      y: b64url(raw.subarray(33, 65)),
    },
    format: 'jwk',
  })
  return verifyWith(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: 'ieee-p1363' },
    fromB64url(parts[2]),
  )
}

export interface PushSubscriptionKeys {
  /** The subscriber's public key, uncompressed P-256, base64url. */
  p256dh: string
  /** The subscriber's authentication secret, base64url. */
  auth: string
}

export interface EncryptOptions {
  /** Fixed only by the tests, so the RFC's worked example can be reproduced. */
  salt?: Buffer
  senderPrivateKey?: Buffer
}

/**
 * The `aes128gcm` body of a push message (RFC 8291, framed by RFC 8188).
 *
 * The shape is: derive a shared secret with the subscriber, mix it with their
 * auth secret to get the input keying material, then derive a content key and
 * a nonce from a random salt. The body carries the salt and the sender's
 * ephemeral public key in front of the ciphertext, so the browser can repeat
 * the derivation.
 */
export function encryptPushPayload(
  plaintext: Buffer | string,
  keys: PushSubscriptionKeys,
  options: EncryptOptions = {},
): Buffer {
  const message = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf-8') : plaintext
  const subscriberKey = fromB64url(keys.p256dh)
  const authSecret = fromB64url(keys.auth)
  const salt = options.salt ?? randomBytes(16)

  const ecdh = createECDH('prime256v1')
  if (options.senderPrivateKey) ecdh.setPrivateKey(options.senderPrivateKey)
  else ecdh.generateKeys()
  const senderPublicKey = ecdh.getPublicKey()
  const sharedSecret = ecdh.computeSecret(subscriberKey)

  // RFC 8291 §3.3. Both public keys are bound into the info string so that a
  // key swapped in transit produces a different secret rather than a working
  // one.
  const ikm = Buffer.from(hkdfSync(
    'sha256',
    sharedSecret,
    authSecret,
    Buffer.concat([
      Buffer.from('WebPush: info\0', 'ascii'),
      subscriberKey,
      senderPublicKey,
    ]),
    32,
  ))

  const contentKey = Buffer.from(hkdfSync(
    'sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16,
  ))
  const nonce = Buffer.from(hkdfSync(
    'sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12,
  ))

  // One record, so the delimiter is 0x02 (RFC 8188 §2). A 0x01 here would say
  // "more records follow" and the browser would wait for them.
  const padded = Buffer.concat([message, Buffer.from([0x02])])
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()])

  // RFC 8188 §2.1: salt | record size | key id length | key id | ciphertext
  const preamble = Buffer.alloc(5)
  preamble.writeUInt32BE(4096, 0)
  preamble.writeUInt8(senderPublicKey.length, 4)

  return Buffer.concat([salt, preamble, senderPublicKey, ciphertext])
}

/** Scheme and host of an endpoint, which is what the VAPID audience is. */
export function audienceFor(endpoint: string): string {
  const url = new URL(endpoint)
  return `${url.protocol}//${url.host}`
}

/** A stable id for a subscription, so re-subscribing updates rather than duplicates. */
export function subscriptionId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16)
}
