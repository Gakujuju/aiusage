import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ConsentConfig } from './sync/consent.js'
import type { PriceEntry, ExchangeRateCache } from '@aiusage/core'

/** Env var that relocates aiusage's own data directory. */
export const AIUSAGE_HOME_ENV = 'AIUSAGE_HOME'

/**
 * Where aiusage keeps its database, config and state.
 *
 * Only aiusage's own data moves with this. The paths where other tools store
 * their logs and credentials stay under the real home directory — those are
 * facts about the machine, not about this installation.
 *
 * A relative override is resolved against the current working directory.
 * Blank or whitespace-only counts as unset.
 */
export function resolveAiusageDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[AIUSAGE_HOME_ENV]?.trim()
  if (override) return resolve(override)
  return join(homedir(), '.aiusage')
}

/**
 * Evaluated once, when this module is first imported. Everything else — the
 * database path, the config file, state.json — is derived from it, so the
 * override must be in the environment before the process starts. Setting it
 * from inside the process has no effect.
 */
export const AIUSAGE_DIR = resolveAiusageDir()
export const CONFIG_PATH = join(AIUSAGE_DIR, 'config.json')

export const SYNC_FIELDS = [
  'ts', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'thinkingTokens', 'cost', 'costSource', 'tool', 'model', 'provider',
  'sessionKey', 'device', 'deviceInstanceId', 'updatedAt',
]

export interface SyncConfig {
  backend: 'github' | 's3' | 'cloud'
  repo?: string
  bucket?: string
  prefix?: string
  endpoint?: string
  region?: string
  credentialRef?: string
}

export interface Config {
  sync?: SyncConfig
  device?: string
  platform?: string                    // 'win32' | 'darwin' | 'linux'
  retentionDays?: number
  refreshInterval?: number
  /** @deprecated Use refreshInterval. Kept for migration only. */
  parseInterval?: number
  /** @deprecated Use refreshInterval. Kept for migration only. */
  dashboardPollInterval?: number
  leaderboardAutoUpload?: boolean
  leaderboardUploadInterval?: number
  credentials?: Record<string, string>
  priceOverrides?: Record<string, PriceEntry>
  /** @deprecated Legacy source paths — use AIUSAGE_*_PATH env vars instead. Kept for migration only. */
  sources?: Record<string, string>
  /** First day of week: 0 = Sunday (Western), 1 = Monday (ISO/Chinese). Defaults to 1. */
  weekStart?: 0 | 1
  /** Display currency for the web UI: 'USD' (default) or 'CNY' */
  displayCurrency?: 'USD' | 'CNY'
  /** Manual exchange rate override (CNY → USD multiplier) */
  exchangeRate?: number
  /** Auto-fetched exchange rate cache */
  exchangeRateCache?: ExchangeRateCache
  /** Auto-sync interval in milliseconds (0 or undefined = disabled) */
  syncInterval?: number
  /** Subscription quota polling interval in ms. 0 disables it. Defaults to 300000 (5 min). */
  quotaSnapshotInterval?: number
  /** Retention for quota history, in days. Independent of retentionDays. Defaults to 180. */
  quotaRetentionDays?: number
  agentSessions?: {
    /**
     * Store a 120-character preview of the user's prompt on the session row.
     * Off unless asked for: this is the most sensitive thing a hook carries.
     */
    storePromptPreview?: boolean
  }
  notifications?: NotificationConfig
  /**
   * Extra directory names to treat as workspace roots when naming a project
   * from a path — added to the built-in set, never replacing it. e.g.
   * ["Desktop"] makes ~/Desktop/aiusage report "aiusage" rather than "Desktop".
   */
  projectRoots?: string[]
  /** Display names for projects, keyed by the extracted project name. */
  projectAliases?: Record<string, string>
}

export interface NotificationConfig {
  /** Off until deliberately switched on. Nothing is sent while false. */
  enabled?: boolean
  channel?: 'discord'
  /** Marks messages as ours while running alongside the existing hooks. */
  prefix?: string
  /**
   * Whether this machine is the one that sends. Several machines watching the
   * same account would otherwise each announce the same thing.
   */
  notifierDevice?: boolean
  /**
   * Include the assistant's reply in the notification. Off by default: this
   * sends response content to a third-party service, and the existing
   * PowerShell hook doing so is not a reason to inherit the behaviour.
   */
  includeAssistantMessage?: boolean
  /** Floor on how often one session may notify. */
  minIntervalMs?: number
  events?: {
    waiting_for_permission?: boolean
    waiting_for_user?: boolean
    failed?: boolean
    completed?: boolean
    running?: boolean
    idle?: boolean
  }
  escalation?: {
    /** Delays from status_since at which to re-announce, in ms. */
    waiting_for_permission?: number[]
  }
  quota?: {
    thresholds?: number[]
    notifyOnReset?: boolean
  }
  /** Local 'HH:MM' times. Unset means notify at any hour. */
  quietHours?: { start: string; end: string }
  /** Event kinds that ignore quiet hours. */
  quietHoursAllow?: string[]
}

/** Credential key holding the Discord webhook. Never stored in `notifications`. */
export const DISCORD_WEBHOOK_CREDENTIAL = 'discordWebhook'

export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return null
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })
}

export function buildConsentConfig(config: Config): ConsentConfig | null {
  const sync = config.sync
  if (!sync) return null

  // Cloud sync uses device auth (HMAC), not consent
  if (sync.backend === 'cloud') return null

  const backend = sync.backend
  const target = backend === 'github'
    ? sync.repo ?? ''
    : `${sync.bucket}/${sync.prefix ?? 'aiusage/'}`
  const endpoint = backend === 'github'
    ? 'https://api.github.com'
    : sync.endpoint ?? 'https://s3.amazonaws.com'
  const region = backend === 'github' ? 'global' : (sync.region ?? 'auto')

  return {
    backend,
    target,
    endpoint,
    region,
    fields: SYNC_FIELDS,
    operations: ['read', 'write'],
    schemaVersion: 'v1',
  }
}

export function loadCredential(key: string): string | null {
  const config = loadConfig()
  if (!config?.credentials) return null
  return config.credentials[key] ?? null
}

export function saveCredential(key: string, value: string): void {
  const config = loadConfig() ?? {}
  if (!config.credentials) config.credentials = {}
  config.credentials[key] = value
  saveConfig(config)
}
