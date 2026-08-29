import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
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
 * A drop this large without a matching resets_at change is treated as upstream
 * noise rather than a window rollover.
 */
const SUSPICIOUS_DROP_POINTS = 10

export interface QuotaRecordContext {
  device: string
  deviceInstanceId: string
  now: number
}

export interface RecordSummary {
  /** Rows appended to quota_snapshots */
  inserted: number
  /** (tool, tier) pairs whose current row was refreshed, including no-change ones */
  updated: number
  /** Windows closed out because resets_at moved */
  windowsClosed: number
  /** Tools whose poll failed and fell back to the stored value */
  failedTools: string[]
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
  consecutive_errors: number
  notified_level: number
  notified_window_id: string
  updated_at: number
}

/**
 * Identifies one reset window. Keyed on resets_at, so the id changes exactly
 * when the upstream window rolls over — that is the rollover signal.
 */
export function computeWindowId(
  deviceInstanceId: string,
  tool: string,
  tier: string,
  resetsAtMs: number | null,
): string {
  const resetPart = resetsAtMs == null ? 'unknown' : String(resetsAtMs)
  return createHash('sha256')
    .update(deviceInstanceId + '\0' + tool + '\0' + tier + '\0' + resetPart)
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
): RecordSummary {
  const summary: RecordSummary = { inserted: 0, updated: 0, windowsClosed: 0, failedTools: [] }
  if (!Array.isArray(results) || results.length === 0) return summary

  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now()
  const deviceInstanceId = ctx.deviceInstanceId || ''
  const device = ctx.device || ''

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
      cred_status, last_success_at, last_error, consecutive_errors,
      notified_level, notified_window_id, updated_at
    ) VALUES (
      @tool, @tier, @deviceInstanceId, @utilization, @resetsAt, @windowId, @ts,
      @credStatus, @ts, NULL, 0,
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
      consecutive_errors = 0,
      notified_level     = excluded.notified_level,
      notified_window_id = excluded.notified_window_id,
      updated_at         = excluded.updated_at
  `)
  const markFailure = db.prepare(`
    UPDATE quota_current
    SET cred_status = @credStatus,
        last_error = @lastError,
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
    SET closed_at = @closedAt, final_utilization = @finalUtilization
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
        for (const row of rows) {
          markFailure.run({
            tool: row.tool,
            tier: row.tier,
            deviceInstanceId,
            credStatus: result.credentialStatus,
            lastError: result.error ?? result.credentialMessage ?? null,
            now,
          })
          summary.updated++
        }
        continue
      }

      for (const tier of result.tiers ?? []) {
        if (!tier || typeof tier.name !== 'string') continue
        if (!Number.isFinite(tier.utilization)) continue

        const resetsAt = parseResetsAt(tier.resetsAt)
        const candidateWindowId = computeWindowId(deviceInstanceId, result.tool, tier.name, resetsAt)
        const previous = selectCurrent.get(result.tool, tier.name, deviceInstanceId) as CurrentRow | undefined

        // A changed resets_at is the rollover signal — but not on its own.
        // Codex reports a *rolling* reset for an untouched 5-hour window
        // (always "now + 5h"), so the reset time creeps forward on every poll
        // and would otherwise mint a fresh window each time, shredding the
        // series into one-point fragments. A genuine rollover always drops
        // utilization, so require that too; without it we keep the window we
        // already have and just adopt the newer reset time.
        const resetChanged = previous != null && previous.window_id !== candidateWindowId
        const windowRolled = resetChanged && tier.utilization < previous!.utilization
        const windowId = previous != null && !windowRolled ? previous.window_id : candidateWindowId

        if (!resetChanged && previous && previous.utilization - tier.utilization >= SUSPICIOUS_DROP_POINTS) {
          // Same window, but the number fell off a cliff. Upstream sometimes
          // reports mid-recalculation values; treating that as a new window
          // would fragment the series and re-arm notifications for nothing.
          console.warn(
            `[quota-history] ${result.tool}/${tier.name}: utilization dropped ` +
            `${previous.utilization.toFixed(1)} → ${tier.utilization.toFixed(1)} ` +
            'without a reset change; keeping the current window'
          )
        }

        if (windowRolled) {
          closeWindow.run({
            windowId: previous!.window_id,
            closedAt: now,
            finalUtilization: previous!.utilization,
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
          // A new window means the Phase 7 notifier should be allowed to fire
          // again from scratch.
          notifiedLevel: windowRolled ? 0 : previous?.notified_level ?? 0,
          notifiedWindowId: windowRolled ? '' : previous?.notified_window_id ?? '',
        })
        summary.updated++
      }
    }
  })

  apply()
  return summary
}
