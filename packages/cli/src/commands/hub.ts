import {
  HUB_FORWARD_TOKEN_CREDENTIAL,
  loadConfig,
  loadCredential,
  saveConfig,
  saveCredential,
} from '../config.js'
import { readSecretLine, normalizeSecret } from '../secret-input.js'

/**
 * Point this machine at the one that collects everything.
 *
 * For a laptop that parses its own logs but should not be the one deciding
 * what to announce: it keeps running serve, and sends the machine that polls
 * quotas and holds the push subscriptions both its agent events and its usage
 * records. One destination for both, so there is one thing to set up and one
 * thing to check when nothing arrives.
 *
 * The token is read from stdin rather than argv, like the dashboard password:
 * it goes over the network on every hook and every upload, and it is what
 * lets a caller write into another machine's database.
 */

export interface HubResult {
  configured: boolean
  saved: boolean
  error?: string
}

export async function runSetHub(url: string): Promise<HubResult> {
  const trimmed = (url ?? '').trim()
  if (!trimmed) {
    console.error('A destination URL is required. Nothing was saved.')
    return { configured: false, saved: false, error: 'empty url' }
  }

  let origin: string
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      console.error('The URL must be http or https. Nothing was saved.')
      return { configured: false, saved: false, error: 'bad protocol' }
    }
    origin = parsed.origin
  } catch {
    console.error('That is not a URL. Nothing was saved.')
    console.error('Example: aiusage set-hub https://desktop-abc.tail1234.ts.net')
    return { configured: false, saved: false, error: 'bad url' }
  }

  const token = normalizeSecret(await readSecretLine("Receiving machine's ingest token: "))
  if (!token) {
    console.error('Nothing was entered. The forward is unchanged.')
    return { configured: false, saved: false, error: 'empty token' }
  }

  saveCredential(HUB_FORWARD_TOKEN_CREDENTIAL, token)
  const config = loadConfig() ?? {}
  config.hubForward = { ...config.hubForward, url: origin }
  saveConfig(config)

  console.log(`This machine now reports to ${origin}.`)
  console.log('Agent events go there as they happen; usage records are')
  console.log('uploaded in batches.')
  console.log('The token is stored with the other credentials (mode 0600) and is')
  console.log('never printed or returned by the API.')
  console.log('')
  console.log('serve on this machine keeps parsing local logs, and will no longer')
  console.log('drain the agent event spool — those events belong to the other')
  console.log('machine now, and the hook delivers them when it next succeeds.')
  console.log('Restart `aiusage serve` here for that to take effect.')
  return { configured: true, saved: true }
}

export function runHubStatus(): HubResult {
  const url = loadConfig()?.hubForward?.url?.trim()
  const token = loadCredential(HUB_FORWARD_TOKEN_CREDENTIAL)

  if (!url) {
    console.log('Hub: none. This machine keeps its own events and records.')
    return { configured: false, saved: false }
  }
  console.log(`Hub: ${url}`)
  if (!token) {
    // Without the token nothing is sent at all — events spool instead. Worth
    // saying outright, because the symptom is silence.
    console.log('  Token: MISSING. Nothing can be sent; events are being spooled.')
    console.log('  Set it with: aiusage set-hub <url>')
    return { configured: false, saved: false, error: 'no token' }
  }
  console.log('  Token: set.')
  return { configured: true, saved: false }
}

export function runClearHub(): HubResult {
  const config = loadConfig() ?? {}
  if (!config.hubForward?.url) {
    console.log('No hub was set. Nothing changed.')
    return { configured: false, saved: false }
  }
  delete config.hubForward
  saveConfig(config)
  // The credential is left in place on purpose: clearing the forward is
  // usually temporary, and a token nothing reads is inert.
  console.log('Hub cleared. This machine keeps its own events and records again.')
  console.log('Restart `aiusage serve` here so it drains the spool again.')
  return { configured: false, saved: true }
}
