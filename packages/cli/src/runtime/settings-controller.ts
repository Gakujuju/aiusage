import type Database from 'better-sqlite3'
import type { Config } from '../config.js'

export interface RuntimeSettingsControllerOptions {
  db: Database.Database
  loadConfig: () => Config | null
  runParse: (db: Database.Database) => Promise<unknown>
  runCleanup: (db: Database.Database, retentionDays: number) => unknown | Promise<unknown>
  runLeaderboardUpload?: (db: Database.Database) => Promise<unknown>
  runSync?: () => void
  runQuotaSnapshot?: () => Promise<unknown>
  onSyncScheduleChanged?: (nextSyncAt: number | undefined) => void
  cleanupIntervalMs?: number
}

const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_LEADERBOARD_UPLOAD_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_QUOTA_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000

export class RuntimeSettingsController {
  private readonly db: Database.Database
  private readonly loadConfigFn: RuntimeSettingsControllerOptions['loadConfig']
  private readonly runParseFn: RuntimeSettingsControllerOptions['runParse']
  private readonly runCleanupFn: RuntimeSettingsControllerOptions['runCleanup']
  private readonly runLeaderboardUploadFn: RuntimeSettingsControllerOptions['runLeaderboardUpload']
  private readonly runSyncFn: RuntimeSettingsControllerOptions['runSync']
  private readonly runQuotaSnapshotFn: RuntimeSettingsControllerOptions['runQuotaSnapshot']
  private readonly onSyncScheduleChangedFn: RuntimeSettingsControllerOptions['onSyncScheduleChanged']
  private readonly cleanupIntervalMs: number
  private parseTimer: ReturnType<typeof setInterval> | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private leaderboardUploadTimer: ReturnType<typeof setInterval> | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private quotaSnapshotTimer: ReturnType<typeof setInterval> | null = null
  private parseInFlight = false
  private cleanupInFlight = false
  private leaderboardUploadInFlight = false
  private quotaSnapshotInFlight = false
  private started = false

  constructor(options: RuntimeSettingsControllerOptions) {
    this.db = options.db
    this.loadConfigFn = options.loadConfig
    this.runParseFn = options.runParse
    this.runCleanupFn = options.runCleanup
    this.runLeaderboardUploadFn = options.runLeaderboardUpload
    this.runSyncFn = options.runSync
    this.runQuotaSnapshotFn = options.runQuotaSnapshot
    this.onSyncScheduleChangedFn = options.onSyncScheduleChanged
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.applyConfig()
  }

  reload(): void {
    if (!this.started) return
    this.applyConfig()
  }

  stop(): void {
    this.started = false
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
    const parseInterval = Number(config?.refreshInterval ?? config?.parseInterval ?? 0)
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
    } catch (err) {
      // Keep scheduling active after individual parse failures.
      console.error('[settings-controller] parse failed:', err)
    } finally {
      this.parseInFlight = false
    }
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
