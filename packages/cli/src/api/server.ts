import http from 'node:http'
import path from 'node:path'
import { hostname, platform, tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { removePriceOverride, resolveExchangeRate, fetchExchangeRate, forecastQuota, p90FinalUtilization, classifyQuotaError, isAgentEventKind, isAgentStatus, TOOLS, type PriceEntry, type QuotaErrorInput } from '@aiusage/core'
import { PRODUCED_HERE, PRODUCED_HERE_R, NOT_YET_MERGED } from '../db/row-scope.js'
import { decideRecalc, makePriceResolver, RECALC_COLUMNS, RECALC_UPDATE_SQL, type RecalcRow } from '../pricing/recalc-row.js'
import { AIUSAGE_DIR, DISCORD_WEBHOOK_CREDENTIAL,
  DASHBOARD_PASSWORD_CREDENTIAL, DEFAULT_VAPID_SUBJECT, HIDEABLE_ROUTES, VAPID_PRIVATE_KEY_CREDENTIAL,
  buildConsentConfig, loadConfig, saveConfig,
  loadCredential, normalizeHiddenRoutes } from '../config.js'
import type { Config, SyncConfig } from '../config.js'
import { setSyncConsent, getIngestToken } from '../init.js'
import { generateConsentFingerprint } from '../sync/consent.js'
import { MAX_SYNC_PAYLOAD_BYTES, MAX_SYNC_RECORDS_PER_REQUEST, normalizeIncomingSyncRecord } from '../sync/direct.js'
import { insertSyncedRecord, mergeSyncedRecordsIntoRecords } from '../db/synced-records.js'
import { getSyncTarget } from '../sync/target.js'
import { extractProject, extractProjectFromCwd } from './project-extraction.js'
import { discoverTools } from '../discovery.js'
import type { SyncStartResult, SyncStatusSnapshot } from '../sync/runtime.js'
import { queryAllQuotas } from '../quota.js'
import {
  buildAuthCookie,
  buildClearAuthCookie,
  getDashboardPassword,
  isAuthenticated,
  safeEqual,
  shouldProtectApiPath,
  verifyPassword,
} from '../auth.js'
import { getSiteUrl } from '../site-url.js'
import { startDeviceAuth, completeDeviceAuth, fetchLeaderboardStatus } from '../leaderboard/api.js'
import { clearCredentials, hasCredentials, loadCredentials, saveCredentials } from '../leaderboard/credentials.js'
import { base64url, sha256Buffer } from '../leaderboard/crypto.js'
import { uploadLeaderboardData } from '../commands/leaderboard-upload.js'
import { runParseKelivo } from '../commands/parse-kelivo.js'
import { countUnpricedRecords, insertRecord, type UnpricedScope } from '../db/records.js'
import { recordQuotaSnapshot } from '../db/quota-history.js'
import {
  enqueueNotification,
  listNotifications,
  retryNotification,
  summariseNotifications,
  WEBPUSH_CHANNEL,
} from '../db/notifications.js'
import {
  AgentSessionEmitter,
  applyAgentEvents,
  getAgentSession,
  listAgentSessions,
  summariseAgentSessions,
  type AgentEventInput,
} from '../db/agent-sessions.js'
import { openAgentStream } from './agent-stream.js'
import {
  deletePushSubscription, savePushSubscription, summarisePushSubscriptions,
} from '../db/push-subscriptions.js'
import { AsyncTaskQueue, type AsyncTaskQueueStatus } from '../db/write-queue.js'
import { getPricingRegistrySummary, getUserAliasBindings, hasUserPrice, listLocalModelBindings, listPricingAliasTargets, listPricingModels, loadPricingRuntime, removeUserPricingAlias, resetUserPriceToSynced, resolvePriceFromRegistry, setUserPrice, setUserPricingAlias, syncPricingFromLitellm } from '../pricing-registry.js'
import type { DetectedTool } from '../discovery.js'

const pendingLeaderboardAuth = new Map<string, { verifier: string; expiresAt: number }>()

function getManualImportMetadata(db: Database.Database): Record<string, { lastImportedAt: number }> {
  const rows = db.prepare(`
    SELECT tool, MAX(ingested_at) AS lastImportedAt
    FROM records
    WHERE tool IN ('kelivo')
    GROUP BY tool
  `).all() as Array<{ tool: string; lastImportedAt: number | null }>

  const metadata: Record<string, { lastImportedAt: number }> = {}
  for (const row of rows) {
    if (typeof row.lastImportedAt === 'number') {
      metadata[row.tool] = { lastImportedAt: row.lastImportedAt }
    }
  }
  return metadata
}

function attachManualImportMetadata(tools: DetectedTool[], db: Database.Database): DetectedTool[] {
  const metadata = getManualImportMetadata(db)
  return tools.map((tool) => {
    const toolMetadata = metadata[tool.tool]
    return toolMetadata ? { ...tool, ...toolMetadata } : tool
  })
}

function countExistingRecordIds(db: Database.Database, ids: string[]): number {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return 0

  const stmt = db.prepare('SELECT 1 FROM records WHERE id = ? LIMIT 1')
  let count = 0
  for (const id of uniqueIds) {
    if (stmt.get(id)) count++
  }
  return count
}

type PricingRecalcState = 'idle' | 'queued' | 'running' | 'done' | 'error'

interface PricingRecalcStatus {
  state: PricingRecalcState
  needsRecalc: boolean
  needsRecalcSince: number | null
  total: number
  processed: number
  updated: number
  skipped: number
  queueRunning: boolean
  queuePending: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

function emptyPricingRecalcStatus(): PricingRecalcStatus {
  return {
    state: 'idle',
    needsRecalc: false,
    needsRecalcSince: null,
    total: 0,
    processed: 0,
    updated: 0,
    skipped: 0,
    queueRunning: false,
    queuePending: 0,
    startedAt: null,
    finishedAt: null,
    error: null,
  }
}

/**
 * Reprice every row, without stopping the dashboard answering.
 *
 * What to do with a row lives in decideRecalc, shared with the CLI. The
 * loop is not shared and should not be: this one runs inside a live
 * server, so it hands the event loop back between batches. Twenty
 * thousand rows priced in one go is long enough to be noticed as an
 * outage.
 */
async function recalcCosts(db: Database.Database, onProgress?: (status: Pick<PricingRecalcStatus, 'total' | 'processed' | 'updated' | 'skipped'>) => void): Promise<number> {
  const BATCH_SIZE = 1000
  let updated = 0
  let processed = 0
  let skipped = 0
  let lastId = ''

  const deps = {
    resolvePrice: makePriceResolver(db),
    hasUserPrice: (model: string) => hasUserPrice(db, model),
    exchangeRate: resolveExchangeRate(loadConfig() ?? {}),
  }

  const selectStmt = db.prepare(
    `SELECT ${RECALC_COLUMNS} FROM records WHERE id > ? ORDER BY id LIMIT ?`)
  const updateStmt = db.prepare(RECALC_UPDATE_SQL)

  const total = (db.prepare('SELECT COUNT(*) AS total FROM records').get() as { total: number }).total
  onProgress?.({ total, processed, updated, skipped })

  const applyBatch = db.transaction((rows: RecalcRow[]) => {
    for (const row of rows) {
      processed++
      const decision = decideRecalc(row, deps)
      if (decision.action === 'skip') { skipped++; continue }
      if (decision.action === 'keep') continue
      updateStmt.run(
        decision.model, decision.provider, decision.cost, decision.costSource,
        Date.now(), row.id)
      updated++
    }
  })

  while (true) {
    const rows = selectStmt.all(lastId, BATCH_SIZE) as RecalcRow[]
    if (rows.length === 0) break
    applyBatch(rows)
    lastId = rows[rows.length - 1].id
    onProgress?.({ total, processed, updated, skipped })
    // The point of the whole separate loop: let the server answer.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return updated
}

function getDateRangeFilter(range: string | null, from: string | null, to: string | null, prefix = '', weekStart: 0 | 1 = 1): { where: string; params: Record<string, unknown> } {
  const ts = prefix ? `${prefix}.ts` : 'ts'

  if (from && to) {
    const startMs = new Date(from).getTime()
    const endMs = new Date(to + 'T23:59:59.999Z').getTime()
    return { where: `AND ${ts} >= @start AND ${ts} < @end`, params: { start: startMs, end: endMs } }
  }

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  if (range === 'week') {
    const dayOfWeek = today.getDay()
    const diff = (dayOfWeek - weekStart + 7) % 7
    const startOfWeek = new Date(today)
    startOfWeek.setDate(today.getDate() - diff)
    return { where: `AND ${ts} >= @start`, params: { start: startOfWeek.getTime() } }
  }
  if (range === 'month') {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    return { where: `AND ${ts} >= @start`, params: { start: startOfMonth.getTime() } }
  }
  if (range === 'last30') {
    const start = new Date(today)
    start.setDate(start.getDate() - 30)
    return { where: `AND ${ts} >= @start`, params: { start: start.getTime() } }
  }
  if (range === 'all') {
    return { where: '', params: {} }
  }
  // default: day
  return { where: `AND ${ts} >= @start`, params: { start: today.getTime() } }
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function isDatabaseLockedError(error: unknown): boolean {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message)
}

function databaseBusy(res: http.ServerResponse): void {
  json(res, {
    error: {
      code: 'DATABASE_BUSY',
      message: 'Database is busy. Wait for the current refresh, sync, or import to finish and retry.',
    },
  }, 503)
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of req) body += chunk
  if (!body.trim()) return {}
  return JSON.parse(body) as Record<string, unknown>
}

/**
 * Read a JSON body, giving up once it is bigger than the caller allows.
 *
 * readJsonBody concatenates whatever arrives, which is fine for a settings
 * PUT and wrong for an endpoint another machine posts to on a timer: without
 * a ceiling, one oversized upload is bounded only by memory. Counting as the
 * chunks arrive means the refusal costs nothing to produce.
 */
class PayloadTooLarge extends Error {}

async function readJsonBodyLimited(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) throw new PayloadTooLarge()
    chunks.push(buf)
  }
  const body = Buffer.concat(chunks).toString('utf-8')
  if (!body.trim()) return {}
  return JSON.parse(body) as Record<string, unknown>
}

async function readBodyBuffer(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function multipartBoundary(contentType: string | string[] | undefined): string | null {
  const value = Array.isArray(contentType) ? contentType[0] : contentType
  if (!value) return null
  const match = value.match(/(?:^|;)\s*boundary=("([^"]+)"|[^;]+)/i)
  if (!match) return null
  return (match[2] ?? match[1]).replace(/^"|"$/g, '')
}

async function readMultipartFile(req: http.IncomingMessage): Promise<{ filename: string; data: Buffer } | null> {
  const boundary = multipartBoundary(req.headers['content-type'])
  if (!boundary) return null

  const body = await readBodyBuffer(req)
  const marker = Buffer.from(`--${boundary}`)
  let position = body.indexOf(marker)
  while (position !== -1) {
    position += marker.length
    if (body.subarray(position, position + 2).toString() === '--') return null
    if (body.subarray(position, position + 2).toString() === '\r\n') position += 2

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), position)
    if (headerEnd === -1) return null
    const headers = body.subarray(position, headerEnd).toString('utf-8')
    const filenameMatch = headers.match(/Content-Disposition:[^\r\n]*\bname="file"[^\r\n]*\bfilename="([^"]+)"/i)
    const dataStart = headerEnd + 4
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart)
    if (nextBoundary === -1) return null
    if (filenameMatch) return { filename: path.basename(filenameMatch[1]), data: body.subarray(dataStart, nextBoundary) }
    position = body.indexOf(marker, nextBoundary)
  }
  return null
}

function isKelivoBackupFilename(filename: string): boolean {
  return filename === 'chats.json' || filename.toLowerCase().endsWith('.zip')
}

function getDeviceName(): string {
  return loadConfig()?.device || hostname() || `${platform()}-${process.arch}`
}

function getLeaderboardFallback(periodType: string): Record<string, unknown> {
  return {
    entries: [],
    next_cursor: null,
    current_user: null,
    period_type: periodType,
    period_start: new Date().toISOString().slice(0, 10),
    source_status: 'unavailable',
  }
}

async function proxyLeaderboard(res: http.ServerResponse, url: URL): Promise<void> {
  const periodType = url.searchParams.get('period_type') || 'daily'
  const upstreamBase = getSiteUrl()
  const upstream = new URL('/api/leaderboard', upstreamBase)
  upstream.searchParams.set('period_type', periodType)

  const periodStart = url.searchParams.get('period_start')
  if (periodStart) upstream.searchParams.set('period_start', periodStart)

  const cursor = url.searchParams.get('cursor')
  if (cursor) upstream.searchParams.set('cursor', cursor)

  try {
    const response = await fetch(upstream, {
      headers: { Accept: 'application/json' },
    })
    const contentType = response.headers.get('content-type') || ''
    if (!response.ok || !contentType.includes('application/json')) {
      json(res, getLeaderboardFallback(periodType))
      return
    }

    const data = await response.json().catch(() => null)
    if (!data || !Array.isArray(data.entries)) {
      json(res, getLeaderboardFallback(periodType))
      return
    }

    json(res, data)
  } catch {
    json(res, getLeaderboardFallback(periodType))
  }
}

async function proxyCloudSyncStatus(res: http.ServerResponse): Promise<void> {
  const upstream = new URL('/api/cli/sync/status', getSiteUrl())

  try {
    const response = await fetch(upstream, {
      headers: { Accept: 'application/json' },
    })
    const contentType = response.headers.get('content-type') || ''
    if (!response.ok || !contentType.includes('application/json')) {
      json(res, { enabled: false })
      return
    }

    const data = await response.json().catch(() => null)
    json(res, data && typeof data.enabled === 'boolean' ? data : { enabled: false })
  } catch {
    json(res, { enabled: false })
  }
}


export interface ApiServerOptions {
  currentDeviceInstanceId?: string
  onRefresh?: () => Promise<{ parsedCount: number; toolCallCount: number; errors: string[] }>
  /**
   * Which build of the screen this server would hand out right now.
   *
   * Reported so it can be set against the build the app is actually running.
   * Neither number means anything alone — the question is only ever whether
   * they match, and a mismatch is exactly the state worth recognising: the
   * app is serving a shell from its cache that the server has moved past.
   */
  getWebVersion?: () => string | null
  /** The parse-health verdict, decided in one place by the controller. */
  getParseHealth?: () => {
    lastParseOkAt: number | null
    intervalMs: number
    thresholdMs: number
    stalled: boolean
    stalledSince: number | null
  }
  onSyncStart?: () => SyncStartResult
  getSyncStatus?: () => SyncStatusSnapshot | null
  onConfigUpdated?: () => void
  runDbWrite?: <T>(task: () => T | Promise<T>) => Promise<T>
  agentEmitter?: AgentSessionEmitter
  /**
   * False when serve is bound beyond loopback. Reachable from the network,
   * /api/summary and /api/quotas stop being safe to leave open — they are the
   * total spend and the subscription burn.
   */
  isLoopbackBind?: boolean
  getDbWriteQueueStatus?: () => AsyncTaskQueueStatus
}

interface DeviceFilter {
  /** SQL fragment for WHERE clause (prepend with AND) */
  where: string
  /** Named parameters for the WHERE fragment */
  params: Record<string, unknown>
  /** True when query should UNION records + synced_records */
  useUnion: boolean
  /** True when querying records table should exclude merged synced records */
  localOnly: boolean
}

function getToolFilter(tool: string | null, prefix = ''): { where: string; params: Record<string, unknown> } {
  if (!tool) return { where: '', params: {} }
  const col = prefix ? `${prefix}.tool` : 'tool'
  return { where: `AND ${col} = @tool`, params: { tool } }
}

function classifyToolCall(name: string): 'mcp' | 'skill' | 'builtin' {
  if (name.startsWith('mcp__')) return 'mcp'
  if (name.startsWith('skill__') || name === 'Skill') return 'skill'
  return 'builtin'
}

function parseMcpName(name: string): { server: string; action: string; display: string } {
  const withoutPrefix = name.slice(5)
  const idx = withoutPrefix.indexOf('__')
  if (idx === -1) return { server: withoutPrefix, action: '', display: withoutPrefix }
  return {
    server: withoutPrefix.slice(0, idx),
    action: withoutPrefix.slice(idx + 2),
    display: `${withoutPrefix.slice(0, idx)} / ${withoutPrefix.slice(idx + 2)}`,
  }
}

function getToolTypeFilter(toolType: string | null): string {
  if (toolType === 'mcp') return "AND tc.name LIKE 'mcp\\_\\_%' ESCAPE '\\'"
  if (toolType === 'skill') return "AND (tc.name LIKE 'skill\\_\\_%' ESCAPE '\\' OR tc.name = 'Skill')"
  if (toolType === 'builtin') return "AND tc.name NOT LIKE 'mcp\\_\\_%' ESCAPE '\\' AND tc.name NOT LIKE 'skill\\_\\_%' ESCAPE '\\' AND tc.name != 'Skill'"
  return ''
}

// The predicates live in row-scope.ts. Three copies of these were wrong in
// three different ways on one day; the predicate is what was wrong each
// time, so the predicate is what is shared.
const LOCAL_ONLY_FILTER = PRODUCED_HERE
const LOCAL_ONLY_FILTER_R = PRODUCED_HERE_R

const NOT_ALREADY_MERGED = NOT_YET_MERGED

/**
 * The rows a screen's uncosted counts should be taken over.
 *
 * Built from the same fragments the screen uses for its own figures, so
 * the count cannot describe a different set of rows than the numbers
 * beside it. The band once read "334 records" over all time while every
 * figure under it was one day's.
 *
 * Written once because four screens need it. Three predicates that were
 * each spelled out by hand went wrong three separate ways in one day.
 *
 * Under a union the records side is left unfiltered and the synced side
 * drops what has already been merged — filtering both would count a
 * merged row zero times instead of twice.
 */
function unpricedScopeFor(
  dr: { where: string; params: Record<string, unknown> },
  df: DeviceFilter,
  tf: { where: string; params: Record<string, unknown> },
): UnpricedScope {
  return {
    source: df.useUnion ? 'union' : (df.where ? 'synced' : 'records'),
    recordsWhere: df.useUnion
      ? `${dr.where} ${tf.where}`
      : `${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}`,
    syncedWhere: df.useUnion
      ? `AND device_instance_id != @currentDeviceId ${NOT_ALREADY_MERGED} ${dr.where} ${tf.where}`
      : `${df.where} ${dr.where} ${tf.where}`,
    params: { ...dr.params, ...df.params, ...tf.params },
    // Read fresh each time, so acknowledging a model takes effect on the
    // next page load rather than the next restart.
    acknowledgedModels: loadConfig()?.acknowledgedUnpricedModels ?? [],
  }
}

function getDeviceFilter(
  device: string | null | undefined,
  currentDeviceInstanceId: string | undefined,
): DeviceFilter {
  if (!currentDeviceInstanceId) {
    // No device instance ID available — query only records (legacy behavior)
    return { where: '', params: {}, useUnion: false, localOnly: false }
  }

  if (!device) {
    // All devices: UNION local records + synced_records from other devices
    // localOnly=true prevents double-counting merged synced records
    return {
      where: '',
      params: { currentDeviceId: currentDeviceInstanceId },
      useUnion: true,
      localOnly: true,
    }
  }

  if (device === currentDeviceInstanceId) {
    // Current device only: query local records only (not merged synced from other devices)
    return { where: '', params: {}, useUnion: false, localOnly: true }
  }

  // Specific other device: query synced_records only
  return {
    where: 'AND device_instance_id = @deviceId',
    params: { deviceId: device },
    useUnion: false,
    localOnly: false,
  }
}

// ── Agent session helpers ──────────────────────────────────────────────────

const MAX_AGENT_EVENT_BATCH = 200

const AGENT_EVENT_SOURCES = new Set([
  'manual', 'hook', 'log', 'heartbeat', 'process', 'derived', 'unknown',
])

/** Returns an error message, or null when the entry is usable. */
function validateAgentEvent(entry: Record<string, unknown>): string | null {
  if (!entry || typeof entry !== 'object') return 'Each event must be an object'
  if (typeof entry.sessionId !== 'string' || !entry.sessionId) return 'sessionId required'
  if (typeof entry.tool !== 'string' || !TOOLS.includes(entry.tool as never)) return 'Invalid tool'
  if (!isAgentEventKind(entry.kind)) return 'Invalid kind'
  if (entry.source != null && !AGENT_EVENT_SOURCES.has(String(entry.source))) return 'Invalid source'
  if (entry.ts != null && !Number.isFinite(entry.ts)) return 'ts must be a number'
  if (entry.status != null && !isAgentStatus(entry.status)) return 'Invalid status'
  return null
}

// ── Quota history helpers ──────────────────────────────────────────────────

const QUOTA_HISTORY_RANGES = new Set(['day', 'week', 'month', 'all'])
const QUOTA_HISTORY_MAX_POINTS = 2000
const QUOTA_P90_WINDOW_LIMIT = 20

interface QuotaCurrentRow {
  tool: string
  tier: string
  device_instance_id: string
  utilization: number
  resets_at: number | null
  window_id: string
  ts: number
  cred_status: string
  last_success_at: number | null
  last_error: string | null
  last_error_kind: string
  consecutive_errors: number
}

/** Accepts either an ISO 8601 string or epoch milliseconds. */
function parseTimeParam(value: string | null): number | null {
  if (!value) return null
  const asNumber = Number(value)
  if (Number.isFinite(asNumber) && value.trim() !== '') return asNumber
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Start of the requested range in ms, or null for an unbounded range. */
function quotaHistoryStart(range: string, now: number): number | null {
  if (range === 'all') return null
  if (range === 'day') return now - 86400000
  if (range === 'month') return now - 30 * 86400000
  return now - 7 * 86400000
}

/**
 * Evenly thin a series down to `max` points, always keeping the first and last
 * so the endpoints of the chart stay truthful.
 */
function downsampleSeries<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points
  const step = (points.length - 1) / (max - 1)
  const out: T[] = []
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round(i * step)])
  }
  return out
}

function readQuotaCurrent(db: Database.Database, device: string | null): QuotaCurrentRow[] {
  if (device) {
    return db.prepare(
      'SELECT * FROM quota_current WHERE device_instance_id = @device ORDER BY tool, tier'
    ).all({ device }) as QuotaCurrentRow[]
  }
  return db.prepare('SELECT * FROM quota_current ORDER BY tool, tier').all() as QuotaCurrentRow[]
}

/**
 * Fill in the tiers of any tool whose live query failed, using the last value
 * we stored for it. This is what keeps the dashboard readable when the
 * undocumented upstream endpoints break or the machine is offline.
 */
function withStaleQuotaFallback(
  db: Database.Database,
  results: Array<Record<string, unknown>>,
  deviceInstanceId: string,
): Array<Record<string, unknown>> {
  let stored: QuotaCurrentRow[] | null = null
  const storedFor = (tool: string): QuotaCurrentRow[] => {
    stored ??= readQuotaCurrent(db, deviceInstanceId || null)
    return stored.filter((row) => row.tool === tool)
  }

  return results.map((result) => {
    const tool = String(result.tool ?? '')
    // Why the query failed, for a caller that wants to say "re-login" rather
    // than "check your connection". cred_status reports 'valid' for both.
    const lastErrorKind = classifyQuotaError(result as QuotaErrorInput)

    if (result.success === true) {
      return {
        ...result,
        stale: false,
        lastSuccessAt: typeof result.queriedAt === 'number' ? result.queriedAt : null,
        consecutiveErrors: 0,
        lastErrorKind: '',
      }
    }

    const rows = storedFor(tool)
    if (rows.length === 0) {
      return { ...result, stale: false, lastSuccessAt: null, consecutiveErrors: 0, lastErrorKind }
    }

    return {
      ...result,
      tiers: rows.map((row) => ({
        name: row.tier,
        utilization: row.utilization,
        resetsAt: row.resets_at == null ? null : new Date(row.resets_at).toISOString(),
      })),
      stale: true,
      lastErrorKind,
      lastSuccessAt: rows.reduce<number | null>(
        (acc, row) => (row.last_success_at == null ? acc : Math.max(acc ?? 0, row.last_success_at)),
        null,
      ),
      consecutiveErrors: rows.reduce((acc, row) => Math.max(acc, row.consecutive_errors), 0),
    }
  })
}

export function createApiServer(db: Database.Database, options?: ApiServerOptions): http.Server {
  const cfg = loadConfig()
  let weekStart: 0 | 1 = (cfg?.weekStart ?? 1) as 0 | 1
  const dashboardPassword = getDashboardPassword()
  const localWriteQueue = new AsyncTaskQueue()
  const runDbWrite = options?.runDbWrite ?? (<T>(task: () => T | Promise<T>) => localWriteQueue.run(task))
  const getDbWriteQueueStatus = options?.getDbWriteQueueStatus ?? (() => localWriteQueue.getStatus())
  let pricingRecalcStatus = emptyPricingRecalcStatus()
  let pricingNeedsRecalcSince: number | null = null
  let pricingRecalcGeneration = 0
  let quotaRefreshInFlight = false
  const agentEmitter = options?.agentEmitter ?? new AgentSessionEmitter()

  const agentContext = () => ({
    device: getDeviceName(),
    deviceInstanceId: options?.currentDeviceInstanceId ?? '',
    platform: loadConfig()?.platform || platform(),
    now: Date.now(),
    // Prompt text is the most sensitive thing a hook carries, so it is stored
    // only when the user has asked for it.
    storePromptPreview: loadConfig()?.agentSessions?.storePromptPreview === true,
    projectRoots: loadConfig()?.projectRoots,
  })

  const hasValidIngestToken = (req: http.IncomingMessage): boolean => {
    const expected = getIngestToken(AIUSAGE_DIR)
    if (!expected) return false
    const header = req.headers['x-aiusage-token']
    const supplied = Array.isArray(header) ? header[0] : header
    if (typeof supplied !== 'string' || !supplied) return false
    return safeEqual(supplied, expected)
  }

  const currentPricingRecalcStatus = (): PricingRecalcStatus => {
    const status = {
      ...pricingRecalcStatus,
      needsRecalc: pricingNeedsRecalcSince != null,
      needsRecalcSince: pricingNeedsRecalcSince,
    }
    if (status.state !== 'queued') return status
    const queueStatus = getDbWriteQueueStatus()
    return {
      ...status,
      queueRunning: queueStatus.running,
      queuePending: queueStatus.pending,
    }
  }

  const markPricingNeedsRecalc = (): number => {
    pricingRecalcGeneration += 1
    pricingNeedsRecalcSince = Date.now()
    return pricingNeedsRecalcSince
  }

  const startPricingRecalc = (): { accepted: boolean; status: PricingRecalcStatus } => {
    if (pricingRecalcStatus.state === 'queued' || pricingRecalcStatus.state === 'running') {
      return { accepted: false, status: currentPricingRecalcStatus() }
    }

    const startedAt = Date.now()
    const startedGeneration = pricingRecalcGeneration

    pricingRecalcStatus = {
      ...emptyPricingRecalcStatus(),
      state: 'running',
      startedAt,
    }

    const runRecalc = async () => {
      pricingRecalcStatus = {
        ...pricingRecalcStatus,
        state: 'running',
        queueRunning: false,
        queuePending: 0,
        startedAt: pricingRecalcStatus.startedAt ?? Date.now(),
      }
      try {
        await recalcCosts(db, (progress) => {
          pricingRecalcStatus = {
            ...pricingRecalcStatus,
            ...progress,
            state: 'running',
          }
        })
        if (pricingNeedsRecalcSince != null && pricingRecalcGeneration === startedGeneration) {
          pricingNeedsRecalcSince = null
        }
        pricingRecalcStatus = {
          ...pricingRecalcStatus,
          state: 'done',
          needsRecalc: pricingNeedsRecalcSince != null,
          needsRecalcSince: pricingNeedsRecalcSince,
          finishedAt: Date.now(),
          error: null,
        }
      } catch (error) {
        pricingRecalcStatus = {
          ...pricingRecalcStatus,
          state: 'error',
          finishedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    setImmediate(() => {
      void runRecalc().catch((error) => {
        pricingRecalcStatus = {
          ...pricingRecalcStatus,
          state: 'error',
          finishedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }
      })
    })

    return { accepted: true, status: currentPricingRecalcStatus() }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/api/auth/status' && req.method === 'GET') {
      json(res, {
        enabled: dashboardPassword != null,
        authenticated: isAuthenticated(dashboardPassword, req.headers.cookie),
        /**
         * Whether the home page can show anything without a login.
         *
         * The client cannot work this out for itself — it depends on what
         * this server bound to, which is not visible from a browser. Getting
         * it wrong left the home page rendering its public variant against
         * endpoints that answered 401, with no way to reach the login form
         * from there. Same condition as the gate below, so the two cannot
         * drift apart.
         */
        publicHome: !shouldProtectApiPath('/api/summary', options?.isLoopbackBind !== false),
      })
      return
    }

    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req)
        if (!verifyPassword(dashboardPassword, typeof body.password === 'string' ? body.password : null)) {
          json(res, { error: { code: 'UNAUTHORIZED', message: 'Invalid password' } }, 401)
          return
        }

        if (dashboardPassword) {
          res.setHeader('Set-Cookie', buildAuthCookie(dashboardPassword))
        }
        json(res, { ok: true })
      } catch {
        json(res, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400)
      }
      return
    }

    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', buildClearAuthCookie())
      json(res, { ok: true })
      return
    }

    if (url.pathname === '/api/cli/sync/status' && req.method === 'GET') {
      await proxyCloudSyncStatus(res)
      return
    }

    // The ingest token stands in for the dashboard password. Hooks run as
    // separate processes with no cookie jar, so once a password was set every
    // agent-event POST answered 401 — and because agent-event spools what it
    // cannot send, that failed silently: no error anywhere, events piling up,
    // notifications simply stopping.
    //
    // The substitution goes one way only. A dashboard cookie does not satisfy
    // the ingest check further down; the token is still required there. One
    // says "you may read this dashboard", the other "you are this machine's
    // hook", and only the second is enough to write events.
    //
    // And it is only good for /api/agent/. The token travels the network on
    // every hook POST — over Tailscale once the bind is not loopback — while
    // cache.db never leaves the disk, so a leaked token must not become a
    // read key for everything the dashboard shows. Narrowing costs nothing:
    // agent-event only ever POSTs here, and the widget stays inside
    // isPublicPath.
    // The stream is the exception to the exception. Everything else under
    // /api/agent/ that the token unlocks is a write from a hook; this is a
    // read, and what it reads out is the same session state the dashboard
    // shows. Letting the token open it would undo the narrowing above, since
    // the token is the thing that travels the network.
    //
    // /api/sync/ was added to the same list, and the reason it belongs there
    // is the same reason /api/agent/ does rather than a new one. A laptop
    // uploading its usage records is in exactly the position a hook is in:
    // another process, on another machine, with no cookie jar, whose whole
    // purpose is to write. The rule the narrowing above expresses is not
    // "only agent paths" — it is "the token is a write key, never a read
    // key". So a write endpoint under /api/sync/ is inside that rule, and
    // every read stays outside it, unchanged: /api/summary, /api/records and
    // the rest still want a dashboard cookie and answer 401 to a token.
    //
    // The cost of getting this wrong is the same as before. A token that
    // opened reads would turn the one secret that travels the network into a
    // key for everything cache.db holds, which never leaves the disk.
    const tokenExempt = (url.pathname.startsWith('/api/agent/') || url.pathname.startsWith('/api/sync/'))
      && url.pathname !== '/api/agent/stream'
      && hasValidIngestToken(req)
    if (
      dashboardPassword
      && !tokenExempt
      && shouldProtectApiPath(url.pathname, options?.isLoopbackBind !== false)
      && !isAuthenticated(dashboardPassword, req.headers.cookie)
    ) {
      json(res, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401)
      return
    }

    const range = url.searchParams.get('range')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')

    // Validate tool parameter early — same style as range validation
    const toolParam = url.searchParams.get('tool')
    if (toolParam && !(TOOLS as readonly string[]).includes(toolParam)) {
      json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid tool' } }, 400)
      return
    }

    try {
      // ── /api/summary ──────────────────────────────────────────────
      if (url.pathname === '/api/summary') {
        if (range && !['day', 'week', 'month', 'last30', 'all'].includes(range)) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid range' } }, 400)
          return
        }
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const dr = getDateRangeFilter(range, from, to, '', weekStart)
        const tool = url.searchParams.get('tool')
        const tf = getToolFilter(tool)

        let totals: any
        let byToolRows: any[]

        if (df.useUnion) {
          // All devices: UNION records + synced_records (excluding current device's synced copy)
          const unionSql = `
            SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost, ts, session_id, breakdown_missing
            FROM records WHERE 1=1 ${dr.where} ${tf.where}
            UNION ALL
            SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, cost, ts, session_key AS session_id, breakdown_missing
            FROM synced_records WHERE device_instance_id != @currentDeviceId ${NOT_ALREADY_MERGED} ${dr.where} ${tf.where}
          `
          totals = db.prepare(`
            SELECT
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
              COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
              COALESCE(SUM(thinking_tokens), 0) AS thinkingTokens,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens), 0) AS totalTokens,
              COALESCE(SUM(cost), 0) AS totalCost,
              /*
               * How much of "input" above is really input+output.
               *
               * Codex desktop sessions report a total with no split, so the
               * whole figure lands in input_tokens. Counting the tokens is
               * right; calling them input is not, and the number alone gives
               * the reader no way to tell. See D27.
               */
              COALESCE(SUM(CASE WHEN breakdown_missing = 1 THEN input_tokens ELSE 0 END), 0) AS unsplitTokens,
              COUNT(DISTINCT strftime('%Y-%m-%d', ts/1000, 'unixepoch')) AS activeDays,
              COUNT(DISTINCT session_id) AS totalSessions
            FROM (${unionSql})
          `).get({ ...dr.params, ...df.params, ...tf.params }) as any

          byToolRows = db.prepare(`
            SELECT tool, SUM(tokens) AS tokens, SUM(cost) AS cost FROM (
              SELECT tool,
                     SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
                     SUM(cost) AS cost
              FROM records WHERE 1=1 ${dr.where} ${tf.where}
              GROUP BY tool
              UNION ALL
              SELECT tool,
                     SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
                     SUM(cost) AS cost
              FROM synced_records WHERE device_instance_id != @currentDeviceId ${NOT_ALREADY_MERGED} ${dr.where} ${tf.where}
              GROUP BY tool
            ) GROUP BY tool ORDER BY cost DESC
          `).all({ ...dr.params, ...df.params, ...tf.params }) as any[]
        } else if (df.where) {
          // Specific other device: query synced_records only
          totals = db.prepare(`
            SELECT
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
              COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
              COALESCE(SUM(thinking_tokens), 0) AS thinkingTokens,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens), 0) AS totalTokens,
              COALESCE(SUM(cost), 0) AS totalCost,
              COALESCE(SUM(CASE WHEN breakdown_missing = 1 THEN input_tokens ELSE 0 END), 0) AS unsplitTokens,
              COUNT(DISTINCT strftime('%Y-%m-%d', ts/1000, 'unixepoch')) AS activeDays,
              COUNT(DISTINCT session_key) AS totalSessions
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
          `).get({ ...dr.params, ...df.params, ...tf.params }) as any

          byToolRows = db.prepare(`
            SELECT tool,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
                   SUM(cost) AS cost
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
            GROUP BY tool ORDER BY cost DESC
          `).all({ ...dr.params, ...df.params, ...tf.params }) as any[]
        } else {
          // Current device or legacy: query records only
          totals = db.prepare(`
            SELECT
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
              COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
              COALESCE(SUM(thinking_tokens), 0) AS thinkingTokens,
              COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens), 0) AS totalTokens,
              COALESCE(SUM(cost), 0) AS totalCost,
              COALESCE(SUM(CASE WHEN breakdown_missing = 1 THEN input_tokens ELSE 0 END), 0) AS unsplitTokens,
              COUNT(DISTINCT strftime('%Y-%m-%d', ts/1000, 'unixepoch')) AS activeDays,
              COUNT(DISTINCT session_id) AS totalSessions
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
          `).get({ ...dr.params, ...tf.params }) as any

          byToolRows = db.prepare(`
            SELECT tool,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS tokens,
                   SUM(cost) AS cost
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY tool ORDER BY cost DESC
          `).all({ ...dr.params, ...tf.params }) as any[]
        }

        const byTool: Record<string, { tokens: number; cost: number }> = {}
        for (const row of byToolRows) {
          byTool[row.tool] = { tokens: row.tokens, cost: row.cost }
        }

        // LEFT JOIN + COALESCE so orphan tool calls (record_id IS NULL) are still
        // counted. Orphan calls have no records row; for device filtering we treat
        // them as local (r.device_instance_id IS NULL), and for date/tool we fall
        // back to tc.ts / tc.tool.
        const drJoin = getDateRangeFilter(range, from, to, 'r', weekStart)
        const drJoinO = drJoin.where.replaceAll('r.ts', 'COALESCE(r.ts, tc.ts)')
        const dfJoinRaw = df.where ? df.where.replace(/device_instance_id/g, 'r.device_instance_id') : ''
        // Orphan tool calls (record_id IS NULL) are local by definition; include them
        // when filtering to the current device. Use a word-boundary-safe replace so the
        // @deviceId param name is not split.
        const dfJoin = dfJoinRaw.replace(
          /r\.device_instance_id\s*=\s*@\w+/,
          '(r.device_instance_id IS NULL OR r.device_instance_id = @deviceId)',
        )
        const tfJoin = getToolFilter(tool, 'r')
        const tfJoinO = tfJoin.where.replaceAll('r.tool', 'COALESCE(r.tool, tc.tool)')
        const topToolCalls = db.prepare(`
          SELECT tc.name, COUNT(*) AS count
          FROM tool_calls tc
          LEFT JOIN records r ON r.id = tc.record_id
          WHERE 1=1 ${dfJoin} ${drJoinO} ${tfJoinO}
          GROUP BY tc.name ORDER BY count DESC LIMIT 10
        `).all({ ...drJoin.params, ...df.params, ...tfJoin.params }) as any[]

        const topMcpServersRaw = db.prepare(`
          SELECT tc.name, COUNT(*) AS count
          FROM tool_calls tc
          LEFT JOIN records r ON r.id = tc.record_id
          WHERE tc.name LIKE 'mcp\\_\\_%' ESCAPE '\\'
            AND INSTR(SUBSTR(tc.name, 6), '__') > 0
            ${dfJoin} ${drJoinO} ${tfJoinO}
          GROUP BY tc.name ORDER BY count DESC
        `).all({ ...drJoin.params, ...df.params, ...tfJoin.params }) as any[]

        // Aggregate by server (multiple mcp__server__X tools collapse to one server)
        const mcpServerMap = new Map<string, number>()
        for (const row of topMcpServersRaw) {
          const server = parseMcpName(row.name).server
          mcpServerMap.set(server, (mcpServerMap.get(server) ?? 0) + row.count)
        }
        const topMcpServers = Array.from(mcpServerMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([server, count]) => ({ server, count }))

        json(res, {
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          cacheWriteTokens: totals.cacheWriteTokens,
          thinkingTokens: totals.thinkingTokens,
          totalTokens: totals.totalTokens,
          totalCost: totals.totalCost,
          activeDays: totals.activeDays,
          totalSessions: totals.totalSessions,
          byTool,
          topToolCalls,
          topMcpServers,
          // A total of $0 read as "no usage" for months when it actually
          // meant "no prices for the models in use". Surfacing the count
          // makes the difference visible without anyone having to go
          // looking.
          //
          // Given the same filters as the totals above, from the same
          // fragments rather than a second description of them. Counted over
          // everything, the band said "334 records" while every figure
          // beside it was one day's — a number that does not mean what it
          // appears to mean, which is the whole family of faults this pass
          // has been closing.
          ...countUnpricedRecords(db, unpricedScopeFor(dr, df, tf)),
        })
        return
      }

      // ── /api/tokens ───────────────────────────────────────────────
      if (url.pathname === '/api/tokens') {
        const dr = getDateRangeFilter(range, from, to, '', weekStart)
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const tool = url.searchParams.get('tool')
        const tf = getToolFilter(tool)

        let sql: string
        let params: Record<string, unknown>

        if (df.useUnion) {
          sql = `
            SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens
            FROM (
              SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, ts FROM records WHERE 1=1 ${dr.where} ${tf.where}
              UNION ALL
              SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, ts FROM synced_records WHERE device_instance_id != @currentDeviceId ${NOT_ALREADY_MERGED} ${dr.where} ${tf.where}
            )
            GROUP BY date ORDER BY date`
          params = { ...dr.params, currentDeviceId: df.params.currentDeviceId, ...tf.params }
        } else if (device && device !== options?.currentDeviceInstanceId) {
          sql = `
            SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
            GROUP BY date ORDER BY date`
          params = { ...df.params, ...dr.params, ...tf.params }
        } else {
          sql = `
            SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY date ORDER BY date`
          params = { ...dr.params, ...tf.params }
        }

        const rows = db.prepare(sql).all(params) as any[]
        json(res, { data: rows })
        return
      }

      // ── /api/cost ─────────────────────────────────────────────────
      if (url.pathname === '/api/cost') {
        const dr = getDateRangeFilter(range, from, to, '', weekStart)
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const tool = url.searchParams.get('tool')
        const tf = getToolFilter(tool)

        let daily: any[]
        let byToolRows: any[]
        let byModelRows: any[]

        if (df.useUnion) {
          daily = db.prepare(`
            SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date,
                   SUM(cost) AS cost
            FROM (
              SELECT cost, ts FROM records WHERE 1=1 ${dr.where} ${tf.where}
              UNION ALL
              SELECT cost, ts FROM synced_records WHERE device_instance_id != @currentDeviceId ${NOT_ALREADY_MERGED} ${dr.where} ${tf.where}
            )
            GROUP BY date ORDER BY date
          `).all({ ...dr.params, currentDeviceId: df.params.currentDeviceId, ...tf.params }) as any[]

          byToolRows = db.prepare(`
            SELECT tool, SUM(cost) AS cost FROM (
              SELECT tool, SUM(cost) AS cost FROM records WHERE 1=1 ${dr.where} ${tf.where} GROUP BY tool
              UNION ALL
              SELECT tool, SUM(cost) AS cost FROM synced_records WHERE device_instance_id != @currentDeviceId ${NOT_ALREADY_MERGED} ${dr.where} ${tf.where} GROUP BY tool
            ) GROUP BY tool ORDER BY cost DESC
          `).all({ ...dr.params, currentDeviceId: df.params.currentDeviceId, ...tf.params }) as any[]

          byModelRows = db.prepare(`
            SELECT model, SUM(cost) AS cost FROM (
              SELECT model, SUM(cost) AS cost FROM records WHERE 1=1 ${dr.where} ${tf.where} GROUP BY model
              UNION ALL
              SELECT model, SUM(cost) AS cost FROM synced_records WHERE device_instance_id != @currentDeviceId ${NOT_ALREADY_MERGED} ${dr.where} ${tf.where} GROUP BY model
            ) GROUP BY model ORDER BY cost DESC
          `).all({ ...dr.params, currentDeviceId: df.params.currentDeviceId, ...tf.params }) as any[]
        } else if (device && device !== options?.currentDeviceInstanceId) {
          daily = db.prepare(`
            SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date,
                   SUM(cost) AS cost
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
            GROUP BY date ORDER BY date
          `).all({ ...df.params, ...dr.params, ...tf.params }) as any[]

          byToolRows = db.prepare(`
            SELECT tool, SUM(cost) AS cost
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
            GROUP BY tool ORDER BY cost DESC
          `).all({ ...df.params, ...dr.params, ...tf.params }) as any[]

          byModelRows = db.prepare(`
            SELECT model, SUM(cost) AS cost
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where} ${tf.where}
            GROUP BY model ORDER BY cost DESC
          `).all({ ...df.params, ...dr.params, ...tf.params }) as any[]
        } else {
          daily = db.prepare(`
            SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS date,
                   SUM(cost) AS cost
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY date ORDER BY date
          `).all({ ...dr.params, ...tf.params }) as any[]

          byToolRows = db.prepare(`
            SELECT tool, SUM(cost) AS cost
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY tool ORDER BY cost DESC
          `).all({ ...dr.params, ...tf.params }) as any[]

          byModelRows = db.prepare(`
            SELECT model, SUM(cost) AS cost
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY model ORDER BY cost DESC
          `).all({ ...dr.params, ...tf.params }) as any[]
        }

        const byTool: Record<string, number> = {}
        for (const r of byToolRows) byTool[r.tool] = r.cost

        const byModel: Record<string, number> = {}
        for (const r of byModelRows) byModel[r.model] = r.cost

        json(res, { data: daily, byTool, byModel })
        return
      }

      // ── /api/models ───────────────────────────────────────────────
      if (url.pathname === '/api/models') {
        const dr = getDateRangeFilter(range, from, to, '', weekStart)
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const tool = url.searchParams.get('tool')
        const tf = getToolFilter(tool)

        let totalTokensAcrossModels: number
        let rows: any[]

        if (df.useUnion) {
          const unionSql = `
            SELECT model, provider,
                   COUNT(*) AS callCount,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
                   SUM(cost) AS totalCost
            FROM records WHERE 1=1 ${dr.where} ${tf.where}
            GROUP BY model, provider
            UNION ALL
            SELECT model, provider,
                   COUNT(*) AS callCount,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
                   SUM(cost) AS totalCost
            FROM synced_records WHERE device_instance_id != @currentDeviceId ${NOT_ALREADY_MERGED} ${dr.where} ${tf.where}
            GROUP BY model, provider
          `
          const mergedRows = db.prepare(`
            SELECT model, provider,
                   SUM(callCount) AS callCount,
                   SUM(inputTokens) AS inputTokens,
                   SUM(outputTokens) AS outputTokens,
                   SUM(cacheReadTokens) AS cacheReadTokens,
                   SUM(cacheWriteTokens) AS cacheWriteTokens,
                   SUM(thinkingTokens) AS thinkingTokens,
                   SUM(totalTokens) AS totalTokens,
                   SUM(totalCost) AS totalCost
            FROM (${unionSql})
            WHERE model != 'unknown'
            GROUP BY model, provider ORDER BY totalTokens DESC
          `).all({ ...dr.params, ...df.params, ...tf.params }) as any[]
          totalTokensAcrossModels = mergedRows.reduce((sum, row) => sum + row.totalTokens, 0)
          rows = mergedRows
        } else if (device && device !== options?.currentDeviceInstanceId) {
          rows = db.prepare(`
            SELECT model, provider,
                   COUNT(*) AS callCount,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
                   SUM(cost) AS totalCost
            FROM synced_records WHERE 1=1 AND model != 'unknown' ${df.where} ${dr.where} ${tf.where}
            GROUP BY model, provider ORDER BY totalTokens DESC
          `).all({ ...df.params, ...dr.params, ...tf.params }) as any[]
          totalTokensAcrossModels = rows.reduce((sum, row) => sum + row.totalTokens, 0)
        } else {
          rows = db.prepare(`
            SELECT model, provider,
                   COUNT(*) AS callCount,
                   SUM(input_tokens) AS inputTokens,
                   SUM(output_tokens) AS outputTokens,
                   SUM(cache_read_tokens) AS cacheReadTokens,
                   SUM(cache_write_tokens) AS cacheWriteTokens,
                   SUM(thinking_tokens) AS thinkingTokens,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
                   SUM(cost) AS totalCost
            FROM records WHERE 1=1 AND model != 'unknown' ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY model, provider ORDER BY totalTokens DESC
          `).all({ ...dr.params, ...tf.params }) as any[]
          totalTokensAcrossModels = rows.reduce((sum, row) => sum + row.totalTokens, 0)
        }

        const models = rows.map(r => ({
          model: r.model,
          provider: r.provider,
          callCount: r.callCount,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheWriteTokens: r.cacheWriteTokens,
          thinkingTokens: r.thinkingTokens,
          totalTokens: r.totalTokens,
          totalCost: r.totalCost,
          percentage: totalTokensAcrossModels > 0
            ? Math.round((r.totalTokens / totalTokensAcrossModels) * 1000) / 10
            : 0,
        }))

        // The same counts the home screen carries, over this screen's own rows.
        // A figure of $0 reads as "not used much" unless something says the
        // price is missing, and a lump-total row can never be priced at all.
        json(res, { models, ...countUnpricedRecords(db, unpricedScopeFor(dr, df, tf)) })
        return
      }

      // ── /api/tool-calls ───────────────────────────────────────────
      if (url.pathname === '/api/tool-calls') {
        const device = url.searchParams.get('device')
        if (device && device !== options?.currentDeviceInstanceId) {
          json(res, { toolCalls: [] })
          return
        }

        // Use COALESCE so orphan tool calls (record_id IS NULL, e.g. from ZCode,
        // Codex backfill) are still counted. They have no matching records row,
        // so we fall back to tc.ts / tc.tool for filtering.
        const drRaw = getDateRangeFilter(range, from, to, 'r', weekStart)
        const dr = {
          where: drRaw.where.replaceAll('r.ts', 'COALESCE(r.ts, tc.ts)'),
          params: drRaw.params,
        }
        const tool = url.searchParams.get('tool')
        const tfRaw = getToolFilter(tool, 'r')
        const tf = {
          where: tfRaw.where.replaceAll('r.tool', 'COALESCE(r.tool, tc.tool)'),
          params: tfRaw.params,
        }
        const toolType = url.searchParams.get('toolType')
        if (toolType && !['mcp', 'skill', 'builtin'].includes(toolType)) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid toolType' } }, 400)
          return
        }
        const ttf = getToolTypeFilter(toolType)

        const totalRow = db.prepare(`
          SELECT COUNT(*) AS total FROM tool_calls tc
          LEFT JOIN records r ON r.id = tc.record_id
          WHERE 1=1 ${dr.where} ${tf.where} ${ttf}
        `).get({ ...dr.params, ...tf.params }) as any
        const total = totalRow.total || 1

        const rows = db.prepare(`
          SELECT tc.name, COUNT(*) AS count
          FROM tool_calls tc
          LEFT JOIN records r ON r.id = tc.record_id
          WHERE 1=1 ${dr.where} ${tf.where} ${ttf}
          GROUP BY tc.name ORDER BY count DESC
        `).all({ ...dr.params, ...tf.params }) as any[]

        const toolCalls = rows.map(r => {
          const type = classifyToolCall(r.name)
          const mcpParsed = type === 'mcp' ? parseMcpName(r.name) : null
          const displayName = mcpParsed
            ? mcpParsed.display
            : (type === 'skill' && r.name.startsWith('skill__'))
              ? r.name.slice('skill__'.length)
              : r.name
          return {
            name: r.name,
            displayName,
            mcpServer: mcpParsed ? mcpParsed.server : null,
            type,
            count: r.count,
            percentage: Math.round((r.count / total) * 1000) / 10,
          }
        })

        json(res, { toolCalls })
        return
      }

      // ── /api/sessions/:sessionId ──────────────────────────────────
      if (url.pathname.startsWith('/api/sessions/') && req.method === 'GET') {
        const sessionId = decodeURIComponent(url.pathname.slice('/api/sessions/'.length))
        if (!sessionId) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'Missing sessionId' } }, 400)
          return
        }

        const toolParam = url.searchParams.get('tool')
        const deviceParam = url.searchParams.get('device')

        // Build optional filters
        const toolClause = toolParam ? 'AND tool = @tool' : ''
        const deviceClause = deviceParam ? 'AND device_instance_id = @device' : ''
        const filterParams: Record<string, unknown> = { sessionId }
        if (toolParam) filterParams.tool = toolParam
        if (deviceParam) filterParams.device = deviceParam

        // Session metadata
        const meta = db.prepare(`
          SELECT session_id AS sessionId,
                 tool, model,
                 MIN(ts) AS firstTs,
                 MAX(ts) AS lastTs,
                 MAX(ts) - MIN(ts) AS duration,
                 SUM(input_tokens) AS inputTokens,
                 SUM(output_tokens) AS outputTokens,
                 SUM(cache_read_tokens) AS cacheReadTokens,
                 SUM(cache_write_tokens) AS cacheWriteTokens,
                 SUM(thinking_tokens) AS thinkingTokens,
                 SUM(cost) AS cost,
                 COUNT(*) AS recordCount
          FROM records
          WHERE session_id = @sessionId ${toolClause} ${deviceClause}
          GROUP BY session_id, tool, model
          ORDER BY MIN(ts) ASC
          LIMIT 1
        `).get(filterParams) as any

        // Fetch cwd from the first record that has one
        const cwdRow = db.prepare(`
          SELECT cwd FROM records
          WHERE session_id = @sessionId AND cwd != '' ${toolClause} ${deviceClause}
          LIMIT 1
        `).get(filterParams) as any
        const cwd = cwdRow?.cwd || ''

        if (!meta) {
          json(res, { error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404)
          return
        }

        // Records in ascending order
        const records = db.prepare(`
          SELECT id, ts, model,
                 input_tokens AS inputTokens,
                 output_tokens AS outputTokens,
                 cache_read_tokens AS cacheReadTokens,
                 cache_write_tokens AS cacheWriteTokens,
                 thinking_tokens AS thinkingTokens,
                 cost
          FROM records
          WHERE session_id = @sessionId ${toolClause} ${deviceClause}
          ORDER BY ts ASC
        `).all(filterParams) as any[]

        // Tool calls for all records in this session
        const rToolClause = toolParam ? 'AND r.tool = @tool' : ''
        const rDeviceClause = deviceParam ? 'AND r.device_instance_id = @device' : ''
        const toolCallRows = db.prepare(`
          SELECT tc.record_id AS recordId, tc.name, tc.ts, tc.call_index AS callIndex
          FROM tool_calls tc
          JOIN records r ON r.id = tc.record_id
          WHERE r.session_id = @sessionId ${rToolClause} ${rDeviceClause}
          ORDER BY tc.record_id, tc.call_index ASC
        `).all(filterParams) as any[]

        // Group tool calls by record_id
        const toolCallsByRecord: Record<string, any[]> = {}
        for (const tc of toolCallRows) {
          if (!toolCallsByRecord[tc.recordId]) toolCallsByRecord[tc.recordId] = []
          const type = classifyToolCall(tc.name)
          const mcpParsed = type === 'mcp' ? parseMcpName(tc.name) : null
          const displayName = mcpParsed
            ? mcpParsed.display
            : (type === 'skill' && tc.name.startsWith('skill__'))
              ? tc.name.slice('skill__'.length)
              : tc.name
          toolCallsByRecord[tc.recordId].push({
            name: tc.name,
            displayName,
            type,
            ts: tc.ts,
            callIndex: tc.callIndex,
          })
        }

        const toolCallCount = toolCallRows.length

        json(res, {
          session: { ...meta, toolCallCount, cwd },
          records: records.map(r => ({
            ...r,
            toolCalls: toolCallsByRecord[r.id] ?? [],
          })),
        })
        return
      }

      // ── /api/sessions ─────────────────────────────────────────────
      if (url.pathname === '/api/sessions') {
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
        const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') || '50', 10)))

        const dr = getDateRangeFilter(range, from, to, 'r', weekStart)
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const tool = url.searchParams.get('tool')

        if (device && !df.localOnly && !df.useUnion) {
          json(res, {
            sessions: [],
            total: 0,
            page,
            pageSize,
          })
          return
        }

        const tf = getToolFilter(tool, 'r')
        const params: Record<string, unknown> = { ...dr.params, ...tf.params }

        const totalRow = db.prepare(`
          SELECT COUNT(DISTINCT r.session_id) AS total
          FROM records r
          WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER_R : ''} ${tf.where}
        `).get(params) as any

        const sessions = db.prepare(`
          SELECT r.session_id AS sessionId,
                 r.tool,
                 r.model,
                 MIN(r.ts) AS ts,
                 MAX(r.ts) - MIN(r.ts) AS duration,
                 SUM(r.input_tokens) AS inputTokens,
                 SUM(r.output_tokens) AS outputTokens,
                 SUM(r.cache_read_tokens) AS cacheReadTokens,
                 SUM(r.cache_write_tokens) AS cacheWriteTokens,
                 SUM(r.cost) AS cost,
                 COUNT(DISTINCT tc.id) AS toolCallCount
          FROM records r
          LEFT JOIN tool_calls tc ON tc.record_id = r.id
          WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER_R : ''} ${tf.where}
          GROUP BY r.session_id
          ORDER BY MIN(r.ts) DESC
          LIMIT @limit OFFSET @offset
        `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as any[]

        json(res, {
          sessions,
          // dr and tf above are prefixed for the aliased "records r"; the
          // counts read the table unaliased, so they need the same filters
          // spelled without the prefix.
          ...countUnpricedRecords(db, unpricedScopeFor(
            getDateRangeFilter(range, from, to, '', weekStart),
            df,
            getToolFilter(tool),
          )),
          total: totalRow.total,
          page,
          pageSize,
        })
        return
      }

      // ── /api/agent ────────────────────────────────────────────────
      // Writes here carry their own token regardless of the bind. serve now
      // defaults to loopback, but the token is what makes --host 0.0.0.0 safe
      // to offer at all, and it does not depend on the dashboard password
      // being set.
      if (url.pathname.startsWith('/api/agent/')) {
        const isWrite = req.method === 'POST'
        if (isWrite && !hasValidIngestToken(req)) {
          json(res, { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid ingest token' } }, 401)
          return
        }

        try {
          if (url.pathname === '/api/agent/events' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const raw = Array.isArray(body.events) ? body.events : null
            if (!raw) {
              json(res, { error: { code: 'INVALID_PARAM', message: 'events array required' } }, 400)
              return
            }
            if (raw.length > MAX_AGENT_EVENT_BATCH) {
              json(res, {
                error: { code: 'INVALID_PARAM', message: `At most ${MAX_AGENT_EVENT_BATCH} events per request` },
              }, 400)
              return
            }

            const events: AgentEventInput[] = []
            for (const entry of raw as Array<Record<string, unknown>>) {
              const invalid = validateAgentEvent(entry)
              if (invalid) {
                json(res, { error: { code: 'INVALID_PARAM', message: invalid } }, 400)
                return
              }
              events.push(entry as unknown as AgentEventInput)
            }

            const result = await runDbWrite(() => applyAgentEvents(db, events, agentContext(), agentEmitter))
            json(res, { ok: true, ...result })
            return
          }

          if (url.pathname === '/api/agent/heartbeat' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const invalid = validateAgentEvent({ ...body, kind: 'heartbeat' })
            if (invalid) {
              json(res, { error: { code: 'INVALID_PARAM', message: invalid } }, 400)
              return
            }
            const event = { ...body, kind: 'heartbeat', source: 'heartbeat' } as unknown as AgentEventInput
            const result = await runDbWrite(() => applyAgentEvents(db, [event], agentContext(), agentEmitter))
            json(res, { ok: true, ...result })
            return
          }

          const statusMatch = /^\/api\/agent\/sessions\/([^/]+)\/status$/.exec(url.pathname)
          if (statusMatch && req.method === 'POST') {
            const body = await readJsonBody(req)
            if (!isAgentStatus(body.status)) {
              json(res, { error: { code: 'INVALID_PARAM', message: 'Unknown status' } }, 400)
              return
            }
            const existing = db.prepare(
              'SELECT agent_session_id, tool, device_instance_id FROM agent_sessions WHERE id = ?'
            ).get(decodeURIComponent(statusMatch[1])) as
              { agent_session_id: string; tool: string; device_instance_id: string } | undefined
            if (!existing) {
              json(res, { error: { code: 'NOT_FOUND', message: 'Unknown session' } }, 404)
              return
            }

            const event: AgentEventInput = {
              sessionId: existing.agent_session_id,
              tool: existing.tool,
              deviceInstanceId: existing.device_instance_id,
              kind: 'manual',
              source: 'manual',
              status: body.status,
              detail: typeof body.detail === 'string' ? body.detail : undefined,
              ts: Date.now(),
            }
            const result = await runDbWrite(() => applyAgentEvents(db, [event], agentContext(), agentEmitter))
            json(res, { ok: true, ...result })
            return
          }

          if (url.pathname === '/api/agent/sessions' && req.method === 'GET') {
            const status = url.searchParams.get('status')
            if (status && !isAgentStatus(status)) {
              json(res, { error: { code: 'INVALID_PARAM', message: 'Unknown status' } }, 400)
              return
            }
            const tool = url.searchParams.get('tool')
            if (tool && !TOOLS.includes(tool as never)) {
              json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid tool' } }, 400)
              return
            }
            json(res, listAgentSessions(db, {
              status,
              tool,
              device: url.searchParams.get('device'),
              project: url.searchParams.get('project'),
              active: url.searchParams.get('active') === 'true',
              limit: Number(url.searchParams.get('limit')) || undefined,
              offset: Number(url.searchParams.get('offset')) || undefined,
            }, Date.now()))
            return
          }

          if (url.pathname === '/api/agent/stream' && req.method === 'GET') {
            openAgentStream(req, res, agentEmitter)
            return
          }

          if (url.pathname === '/api/agent/summary' && req.method === 'GET') {
            json(res, summariseAgentSessions(db, Date.now()))
            return
          }

          const detailMatch = /^\/api\/agent\/sessions\/([^/]+)$/.exec(url.pathname)
          if (detailMatch && req.method === 'GET') {
            const detail = getAgentSession(db, decodeURIComponent(detailMatch[1]), Date.now())
            if (!detail) {
              json(res, { error: { code: 'NOT_FOUND', message: 'Unknown session' } }, 404)
              return
            }
            json(res, detail)
            return
          }
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            databaseBusy(res)
            return
          }
          throw error
        }
      }

      // ── /api/push ─────────────────────────────────────────────────
      // Everything here is behind the same auth gate as the rest of /api/.
      // p256dh and auth go in and are never read back out: they are the keys
      // that let anyone push to that browser.
      if (url.pathname.startsWith('/api/push')) {
        try {
          if (url.pathname === '/api/push/status' && req.method === 'GET') {
            const cfg = loadConfig()
            json(res, {
              // The public key is meant to be public — the browser needs it
              // to subscribe at all.
              publicKey: cfg?.vapid?.publicKey ?? null,
              configured: cfg?.vapid?.publicKey != null
                && loadCredential(VAPID_PRIVATE_KEY_CREDENTIAL) != null,
              enabled: cfg?.notifications?.channels?.webpush === true,
              subject: cfg?.vapid?.subject ?? DEFAULT_VAPID_SUBJECT,
              subscriptions: summarisePushSubscriptions(db),
            })
            return
          }

          if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
            const keys = (body.keys ?? {}) as { p256dh?: unknown; auth?: unknown }
            if (!endpoint || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
              json(res, {
                error: { code: 'INVALID_PARAM', message: 'endpoint and keys are required' },
              }, 400)
              return
            }
            const id = await runDbWrite(() => savePushSubscription(db, {
              endpoint,
              p256dh: keys.p256dh as string,
              auth: keys.auth as string,
              label: typeof body.label === 'string' ? body.label.slice(0, 60) : '',
              userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
              deviceInstanceId: options?.currentDeviceInstanceId ?? '',
            }, Date.now()))
            json(res, { ok: true, id })
            return
          }

          if (url.pathname === '/api/push/test' && req.method === 'POST') {
            const cfg = loadConfig()
            const enqueued = await runDbWrite(() => enqueueNotification(db, {
              channel: WEBPUSH_CHANNEL,
              eventType: 'test',
              subjectKind: 'system',
              subjectId: 'test',
              dedupeKey: `webpush:test:${Date.now()}:${randomBytes(4).toString('hex')}`,
              title: `${cfg?.notifications?.prefix ?? '[aiusage] '}✅ ${getDeviceName()}｜通知テスト`,
              body: 'aiusage からスマートフォンへの疎通確認です。',
              deviceInstanceId: options?.currentDeviceInstanceId ?? '',
              drop: cfg?.notifications?.notifierDevice !== true,
              dropReason: 'not the notifier device',
            }, Date.now()))
            json(res, {
              ok: true,
              enqueued,
              enabled: cfg?.notifications?.enabled === true,
              channelEnabled: cfg?.notifications?.channels?.webpush === true,
              subscriptions: summarisePushSubscriptions(db).length,
              notifierDevice: cfg?.notifications?.notifierDevice === true,
            })
            return
          }

          const pushDelete = /^\/api\/push\/subscriptions\/([^/]+)$/.exec(url.pathname)
          if (pushDelete && req.method === 'DELETE') {
            const removed = await runDbWrite(() =>
              deletePushSubscription(db, decodeURIComponent(pushDelete[1])))
            if (!removed) {
              json(res, { error: { code: 'NOT_FOUND', message: 'Unknown subscription' } }, 404)
              return
            }
            json(res, { ok: true })
            return
          }
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            json(res, { error: { code: 'BUSY', message: 'Database is busy' } }, 503)
            return
          }
          throw error
        }
      }

      // ── /api/notifications ────────────────────────────────────────
      // The outbox never stores the webhook, and last_error is masked before
      // it is written, so nothing returned here can carry the URL.
      if (url.pathname.startsWith('/api/notifications')) {
        try {
          if (url.pathname === '/api/notifications' && req.method === 'GET') {
            json(res, listNotifications(db, {
              state: url.searchParams.get('state'),
              subjectKind: url.searchParams.get('subjectKind'),
              limit: Number(url.searchParams.get('limit')) || undefined,
            }))
            return
          }

          if (url.pathname === '/api/notifications/summary' && req.method === 'GET') {
            json(res, summariseNotifications(db, Date.now()))
            return
          }

          if (url.pathname === '/api/notifications/test' && req.method === 'POST') {
            const cfg = loadConfig()
            const enqueued = await runDbWrite(() => enqueueNotification(db, {
              eventType: 'test',
              subjectKind: 'system',
              subjectId: 'test',
              // Unique per request: a test is worth repeating on demand.
              dedupeKey: `test:${Date.now()}:${randomBytes(4).toString('hex')}`,
              title: `${cfg?.notifications?.prefix ?? '[aiusage] '}✅ ${getDeviceName()}｜通知テスト`,
              body: 'aiusage から Discord への疎通確認です。',
              deviceInstanceId: options?.currentDeviceInstanceId ?? '',
              drop: cfg?.notifications?.notifierDevice !== true,
              dropReason: 'not the notifier device',
            }, Date.now()))
            json(res, {
              ok: true,
              enqueued,
              enabled: cfg?.notifications?.enabled === true,
              webhookConfigured: loadCredential(DISCORD_WEBHOOK_CREDENTIAL) != null,
              notifierDevice: cfg?.notifications?.notifierDevice === true,
            })
            return
          }

          const retryMatch = /^\/api\/notifications\/([^/]+)\/retry$/.exec(url.pathname)
          if (retryMatch && req.method === 'POST') {
            const ok = await runDbWrite(() =>
              retryNotification(db, decodeURIComponent(retryMatch[1]), Date.now()))
            if (!ok) {
              json(res, { error: { code: 'NOT_FOUND', message: 'No retryable notification with that id' } }, 404)
              return
            }
            json(res, { ok: true })
            return
          }
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            databaseBusy(res)
            return
          }
          throw error
        }
      }

      // ── /api/projects ─────────────────────────────────────────────
      if (url.pathname === '/api/projects') {
        const dr = getDateRangeFilter(range, from, to, '', weekStart)
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const tool = url.searchParams.get('tool')
        const tf = getToolFilter(tool)

        let rows: any[]

        if (df.where && !df.useUnion) {
          // Specific other device: query synced_records which now carry source_file and cwd
          rows = db.prepare(`
            SELECT source_file, cwd,
                   COUNT(*) AS sessionCount,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
                   SUM(cost) AS cost
            FROM synced_records WHERE 1=1 ${df.where} ${tf.where}
            GROUP BY source_file ORDER BY totalTokens DESC
          `).all({ ...df.params, ...tf.params }) as any[]
        } else {
          rows = db.prepare(`
            SELECT source_file, cwd,
                   COUNT(*) AS sessionCount,
                   SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS totalTokens,
                   SUM(cost) AS cost
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''} ${tf.where}
            GROUP BY source_file ORDER BY totalTokens DESC
          `).all({ ...dr.params, ...tf.params }) as any[]
        }

        // Build a cwd inference map for Claude Code paths: encoded project dir → cwd.
        // Records without cwd can inherit it from another session in the same project directory.
        const cwdByEncodedDir: Record<string, string> = {}
        for (const row of rows) {
          if (row.cwd && row.source_file) {
            const m = (row.source_file as string).replace(/\\/g, '/').match(/\.claude\/projects\/([^/]+)/)
            if (m && !cwdByEncodedDir[m[1]]) cwdByEncodedDir[m[1]] = row.cwd
          }
        }

        // Aggregate by project
        const projectMap: Record<string, { sessions: number; tokens: number; cost: number; fullPath: string }> = {}
        for (const row of rows) {
          if (!row.source_file) continue
          let effectiveCwd: string = row.cwd || ''
          if (!effectiveCwd) {
            const m = (row.source_file as string).replace(/\\/g, '/').match(/\.claude\/projects\/([^/]+)/)
            if (m) effectiveCwd = cwdByEncodedDir[m[1]] || ''
          }
          const fromCwd = effectiveCwd ? extractProjectFromCwd(effectiveCwd) : null
          const project = (fromCwd && fromCwd !== 'unknown') ? fromCwd : extractProject(row.source_file)
          if (!projectMap[project]) projectMap[project] = { sessions: 0, tokens: 0, cost: 0, fullPath: effectiveCwd || row.source_file }
          projectMap[project].sessions += row.sessionCount
          projectMap[project].tokens += row.totalTokens
          projectMap[project].cost += row.cost
        }

        const totalTokens = Object.values(projectMap).reduce((s, p) => s + p.tokens, 0) || 1
        const projects = Object.entries(projectMap)
          .map(([name, data]) => ({
            name,
            sessions: data.sessions,
            tokens: data.tokens,
            cost: data.cost,
            percentage: Math.round((data.tokens / totalTokens) * 1000) / 10,
            fullPath: data.fullPath,
          }))
          .sort((a, b) => b.tokens - a.tokens)

        // See /api/models: the counts follow this screen's own scope.
        json(res, { projects, ...countUnpricedRecords(db, unpricedScopeFor(dr, df, tf)) })
        return
      }

      // ── /api/pricing ────────────────────────────────────────────────
      if (url.pathname === '/api/pricing') {
        // GET: list all prices from the local pricing registry plus models from DB.
        if (req.method === 'GET') {
          json(res, {
            models: listPricingModels(db),
            registry: getPricingRegistrySummary(db),
            targets: listPricingAliasTargets(db),
            aliasBindings: getUserAliasBindings(db),
            localBindings: listLocalModelBindings(db),
            // Which models the reader has accepted as having no published
            // rate. Config, not registry — it is not a price.
            acknowledgedUnpriced: loadConfig()?.acknowledgedUnpricedModels ?? [],
          })
          return
        }
        // PUT: set price override
        if (req.method === 'PUT') {
          let body = ''
          for await (const chunk of req) body += chunk
          let data: Record<string, unknown>
          try {
            data = JSON.parse(body)
          } catch {
            json(res, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400)
            return
          }
          if (!data.model || typeof data.input !== 'number' || typeof data.output !== 'number') {
            json(res, { error: { code: 'INVALID_PARAM', message: 'model, input, output required' } }, 400)
            return
          }
          const entry: PriceEntry = {
            input: data.input,
            output: data.output,
            cacheRead: data.cacheRead as number | undefined,
            cacheWrite: data.cacheWrite as number | undefined,
          }
          if (data.currency === 'CNY') {
            entry.currency = 'CNY'
          }
          try {
            await runDbWrite(() => {
              setUserPrice(db, data.model as string, entry)
              const cfg = loadConfig() ?? {}
              cfg.priceOverrides = { ...cfg.priceOverrides, [data.model as string]: entry }
              saveConfig(cfg)
              loadPricingRuntime(db, cfg)
            })
          } catch (error) {
            if (isDatabaseLockedError(error)) {
              databaseBusy(res)
              return
            }
            throw error
          }
          json(res, { ok: true, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
          return
        }
        // DELETE: remove price override
        if (req.method === 'DELETE') {
          const model = url.searchParams.get('model')
          if (!model) {
            json(res, { error: { code: 'INVALID_PARAM', message: 'model param required' } }, 400)
            return
          }
          try {
            await runDbWrite(() => {
              resetUserPriceToSynced(db, model)
              removePriceOverride(model)
              const cfg = loadConfig() ?? {}
              if (cfg.priceOverrides) {
                delete cfg.priceOverrides[model]
                saveConfig(cfg)
              }
              loadPricingRuntime(db, cfg)
            })
            json(res, { ok: true, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
          } catch (error) {
            if (isDatabaseLockedError(error)) {
              databaseBusy(res)
              return
            }
            throw error
          }
          return
        }
      }

      // ── /api/pricing/acknowledge ───────────────────────────────────
      /*
       * Mark a model as having no published rate, or take that back.
       *
       * Not a price, and it writes none: the rows keep cost 0 and
       * cost_source 'unknown'. All it changes is which sentence describes
       * them on screen — a warning you can act on, or a fact you cannot.
       *
       * Kept in config.json rather than the price registry so that
       * pressing Reset next to it cannot take it away, and so that it can
       * never be mistaken for a rate.
       */
      if (url.pathname === '/api/pricing/acknowledge' && req.method === 'PUT') {
        let body = ''
        for await (const chunk of req) body += chunk
        let data: { model?: unknown; acknowledged?: unknown }
        try {
          data = JSON.parse(body)
        } catch {
          json(res, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400)
          return
        }
        if (typeof data.model !== 'string' || !data.model.trim()) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'model is required' } }, 400)
          return
        }
        const model = data.model.trim()
        const on = data.acknowledged !== false

        await runDbWrite(() => {
          const cfg = loadConfig() ?? {}
          const current = new Set(cfg.acknowledgedUnpricedModels ?? [])
          if (on) current.add(model)
          else current.delete(model)
          saveConfig({ ...cfg, acknowledgedUnpricedModels: [...current].sort() })
        })

        json(res, { ok: true, acknowledged: on, model })
        return
      }

      if (url.pathname === '/api/pricing/alias' && req.method === 'POST') {
        try {
          const data = await readJsonBody(req)
          if (typeof data.alias !== 'string' || typeof data.modelKey !== 'string') {
            json(res, { error: { code: 'INVALID_PARAM', message: 'alias and modelKey required' } }, 400)
            return
          }
          await runDbWrite(() => {
            setUserPricingAlias(db, data.alias, data.modelKey)
            loadPricingRuntime(db, loadConfig())
          })
          json(res, { ok: true, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            databaseBusy(res)
            return
          }
          json(res, { error: { code: 'INVALID_PARAM', message: error instanceof Error ? error.message : 'Invalid pricing alias' } }, 400)
        }
        return
      }

      if (url.pathname === '/api/pricing/alias' && req.method === 'DELETE') {
        const alias = url.searchParams.get('alias')
        if (!alias) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'alias param required' } }, 400)
          return
        }
        try {
          await runDbWrite(() => {
            removeUserPricingAlias(db, alias)
            loadPricingRuntime(db, loadConfig())
          })
          json(res, { ok: true, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            databaseBusy(res)
            return
          }
          json(res, { error: { code: 'INVALID_PARAM', message: error instanceof Error ? error.message : 'Invalid pricing alias' } }, 400)
        }
        return
      }

      if (url.pathname === '/api/pricing/sync' && req.method === 'POST') {
        try {
          const summary = await runDbWrite(async () => {
            const summary = await syncPricingFromLitellm(db)
            loadPricingRuntime(db, loadConfig())
            return summary
          })
          json(res, { ok: true, summary, needsRecalc: true, needsRecalcSince: markPricingNeedsRecalc() })
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            databaseBusy(res)
            return
          }
          json(res, { error: { code: 'SYNC_FAILED', message: error instanceof Error ? error.message : 'Pricing sync failed' } }, 502)
        }
        return
      }

      // ── /api/pricing/recalc ─────────────────────────────────────────
      if (url.pathname === '/api/pricing/recalc' && req.method === 'GET') {
        json(res, currentPricingRecalcStatus())
        return
      }

      if (url.pathname === '/api/pricing/recalc' && req.method === 'POST') {
        const result = startPricingRecalc()
        json(res, result, result.accepted ? 202 : 200)
        return
      }

      // ── /api/health ────────────────────────────────────────────────
      /*
       * What the log cannot say.
       *
       * A scheduled parse only writes a line when it found something, so a
       * quiet log means either "nothing to do" or "not running" and there is
       * no way to tell which from the outside. This answers that directly,
       * and can be asked whenever the question comes up rather than only
       * while someone is tailing a file.
       *
       * The verdict is the controller's; nothing is recomputed here, so the
       * banner and the notification cannot disagree.
       */
      if (url.pathname === '/api/health') {
        const parse = options?.getParseHealth?.() ?? null
        json(res, {
          ok: parse ? !parse.stalled : true,
          parse,
          web: { version: options?.getWebVersion?.() ?? null },
          now: Date.now(),
        })
        return
      }

      // ── /api/sync/records ──────────────────────────────────────────
      /**
       * Usage records arriving from another machine on the tailnet.
       *
       * The hub is whichever install polls quotas and sends the
       * notifications; the others parse their own logs and post the results
       * here so the totals are added up in one place. One direction only —
       * nothing is sent back, and deletions are not propagated (see D25).
       *
       * Nothing here decides what a record means. insertSyncedRecord already
       * refuses to overwrite a newer row with an older one, and the id is
       * derived from the sending device, so a resend is an update rather than
       * a duplicate. This endpoint is the HTTP around that.
       */
      if (url.pathname === '/api/sync/records') {
        if (req.method !== 'POST') {
          json(res, { error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } }, 405)
          return
        }
        let body: Record<string, unknown>
        try {
          body = await readJsonBodyLimited(req, MAX_SYNC_PAYLOAD_BYTES)
        } catch (error) {
          if (error instanceof PayloadTooLarge) {
            json(res, {
              error: {
                code: 'PAYLOAD_TOO_LARGE',
                message: `Body exceeds ${MAX_SYNC_PAYLOAD_BYTES} bytes`,
                maxBytes: MAX_SYNC_PAYLOAD_BYTES,
                maxRecords: MAX_SYNC_RECORDS_PER_REQUEST,
              },
            }, 413)
            return
          }
          json(res, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400)
          return
        }

        const records = Array.isArray(body.records) ? body.records : null
        if (!records) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'records must be an array' } }, 400)
          return
        }
        if (records.length > MAX_SYNC_RECORDS_PER_REQUEST) {
          // Two ceilings, because either one can be hit first: many tiny
          // records, or few with long paths in them. The sender is told both
          // so it can split without guessing.
          json(res, {
            error: {
              code: 'TOO_MANY_RECORDS',
              message: `At most ${MAX_SYNC_RECORDS_PER_REQUEST} records per request`,
              maxBytes: MAX_SYNC_PAYLOAD_BYTES,
              maxRecords: MAX_SYNC_RECORDS_PER_REQUEST,
            },
          }, 413)
          return
        }

        try {
          let accepted = 0
          let rejected = 0
          let merged = 0
          await runDbWrite(() => {
            for (const raw of records) {
              const record = normalizeIncomingSyncRecord(raw)
              if (!record) { rejected++; continue }
              // The return value is "did this change anything", which is
              // false for a record already held at the same or a newer
              // version. Not an error — a resend landing on a no-op is the
              // system working.
              insertSyncedRecord(db, record)
              accepted++
            }

            /*
             * synced_records is a holding table; records is what the
             * dashboard reads. Everything else that fills the first also
             * runs this merge, but it runs it as the last step of a sync
             * pass — and a hub that receives records directly may never do a
             * sync pass at all.
             *
             * Left out, this endpoint accepted uploads, answered 200, filled
             * synced_records, and showed nothing: 13,497 rows arrived and
             * the dashboard still read zero. Doing it here means arriving
             * and appearing are the same event.
             */
            if (accepted > 0) merged = mergeSyncedRecordsIntoRecords(db)
          })
          json(res, { ok: true, accepted, rejected, merged })
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            json(res, { error: { code: 'BUSY', message: 'Database is busy' } }, 503)
            return
          }
          throw error
        }
        return
      }

      // ── /api/sync ──────────────────────────────────────────────────
      if (url.pathname === '/api/sync') {
        if (req.method === 'POST') {
          if (!options?.onSyncStart) {
            json(res, { error: { code: 'NOT_AVAILABLE', message: 'Sync not configured' } }, 501)
            return
          }
          const result = options.onSyncStart()
          json(res, result, result.accepted ? 202 : 200)
          return
        }
        // GET: sync status
        const status = options?.getSyncStatus?.() ?? null
        json(res, { status })
        return
      }

      // ── /api/refresh ────────────────────────────────────────────────
      if (url.pathname === '/api/refresh') {
        if (!options?.onRefresh) {
          json(res, { error: { code: 'NOT_AVAILABLE', message: 'Refresh not available' } }, 501)
          return
        }
        try {
          const result = await runDbWrite(() => options.onRefresh!())
          json(res, result)
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            databaseBusy(res)
            return
          }
          throw error
        }
        return
      }

      // ── /api/quotas ───────────────────────────────────────────────
      // Public (see shouldProtectApiPath) — never put credentials in here.
      if (url.pathname === '/api/quotas' && req.method === 'GET') {
        const results = await queryAllQuotas()
        json(res, {
          quotas: withStaleQuotaFallback(
            db,
            results as unknown as Array<Record<string, unknown>>,
            options?.currentDeviceInstanceId ?? '',
          ),
        })
        return
      }

      // ── /api/quotas/history ───────────────────────────────────────
      if (url.pathname === '/api/quotas/history' && req.method === 'GET') {
        const range = url.searchParams.get('range') ?? 'week'
        if (!QUOTA_HISTORY_RANGES.has(range)) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid range' } }, 400)
          return
        }

        const from = parseTimeParam(url.searchParams.get('from'))
        const to = parseTimeParam(url.searchParams.get('to'))
        if ((url.searchParams.get('from') && from == null) || (url.searchParams.get('to') && to == null)) {
          json(res, { error: { code: 'INVALID_PARAM', message: 'Invalid from/to' } }, 400)
          return
        }

        const conditions: string[] = []
        const params: Record<string, unknown> = {}

        const tool = url.searchParams.get('tool')
        if (tool) {
          conditions.push('tool = @tool')
          params.tool = tool
        }
        const tier = url.searchParams.get('tier')
        if (tier) {
          conditions.push('tier = @tier')
          params.tier = tier
        }
        const device = url.searchParams.get('device')
        if (device) {
          conditions.push('device_instance_id = @device')
          params.device = device
        }

        // Explicit from/to wins over the named range.
        const start = from ?? quotaHistoryStart(range, Date.now())
        if (start != null) {
          conditions.push('ts >= @start')
          params.start = start
        }
        if (to != null) {
          conditions.push('ts <= @end')
          params.end = to
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
        const rows = db.prepare(`
          SELECT tool, tier, window_id, ts, utilization, resets_at
          FROM quota_snapshots
          ${where}
          ORDER BY tool, tier, window_id, ts
        `).all(params) as Array<{
          tool: string
          tier: string
          window_id: string
          ts: number
          utilization: number
          resets_at: number | null
        }>

        const grouped = new Map<string, {
          tool: string
          tier: string
          windowId: string
          resetsAt: number | null
          points: Array<{ ts: number; utilization: number }>
        }>()
        for (const row of rows) {
          const key = `${row.tool} ${row.tier} ${row.window_id}`
          let series = grouped.get(key)
          if (!series) {
            series = { tool: row.tool, tier: row.tier, windowId: row.window_id, resetsAt: row.resets_at, points: [] }
            grouped.set(key, series)
          }
          series.resetsAt = row.resets_at
          series.points.push({ ts: row.ts, utilization: row.utilization })
        }

        let truncated = false
        const series = [...grouped.values()].map((entry) => {
          const points = downsampleSeries(entry.points, QUOTA_HISTORY_MAX_POINTS)
          if (points.length < entry.points.length) truncated = true
          return { ...entry, points }
        })

        json(res, { series, truncated })
        return
      }

      // ── /api/quotas/forecast ──────────────────────────────────────
      if (url.pathname === '/api/quotas/forecast' && req.method === 'GET') {
        const device = url.searchParams.get('device')
        const now = Date.now()
        const currentRows = readQuotaCurrent(db, device)

        const samplesStmt = db.prepare(`
          SELECT ts, utilization FROM quota_snapshots
          WHERE tool = @tool AND tier = @tier AND device_instance_id = @device AND window_id = @windowId
          ORDER BY ts
        `)
        // gap_detected windows are excluded: their final_utilization is the
        // last value we happened to see before polling stopped, not the value
        // the window ended on, so it would drag the p90 down.
        const finalsStmt = db.prepare(`
          SELECT final_utilization FROM quota_windows
          WHERE tool = @tool AND tier = @tier AND device_instance_id = @device
            AND closed_at IS NOT NULL AND final_utilization IS NOT NULL
            AND gap_detected = 0
          ORDER BY closed_at DESC
          LIMIT @limit
        `)

        const forecasts = currentRows.map((row) => {
          const samples = samplesStmt.all({
            tool: row.tool,
            tier: row.tier,
            device: row.device_instance_id,
            windowId: row.window_id,
          }) as Array<{ ts: number; utilization: number }>
          const forecast = forecastQuota({
            samples,
            tier: row.tier,
            resetsAt: row.resets_at,
            now,
          })
          const finals = (finalsStmt.all({
            tool: row.tool,
            tier: row.tier,
            device: row.device_instance_id,
            limit: QUOTA_P90_WINDOW_LIMIT,
          }) as Array<{ final_utilization: number }>).map((r) => r.final_utilization)

          return {
            tool: row.tool,
            tier: row.tier,
            windowId: row.window_id,
            // quota_current is newer than the last snapshot when nothing moved.
            current: row.utilization,
            resetsAt: forecast.resetsAt,
            windowStartedAt: forecast.windowStartedAt,
            windowStartInferred: forecast.windowStartInferred,
            elapsedRatio: forecast.elapsedRatio,
            paceRatio: forecast.paceRatio,
            burnRatePerHour: forecast.burnRatePerHour,
            recentBurnRatePerHour: forecast.recentBurnRatePerHour,
            exhaustAt: forecast.exhaustAt,
            exhaustBeforeReset: forecast.exhaustBeforeReset,
            risk: forecast.risk,
            confidence: forecast.confidence,
            p90FinalUtilization: p90FinalUtilization(finals),
            stale: row.consecutive_errors > 0,
          }
        })

        json(res, { forecasts, generatedAt: now })
        return
      }

      // ── /api/quotas/refresh ───────────────────────────────────────
      if (url.pathname === '/api/quotas/refresh' && req.method === 'POST') {
        if (quotaRefreshInFlight) {
          json(res, { error: { code: 'BUSY', message: 'A quota refresh is already running' } }, 409)
          return
        }
        quotaRefreshInFlight = true
        try {
          const results = await queryAllQuotas()
          const summary = await runDbWrite(() => recordQuotaSnapshot(db, results, {
            device: getDeviceName(),
            deviceInstanceId: options?.currentDeviceInstanceId ?? '',
            now: Date.now(),
          }))
          json(res, {
            summary,
            quotas: withStaleQuotaFallback(
              db,
              results as unknown as Array<Record<string, unknown>>,
              options?.currentDeviceInstanceId ?? '',
            ),
          })
        } catch (error) {
          if (isDatabaseLockedError(error)) {
            databaseBusy(res)
            return
          }
          throw error
        } finally {
          quotaRefreshInFlight = false
        }
        return
      }

      // ── /api/leaderboard ──────────────────────────────────────────
      if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
        await proxyLeaderboard(res, url)
        return
      }

      if (url.pathname === '/api/leaderboard/upload' && req.method === 'POST') {
        try {
          const result = await uploadLeaderboardData(db, options?.currentDeviceInstanceId)
          json(res, {
            totalTokens: result.totalTokens,
            response: result.response,
          })
        } catch (err: any) {
          json(res, {
            error: {
              code: err?.code || 'UPLOAD_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
          }, err?.code === 'not_logged_in' ? 401 : 502)
        }
        return
      }

      // ── /api/leaderboard/auth ─────────────────────────────────────
      if (url.pathname === '/api/leaderboard/auth/status' && req.method === 'GET') {
        const creds = loadCredentials()
        if (!creds) {
          json(res, { loggedIn: false, siteUrl: getSiteUrl(), uploads: [] })
          return
        }

        try {
          const status = await fetchLeaderboardStatus(getSiteUrl())
          json(res, {
            loggedIn: true,
            deviceId: creds.device_id,
            deviceName: status.deviceName ?? null,
            user: status.user ?? null,
            obtainedAt: creds.obtained_at,
            siteUrl: getSiteUrl(),
            uploads: status.snapshots,
          })
        } catch (err) {
          json(res, {
            loggedIn: true,
            deviceId: creds.device_id,
            obtainedAt: creds.obtained_at,
            siteUrl: getSiteUrl(),
            uploads: [],
            statusError: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }

      if (url.pathname === '/api/leaderboard/auth/start' && req.method === 'POST') {
        if (hasCredentials()) {
          const creds = loadCredentials()
          json(res, {
            alreadyLoggedIn: true,
            deviceId: creds?.device_id ?? null,
            obtainedAt: creds?.obtained_at ?? null,
          })
          return
        }

        try {
          const verifier = base64url(randomBytes(32))
          const challenge = base64url(sha256Buffer(verifier))
          const started = await startDeviceAuth(getSiteUrl(), {
            device_name: getDeviceName(),
            cli_version: 'web',
            device_challenge: challenge,
          })
          pendingLeaderboardAuth.set(started.device_request_id, {
            verifier,
            expiresAt: new Date(started.expires_at).getTime(),
          })
          json(res, started)
        } catch (err) {
          json(res, { error: { code: 'AUTH_START_FAILED', message: err instanceof Error ? err.message : String(err) } }, 502)
        }
        return
      }

      if (url.pathname === '/api/leaderboard/auth/complete' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req)
          const requestId = typeof body.device_request_id === 'string' ? body.device_request_id : ''
          const pending = pendingLeaderboardAuth.get(requestId)
          if (!requestId || !pending) {
            json(res, { error: { code: 'INVALID_REQUEST', message: 'Unknown or expired authorization request' } }, 400)
            return
          }
          if (Date.now() > pending.expiresAt) {
            pendingLeaderboardAuth.delete(requestId)
            json(res, { error: { code: 'AUTH_EXPIRED', message: 'Authorization expired' } }, 410)
            return
          }

          const completed = await completeDeviceAuth(getSiteUrl(), {
            device_request_id: requestId,
            device_verifier: pending.verifier,
          })
          pendingLeaderboardAuth.delete(requestId)
          saveCredentials({
            device_id: completed.device_id,
            device_secret: completed.device_secret,
            obtained_at: new Date().toISOString(),
          })
          json(res, { loggedIn: true, deviceId: completed.device_id })
        } catch (err: any) {
          if (err?.code === 'authorization_pending') {
            json(res, { pending: true }, 202)
            return
          }
          json(res, { error: { code: err?.code || 'AUTH_COMPLETE_FAILED', message: err instanceof Error ? err.message : String(err) } }, 502)
        }
        return
      }

      if (url.pathname === '/api/leaderboard/auth/logout' && req.method === 'POST') {
        clearCredentials()
        json(res, { ok: true })
        return
      }

      // ── /api/devices ──────────────────────────────────────────────
      if (url.pathname === '/api/devices') {
        const currentId = options?.currentDeviceInstanceId
        if (!currentId) {
          json(res, { currentDeviceInstanceId: null, devices: [] })
          return
        }

        const config = loadConfig()
        const currentDeviceAlias = config?.device || hostname()

        // Current device: only local records (not merged from synced)
        const localRows = db.prepare(`
          SELECT device, device_instance_id AS deviceInstanceId, COUNT(*) AS recordCount
          FROM records
          WHERE device_instance_id = @currentId AND source_file NOT LIKE 'synced/%'
          GROUP BY device_instance_id
        `).all({ currentId }) as any[]

        // Other devices from synced_records (exclude current device's copy)
        const syncedRows = db.prepare(`
          SELECT device, device_instance_id AS deviceInstanceId, platform, COUNT(*) AS recordCount
          FROM synced_records
          WHERE device_instance_id != @currentId
          GROUP BY device_instance_id
        `).all({ currentId }) as any[]

        function getDisplayName(device: string, deviceInstanceId: string): string {
          if (deviceInstanceId === currentId) return currentDeviceAlias
          if (device && device !== 'unknown' && !/^[0-9a-f]{8}$/.test(device)) return device
          if (/^[0-9a-f]{8}-/.test(deviceInstanceId)) return deviceInstanceId.slice(0, 8)
          if (device && device !== 'unknown') return device
          return 'Unknown Device'
        }

        function getPlatformLabel(p: string | undefined): string {
          if (p === 'win32') return 'Windows'
          if (p === 'darwin') return 'macOS'
          if (p === 'linux') return 'Linux'
          return ''
        }

        // Infer platform from device name when sync record has no platform field
        function inferPlatform(device: string, deviceInstanceId: string): string {
          const name = (device || '').toLowerCase()
          const id = (deviceInstanceId || '').toLowerCase()
          // Windows hostnames: DESKTOP-XXXXX, LAPTOP-XXXXX
          if (/^(desktop|laptop)-/.test(name)) return 'Windows'
          // macOS: .local suffix, "macbook", "imac", "mac-mini"
          if (name.endsWith('.local') || /macbook|imac|mac\s*mini|mac\s*pro|mac\s*studio/.test(name)) return 'macOS'
          // Linux common hostnames
          if (/^(ubuntu|debian|centos|fedora|arch|linux|server|node|prod|dev|staging)/.test(name)) return 'Linux'
          // If displayName is just a UUID prefix (8 hex chars), platform is unknown
          return ''
        }

        // Current platform
        const currentPlatform = config?.platform || platform()

        // Merge and deduplicate
        const deviceMap = new Map<string, { device: string; deviceInstanceId: string; displayName: string; platform: string; recordCount: number }>()
        for (const row of localRows) {
          const displayName = getDisplayName(row.device, row.deviceInstanceId)
          deviceMap.set(row.deviceInstanceId, { device: row.device, deviceInstanceId: row.deviceInstanceId, displayName, platform: getPlatformLabel(currentPlatform), recordCount: row.recordCount })
        }
        for (const row of syncedRows) {
          const displayName = getDisplayName(row.device, row.deviceInstanceId)
          const platformLabel = getPlatformLabel(row.platform) || inferPlatform(row.device, row.deviceInstanceId)
          const existing = deviceMap.get(row.deviceInstanceId)
          if (existing) {
            existing.recordCount += row.recordCount
          } else {
            deviceMap.set(row.deviceInstanceId, { device: row.device, deviceInstanceId: row.deviceInstanceId, displayName, platform: platformLabel, recordCount: row.recordCount })
          }
        }

        const devices = [...deviceMap.values()].sort((a, b) => b.recordCount - a.recordCount)
        json(res, { currentDeviceInstanceId: currentId, devices })
        return
      }

      // ── /api/tools ────────────────────────────────────────────────
      if (url.pathname === '/api/tools' && req.method === 'GET') {
        const device = url.searchParams.get('device')
        const df = getDeviceFilter(device, options?.currentDeviceInstanceId)
        const dr = getDateRangeFilter(range, from, to, '', weekStart)

        let rows: Array<{ tool: string; sessionCount: number }>

        if (df.useUnion) {
          rows = db.prepare(`
            SELECT tool, COUNT(DISTINCT session_id) AS sessionCount FROM (
              SELECT tool, session_id FROM records WHERE 1=1 ${dr.where}
              UNION ALL
              SELECT tool, session_key AS session_id FROM synced_records WHERE device_instance_id != @currentDeviceId ${NOT_ALREADY_MERGED} ${dr.where}
            ) GROUP BY tool ORDER BY sessionCount DESC
          `).all({ ...dr.params, ...df.params }) as any[]
        } else if (df.where) {
          rows = db.prepare(`
            SELECT tool, COUNT(DISTINCT session_key) AS sessionCount
            FROM synced_records WHERE 1=1 ${df.where} ${dr.where}
            GROUP BY tool ORDER BY sessionCount DESC
          `).all({ ...dr.params, ...df.params }) as any[]
        } else {
          rows = db.prepare(`
            SELECT tool, COUNT(DISTINCT session_id) AS sessionCount
            FROM records WHERE 1=1 ${dr.where} ${df.localOnly ? LOCAL_ONLY_FILTER : ''}
            GROUP BY tool ORDER BY sessionCount DESC
          `).all({ ...dr.params }) as any[]
        }

        json(res, { tools: rows })
        return
      }

      // ── /api/config/credential ──────────────────────────────────────
      if (url.pathname === '/api/config/credential' && req.method === 'GET') {
        const ref = url.searchParams.get('ref')?.trim()
        if (!ref) {
          json(res, { error: { code: 'MISSING_CREDENTIAL_REF', message: 'credential ref is required' } }, 400)
          return
        }

        const value = loadCredential(ref)
        if (!value) {
          json(res, { error: { code: 'CREDENTIAL_NOT_FOUND', message: 'Credential not found' } }, 404)
          return
        }

        json(res, { value })
        return
      }

      // ── /api/config ───────────────────────────────────────────────
      if (url.pathname === '/api/config') {
        if (req.method === 'GET') {
          const currentCfg = loadConfig() ?? {}
          const osPlatform = platform()
          const { credentials, priceOverrides, platform: _cfgPlatform, sources: _legacySources, ...rest } = currentCfg
          json(res, {
            device: rest.device ?? null,
            weekStart: rest.weekStart ?? 1,
            refreshInterval: rest.refreshInterval ?? rest.dashboardPollInterval ?? rest.parseInterval ?? null,
            retentionDays: rest.retentionDays ?? null,
            leaderboardAutoUpload: rest.leaderboardAutoUpload ?? false,
            leaderboardUploadInterval: rest.leaderboardUploadInterval ?? null,
            sync: rest.sync ?? null,
            syncInterval: rest.syncInterval ?? null,
            loggedIn: hasCredentials(),
            displayCurrency: rest.displayCurrency ?? 'USD',
            exchangeRate: rest.exchangeRate ?? null,
            exchangeRateCache: rest.exchangeRateCache ?? null,
            siteUrl: getSiteUrl(),
            credentialKeys: credentials ? Object.keys(credentials) : [],
            notifications: rest.notifications ?? null,
            // Whether a webhook exists, never what it is.
            notificationWebhookConfigured: loadCredential(DISCORD_WEBHOOK_CREDENTIAL) != null,
            // Same shape as the webhook above: the name may appear in
            // credentialKeys, the value never leaves the machine.
            dashboardPasswordConfigured: loadCredential(DASHBOARD_PASSWORD_CREDENTIAL) != null,
            hostname: hostname(),
            platform: osPlatform,
            // Always an array, never null: the client filters its navigation
            // with it, and an absent value would have to be special-cased at
            // every use.
            ui: { hiddenRoutes: normalizeHiddenRoutes(rest.ui?.hiddenRoutes) },
            // Public by design: a browser cannot subscribe without it. The
            // private half stays in credentials and is never returned.
            vapidPublicKey: rest.vapid?.publicKey ?? null,
            vapidSubject: rest.vapid?.subject ?? DEFAULT_VAPID_SUBJECT,
            hideableRoutes: [...HIDEABLE_ROUTES],
          })
          return
        }

        if (req.method === 'PUT') {
          let body = ''
          for await (const chunk of req) body += chunk
          try {
            const update = JSON.parse(body) as Record<string, unknown>
            const existing: Config = loadConfig() ?? {}

            if ('device' in update) {
              if (!update.device) delete existing.device
              else existing.device = String(update.device)
            }
            if ('weekStart' in update) {
              const ws = Number(update.weekStart)
              if (ws === 0 || ws === 1) {
                existing.weekStart = ws as 0 | 1
                weekStart = ws as 0 | 1
              } else {
                delete existing.weekStart
              }
            }
            if ('hiddenRoutes' in update) {
              // Only paths we know. An unrecognised one would be a screen
              // nobody can reach and nobody can find in the settings list to
              // turn back on.
              const hidden = normalizeHiddenRoutes(update.hiddenRoutes)
              if (hidden.length === 0) {
                if (existing.ui) {
                  delete existing.ui.hiddenRoutes
                  if (Object.keys(existing.ui).length === 0) delete existing.ui
                }
              } else {
                existing.ui = { ...existing.ui, hiddenRoutes: hidden }
              }
            }
            if ('displayCurrency' in update) {
              const dc = update.displayCurrency
              if (dc === 'USD' || dc === 'CNY') {
                existing.displayCurrency = dc
              } else {
                delete existing.displayCurrency
              }
            }
            if ('exchangeRate' in update) {
              const er = update.exchangeRate
              if (er != null && typeof er === 'number' && er > 0) {
                existing.exchangeRate = er
              } else {
                delete existing.exchangeRate
              }
            }

            if ('refreshInterval' in update) {
              if (!update.refreshInterval) {
                delete existing.refreshInterval
              } else {
                existing.refreshInterval = Number(update.refreshInterval)
              }
              // Clean up legacy fields
              delete existing.dashboardPollInterval
              delete existing.parseInterval
            }
            if ('retentionDays' in update) {
              if (!update.retentionDays) delete existing.retentionDays
              else existing.retentionDays = Number(update.retentionDays)
            }
            if ('notifications' in update) {
              // Merged rather than replaced, so a partial update cannot switch
              // off events it never mentioned. The webhook is not accepted
              // here — it goes through /api/config/credential like every other
              // secret, so it never lands in the plain config section.
              const incoming = (update.notifications ?? {}) as Record<string, unknown>
              delete incoming.webhook
              delete incoming.webhookUrl
              // channels is an object, so the spread above would replace it
              // whole: sending { discord: false } alone would also erase the
              // webpush setting. Merge it one level deeper for the same reason
              // the rest of the section is merged.
              const channels = incoming.channels
              delete incoming.channels
              existing.notifications = { ...(existing.notifications ?? {}), ...incoming }
              if (channels && typeof channels === 'object') {
                const merged = { ...(existing.notifications.channels ?? {}) } as Record<string, boolean>
                for (const [name, value] of Object.entries(channels as Record<string, unknown>)) {
                  if (name === 'discord' || name === 'webpush') merged[name] = value === true
                }
                existing.notifications.channels = merged
              }
            }
            if ('vapidSubject' in update) {
              // Only the subject. The key pair is created by the CLI command;
              // the private half never travels over this API in either
              // direction, and the public half would orphan every existing
              // subscription if it could be edited here.
              const subject = typeof update.vapidSubject === 'string' ? update.vapidSubject.trim() : ''
              existing.vapid = { ...(existing.vapid ?? {}), subject: subject || DEFAULT_VAPID_SUBJECT }
            }
            if ('leaderboardAutoUpload' in update) {
              existing.leaderboardAutoUpload = update.leaderboardAutoUpload === true
            }
            if ('leaderboardUploadInterval' in update) {
              const uploadInterval = Number(update.leaderboardUploadInterval)
              if (Number.isFinite(uploadInterval) && uploadInterval > 0) {
                existing.leaderboardUploadInterval = uploadInterval
              } else {
                delete existing.leaderboardUploadInterval
              }
            }

            if ('syncInterval' in update) {
              const si = Number(update.syncInterval)
              if (Number.isFinite(si) && si > 0) {
                existing.syncInterval = si
              } else {
                delete existing.syncInterval
              }
            }

            if ('sync' in update) {
              const syncUpdate = update.sync as Record<string, unknown> | null
              if (!syncUpdate?.backend) {
                delete existing.sync
              } else {
                const backendVal = String(syncUpdate.backend)
                if (backendVal !== 'github' && backendVal !== 's3' && backendVal !== 'cloud') {
                  json(res, { error: { code: 'INVALID_BACKEND', message: 'sync.backend must be cloud, github, or s3' } }, 400)
                  return
                }
                // Merge with existing sync config to preserve fields from other backends
                const newSync: SyncConfig = { ...existing.sync, backend: backendVal as 'github' | 's3' | 'cloud' }
                for (const f of ['repo', 'bucket', 'prefix', 'endpoint', 'region', 'credentialRef'] as const) {
                  if (syncUpdate[f] != null && syncUpdate[f] !== '') (newSync as any)[f] = String(syncUpdate[f])
                }
                if (newSync.backend === 'github' && !newSync.repo) {
                  json(res, { error: { code: 'INVALID_SYNC_CONFIG', message: 'sync.repo is required for GitHub sync' } }, 400)
                  return
                }
                if (newSync.backend === 's3' && !newSync.bucket) {
                  json(res, { error: { code: 'INVALID_SYNC_CONFIG', message: 'sync.bucket is required for S3 sync' } }, 400)
                  return
                }
                existing.sync = newSync
              }
            }

            if (update.credentials && typeof update.credentials === 'object') {
              const creds = update.credentials as Record<string, unknown>
              const c: Record<string, string> = existing.credentials ?? {}
              for (const [key, val] of Object.entries(creds)) {
                if (val !== '' && val !== null && val !== undefined) {
                  c[key] = String(val)
                }
              }
              if (Object.keys(c).length) existing.credentials = c
              else delete existing.credentials
            }

            saveConfig(existing)
            const consentConfig = buildConsentConfig(existing)
            const syncTarget = getSyncTarget(existing.sync)
            if (consentConfig && syncTarget) {
              setSyncConsent(AIUSAGE_DIR, syncTarget, {
                syncConsentAt: Date.now(),
                syncConsentTarget: generateConsentFingerprint(consentConfig),
              })
            }
            options?.onConfigUpdated?.()
            json(res, { ok: true })
          } catch {
            json(res, { error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } }, 400)
          }
          return
        }
      }

      // ── /api/detected-tools ──────────────────────────────────────
      if (url.pathname === '/api/detected-tools' && req.method === 'GET') {
        const tools = attachManualImportMetadata(discoverTools(), db)
        json(res, { tools })
        return
      }

      // ── /api/import/kelivo ────────────────────────────────────────
      if (url.pathname === '/api/import/kelivo' && req.method === 'POST') {
        let tempDir: string | null = null
        try {
          const upload = await readMultipartFile(req)
          if (!upload) {
            json(res, { error: { code: 'INVALID_UPLOAD', message: 'Missing uploaded file' } }, 400)
            return
          }
          if (!isKelivoBackupFilename(upload.filename)) {
            json(res, { error: { code: 'INVALID_FILE', message: 'Upload a Kelivo .zip backup or chats.json' } }, 400)
            return
          }

          tempDir = mkdtempSync(path.join(tmpdir(), 'aiusage-kelivo-'))
          const tempPath = path.join(tempDir, upload.filename)
          writeFileSync(tempPath, upload.data)

          const cfg = loadConfig()
          const now = Date.now()
          const result = await runParseKelivo({
            filePath: tempPath,
            device: getDeviceName(),
            deviceInstanceId: options?.currentDeviceInstanceId ?? 'unknown',
            platform: cfg?.platform ?? platform(),
            now,
            exchangeRate: resolveExchangeRate(cfg ?? {}),
          })
          if (result.errors.length > 0 && result.records.length === 0) {
            json(res, { error: { code: 'IMPORT_FAILED', message: result.errors[0] }, errors: result.errors }, 400)
            return
          }

          const existingCount = await runDbWrite(() => {
            const existingCount = countExistingRecordIds(db, result.records.map((record) => record.id))
            for (const record of result.records) insertRecord(db, record)
            return existingCount
          })
          const imported = result.records.length
          const added = Math.max(0, new Set(result.records.map((record) => record.id)).size - existingCount)
          json(res, {
            imported,
            added,
            lastImportedAt: imported > 0 ? now : undefined,
            errors: result.errors,
          })
        } finally {
          if (tempDir) rmSync(tempDir, { recursive: true, force: true })
        }
        return
      }

      // ── /api/exchange-rate/refresh ────────────────────────────────
      if (url.pathname === '/api/exchange-rate/refresh' && req.method === 'POST') {
        const rate = await fetchExchangeRate()
        if (rate == null) {
          json(res, { error: { code: 'FETCH_FAILED', message: 'Failed to fetch exchange rate' } }, 502)
          return
        }
        const cfg = loadConfig() ?? {}
        cfg.exchangeRateCache = { CNY_USD: rate, fetchedAt: Date.now() }
        saveConfig(cfg)
        json(res, { rate, fetchedAt: cfg.exchangeRateCache.fetchedAt })
        return
      }

      // ── 404 ───────────────────────────────────────────────────────
      json(res, { error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404)
    } catch (error) {
      console.error('API error:', error)
      json(res, { error: { code: 'INTERNAL', message: 'Internal server error' } }, 500)
    }
  })

  return server
}
