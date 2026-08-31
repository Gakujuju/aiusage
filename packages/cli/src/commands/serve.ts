import http from 'node:http'
import { readFileSync, existsSync, statSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiServer } from '../api/server.js'
import { importConfigPriceOverrides, loadPricingRuntime } from '../pricing-registry.js'
import { runParse } from './parse.js'
import { runSync } from './sync.js'
import { cleanOldData } from './clean.js'
import { uploadLeaderboardData } from './leaderboard-upload.js'
import { ensureAiusageDir, getState } from '../init.js'
import { AIUSAGE_DIR, loadConfig, saveConfig } from '../config.js'
import { getDashboardPassword, isLoopbackHost } from '../auth.js'
import { SyncRuntimeController } from '../sync/runtime.js'
import { getSyncTarget } from '../sync/target.js'
import { RuntimeSettingsController } from '../runtime/settings-controller.js'
import { AsyncTaskQueue } from '../db/write-queue.js'
import { countUnpricedRecords, findPredominantDeviceInstanceId } from '../db/records.js'
import { recordQuotaSnapshot } from '../db/quota-history.js'
import { AgentSessionEmitter, applyAgentEvents, decayStaleSessions } from '../db/agent-sessions.js'
import { NotificationSender } from '../notify/discord.js'
import { runPushNotificationTick } from '../notify/webpush-tick.js'
import { requeueInFlightNotifications } from '../db/notifications.js'
import { notifyEscalations, notifyQuotaSummary, notifySessionChange } from '../notify/enqueue.js'
import { drainAgentEventSpool } from './agent-event.js'
import { runHubUpload } from '../sync/hub-upload.js'
import { runCodexLogTick } from '../agent/codex-log-watcher.js'
import { queryAllQuotas } from '../quota.js'
import { hostname, platform } from 'node:os'
import { fetchExchangeRate, CACHE_TTL_MS } from '@aiusage/core'
import type Database from 'better-sqlite3'

export interface ServeOptions {
  port: number
  db: Database.Database
  /** Interface to bind. Defaults to loopback; see resolveServeHost. */
  host?: string
}

export const DEFAULT_SERVE_HOST = '127.0.0.1'

/**
 * Interfaces to listen on.
 * Priority: --host, then AIUSAGE_HOST, then config.host, then loopback.
 *
 * A comma-separated list, because reaching the dashboard from a phone over
 * Tailscale means binding that interface *as well as* loopback — not instead
 * of it. agent-event reads .serve-port and posts to 127.0.0.1, and the widget
 * connects to localhost; binding only the Tailscale address makes both
 * unreachable, and agent-event spools what it cannot send, so the failure is
 * silent. Hence 127.0.0.1 is always in the list whether it was asked for or
 * not.
 */
export function resolveServeHosts(
  hostOption?: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // config last, so a file cannot override what was asked for on the command
  // line or in the environment for this one run.
  const raw = hostOption?.trim()
    || env.AIUSAGE_HOST?.trim()
    || loadConfig()?.host?.trim()
    || DEFAULT_SERVE_HOST
  const requested = raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host !== '')

  // Loopback first: it is the one that must work, so it is the one whose
  // port-in-use retry decides the port for everybody else.
  const hosts = [DEFAULT_SERVE_HOST, ...requested.filter((h) => h !== DEFAULT_SERVE_HOST)]
  return [...new Set(hosts)]
}

/** Kept for callers that only care about the primary interface. */
export function resolveServeHost(
  hostOption?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveServeHosts(hostOption, env)[0]
}

export interface HostSafetyVerdict {
  allowed: boolean
  /** Present when the bind is reachable from the network without a password. */
  insecure: boolean
  message: string | null
}

/**
 * Whether it is acceptable to listen on this host.
 *
 * Binding beyond loopback publishes total spend, project names, session
 * history and subscription burn to everyone on the network, and the dashboard
 * password is optional. Rather than force a password on the single-machine
 * case — where none of this is exposed and a password is pure friction — the
 * default bind is local and anything wider has to say so.
 */
export function checkHostSafety(
  host: string | readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): HostSafetyVerdict {
  const hosts = typeof host === 'string' ? [host] : [...host]
  // One reachable interface is enough to require a password; the loopback
  // listener sitting beside it does not make the other one private.
  const exposed = hosts.filter((h) => !isLoopbackHost(h))
  if (exposed.length === 0) return { allowed: true, insecure: false, message: null }
  const named = exposed.join(', ')

  // The injected env first, so a test can describe a machine other than
  // this one; then the stored credential, which has no env to inject.
  if (env.AIUSAGE_DASHBOARD_PASSWORD?.trim() || getDashboardPassword()) {
    return { allowed: true, insecure: false, message: null }
  }

  // An escape hatch for a host already fronted by something else. Refusing
  // outright would break reverse-proxy setups that are perfectly safe.
  if (env.AIUSAGE_ALLOW_INSECURE_HOST === '1') {
    return {
      allowed: true,
      insecure: true,
      message:
        `aiusage serve: listening on ${named} without a password ` +
        '(AIUSAGE_ALLOW_INSECURE_HOST=1). Anyone who can reach this port can ' +
        'read your usage data, costs and project names.',
    }
  }

  return {
    allowed: false,
    insecure: true,
    message:
      `aiusage serve: refusing to listen on ${named} without a password.\n` +
      'This exposes your usage data, costs and project names to your network.\n' +
      'Set a password (aiusage set-dashboard-password, or the\n' +
      'AIUSAGE_DASHBOARD_PASSWORD environment variable), use the default\n' +
      'local-only bind,\n' +
      'or set AIUSAGE_ALLOW_INSECURE_HOST=1 if this host is already\n' +
      'protected by something else (a reverse proxy, a private network).',
  }
}

export interface ServeCommandDeps {
  dbPath: string
  createDatabase: (path: string) => Database.Database
  serve: (options: ServeOptions) => void
  env?: NodeJS.ProcessEnv
  onError?: (message: string) => void
  onExit?: (code: number) => void
}

/**
 * The `serve` CLI command, in the order the steps have to happen in.
 *
 * The host check comes before createDatabase because createDatabase runs the
 * migrations. Opening the database first meant a refused start still left the
 * production database migrated — harmless while no migration is pending, and a
 * real "start was refused but the schema moved anyway" the moment one is.
 *
 * Nothing warns here: serve() re-checks and warns when it actually binds, so
 * warning in both places would print the same line twice.
 */
export function runServeCommand(
  options: { port: number; host?: string },
  deps: ServeCommandDeps,
): void {
  const hosts = resolveServeHosts(options.host, deps.env)
  const safety = checkHostSafety(hosts, deps.env)
  if (!safety.allowed) {
    // The same message serve() would print. Kept in checkHostSafety rather
    // than written out at each call site so the two cannot drift.
    ;(deps.onError ?? console.error)(safety.message ?? '')
    ;(deps.onExit ?? process.exit)(1)
    return
  }

  const db = deps.createDatabase(deps.dbPath)
  // Passed as a list, not just the primary: resolving again inside serve()
  // is idempotent, and handing over one address would drop the rest.
  deps.serve({ port: options.port, host: hosts.join(','), db })
}

/**
 * Skip reasons worth a log line.
 *
 * 'no_label' is missing on purpose: running and idle produce one on every
 * turn, which is dozens an hour and would bury the rest. 'not_found' is a
 * lookup miss, not a decision. What is left is the set that answers "the
 * notification I expected did not arrive".
 */
const LOGGED_SKIP_REASONS: ReadonlySet<string> = new Set([
  'disabled', 'event_disabled', 'tool_disabled',
  'duplicate', 'throttled', 'quiet_hours',
])

const MAX_PORT_ATTEMPTS = 10
const AGENT_REAPER_INTERVAL_MS = 15_000
const CODEX_LOG_INTERVAL_MS = 5_000
const PORT_FILE = join(AIUSAGE_DIR, '.serve-port')

/**
 * How often the port file's timestamp is refreshed while serve is alive.
 *
 * The file exists to tell hooks which port to use; touching it also leaves a
 * record of when this process was last known to be running, which is the
 * only thing a killed process can leave behind about when it died.
 */
const PORT_FILE_HEARTBEAT_MS = 60_000

/**
 * Say how long the gap was, if the previous process left its port file.
 *
 * A file still sitting there means the last shutdown was not graceful — the
 * SIGINT path removes it — and its mtime is that process's final heartbeat.
 */
function reportOutage(portFile: string, now: number = Date.now()): void {
  let lastSeen: number
  try {
    lastSeen = statSync(portFile).mtimeMs
  } catch {
    return // Clean start, or a clean shutdown last time. Nothing to say.
  }
  const gapMs = now - lastSeen
  if (gapMs < 0) return
  const minutes = Math.round(gapMs / 60_000)
  const spoken = minutes < 1 ? '1分未満' : `約${minutes}分`
  console.warn(`[serve] 前回の稼働確認から${spoken}ぶりの再開です（前回は正常停止していません）`)
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  // Without this the manifest goes out as application/octet-stream, and a
  // browser that refuses it gives no reason anyone would connect to "add to
  // home screen quietly does nothing".
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function serve(options: ServeOptions): void {
  // Decided before anything else starts: refusing to bind should not leave a
  // half-initialised process behind.
  //
  // runServeCommand already refuses before the database is opened, so on the
  // CLI path this looks redundant — do not remove it on those grounds. serve()
  // is exported and gets called directly by tests and by anything embedding
  // it, and it has to be safe on its own. resolveServeHost is idempotent, so
  // running it again over an already-resolved host is a no-op.
  const hosts = resolveServeHosts(options.host)
  // Every listener has to be loopback for the two open endpoints to stay
  // open: one reachable interface makes /api/summary and /api/quotas the
  // whole payload rather than a convenience.
  const isLoopback = hosts.every(isLoopbackHost)
  const hostSafety = checkHostSafety(hosts)
  if (!hostSafety.allowed) {
    console.error(hostSafety.message)
    process.exit(1)
  }
  if (hostSafety.insecure && hostSafety.message) {
    console.warn(hostSafety.message)
  }

  // First, before anything reads state.json. Nothing was calling this, so
  // state.json was never created — which left getIngestToken() returning null
  // and every hook POST answered with 401. The events were not lost, because
  // agent-event spools what it cannot send, but nothing was being applied.
  //
  // Deriving the device id needs the records table, so this has to run after
  // the migrations rather than before them. Everything that consumes
  // state.json comes later in this function, which is what actually matters.
  const stateResult = ensureAiusageDir(AIUSAGE_DIR, () => findPredominantDeviceInstanceId(options.db))
  if (stateResult.created) {
    console.log(
      `[serve] created state.json (device instance id from ${stateResult.deviceInstanceIdSource})`
    )
  } else if (stateResult.ingestTokenAdded) {
    console.log('[serve] added an ingest token to the existing state.json')
  }

  const config = loadConfig()
  const dbWriteQueue = new AsyncTaskQueue()
  const runDbWrite = <T>(task: () => T | Promise<T>) => dbWriteQueue.run(task)

  // One-time: migrate legacy config.priceOverrides into the pricing registry so
  // recalc/Sessions actually use them (they were previously ignored — issue #13).
  // After import, drop them from config so the registry is the single source of
  // truth and this does not run again.
  if (config?.priceOverrides && Object.keys(config.priceOverrides).length > 0) {
    const imported = importConfigPriceOverrides(options.db, config.priceOverrides)
    delete config.priceOverrides
    saveConfig(config)
    loadPricingRuntime(options.db, config)
    if (imported.length > 0) {
      console.log(`[serve] migrated ${imported.length} config price override(s) into the registry: ${imported.join(', ')}`)
    }
  }

  // Initialize exchange rate: fetch if cache missing or expired (non-blocking)
  if (config == null || config.exchangeRate == null) {
    const cacheAge = config?.exchangeRateCache
      ? Date.now() - config.exchangeRateCache.fetchedAt
      : Infinity
    if (cacheAge >= CACHE_TTL_MS) {
      fetchExchangeRate().then(rate => {
        if (rate != null) {
          const cfg = loadConfig() ?? {}
          cfg.exchangeRateCache = { CNY_USD: rate, fetchedAt: Date.now() }
          saveConfig(cfg)
        }
      }).catch(() => {
        // Silently ignore — FALLBACK_RATE will be used
      })
    }
  }

  const syncRuntime = new SyncRuntimeController({
    runSync: async (runtimeOptions) => {
      await runDbWrite(async () => {
        await runParse(options.db)
        await runSync(options.db, runtimeOptions)
      })
    },
    getPersistedState: () => getState(AIUSAGE_DIR),
    getCurrentTarget: () => getSyncTarget(loadConfig()?.sync),
  })

  // Poll the subscription usage APIs and fold the result into quota history.
  // queryAllQuotas never rejects — it reports failures per tool — but the
  // caller still guards, because a locked database can throw here.
  // A round that reaches nothing writes no rows and raises no error, which is
  // correct but silent — silent enough that a startup snapshot failing on every
  // large install went unnoticed until it was run against real data. Report the
  // shape of each round instead. Only the classified kinds are logged, never the
  // error text or the URL, so no token can reach a log line this way.
  let loggedQuotaSuccess = false
  const runQuotaSnapshot = async () => {
    const results = await queryAllQuotas()
    const summary = await runDbWrite(() => {
      const recorded = recordQuotaSnapshot(options.db, results, {
        device: loadConfig()?.device || hostname() || 'unknown',
        deviceInstanceId: getState(AIUSAGE_DIR)?.deviceInstanceId ?? '',
        now: Date.now(),
      }, { thresholds: loadConfig()?.notifications?.quota?.thresholds })
      notifyQuotaSummary(notifyContext(), recorded)
      return recorded
    })

    if (summary.attempted > 0 && summary.succeeded === 0) {
      const kinds = summary.errorKinds.length > 0 ? summary.errorKinds.join(', ') : 'unknown'
      console.warn(`[serve] quota snapshot: all ${summary.attempted} tool(s) failed (kinds: ${kinds})`)
    } else if (summary.succeeded > 0 && !loggedQuotaSuccess) {
      // Once, so the operator sees it working; after that a five-minute poll
      // logging every round would be noise.
      loggedQuotaSuccess = true
      console.log(
        `[serve] quota snapshot: ${summary.succeeded}/${summary.attempted} ok, ` +
        `${summary.inserted} row(s) inserted`
      )
    }
    return summary
  }

  const runtimeSettings = new RuntimeSettingsController({
    db: options.db,
    loadConfig,
    runParse: (db) => runDbWrite(() => runParse(db)),
    runCleanup: (db, retentionDays) => runDbWrite(() => cleanOldData(db, retentionDays)),
    runLeaderboardUpload: (db) => uploadLeaderboardData(db, getState(AIUSAGE_DIR)?.deviceInstanceId).then(() => undefined),
    runSync: () => syncRuntime.start(),
    runQuotaSnapshot,
    /*
     * Records to the hub, when this machine reports to one.
     *
     * runHubUpload answers 'no_hub' on its own, so this is safe to wire
     * unconditionally — and wiring it unconditionally is what lets someone
     * set a hub and have it take effect on the next parse rather than the
     * next restart.
     */
    runHubUpload: async () => {
      const result = await runHubUpload({ db: options.db, runDbWrite })
      if (result.sent > 0) {
        console.log('[serve] uploaded ' + result.sent + ' record(s) to the hub')
      } else if (result.error) {
        console.warn('[serve] hub upload failed: ' + result.error)
      }
      return result
    },
    onSyncScheduleChanged: (ts) => syncRuntime.setNextSyncAt(ts),
  })
  runtimeSettings.start()

  /**
   * Parse once on startup — but only after the port is open.
   *
   * runParse is better-sqlite3, so it is synchronous: it holds the event loop
   * for as long as it takes, and with 22,000 records that is tens of seconds.
   * Started here directly it ran to completion before server.listen() was
   * even reached, so every request during a restart was refused outright.
   * Deferring it one turn of the loop puts the socket up first, and the
   * requests that arrive during the parse wait in the accept queue instead.
   *
   * Nothing can read a half-parsed database this way: the parse blocks the
   * loop, so a request is handled either before it starts or after it
   * finishes, never in the middle. The change turns "connection refused"
   * into "slow", which is the whole of it.
   */
  setImmediate(() => {
  console.log('[serve] parsing logs...')
  runDbWrite(() => runParse(options.db)).then((result) => {
    console.log(`[serve] parsed ${result.parsedCount} records, ${result.toolCallCount} tool calls.`)
    // Said out loud, because the alternative is a dashboard reading $0 and
    // being believed. That is exactly what happened for months.
    const unpriced = countUnpricedRecords(options.db)
    if (unpriced.unpricedRecords > 0) {
      const [first, ...rest] = unpriced.unpricedModels
      const models = rest.length > 0 ? `${first} ほか${rest.length}モデル` : first
      console.warn(
        `[serve] ${unpriced.unpricedRecords} 件のレコードに価格が設定されていません（${models}）。` +
        ' POST /api/pricing/sync で価格表を更新できます。'
      )
    }
  }).catch((err) => {
    console.error('[serve] initial parse failed:', err)
  }).finally(() => {
    // Seed the history so the first dashboard load is not empty. This waits
    // for the parse rather than racing it: better-sqlite3 is synchronous, so a
    // first parse of any size holds the event loop long enough for the usage
    // APIs' 10-second fetch timeout to expire unserviced — the snapshot then
    // failed silently on exactly the large-install first run it exists for.
    // Still never awaited, so startup does not wait on third-party network.
    //
    // quotaSnapshotInterval: 0 turns the poller off, and it has to turn this
    // off too: a second serve started for development would otherwise still
    // reach the usage APIs once per launch. Two processes polling the same
    // endpoint is what produced a 429 — and the failure was recorded against
    // the production quota_current, not the development one.
    if ((loadConfig()?.quotaSnapshotInterval ?? 1) !== 0) {
      void runQuotaSnapshot().catch((err) => {
        console.error('[serve] initial quota snapshot failed:', err)
      })
    }

    /*
     * The startup parse is a parse, and this is the moment a machine that has
     * been off has the most to hand over. It does not go through
     * runParseSafely — that runs the interval parse — so the controller's
     * after-a-parse hook never sees this one, and without saying so here a
     * restart would sit on its backlog until the first interval parse came
     * round.
     *
     * After the parse rather than beside it: better-sqlite3 holds the loop
     * while parsing, so an upload started alongside would spend its timeout
     * waiting for a turn that does not come.
     */
    void runtimeSettings.uploadToHubNow()
  })
  })

  // Age out sessions nothing has reported on. No network here, so unlike the
  // quota poller it can simply skip a tick that lands during a parse: the next
  // one is 15 seconds away and decay is not time-critical.
  const agentEmitter = new AgentSessionEmitter()

  // Read fresh each time, so switching notifications on takes effect without
  // restarting serve.
  const notifyContext = () => {
    const cfg = loadConfig()
    return {
      db: options.db,
      config: cfg?.notifications,
      isNotifier: cfg?.notifications?.notifierDevice === true,
      projectAliases: cfg?.projectAliases,
      deviceInstanceId: getState(AIUSAGE_DIR)?.deviceInstanceId ?? '',
      device: cfg?.device || hostname() || 'unknown',
      now: Date.now(),
    }
  }

  // A status change is the trigger. The emitter already fires outside the
  // transaction that produced it, so queueing here cannot extend that lock.
  agentEmitter.subscribe((session) => {
    // Also on a kind change at the same status: Stop and StopFailure both land
    // on waiting_for_user but mean different things. shouldNotifySession has
    // the final say, and its duplicate check keys on the kind too.
    if (!session.changed && !session.kindChanged) return
    void runDbWrite(() => notifySessionChange(notifyContext(), session.id))
      .then((result) => {
        // The decision was being thrown away, so "why did I not get a
        // notification" could only be answered by re-deriving it from the
        // event table afterwards. One line at the moment it happens is
        // enough; there is no case for a table.
        if (result.enqueued || !LOGGED_SKIP_REASONS.has(result.reason)) return
        console.log(
          `[serve] notification skipped: ${result.reason} (session=${session.id.slice(0, 8)})`
        )
      })
      .catch((err) => console.error('[serve] notification enqueue failed:', err))
  })

  const agentReaper = setInterval(() => {
    if (runtimeSettings.isParseInFlight()) return
    void runDbWrite(() => {
      decayStaleSessions(options.db, Date.now(), agentEmitter)
      // Re-announce permission waits nobody has answered. Only possible
      // because those no longer decay away while the person is not looking.
      notifyEscalations(notifyContext())
    }).catch((err) => console.error('[serve] agent session reaper failed:', err))
  }, AGENT_REAPER_INTERVAL_MS)

  // Codex has no hooks, so its lifecycle is read out of the rollout logs it
  // already writes (D18). Skipped while a parse is in flight for the same
  // reason the notification sender is: better-sqlite3 is synchronous, and a
  // parse holds the event loop long enough that this would only queue up.
  const codexLogWatcher = setInterval(() => {
    if (runtimeSettings.isParseInFlight()) return
    const now = Date.now()
    // Read per tick rather than captured once: the same resolution the hook
    // client uses, so both tools name this machine the same way. Reading it
    // here also means a device rename takes effect without a restart.
    const watcherConfig = loadConfig()
    void runDbWrite(() => runCodexLogTick({
      db: options.db,
      now,
      applyEvents: (events) => applyAgentEvents(options.db, events, {
        projectRoots: watcherConfig?.projectRoots,
        device: watcherConfig?.device || hostname() || '',
        deviceInstanceId: getState(AIUSAGE_DIR)?.deviceInstanceId ?? 'unknown',
        platform: watcherConfig?.platform || platform(),
        now,
      }, agentEmitter).applied,
    })).catch((err) => console.error('[serve] codex log watcher failed:', err))
  }, CODEX_LOG_INTERVAL_MS)

  // Anything the previous process was mid-send on. Runs before the sender
  // starts, so the first tick can pick them up.
  void runDbWrite(() => requeueInFlightNotifications(options.db))
    .then((requeued) => {
      if (requeued > 0) console.log(`[serve] requeued ${requeued} notification(s) left in flight`)
    })
    .catch((err) => console.error('[serve] notification requeue failed:', err))

  const notificationSender = new NotificationSender({
    db: options.db,
    runDbWrite,
    isParseInFlight: () => runtimeSettings.isParseInFlight(),
  })
  notificationSender.start()

  /**
   * The push half, on the same cadence and with its own failures.
   *
   * A separate timer rather than a step inside the Discord tick: the two
   * channels share the decision that produced the rows and nothing else, and
   * a slow webhook must not delay a phone.
   */
  const pushSender = setInterval(() => {
    void runPushNotificationTick({
      db: options.db,
      runDbWrite,
      isParseInFlight: () => runtimeSettings.isParseInFlight(),
    })
      .then((pushResult) => {
        if (pushResult.sent > 0) console.log(`[serve] pushed ${pushResult.sent} notification(s)`)
        if (pushResult.pruned > 0) {
          console.log(`[serve] removed ${pushResult.pruned} push subscription(s) the browser no longer has`)
        }
      })
      .catch((err) => console.error('[serve] push sender failed:', err))
  }, 5_000)
  pushSender.unref?.()

  // Events buffered while serve was down. dedupeKey makes this idempotent.
  void runDbWrite(() => drainAgentEventSpool(options.db, agentEmitter))
    .then((drained) => {
      if (drained > 0) console.log(`[serve] replayed ${drained} buffered agent event(s)`)
    })
    .catch((err) => console.error('[serve] agent event spool replay failed:', err))

  const apiServer = createApiServer(options.db, {
    currentDeviceInstanceId: getState(AIUSAGE_DIR)?.deviceInstanceId,
    agentEmitter,
    isLoopbackBind: isLoopback,
    onRefresh: () => runParse(options.db),
    onSyncStart: () => syncRuntime.start(),
    getSyncStatus: () => syncRuntime.getStatus(),
    onConfigUpdated: () => runtimeSettings.reload(),
    runDbWrite,
    getDbWriteQueueStatus: () => dbWriteQueue.getStatus(),
  })
  const webBuildDir = (() => {
    const prodDir = join(dirname(fileURLToPath(import.meta.url)), 'web')
    if (existsSync(prodDir)) return prodDir
    // dev mode (tsx): fall back to packages/web/build
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'build')
  })()

  if (!existsSync(webBuildDir)) {
    console.error('Web dashboard not found. Reinstall the package: npm install -g @juliantanx/aiusage')
    process.exit(1)
  }

  /**
   * One handler, several listeners. Everything behind it — the database, the
   * write queue, the pollers — stays single; only the sockets differ.
   */
  const handleRequest: http.RequestListener = async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    // API routes go to API server
    if (url.pathname.startsWith('/api/')) {
      apiServer.emit('request', req, res)
      return
    }

    // Try to serve static files from web build
    if (existsSync(webBuildDir)) {
      let filePath = join(webBuildDir, url.pathname)

      // If path is a directory, try index.html
      try {
        if (statSync(filePath).isDirectory()) {
          filePath = join(filePath, 'index.html')
        }
      } catch {}

      // If file doesn't exist, fall back to index.html (SPA routing)
      if (!existsSync(filePath)) {
        filePath = join(webBuildDir, 'index.html')
      }

      try {
        const content = readFileSync(filePath)
        const ext = extname(filePath)
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream'

        res.writeHead(200, { 'Content-Type': contentType })
        res.end(content)
        return
      } catch {}
    }

    // No web build available
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Web dashboard not found. Reinstall the package: npm install -g @juliantanx/aiusage' } }))
  }

  const server = http.createServer(handleRequest)
  /** Listeners beyond loopback, so shutdown can close them too. */
  const extraServers: http.Server[] = []

  let currentPort = options.port
  let started = false

  const scopeLabel = isLoopback
    ? 'local only'
    : (hostSafety.insecure ? 'network, NO PASSWORD — insecure' : 'network, password required')

  /**
   * Bind the remaining interfaces on the port loopback settled on.
   *
   * A failure here is reported and stepped over. The usual cause is an
   * address that is not up yet — Tailscale not running, most likely — and
   * losing the hook pipeline and the notifier because a VPN is down would
   * cost far more than the dashboard being unreachable from a phone.
   */
  const listenSecondary = (host: string): void => {
    const extra = http.createServer(handleRequest)
    extra.on('error', (error: NodeJS.ErrnoException) => {
      console.warn(
        `[serve] could not listen on ${host}:${currentPort} (${error.code ?? error.message}); ` +
        'the other addresses are unaffected'
      )
    })
    extra.on('listening', () => {
      console.log(`aiusage serve also listening on http://${host}:${currentPort} (${scopeLabel})`)
    })
    extraServers.push(extra)
    extra.listen(currentPort, host)
  }

  const listenOnPort = (port: number): void => {
    currentPort = port
    server.listen(port, DEFAULT_SERVE_HOST)
  }

  server.on('listening', () => {
    started = true
    /**
     * How long the dashboard was unreachable, said out loud.
     *
     * A .serve-port left behind means the previous process was killed rather
     * than stopped, and its modification time is that process's last
     * heartbeat — so the difference is the outage, to within a minute. The
     * log already said "it was killed"; it could not say for how long, which
     * is the part anyone reading it actually wants.
     */
    reportOutage(PORT_FILE)
    writeFileSync(PORT_FILE, String(currentPort), 'utf-8')
    // Say what was actually bound and whether it is protected. "listening on
    // localhost" was true of the URL and false of the bind.
    console.log(`aiusage serve listening on http://${DEFAULT_SERVE_HOST}:${currentPort} (${scopeLabel})`)
    // Only now: the port is settled, so every interface gets the same one.
    for (const host of hosts.filter((h) => h !== DEFAULT_SERVE_HOST)) listenSecondary(host)
  })

  /**
   * Keep the port file's timestamp current.
   *
   * Cheap, and it is what makes the outage figure above possible: a process
   * that is killed cannot write a shutdown time, so the last time it was
   * seen alive has to already be on disk.
   */
  const portFileHeartbeat = setInterval(() => {
    if (!started) return
    try {
      const now = new Date()
      utimesSync(PORT_FILE, now, now)
    } catch {
      // The file may have been removed by hand. Not worth a line of output.
    }
  }, PORT_FILE_HEARTBEAT_MS)
  portFileHeartbeat.unref?.()

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && !started && currentPort < options.port + MAX_PORT_ATTEMPTS - 1) {
      const nextPort = currentPort + 1
      console.warn(`Port ${currentPort} is already in use, trying ${nextPort}...`)
      server.close(() => {
        listenOnPort(nextPort)
      })
      return
    }

    runtimeSettings.stop()
    clearInterval(agentReaper)
    clearInterval(codexLogWatcher)
    clearInterval(pushSender)
    clearInterval(portFileHeartbeat)
    notificationSender.stop()
    throw error
  })

  listenOnPort(options.port)

  // Graceful shutdown
  const cleanup = () => {
    try { unlinkSync(PORT_FILE) } catch {}
  }

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    cleanup()
    runtimeSettings.stop()
    clearInterval(agentReaper)
    clearInterval(codexLogWatcher)
    clearInterval(pushSender)
    clearInterval(portFileHeartbeat)
    notificationSender.stop()
    for (const extra of extraServers) extra.close()
    server.close(() => {
      process.exit(0)
    })
  })

  process.on('SIGTERM', () => {
    cleanup()
    runtimeSettings.stop()
    clearInterval(agentReaper)
    clearInterval(codexLogWatcher)
    clearInterval(pushSender)
    clearInterval(portFileHeartbeat)
    notificationSender.stop()
    for (const extra of extraServers) extra.close()
    server.close(() => {
      process.exit(0)
    })
  })
}
