import http from 'node:http'
import { readFileSync, existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
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
import { isLoopbackHost } from '../auth.js'
import { SyncRuntimeController } from '../sync/runtime.js'
import { getSyncTarget } from '../sync/target.js'
import { RuntimeSettingsController } from '../runtime/settings-controller.js'
import { AsyncTaskQueue } from '../db/write-queue.js'
import { countUnpricedRecords, findPredominantDeviceInstanceId } from '../db/records.js'
import { recordQuotaSnapshot } from '../db/quota-history.js'
import { AgentSessionEmitter, applyAgentEvents, decayStaleSessions } from '../db/agent-sessions.js'
import { NotificationSender } from '../notify/discord.js'
import { requeueInFlightNotifications } from '../db/notifications.js'
import { notifyEscalations, notifyQuotaSummary, notifySessionChange } from '../notify/enqueue.js'
import { drainAgentEventSpool } from './agent-event.js'
import { runCodexLogTick } from '../agent/codex-log-watcher.js'
import { queryAllQuotas } from '../quota.js'
import { hostname } from 'node:os'
import { fetchExchangeRate, CACHE_TTL_MS } from '@aiusage/core'
import type Database from 'better-sqlite3'

export interface ServeOptions {
  port: number
  db: Database.Database
  /** Interface to bind. Defaults to loopback; see resolveServeHost. */
  host?: string
}

export const DEFAULT_SERVE_HOST = '127.0.0.1'

/** Priority: --host, then AIUSAGE_HOST, then loopback. */
export function resolveServeHost(
  hostOption?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = hostOption?.trim()
  if (explicit) return explicit
  const fromEnv = env.AIUSAGE_HOST?.trim()
  if (fromEnv) return fromEnv
  return DEFAULT_SERVE_HOST
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
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): HostSafetyVerdict {
  if (isLoopbackHost(host)) return { allowed: true, insecure: false, message: null }

  if (env.AIUSAGE_DASHBOARD_PASSWORD) {
    return { allowed: true, insecure: false, message: null }
  }

  // An escape hatch for a host already fronted by something else. Refusing
  // outright would break reverse-proxy setups that are perfectly safe.
  if (env.AIUSAGE_ALLOW_INSECURE_HOST === '1') {
    return {
      allowed: true,
      insecure: true,
      message:
        `aiusage serve: listening on ${host} without a password ` +
        '(AIUSAGE_ALLOW_INSECURE_HOST=1). Anyone who can reach this port can ' +
        'read your usage data, costs and project names.',
    }
  }

  return {
    allowed: false,
    insecure: true,
    message:
      `aiusage serve: refusing to listen on ${host} without a password.\n` +
      'This exposes your usage data, costs and project names to your network.\n' +
      'Set AIUSAGE_DASHBOARD_PASSWORD, or use the default local-only bind,\n' +
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
  const host = resolveServeHost(options.host, deps.env)
  const safety = checkHostSafety(host, deps.env)
  if (!safety.allowed) {
    // The same message serve() would print. Kept in checkHostSafety rather
    // than written out at each call site so the two cannot drift.
    ;(deps.onError ?? console.error)(safety.message ?? '')
    ;(deps.onExit ?? process.exit)(1)
    return
  }

  const db = deps.createDatabase(deps.dbPath)
  deps.serve({ port: options.port, host, db })
}

const MAX_PORT_ATTEMPTS = 10
const AGENT_REAPER_INTERVAL_MS = 15_000
const CODEX_LOG_INTERVAL_MS = 5_000
const PORT_FILE = join(AIUSAGE_DIR, '.serve-port')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
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
  const host = resolveServeHost(options.host)
  const isLoopback = isLoopbackHost(host)
  const hostSafety = checkHostSafety(host)
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
    onSyncScheduleChanged: (ts) => syncRuntime.setNextSyncAt(ts),
  })
  runtimeSettings.start()

  // Parse logs once on startup so the dashboard has data immediately
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
    void runQuotaSnapshot().catch((err) => {
      console.error('[serve] initial quota snapshot failed:', err)
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
    void runDbWrite(() => runCodexLogTick({
      db: options.db,
      now,
      applyEvents: (events) => applyAgentEvents(options.db, events, {
        projectRoots: loadConfig()?.projectRoots,
        device: hostname(),
        deviceInstanceId: getState(AIUSAGE_DIR)?.deviceInstanceId ?? 'unknown',
        platform: process.platform,
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

  const server = http.createServer(async (req, res) => {
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
  })

  let currentPort = options.port
  let started = false

  const listenOnPort = (port: number): void => {
    currentPort = port
    server.listen(port, host)
  }

  server.on('listening', () => {
    started = true
    writeFileSync(PORT_FILE, String(currentPort), 'utf-8')
    // Say what was actually bound and whether it is protected. "listening on
    // localhost" was true of the URL and false of the bind.
    const scope = isLoopback
      ? 'local only'
      : (hostSafety.insecure ? 'network, NO PASSWORD — insecure' : 'network, password required')
    console.log(`aiusage serve listening on http://${host}:${currentPort} (${scope})`)
  })

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
    notificationSender.stop()
    server.close(() => {
      process.exit(0)
    })
  })

  process.on('SIGTERM', () => {
    cleanup()
    runtimeSettings.stop()
    clearInterval(agentReaper)
    clearInterval(codexLogWatcher)
    notificationSender.stop()
    server.close(() => {
      process.exit(0)
    })
  })
}
