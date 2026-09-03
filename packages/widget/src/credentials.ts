import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { readConfigFile } from './hub-url'
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

/**
 * @throws ConfigUnreadableError when config.json is present and will not parse.
 *
 * It used to return {} for that, with a comment saying overwriting the file
 * would lose someone's webhook - which is exactly what happened next, because
 * saveCredential writes back whatever this returns. An empty object plus one
 * credential replaced the real file.
 *
 * The other half of the same bug is quieter: loadCredential answered "no
 * password saved" for a file that had one, so the widget asked for a password
 * it already held.
 */
function readConfig(): Record<string, unknown> {
  return readConfigFile(CONFIG_PATH) ?? {}
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
 * Which password is in play, without producing the password.
 *
 * The settings panel used to show an empty box either way, so a machine with
 * a working saved password looked exactly like one that had never been set
 * up - on the machine where it mattered, the box was empty while the panel
 * behind it was showing live numbers that could only have come from a
 * password. The screen was describing the default, not the state.
 *
 * 'inherited' is kept separate from 'typed' rather than folded into "saved":
 * on the hub itself nothing was ever typed, and telling someone their
 * password is saved when it is really their own machine's being reused would
 * be the same kind of confident wrong answer in the other direction.
 */
export type HubPasswordSource = 'typed' | 'inherited' | 'none'

export function hubPasswordSource(hubUrl: string): HubPasswordSource {
  if (loadCredential(HUB_PASSWORD_CREDENTIAL)) return 'typed'
  if (isThisMachine(hubUrl) && loadCredential(OWN_DASHBOARD_PASSWORD)) return 'inherited'
  return 'none'
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
