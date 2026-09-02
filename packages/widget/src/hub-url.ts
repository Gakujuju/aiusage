import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Which machine to ask.
 *
 * A spoke already knows: `hubForward.url` in its config is the machine it
 * sends its work to, and that is the machine holding the answers. The hub
 * has no such entry - it is the hub - so it asks itself on the port serve
 * wrote into `.serve-port`.
 *
 * The hub reading its own HTTP rather than the database beside it is the
 * point. One path for every machine means one set of rules about what is
 * stale, what is missing and what a failure looks like. Two paths would be
 * two sets, and they would disagree eventually.
 */
const AIUSAGE_DIR = join(homedir(), '.aiusage')

/** The port serve wrote when it started, or the default if it did not. */
export const DEFAULT_PORT = 3847

export function readServePort(): number {
  try {
    const path = join(AIUSAGE_DIR, '.serve-port')
    if (!existsSync(path)) return DEFAULT_PORT
    const port = Number.parseInt(readFileSync(path, 'utf-8').trim(), 10)
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT
  } catch {
    return DEFAULT_PORT
  }
}

function configuredHubUrl(): string | null {
  try {
    const path = join(AIUSAGE_DIR, 'config.json')
    if (!existsSync(path)) return null
    const config = JSON.parse(readFileSync(path, 'utf-8')) as { hubForward?: { url?: unknown } }
    const url = config?.hubForward?.url
    return typeof url === 'string' && url.length > 0 ? url.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

/**
 * @param override What the user set in the widget's own settings, if
 *   anything. It wins: someone who typed an address meant it.
 */
export function resolveHubUrl(override?: string | null): string {
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim().replace(/\/+$/, '')
  }
  return configuredHubUrl() ?? `http://127.0.0.1:${readServePort()}`
}
