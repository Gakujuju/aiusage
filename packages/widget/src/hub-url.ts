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

/**
 * The config file is there and cannot be read.
 *
 * Distinct from "there is no config file", which is an ordinary first run.
 * Both used to end in the same silent `return null`, and on 2026-09-02 that
 * cost half a day: PowerShell's `Set-Content -Encoding UTF8` had put a BOM
 * on config.json, JSON.parse threw, the catch returned null, and the hub
 * address fell back to the default of this machine. The widget then read the
 * spoke as though it were the hub and showed one tool instead of three.
 *
 * Nothing logged an error, because nothing considered it one. The display
 * was not broken - it was correct about a different machine.
 */
export class ConfigUnreadableError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`${path} exists but could not be read: ${detail}`)
    this.name = 'ConfigUnreadableError'
  }
}

/**
 * Reads and parses config.json, or says which of the two situations it is.
 *
 * Returns null only when there is no file. A file that will not parse throws,
 * because the alternative is carrying on with defaults that are wrong in a
 * way nobody can see.
 */
export function readConfigFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (error) {
    throw new ConfigUnreadableError(path, error instanceof Error ? error.message : String(error))
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') {
      throw new ConfigUnreadableError(path, 'the top level is not an object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof ConfigUnreadableError) throw error
    /*
     * Named, because it is the one that actually happened and it is invisible
     * in an editor. Three bytes at the front of the file, and every reader
     * built on JSON.parse refuses it.
     */
    const bom = text.charCodeAt(0) === 0xfeff
      ? 'the file starts with a UTF-8 BOM (write it with [System.IO.File]::WriteAllText, not Set-Content -Encoding UTF8). '
      : ''
    throw new ConfigUnreadableError(path, bom + (error instanceof Error ? error.message : String(error)))
  }
}

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

/** @throws ConfigUnreadableError when the file is there and will not parse. */
function configuredHubUrl(): string | null {
  const config = readConfigFile(join(AIUSAGE_DIR, 'config.json'))
  const url = (config?.hubForward as { url?: unknown } | undefined)?.url
  return typeof url === 'string' && url.length > 0 ? url.replace(/\/+$/, '') : null
}

/**
 * @param override What the user set in the widget's own settings, if
 *   anything. It wins: someone who typed an address meant it - and it is the
 *   way out when config.json is the thing that is broken.
 * @throws ConfigUnreadableError when there is no override and config.json is
 *   present but unreadable. Deliberately not caught here: falling back to
 *   this machine's own port is how the widget came to describe the wrong
 *   machine without saying anything.
 */
export function resolveHubUrl(override?: string | null): string {
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim().replace(/\/+$/, '')
  }
  return configuredHubUrl() ?? `http://127.0.0.1:${readServePort()}`
}
