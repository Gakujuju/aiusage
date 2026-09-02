import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The dashboard password, kept where this project keeps its secrets.
 *
 * `~/.aiusage/config.json` under `credentials`, mode 0600 - the same file and
 * the same shape the CLI uses for the webhook URL and the hub's ingest token.
 * A second store would be a second thing to find, protect and remember to
 * clear.
 *
 * ── What this widens ─────────────────────────────────────────────────────
 *
 * This machine already holds a token that can write to the hub. This adds
 * one that can read it, and the two are not mirror images.
 *
 * The hub runs with includeAssistantMessage: true, so a notification body
 * carries an excerpt of what the assistant said - for all three machines.
 * What this password opens is therefore not usage figures and cost. It is
 * the content of the work: what was being built, on which project, in whose
 * words. And the direction reverses. Until now this machine sent its own
 * work to the hub; from here the hub's collected work, from every machine,
 * comes back to this one.
 *
 * It grants no writes. That part is unchanged: reading the dashboard is not
 * enough to put anything into it.
 */
const AIUSAGE_DIR = join(homedir(), '.aiusage')
const CONFIG_PATH = join(AIUSAGE_DIR, 'config.json')

export const HUB_PASSWORD_CREDENTIAL = 'hubDashboardPassword'

/**
 * The password this machine's own serve checks, which the CLI already keeps
 * here in plain text.
 */
const OWN_DASHBOARD_PASSWORD = 'dashboardPassword'

function readConfig(): Record<string, unknown> {
  try {
    if (!existsSync(CONFIG_PATH)) return {}
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    /*
     * A config file that will not parse is the CLI's business, not this
     * widget's. Treating it as empty means the widget asks for a password it
     * may already have; overwriting it would lose someone's webhook.
     */
    return {}
  }
}

export function loadCredential(key: string): string | null {
  const credentials = readConfig().credentials
  if (!credentials || typeof credentials !== 'object') return null
  const value = (credentials as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function saveCredential(key: string, value: string): void {
  const config = readConfig()
  const credentials = (config.credentials && typeof config.credentials === 'object'
    ? config.credentials
    : {}) as Record<string, unknown>
  credentials[key] = value
  config.credentials = credentials

  mkdirSync(AIUSAGE_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
  try {
    chmodSync(CONFIG_PATH, 0o600)
  } catch {
    // Windows ignores the mode; the ACL on the user's profile is the guard.
  }
}

/**
 * The password to log in to a particular hub with.
 *
 * Two places, and the order matters. A password typed into the widget is for
 * the hub it names, so it wins. Failing that, and only when the hub is this
 * machine, the password this machine's own serve checks will do - it is
 * already on this disk, put there by the CLI, and asking someone to type
 * their own password back to their own machine is theatre.
 *
 * The fallback is deliberately not used for a remote hub. The password on a
 * spoke is that spoke's own; sending it to another machine would be
 * offering a secret to something that never asked for it.
 */
export function resolveHubPassword(hubUrl: string): string | null {
  const typed = loadCredential(HUB_PASSWORD_CREDENTIAL)
  if (typed) return typed
  return isThisMachine(hubUrl) ? loadCredential(OWN_DASHBOARD_PASSWORD) : null
}

function isThisMachine(hubUrl: string): boolean {
  try {
    const { hostname } = new URL(hubUrl)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}
