import type Database from 'better-sqlite3'
import type { Config } from '../config.js'
import { DEFAULT_HUB_UPLOAD_INTERVAL_MS } from '../sync/hub-upload.js'

export interface RuntimeSettingsControllerOptions {
  db: Database.Database
  loadConfig: () => Config | null
  runParse: (db: Database.Database) => Promise<unknown>
  runCleanup: (db: Database.Database, retentionDays: number) => unknown | Promise<unknown>
  runLeaderboardUpload?: (db: Database.Database) => Promise<unknown>
  runSync?: () => void
  runQuotaSnapshot?: () => Promise<unknown>
  /** Upload this machine's records to the hub. Absent when there is no hub. */
  runHubUpload?: () => Promise<unknown>
  /**
   * Called once each time parsing goes quiet for longer than it should, and
   * not again until it recovers. Absent means nobody is listening, which is
   * the spokes' situation — see the note on checkParseHealth.
   */
  onParseStalled?: (info: ParseHealth & { stalledSince: number }) => void
  /** Injected so the tests can drive it. */
  now?: () => number
  onSyncScheduleChanged?: (nextSyncAt: number | undefined) => void
  cleanupIntervalMs?: number
}

/**
 * How often to ask whether parsing is still happening.
 *
 * Deliberately not the parse interval: this timer's whole purpose is to
 * outlive the one it watches. A minute is fine — it only reads two numbers.
 */
const PARSE_HEALTH_CHECK_INTERVAL_MS = 60 * 1000

/** Missed roughly this many parses before anyone is told. */
const PARSE_STALL_INTERVALS = 3

export interface ParseHealth {
  /** When a parse last finished without throwing. Null before the first. */
  lastParseOkAt: number | null
  /**
   * How long this process has been *running* since that parse.
   *
   * Not wall clock. A laptop that slept for three hours has three hours of
   * elapsed time and almost none of this, which is the point: the parser
   * cannot run while the machine is off, so time it was off is not time it
   * failed to parse.
   *
   * Accumulated by the health timer itself - see checkParseHealth - so
   * nothing here has to ask the operating system about sleep, and nothing
   * has to decide how long a gap must be before it counts as one.
   */
  runningMsSinceParse: number
  /** The interval in force right now, not the one at startup. */
  intervalMs: number
  /** How long a silence has to last before it counts. */
  thresholdMs: number
  stalled: boolean
  /** When the current silence began, or null when it is not stalled. */
  stalledSince: number | null
}

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_LEADERBOARD_UPLOAD_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_QUOTA_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000

/**
 * How often serve parses logs when the config does not say.
 *
 * Upstream leaves this off, and for a single machine that is coherent:
 * opening the dashboard triggers a parse, so the person looking at the
 * numbers is the one who refreshes them. Nobody is worse off for a parse
 * that did not happen while they were not looking.
 *
 * It does not hold here. The spokes run headless — their serve exists to
 * read their own logs and hand the results to the hub — and nobody ever
 * opens their dashboard, so nothing drives them. Worse, the upload to the
 * hub is driven by the parse, so a spoke without this sends its records
 * once at startup and then never again; the laptop's only "uploaded 72
 * record(s)" line came immediately after a restart.
 *
 * So this is not a tuning improvement, it is what makes more than one
 * machine work at all. Setting refreshInterval to 0 still switches it off.
 */
export const DEFAULT_PARSE_INTERVAL_MS = 5 * 60 * 1000

/** How long to wait before the single retry of a parse-blocked snapshot. */
export const QUOTA_SNAPSHOT_RETRY_DELAY_MS = 30 * 1000

export class RuntimeSettingsController {
  private readonly db: Database.Database
  private readonly loadConfigFn: RuntimeSettingsControllerOptions['loadConfig']
  private readonly runParseFn: RuntimeSettingsControllerOptions['runParse']
  private readonly runCleanupFn: RuntimeSettingsControllerOptions['runCleanup']
  private readonly runLeaderboardUploadFn: RuntimeSettingsControllerOptions['runLeaderboardUpload']
  private readonly runSyncFn: RuntimeSettingsControllerOptions['runSync']
  private readonly runQuotaSnapshotFn: RuntimeSettingsControllerOptions['runQuotaSnapshot']
  private readonly runHubUploadFn: RuntimeSettingsControllerOptions['runHubUpload']
  private readonly onSyncScheduleChangedFn: RuntimeSettingsControllerOptions['onSyncScheduleChanged']
  private readonly cleanupIntervalMs: number
  private parseTimer: ReturnType<typeof setInterval> | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private leaderboardUploadTimer: ReturnType<typeof setInterval> | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private quotaSnapshotTimer: ReturnType<typeof setInterval> | null = null
  private quotaSnapshotRetryTimer: ReturnType<typeof setTimeout> | null = null
  private parseInFlight = false
  private readonly onParseStalledFn: RuntimeSettingsControllerOptions['onParseStalled']
  private readonly now: () => number
  /**
   * Set only when a parse completes without throwing.
   *
   * "Attempted" is not the thing worth recording: a run that threw, or one
   * that returned early because another was still in flight, leaves the data
   * exactly as stale as no run at all.
   */
  private lastParseOkAt: number | null = null
  /** @see ParseHealth.runningMsSinceParse */
  private runningMsSinceParse = 0
  /** When the health timer last fired, so the next firing can see the gap. */
  private lastHealthCheckAt: number | null = null
  private parseStalledSince: number | null = null
  private stallTimer: ReturnType<typeof setInterval> | null = null
  private cleanupInFlight = false
  private leaderboardUploadInFlight = false
  private quotaSnapshotInFlight = false
  private hubUploadInFlight = false
  private hubUploadTimer: ReturnType<typeof setInterval> | null = null
  private lastHubUploadAt = 0
  private quotaSnapshotRetrying = false
  private started = false

  constructor(options: RuntimeSettingsControllerOptions) {
    this.db = options.db
    this.loadConfigFn = options.loadConfig
    this.runParseFn = options.runParse
    this.runCleanupFn = options.runCleanup
    this.runLeaderboardUploadFn = options.runLeaderboardUpload
    this.runSyncFn = options.runSync
    this.runQuotaSnapshotFn = options.runQuotaSnapshot
    this.runHubUploadFn = options.runHubUpload
    this.onParseStalledFn = options.onParseStalled
    this.now = options.now ?? Date.now
    this.onSyncScheduleChangedFn = options.onSyncScheduleChanged
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
  }

  start(): void {
    if (this.started) return
    this.started = true
    /*
     * Its own timer, started here rather than in applyConfig.
     *
     * A watcher that lives on the thing it watches cannot report that the
     * thing has stopped — and applyConfig tears every other timer down and
     * rebuilds them, so putting this one there would mean a config reload
     * could silently drop the only thing that would have noticed.
     *
     * Nothing about this timer depends on the parse interval, so a reload
     * has no reason to touch it.
     */
    this.stallTimer = setInterval(() => {
      this.checkParseHealth()
    }, PARSE_HEALTH_CHECK_INTERVAL_MS)
    this.stallTimer.unref?.()

    // Silence only counts from when we started watching; before that there
    // was nothing to be silent about.
    this.lastParseOkAt = this.now()
    this.runningMsSinceParse = 0
    this.lastHealthCheckAt = this.now()

    this.applyConfig()
  }

  /**
   * Whether a parse is running right now. better-sqlite3 is synchronous, so a
   * parse holds the event loop for its whole duration — anything with a
   * network timeout has to stay out of its way.
   */
  isParseInFlight(): boolean {
    return this.parseInFlight
  }

  reload(): void {
    if (!this.started) return
    this.applyConfig()
  }

  stop(): void {
    this.started = false
    if (this.stallTimer) clearInterval(this.stallTimer)
    this.stallTimer = null
    if (this.hubUploadTimer) clearInterval(this.hubUploadTimer)
    this.hubUploadTimer = null
    if (this.parseTimer) clearInterval(this.parseTimer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    if (this.leaderboardUploadTimer) clearInterval(this.leaderboardUploadTimer)
    if (this.syncTimer) clearInterval(this.syncTimer)
    if (this.quotaSnapshotTimer) clearInterval(this.quotaSnapshotTimer)
    this.clearQuotaSnapshotRetry()
    this.parseTimer = null
    this.cleanupTimer = null
    this.leaderboardUploadTimer = null
    this.syncTimer = null
    this.quotaSnapshotTimer = null
  }

  private clearQuotaSnapshotRetry(): void {
    if (this.quotaSnapshotRetryTimer) clearTimeout(this.quotaSnapshotRetryTimer)
    this.quotaSnapshotRetryTimer = null
    this.quotaSnapshotRetrying = false
  }

  private applyConfig(): void {
    if (this.parseTimer) clearInterval(this.parseTimer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    if (this.leaderboardUploadTimer) clearInterval(this.leaderboardUploadTimer)
    if (this.syncTimer) clearInterval(this.syncTimer)
    if (this.quotaSnapshotTimer) clearInterval(this.quotaSnapshotTimer)
    this.parseTimer = null
    this.cleanupTimer = null
    this.leaderboardUploadTimer = null
    this.syncTimer = null
    this.quotaSnapshotTimer = null

    const config = this.loadConfigFn()
    // Defaults to on, for the reason above DEFAULT_PARSE_INTERVAL_MS.
    // parseInterval is the older name and still honoured.
    const parseInterval = Number(
      config?.refreshInterval ?? config?.parseInterval ?? DEFAULT_PARSE_INTERVAL_MS)
    const retentionDays = Number(config?.retentionDays ?? 0)
    const leaderboardUploadInterval = Number(config?.leaderboardUploadInterval ?? DEFAULT_LEADERBOARD_UPLOAD_INTERVAL_MS)

    if (parseInterval > 0) {
      this.parseTimer = setInterval(() => {
        void this.runParseSafely()
      }, parseInterval)
    }

    if (retentionDays > 0) {
      this.cleanupTimer = setInterval(() => {
        void this.runCleanupSafely(retentionDays)
      }, this.cleanupIntervalMs)
    }

    if (config?.leaderboardAutoUpload === true && leaderboardUploadInterval > 0 && this.runLeaderboardUploadFn) {
      this.leaderboardUploadTimer = setInterval(() => {
        void this.runLeaderboardUploadSafely()
      }, leaderboardUploadInterval)
    }

    // Unlike the other timers this one defaults to on: quota history is only
    // useful if it is sampled continuously, and a gap cannot be backfilled.
    const quotaSnapshotInterval = Number(config?.quotaSnapshotInterval ?? DEFAULT_QUOTA_SNAPSHOT_INTERVAL_MS)
    if (quotaSnapshotInterval > 0 && this.runQuotaSnapshotFn) {
      this.quotaSnapshotTimer = setInterval(() => {
        void this.runQuotaSnapshotSafely()
      }, quotaSnapshotInterval)
    }

    const syncInterval = Number(config?.syncInterval ?? 0)
    if (syncInterval > 0 && config?.sync?.backend && this.runSyncFn) {
      const updateNextSyncAt = () => {
        this.onSyncScheduleChangedFn?.(Date.now() + syncInterval)
      }
      updateNextSyncAt()
      this.syncTimer = setInterval(() => {
        this.runSyncFn!()
        updateNextSyncAt()
      }, syncInterval)
    } else {
      this.onSyncScheduleChangedFn?.(undefined)
    }
  }

  private async runParseSafely(): Promise<void> {
    if (this.parseInFlight) return
    this.parseInFlight = true
    try {
      await this.runParseFn(this.db)
      // Only here: reached solely when the parse ran to completion.
      this.lastParseOkAt = this.now()
      this.runningMsSinceParse = 0
      this.parseStalledSince = null
    } catch (err) {
      // Keep scheduling active after individual parse failures.
      console.error('[settings-controller] parse failed:', err)
    } finally {
      this.parseInFlight = false
    }

    /*
     * A parse is the only thing that produces new records, so this is the
     * one moment there is anything to upload. Running on a timer of its own
     * would mean most passes find nothing and the ones that find something
     * are waiting on the next tick rather than on the parse that made them.
     *
     * Outside the flag above: better-sqlite3 holds the event loop while a
     * parse runs, so an upload started inside it would have its timeout
     * expire without the response ever being read. The interval below is
     * what keeps this from firing on every parse.
     */
    void this.runHubUploadSafely()
  }

  /**
   * Upload if enough time has passed since the last one.
   *
   * Rate-limited here rather than by a timer so it can be driven by parses
   * while still not running on every one of them.
   */
  private async runHubUploadSafely(): Promise<void> {
    if (!this.runHubUploadFn) return
    if (this.hubUploadInFlight) return

    const interval = this.hubUploadIntervalMs()
    if (interval <= 0) return
    const now = Date.now()
    if (now - this.lastHubUploadAt < interval) return

    this.hubUploadInFlight = true
    this.lastHubUploadAt = now
    try {
      await this.runHubUploadFn()
    } catch (err) {
      // A hub that is asleep must not stop this machine parsing its own logs.
      console.error('[settings-controller] hub upload failed:', err)
    } finally {
      this.hubUploadInFlight = false
    }
  }

  /**
   * Upload now, subject to the same interval as a parse-driven one.
   *
   * Exposed so serve can call it after the startup parse, which does not run
   * through runParseSafely and would otherwise leave a machine that has been
   * off sitting on its backlog until the first interval parse.
   */
  async uploadToHubNow(): Promise<void> {
    await this.runHubUploadSafely()
  }

  /**
   * The one place that decides whether parsing has gone quiet.
   *
   * Both outputs — the notification and /api/health — read this rather than
   * working it out again, so they cannot come to different conclusions.
   *
   * The interval is read now, not remembered from startup: the config can be
   * reloaded while serve runs, and a threshold derived from a stale interval
   * would either cry wolf or stay silent for hours after someone slowed the
   * poller down.
   */
  parseHealth(): ParseHealth {
    const intervalMs = this.parseIntervalMs()
    const thresholdMs = intervalMs * PARSE_STALL_INTERVALS
    const lastParseOkAt = this.lastParseOkAt

    // Parsing switched off on purpose is not a stall.
    if (intervalMs <= 0 || lastParseOkAt == null) {
      return {
        lastParseOkAt,
        runningMsSinceParse: this.runningMsSinceParse,
        intervalMs,
        thresholdMs,
        stalled: false,
        stalledSince: null,
      }
    }

    // Running time, not elapsed. See ParseHealth.runningMsSinceParse.
    const stalled = this.runningMsSinceParse > thresholdMs
    return {
      lastParseOkAt,
      runningMsSinceParse: this.runningMsSinceParse,
      intervalMs,
      thresholdMs,
      stalled,
      stalledSince: stalled ? lastParseOkAt : null,
    }
  }

  /**
   * Tell someone, once per silence.
   *
   * On a spoke there is nobody to tell: no webhook, no push subscription.
   * The check still runs and /api/health still answers, but the notification
   * goes nowhere. That is a property of the arrangement rather than of this
   * code — a machine nobody watches cannot raise an alarm on its own — and
   * it is written down in OPERATIONS.md next to the hub setup.
   */
  private checkParseHealth(): void {
    /*
     * Add the time this process was actually running, and nothing else.
     *
     * min(gap, interval) rather than "was the gap suspiciously large".
     * A timer that fires on schedule adds its interval; one that fires late
     * adds the interval anyway, so ordinary jitter is absorbed; one that
     * fires after the machine woke from three hours of sleep also adds the
     * interval, so those three hours are simply never added.
     *
     * There is no test for sleep here and no multiplier saying how big a gap
     * has to be to count as one. That is the reason for this shape: today
     * three numbers went into this project that were chosen by eye rather
     * than measured (70%, 90%, fifteen minutes), and a fourth one guarding
     * this would have been the least defensible of them. Sleep does not need
     * to be detected - it falls out as time that was never added.
     */
    const now = this.now()
    const since = this.lastHealthCheckAt
    this.lastHealthCheckAt = now
    if (since != null) {
      this.runningMsSinceParse += Math.min(Math.max(0, now - since), PARSE_HEALTH_CHECK_INTERVAL_MS)
    }

    const health = this.parseHealth()

    if (!health.stalled) {
      this.parseStalledSince = null
      return
    }
    // Already reported this one. A second message adds nothing and the first
    // is still true.
    if (this.parseStalledSince != null) return

    this.parseStalledSince = health.stalledSince
    /*
     * "while running" is load-bearing, not padding.
     *
     * The number used to be wall clock and is not any more, so on a laptop
     * left shut for three hours this says ten minutes - and a reader who
     * takes it for elapsed time will conclude the message is broken. Saying
     * which clock it is makes the small number read as the correct answer it
     * is: the parser had ten minutes in which it could have run, and did not.
     */
    console.warn(
      `[settings-controller] no parse has completed in ${Math.round(health.runningMsSinceParse / 60000)} ` +
      `minute(s) of running time (sleep is not counted); the interval is ` +
      `${Math.round(health.intervalMs / 60000)} minute(s)`)
    this.onParseStalledFn?.({ ...health, stalledSince: health.stalledSince! })
  }

  /** The interval in force, resolved the same way applyConfig resolves it. */
  private parseIntervalMs(): number {
    const config = this.loadConfigFn()
    return Number(config?.refreshInterval ?? config?.parseInterval ?? DEFAULT_PARSE_INTERVAL_MS)
  }

  /** Minutes in config, milliseconds here. 0 switches record upload off. */
  private hubUploadIntervalMs(): number {
    const minutes = this.loadConfigFn()?.hubForward?.recordIntervalMinutes
    if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0) {
      return minutes * 60_000
    }
    return DEFAULT_HUB_UPLOAD_INTERVAL_MS
  }

  private async runCleanupSafely(retentionDays: number): Promise<void> {
    if (this.cleanupInFlight) return
    this.cleanupInFlight = true
    try {
      await this.runCleanupFn(this.db, retentionDays)
    } catch (err) {
      // Keep scheduling active after individual cleanup failures.
      console.error('[settings-controller] cleanup failed:', err)
    } finally {
      this.cleanupInFlight = false
    }
  }

  private async runQuotaSnapshotSafely(): Promise<void> {
    if (this.quotaSnapshotInFlight) return

    // A parse holds the event loop (better-sqlite3 is synchronous), so the
    // usage APIs' 10-second fetch timeout would expire unserviced and every
    // tool would be recorded as failed. Stay out of its way instead.
    if (this.parseInFlight) {
      const retrying = this.quotaSnapshotRetrying
      this.clearQuotaSnapshotRetry()
      if (retrying) {
        // Already the retry — give up and let the next interval have a go,
        // rather than stacking timers behind a parse that is still running.
        console.warn('[settings-controller] quota snapshot skipped again: parse still in flight')
        return
      }
      console.warn('[settings-controller] quota snapshot skipped: parse in flight')
      this.quotaSnapshotRetrying = true
      this.quotaSnapshotRetryTimer = setTimeout(() => {
        this.quotaSnapshotRetryTimer = null
        void this.runQuotaSnapshotSafely()
      }, QUOTA_SNAPSHOT_RETRY_DELAY_MS)
      return
    }

    this.clearQuotaSnapshotRetry()
    this.quotaSnapshotInFlight = true
    try {
      await this.runQuotaSnapshotFn?.()
    } catch (err) {
      // The upstream usage APIs are undocumented and go down; never let that
      // take the timer (or the process) with it.
      console.error('[settings-controller] quota snapshot failed:', err)
    } finally {
      this.quotaSnapshotInFlight = false
    }
  }

  private async runLeaderboardUploadSafely(): Promise<void> {
    if (this.leaderboardUploadInFlight) return
    this.leaderboardUploadInFlight = true
    try {
      await this.runParseFn(this.db)
      await this.runLeaderboardUploadFn?.(this.db)
    } catch (err) {
      // Keep scheduling active after individual upload failures.
      console.error('[settings-controller] leaderboard upload failed:', err)
    } finally {
      this.leaderboardUploadInFlight = false
    }
  }
}
