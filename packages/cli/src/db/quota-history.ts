import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { classifyQuotaError, quotaThresholdCrossings, windowDurationMs, DEFAULT_QUOTA_THRESHOLDS } from '@aiusage/core'
import type { QuotaResult } from '../quota.js'

/**
 * Persistence for subscription quota polling (Phase 6-A).
 *
 * The upstream usage APIs are polled every few minutes, but the numbers only
 * move when the user actually spends quota. Writing a row per poll would grow
 * the table by ~860 rows/day per tier for no extra information, so snapshots
 * are written only when something changed — see `shouldSnapshot`.
 */

/** Minimum utilization delta that counts as a change worth recording. */
const MIN_UTILIZATION_DELTA = 0.1

/** Force a snapshot at least this often so a flat series still has points. */
const MAX_SNAPSHOT_GAP_MS = 60 * 60 * 1000

/**
 * A drop at least this large means the window rolled. Anything smaller is
 * upstream noise: the APIs report mid-recalculation values that wobble by a
 * point or two without the window changing.
 */
const ROLLOVER_DROP_POINTS = 5

/**
 * A reset time that jumps forward by at least this fraction of the window
 * length really is a new window. Smaller jumps are the rolling reset Codex
 * reports for an untouched five_hour window, which creeps forward on every
 * poll and would otherwise mint a window each time.
 */
const ROLLOVER_RESET_JUMP_FRACTION = 0.5

interface RolloverDecision {
  rolled: boolean
  /** Which of the three rules fired, for the gap flag and for logging. */
  reason: 'drop' | 'reset_jump' | 'gap' | null
}

/**
 * Decide whether this observation belongs to a new window.
 *
 * Keyed on resets_at alone this would be trivial, but the upstream reset time
 * is not a stable boundary, so three independent signals are needed. A tier
 * whose length we cannot look up (Copilot) can only use the first.
 */
export function detectRollover(
  previous: { utilization: number; resets_at: number | null; ts: number },
  tier: string,
  utilization: number,
  resetsAt: number | null,
  now: number,
): RolloverDecision {
  // A) The number fell far enough that it cannot be the same window.
  if (previous.utilization - utilization >= ROLLOVER_DROP_POINTS) {
    return { rolled: true, reason: 'drop' }
  }

  const duration = windowDurationMs(tier)
  if (duration == null) return { rolled: false, reason: null }

  // B) The reset time jumped by half a window or more — a real boundary move,
  //    not the few seconds of drift we see between polls.
  if (
    resetsAt != null &&
    previous.resets_at != null &&
    resetsAt - previous.resets_at >= duration * ROLLOVER_RESET_JUMP_FRACTION
  ) {
    return { rolled: true, reason: 'reset_jump' }
  }

  // C) We were not looking for a whole window. Whatever happened in between is
  //    unobserved, so do not draw a line across the gap.
  if (now - previous.ts >= duration) {
    return { rolled: true, reason: 'gap' }
  }

  return { rolled: false, reason: null }
}

export interface QuotaRecordContext {
  device: string
  deviceInstanceId: string
  now: number
}

export interface RecordSummary {
  /**
   * Tools we actually tried to reach. A tool with no credentials on this
   * machine is not counted — it is not set up, not failing.
   */
  attempted: number
  /** Tools that answered */
  succeeded: number
  /** Rows appended to quota_snapshots */
  inserted: number
  /** (tool, tier) pairs whose current row was refreshed, including no-change ones */
  updated: number
  /** Windows closed out because resets_at moved */
  windowsClosed: number
  /** Tools whose poll failed and fell back to the stored value */
  failedTools: string[]
  /**
   * Distinct classifyQuotaError kinds seen this round, '' excluded. Safe to
   * log: these are category names, never the error text, a URL or a token.
   */
  errorKinds: string[]
  /** Thresholds crossed this round, for the notifier to act on. */
  crossings: Array<{
    tool: string
    tier: string
    windowId: string
    threshold: number
    utilization: number
    resetsAt: number | null
  }>
  /** Windows that rolled over this round. */
  resets: Array<{ tool: string; tier: string; newWindowId: string }>
}

/** Notification thresholds, mirrored from the config at the call site. */
export interface QuotaNotifyOptions {
  thresholds?: number[]
}

interface CurrentRow {
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
  notified_level: number
  notified_window_id: string
  updated_at: number
}

/**
 * Identifies one occurrence of a reset window.
 *
 * `openedAt` — the moment we decided a new window had begun — is part of the
 * key, not just resets_at. Rule A rolls a window whose reset time has not
 * moved, and hashing resets_at alone would then hand the new window the id of
 * the one just closed, leaving a permanently-closed row as the current window.
 */
export function computeWindowId(
  deviceInstanceId: string,
  tool: string,
  tier: string,
  resetsAtMs: number | null,
  openedAt: number,
): string {
  const resetPart = resetsAtMs == null ? 'unknown' : String(resetsAtMs)
  return createHash('sha256')
    .update(deviceInstanceId + '\0' + tool + '\0' + tier + '\0' + resetPart + '\0' + openedAt)
    .digest('hex')
    .slice(0, 16)
}

function snapshotId(deviceInstanceId: string, tool: string, tier: string, ts: number): string {
  return createHash('sha256')
    .update(deviceInstanceId + '\0' + tool + '\0' + tier + '\0' + ts)
    .digest('hex')
    .slice(0, 16)
}

/** ISO 8601 → ms, tolerating the null and the malformed. */
export function parseResetsAt(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : null
}

/**
 * Both the delta and the gap are measured against the last row actually
 * written to the series, not against the last poll. quota_current moves on
 * every poll, so comparing to it would let a slow drift (0.05 per poll)
 * accumulate unrecorded, and would make the hourly fallback unreachable.
 */
function shouldSnapshot(
  previous: CurrentRow | undefined,
  lastSnapshot: { ts: number; utilization: number } | null,
  windowId: string,
  utilization: number,
  now: number,
): boolean {
  if (!previous) return true
  if (previous.window_id !== windowId) return true
  if (!lastSnapshot) return true
  if (Math.abs(utilization - lastSnapshot.utilization) >= MIN_UTILIZATION_DELTA) return true
  return now - lastSnapshot.ts >= MAX_SNAPSHOT_GAP_MS
}

/**
 * Fold one round of quota results into the history tables.
 *
 * The whole call is a single transaction; callers must route it through
 * `runDbWrite` so it does not race the parser or the sync writer.
 */
export function recordQuotaSnapshot(
  db: Database.Database,
  results: QuotaResult[],
  ctx: QuotaRecordContext,
  notifyOptions?: QuotaNotifyOptions,
): RecordSummary {
  const summary: RecordSummary = {
    attempted: 0, succeeded: 0, inserted: 0, updated: 0,
    windowsClosed: 0, failedTools: [], errorKinds: [],
    crossings: [], resets: [],
  }
  if (!Array.isArray(results) || results.length === 0) return summary
  const errorKinds = new Set<string>()
  const thresholds = notifyOptions?.thresholds ?? [...DEFAULT_QUOTA_THRESHOLDS]

  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now()
  const deviceInstanceId = ctx.deviceInstanceId || ''
  const device = ctx.device || ''

  // An empty id is not a device that happens to be unnamed — it means
  // state.json does not exist yet, so nothing has minted one. Recording under
  // '' guarantees a split later: the moment state.json appears the same
  // machine starts writing 'unknown', and every tier exists twice, one series
  // frozen and one live. v18 deleted the rows that got in before this guard.
  // Skipping costs one poll interval; recording costs a permanent fork.
  if (deviceInstanceId === '') {
    console.warn(
      '[quota-history] skipping this round: no device instance id yet ' +
      '(state.json has not been created). Recording now would split the ' +
      'history once it is.'
    )
    return summary
  }

  const selectCurrent = db.prepare(
    'SELECT * FROM quota_current WHERE tool = ? AND tier = ? AND device_instance_id = ?'
  )
  const selectCurrentByTool = db.prepare(
    'SELECT * FROM quota_current WHERE tool = ? AND device_instance_id = ?'
  )
  const selectLastSnapshot = db.prepare(`
    SELECT ts, utilization FROM quota_snapshots
    WHERE tool = ? AND tier = ? AND device_instance_id = ?
    ORDER BY ts DESC LIMIT 1
  `)
  const insertSnapshot = db.prepare(`
    INSERT OR REPLACE INTO quota_snapshots (
      id, ts, tool, tier, utilization, resets_at, window_id, device, device_instance_id, created_at
    ) VALUES (@id, @ts, @tool, @tier, @utilization, @resetsAt, @windowId, @device, @deviceInstanceId, @createdAt)
  `)
  const upsertCurrentSuccess = db.prepare(`
    INSERT INTO quota_current (
      tool, tier, device_instance_id, utilization, resets_at, window_id, ts,
      cred_status, last_success_at, last_error, last_error_kind, consecutive_errors,
      notified_level, notified_window_id, updated_at
    ) VALUES (
      @tool, @tier, @deviceInstanceId, @utilization, @resetsAt, @windowId, @ts,
      @credStatus, @ts, NULL, '', 0,
      @notifiedLevel, @notifiedWindowId, @ts
    )
    ON CONFLICT(tool, tier, device_instance_id) DO UPDATE SET
      utilization        = excluded.utilization,
      resets_at          = excluded.resets_at,
      window_id          = excluded.window_id,
      ts                 = excluded.ts,
      cred_status        = excluded.cred_status,
      last_success_at    = excluded.last_success_at,
      last_error         = NULL,
      last_error_kind    = '',
      consecutive_errors = 0,
      notified_level     = excluded.notified_level,
      notified_window_id = excluded.notified_window_id,
      updated_at         = excluded.updated_at
  `)
  const markFailure = db.prepare(`
    UPDATE quota_current
    SET cred_status = @credStatus,
        last_error = @lastError,
        last_error_kind = @lastErrorKind,
        consecutive_errors = consecutive_errors + 1,
        updated_at = @now
    WHERE tool = @tool AND tier = @tier AND device_instance_id = @deviceInstanceId
  `)
  const upsertWindow = db.prepare(`
    INSERT INTO quota_windows (
      window_id, tool, tier, device_instance_id, started_at, resets_at,
      closed_at, peak_utilization, final_utilization, sample_count
    ) VALUES (
      @windowId, @tool, @tier, @deviceInstanceId, @ts, @resetsAt,
      NULL, @utilization, NULL, 1
    )
    ON CONFLICT(window_id) DO UPDATE SET
      resets_at        = excluded.resets_at,
      peak_utilization = MAX(peak_utilization, excluded.peak_utilization),
      sample_count     = sample_count + 1
  `)
  const closeWindow = db.prepare(`
    UPDATE quota_windows
    SET closed_at = @closedAt, final_utilization = @finalUtilization, gap_detected = @gapDetected
    WHERE window_id = @windowId AND closed_at IS NULL
  `)

  const apply = db.transaction(() => {
    for (const result of results) {
      if (!result || typeof result.tool !== 'string') continue

      if (!result.success) {
        summary.failedTools.push(result.tool)
        // Keep utilization / resets_at / window_id untouched: those stored
        // values are what /api/quotas serves as the stale fallback.
        const rows = selectCurrentByTool.all(result.tool, deviceInstanceId) as CurrentRow[]
        // cred_status cannot tell a dead network from working credentials —
        // the reader calls both 'valid'. Phase 7 needs the distinction to say
        // "re-login" versus "you're offline", so classify it here.
        const lastErrorKind = classifyQuotaError(result)
        // An empty kind means the tool simply is not set up here, which is not
        // an attempt and must not read as a failure to the caller's logging.
        if (lastErrorKind) {
          summary.attempted++
          errorKinds.add(lastErrorKind)
        }
        for (const row of rows) {
          markFailure.run({
            tool: row.tool,
            tier: row.tier,
            deviceInstanceId,
            credStatus: result.credentialStatus,
            lastError: result.error ?? result.credentialMessage ?? null,
            lastErrorKind,
            now,
          })
          summary.updated++
        }
        continue
      }

      summary.attempted++
      summary.succeeded++

      for (const tier of result.tiers ?? []) {
        if (!tier || typeof tier.name !== 'string') continue
        if (!Number.isFinite(tier.utilization)) continue

        const resetsAt = parseResetsAt(tier.resetsAt)
        const previous = selectCurrent.get(result.tool, tier.name, deviceInstanceId) as CurrentRow | undefined

        const rollover: RolloverDecision = previous
          ? detectRollover(previous, tier.name, tier.utilization, resetsAt, now)
          : { rolled: false, reason: null }

        // Outside a rollover the window keeps its identity and simply adopts
        // the newer reset time — that is what absorbs Codex's drifting reset.
        const windowId = previous != null && !rollover.rolled
          ? previous.window_id
          : computeWindowId(deviceInstanceId, result.tool, tier.name, resetsAt, now)

        // Notification bookkeeping. notified_level records the highest
        // threshold already announced for this window, so a window that rolls
        // starts announcing again from zero.
        const notifiedLevel = rollover.rolled ? 0 : previous?.notified_level ?? 0
        const crossed = quotaThresholdCrossings(
          rollover.rolled || !previous ? null : previous.utilization,
          tier.utilization,
          thresholds,
        ).filter((t) => t > notifiedLevel)
        if (crossed.length > 0) {
          // Only the highest: three messages saying 80, 95 and 100 in the same
          // second tell the reader nothing the last one does not.
          const highest = crossed[crossed.length - 1]
          summary.crossings.push({
            tool: result.tool,
            tier: tier.name,
            windowId,
            threshold: highest,
            utilization: tier.utilization,
            resetsAt,
          })
        }
        if (rollover.rolled) {
          summary.resets.push({ tool: result.tool, tier: tier.name, newWindowId: windowId })
        }

        if (rollover.rolled) {
          if (rollover.reason === 'gap') {
            console.warn(
              `[quota-history] ${result.tool}/${tier.name}: no observation for a full ` +
              'window; starting a new one rather than joining across the gap'
            )
          }
          closeWindow.run({
            windowId: previous!.window_id,
            closedAt: now,
            // The last value we actually saw, not an interpolation.
            finalUtilization: previous!.utilization,
            gapDetected: rollover.reason === 'gap' ? 1 : 0,
          })
          summary.windowsClosed++
        }

        upsertWindow.run({
          windowId,
          tool: result.tool,
          tier: tier.name,
          deviceInstanceId,
          ts: now,
          resetsAt,
          utilization: tier.utilization,
        })

        const lastSnapshot = selectLastSnapshot.get(result.tool, tier.name, deviceInstanceId) as
          | { ts: number; utilization: number }
          | undefined
        if (shouldSnapshot(previous, lastSnapshot ?? null, windowId, tier.utilization, now)) {
          insertSnapshot.run({
            id: snapshotId(deviceInstanceId, result.tool, tier.name, now),
            ts: now,
            tool: result.tool,
            tier: tier.name,
            utilization: tier.utilization,
            resetsAt,
            windowId,
            device,
            deviceInstanceId,
            createdAt: now,
          })
          summary.inserted++
        }

        upsertCurrentSuccess.run({
          tool: result.tool,
          tier: tier.name,
          deviceInstanceId,
          utilization: tier.utilization,
          resetsAt,
          windowId,
          ts: now,
          credStatus: result.credentialStatus,
          // The highest threshold already announced for this window. A rolled
          // window resets it to 0 above, so the new window announces afresh.
          notifiedLevel: crossed.length > 0 ? crossed[crossed.length - 1] : notifiedLevel,
          notifiedWindowId: windowId,
        })
        summary.updated++
      }
    }
  })

  apply()
  summary.errorKinds = [...errorKinds].sort()
  return summary
}
