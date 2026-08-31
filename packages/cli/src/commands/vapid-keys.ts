import {
  DEFAULT_VAPID_SUBJECT,
  VAPID_PRIVATE_KEY_CREDENTIAL,
  loadConfig,
  loadCredential,
  saveConfig,
  saveCredential,
} from '../config.js'
import { generateVapidKeys, vapidPublicKeyFrom } from '../notify/webpush-crypto.js'

/**
 * Create this server's Web Push identity, once.
 *
 * The key pair is what every browser subscription is registered against at
 * the push service. Replacing it does not migrate them — it orphans them:
 * every existing subscription keeps working from the browser's point of view
 * and silently stops being deliverable from ours. So a second run refuses
 * unless told in as many words to do it anyway.
 */
export function runGenerateVapidKeys(options: { force?: boolean } = {}): void {
  const existingPrivate = loadCredential(VAPID_PRIVATE_KEY_CREDENTIAL)
  const config = loadConfig() ?? {}
  const existingPublic = config.vapid?.publicKey

  if (existingPrivate && existingPublic && !options.force) {
    console.log('VAPID keys already exist. Nothing changed.')
    console.log(`  public key: ${existingPublic}`)
    console.log('')
    console.log('Replacing them invalidates every push subscription already')
    console.log('registered — each device would have to subscribe again, and')
    console.log('nothing would tell them to. Pass --force if that is intended.')
    return
  }

  if (options.force && existingPrivate) {
    console.warn('Replacing the existing VAPID keys. Every current push subscription')
    console.warn('becomes undeliverable and each device must subscribe again.')
  }

  const keys = generateVapidKeys()
  saveCredential(VAPID_PRIVATE_KEY_CREDENTIAL, keys.privateKey)
  const next = loadConfig() ?? {}
  next.vapid = {
    ...next.vapid,
    publicKey: keys.publicKey,
    subject: next.vapid?.subject ?? DEFAULT_VAPID_SUBJECT,
  }
  saveConfig(next)

  // Read it back through the same path the sender uses, so a mistake in
  // storage shows up here rather than as notifications that never arrive.
  const stored = loadCredential(VAPID_PRIVATE_KEY_CREDENTIAL)
  const derived = stored ? vapidPublicKeyFrom(stored) : null
  if (derived !== keys.publicKey) {
    console.error('The stored private key does not match the public key that was saved.')
    console.error('Push would fail silently. Not proceeding.')
    process.exitCode = 1
    return
  }

  console.log('VAPID keys generated.')
  console.log(`  public key: ${keys.publicKey}`)
  console.log(`  subject   : ${next.vapid.subject}`)
  console.log('')
  console.log('The private key is stored with the other credentials and is never')
  console.log('returned by the API. The subject is sent to the push service on')
  console.log('every delivery; it defaults to the repository rather than an email')
  console.log('address, and can be changed in Settings.')
}
