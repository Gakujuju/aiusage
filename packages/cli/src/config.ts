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

/**
 * Every field a synced record carries off this machine.
 *
 * This list is what the consent screen shows and what the consent
 * fingerprint is computed from, so it has one job: match what
 * mapStatsRecordToSyncRecord actually puts on the wire. It did not.
 * platform, sourceFile and cwd were being uploaded without appearing here,
 * which meant consent was given against a list that left out the two fields
 * a person would most want to know about — sourceFile is the path of the log
 * file, and cwd is the absolute path of the directory the work happened in.
 * On a work machine those carry project and client names.
 *
 * Adding them changes the fingerprint, so anyone who has already consented is
 * asked again. That is the point: consent obtained against an inaccurate
 * list is not consent for what was actually being sent.
 *
 * If a field is ever added to the record, add it here in the same change.
 */
export const SYNC_FIELDS = [
  'ts', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'thinkingTokens', 'cost', 'costSource', 'tool', 'model', 'provider',
  'sessionKey', 'device', 'deviceInstanceId', 'platform', 'updatedAt',
  'sourceFile', 'cwd', 'breakdownMissing',
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
  /**
   * Interfaces serve should listen on, comma separated.
   *
   * Lowest precedence: --host and AIUSAGE_HOST both win. 127.0.0.1 is added
   * whatever this says. Setting it here does not make the dashboard public
   * on its own — a non-loopback entry still requires a password, exactly as
   * the flag does.
   */
  host?: string
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
  ui?: UiConfig
  /** Web Push application-server identity. The private half is a credential. */
  vapid?: VapidConfig
  /** The machine this one reports to. Unset means it reports to itself. */
  hubForward?: HubForwardConfig
}

/**
 * The machine this one sends its work to.
 *
 * Three laptops each parse their own logs, but only one of them polls quotas,
 * decides what is worth saying and holds the push subscriptions. The other
 * two send that one everything they produce — agent events as they happen,
 * usage records as they are parsed — so a phone subscribes once instead of
 * three times, /agents shows every machine in one list, and the totals are
 * added up in one place.
 *
 * One destination, not one per kind of data. Two settings that must always
 * hold the same URL is a way of eventually holding two different ones.
 *
 * Unset is the ordinary case and changes nothing: the machine talks to its
 * own serve over loopback, exactly as it always has.
 */
export interface HubForwardConfig {
  /**
   * Origin of the receiving serve, e.g. https://desktop-abc.tail1234.ts.net.
   * A path is ignored — the endpoints are ours to decide.
   */
  url?: string
  /**
   * Minutes between record uploads. Unset uses the built-in default; 0 stops
   * records being sent without affecting agent events, which are not batched.
   */
  recordIntervalMinutes?: number
}

/**
 * The hub's ingest token.
 *
 * A credential rather than a config field for the usual reason: it travels
 * the network on every hook and every upload, and it is the one thing that
 * lets a caller write into another machine's database. Same 0600 file as the
 * webhook, and the API never returns it.
 */
export const HUB_FORWARD_TOKEN_CREDENTIAL = 'hubForwardToken'

export interface VapidConfig {
  /** Uncompressed P-256 point, base64url. Handed to browsers when subscribing. */
  publicKey?: string
  /**
   * RFC 8292 contact, sent to the push service on every delivery. Defaults to
   * the repository — a personal address has no reason to travel to Google
   * unless its owner decides otherwise.
   */
  subject?: string
}

export interface UiConfig {
  /**
   * Screens to leave out of the navigation, by path.
   *
   * Hiding, not removing: the pages still work if opened directly, because
   * the feature exists and pretending otherwise would be a lie. This is about
   * a sidebar with fifteen entries when two of them are for a service the
   * user does not use.
   */
  hiddenRoutes?: string[]
}

/**
 * The screens that may be hidden.
 *
 * `/` and `/settings` are deliberately absent. Settings is the only way back
 * from a hidden screen, and home is the manifest's start_url — hiding either
 * turns a preference into something you cannot undo from the dashboard.
 */
export const HIDEABLE_ROUTES: readonly string[] = [
  '/overview',
  '/tokens',
  '/cost',
  '/models',
  '/agents',
  '/sessions',
  '/projects',
  '/tool-calls',
  '/quotas',
  '/notifications',
  '/pricing',
  '/leaderboard',
  '/support',
]

/** Keep only paths we recognise, deduplicated and in a stable order. */
export function normalizeHiddenRoutes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const wanted = new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()))
  return HIDEABLE_ROUTES.filter((route) => wanted.has(route))
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
  /**
   * Where a decision is delivered. Absent means Discord alone: push cannot
   * default to on, because there is nothing to send to until a browser has
   * subscribed.
   */
  channels?: { discord?: boolean; webpush?: boolean }
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
  /**
   * Per-tool mute, e.g. { codex: false }. Unset means enabled: a tool we
   * learn to watch later starts announcing itself rather than staying
   * silently off for everyone who already has a config file.
   */
  tools?: Record<string, boolean>
}

/** Credential key holding the Discord webhook. Never stored in `notifications`. */
export const DISCORD_WEBHOOK_CREDENTIAL = 'discordWebhook'

/**
 * Credential key holding the dashboard password.
 *
 * Stored beside the webhook rather than in the plain config section, so it
 * inherits the same 0600 file and the same rule about never being returned
 * by the API. The environment variable still wins when both are set.
 */
export const DASHBOARD_PASSWORD_CREDENTIAL = 'dashboardPassword'

/**
 * The application server's private key for Web Push.
 *
 * Stored with the other secrets rather than in the config body because
 * regenerating it invalidates every existing subscription — it is the
 * identity the push service has recorded against them.
 */
export const VAPID_PRIVATE_KEY_CREDENTIAL = 'vapidPrivateKey'

/**
 * What the push service is told about who is sending.
 *
 * RFC 8292 wants a way to contact the operator. It is sent to Google on every
 * delivery, so the default is this project's repository rather than anybody's
 * email address: there is no reason for a personal address to travel to a
 * third party by default, and someone who wants to be reachable can say so.
 */
export const DEFAULT_VAPID_SUBJECT = 'https://github.com/Gakujuju/aiusage'

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
