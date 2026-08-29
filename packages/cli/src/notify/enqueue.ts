import type Database from 'better-sqlite3'
import {
  escalationDue,
  forecastQuota,
  formatQuotaMessage,
  formatSessionMessage,
  notifyStateFor,
  shouldNotifySession,
  DEFAULT_ESCALATION_MS,
  type AgentStatus,
  type NotificationRulesConfig,
  type NotifyDecisionReason,
  type QuotaConfidence,
} from '@aiusage/core'
import { computeDurations } from '../db/agent-sessions.js'
import { enqueueNotification } from '../db/notifications.js'
import type { RecordSummary } from '../db/quota-history.js'

/**
 * Turning things that happened into things to say.
 *
 * Everything here decides and queues; nothing sends. The decision needs the
 * database, so it must be cheap and synchronous — a webhook call in this path
 * would sit inside the write queue.
 */

export interface NotifyContext {
  db: Database.Database
  config: NotificationRulesConfig | undefined
  /** False on machines that watch but do not announce. */
  isNotifier: boolean
  deviceInstanceId: string
  now: number
}

interface SessionRow {
  id: string
  agent_session_id: string
  tool: string
  device: string
  project: string
  status: AgentStatus
  status_detail: string
  status_since: number
  last_event_kind: string
  notify_state: string
  notified_at: number | null
  escalation_level: number
}

function loadSession(db: Database.Database, id: string): SessionRow | undefined {
  return db.prepare(`
    SELECT id, agent_session_id, tool, device, project, status, status_detail,
           status_since, last_event_kind, notify_state, notified_at, escalation_level
    FROM agent_sessions WHERE id = ?
  `).get(id) as SessionRow | undefined
}

/** The most recent error_type recorded for this session, for stop_failure. */
function lastErrorType(db: Database.Database, sessionPk: string): string | null {
  const row = db.prepare(`
    SELECT payload FROM agent_session_events
    WHERE session_pk = ? AND kind = 'stop_failure'
    ORDER BY ts DESC LIMIT 1
  `).get(sessionPk) as { payload: string } | undefined
  if (!row) return null
  try {
    const payload = JSON.parse(row.payload) as { error_type?: unknown }
    return typeof payload.error_type === 'string' ? payload.error_type : null
  } catch {
    return null
  }
}

export interface SessionNotifyResult {
  enqueued: boolean
  reason: NotifyDecisionReason | 'not_found'
}

/**
 * Decide and queue for one session whose status just changed.
 *
 * Runs inside the caller's write transaction, so it stays synchronous.
 */
export function notifySessionChange(ctx: NotifyContext, sessionPk: string): SessionNotifyResult {
  const session = loadSession(ctx.db, sessionPk)
  if (!session) return { enqueued: false, reason: 'not_found' }

  const decision = shouldNotifySession({
    status: session.status,
    lastEventKind: session.last_event_kind,
    previousNotifyState: session.notify_state || null,
    statusSince: session.status_since,
    lastNotifiedAt: session.notified_at,
    now: ctx.now,
    config: ctx.config,
  })
  if (!decision.notify) return { enqueued: false, reason: decision.reason }

  const durations = computeDurations(ctx.db, [sessionPk], ctx.now).get(sessionPk)
  const message = formatSessionMessage({
    status: session.status,
    lastEventKind: session.last_event_kind,
    device: session.device,
    tool: session.tool,
    project: session.project,
    statusSince: session.status_since,
    now: ctx.now,
    runningMs: durations?.runningMs,
    statusDetail: session.status_detail,
    errorType: session.last_event_kind === 'stop_failure' ? lastErrorType(ctx.db, sessionPk) : null,
    config: ctx.config,
  })
  if (!message) return { enqueued: false, reason: 'no_label' }

  enqueueNotification(ctx.db, {
    eventType: 'session_status',
    subjectKind: 'agent_session',
    subjectId: sessionPk,
    // The event kind belongs in the key, not just the status: Stop and
    // StopFailure share waiting_for_user but say different things, and a
    // status-only key silently swallows the second as a duplicate.
    dedupeKey: `session:${sessionPk}:${session.status}:${session.last_event_kind}:${session.status_since}`,
    title: message.title,
    body: message.body,
    payload: { status: session.status, lastEventKind: session.last_event_kind },
    deviceInstanceId: ctx.deviceInstanceId,
    drop: !ctx.isNotifier,
  }, ctx.now)

  // Remember what we said, so the duplicate check has something to compare to.
  ctx.db.prepare('UPDATE agent_sessions SET notify_state = ?, notified_at = ? WHERE id = ?')
    .run(notifyStateFor(session.status, session.last_event_kind, session.status_since), ctx.now, sessionPk)

  return { enqueued: true, reason: 'ok' }
}

/**
 * Re-announce sessions that have been waiting on a person for a while.
 *
 * Only possible because a waiting status no longer decays into `unknown` —
 * previously the session would have been lost before the first step was due.
 */
export function notifyEscalations(ctx: NotifyContext): number {
  const thresholds = ctx.config?.escalation?.waiting_for_permission ?? [...DEFAULT_ESCALATION_MS]
  if (ctx.config?.enabled !== true || thresholds.length === 0) return 0

  const rows = ctx.db.prepare(`
    SELECT id, agent_session_id, tool, device, project, status, status_detail,
           status_since, last_event_kind, notify_state, notified_at, escalation_level
    FROM agent_sessions
    WHERE ended_at IS NULL AND status = 'waiting_for_permission'
  `).all() as SessionRow[]

  let enqueued = 0
  for (const session of rows) {
    const level = escalationDue(
      session.status, session.status_since, session.escalation_level, thresholds, ctx.now,
    )
    if (level == null) continue

    const message = formatSessionMessage({
      status: session.status,
      lastEventKind: session.last_event_kind,
      device: session.device,
      tool: session.tool,
      project: session.project,
      statusSince: session.status_since,
      now: ctx.now,
      statusDetail: session.status_detail,
      escalationLevel: level,
      config: ctx.config,
    })
    if (!message) continue

    enqueueNotification(ctx.db, {
      eventType: 'session_escalation',
      subjectKind: 'agent_session',
      subjectId: session.id,
      dedupeKey: `escalation:${session.id}:${session.status_since}:${level}`,
      title: message.title,
      body: message.body,
      payload: { level },
      deviceInstanceId: ctx.deviceInstanceId,
      drop: !ctx.isNotifier,
    }, ctx.now)

    ctx.db.prepare('UPDATE agent_sessions SET escalation_level = ?, notified_at = ? WHERE id = ?')
      .run(level, ctx.now, session.id)
    enqueued++
  }
  return enqueued
}

export interface QuotaNotifyContext extends NotifyContext {
  device: string
}

/** Queue whatever a quota round turned up. */
export function notifyQuotaSummary(ctx: QuotaNotifyContext, summary: RecordSummary): number {
  if (ctx.config?.enabled !== true) return 0
  let enqueued = 0

  for (const crossing of summary.crossings) {
    // The forecast is only worth showing when it rests on enough samples; the
    // confidence comes from the same place /api/quotas/forecast reads it.
    const forecast = forecastFor(ctx.db, crossing.tool, crossing.tier, crossing.windowId, ctx.now)
    const message = formatQuotaMessage({
      kind: 'threshold',
      device: ctx.device,
      tool: crossing.tool,
      tier: crossing.tier,
      threshold: crossing.threshold,
      utilization: crossing.utilization,
      resetsAt: crossing.resetsAt,
      exhaustAt: forecast.exhaustAt,
      confidence: forecast.confidence,
      now: ctx.now,
      config: ctx.config,
    })

    enqueueNotification(ctx.db, {
      eventType: 'quota_threshold',
      subjectKind: 'quota',
      subjectId: `${crossing.tool}:${crossing.tier}`,
      dedupeKey: `quota:${crossing.tool}:${crossing.tier}:${crossing.windowId}:${crossing.threshold}`,
      title: message.title,
      body: message.body,
      payload: { threshold: crossing.threshold, utilization: crossing.utilization },
      deviceInstanceId: ctx.deviceInstanceId,
      drop: !ctx.isNotifier,
    }, ctx.now)
    enqueued++
  }

  if (ctx.config?.quota?.notifyOnReset === true) {
    for (const reset of summary.resets) {
      const message = formatQuotaMessage({
        kind: 'reset',
        device: ctx.device,
        tool: reset.tool,
        tier: reset.tier,
        utilization: 0,
        resetsAt: null,
        exhaustAt: null,
        confidence: 'low',
        now: ctx.now,
        config: ctx.config,
      })
      enqueueNotification(ctx.db, {
        eventType: 'quota_reset',
        subjectKind: 'quota',
        subjectId: `${reset.tool}:${reset.tier}`,
        dedupeKey: `quotareset:${reset.tool}:${reset.tier}:${reset.newWindowId}`,
        title: message.title,
        body: message.body,
        deviceInstanceId: ctx.deviceInstanceId,
        drop: !ctx.isNotifier,
      }, ctx.now)
      enqueued++
    }
  }

  return enqueued
}

/**
 * Just enough of the forecast to decide whether to print a projection. Kept
 * local rather than importing the API handler's version, which builds a much
 * larger object.
 */
function forecastFor(
  db: Database.Database,
  tool: string,
  tier: string,
  windowId: string,
  now: number,
): { exhaustAt: number | null; confidence: QuotaConfidence } {
  const samples = db.prepare(`
    SELECT ts, utilization FROM quota_snapshots
    WHERE tool = ? AND tier = ? AND window_id = ? ORDER BY ts
  `).all(tool, tier, windowId) as Array<{ ts: number; utilization: number }>

  const current = db.prepare(
    'SELECT resets_at FROM quota_current WHERE tool = ? AND tier = ? LIMIT 1'
  ).get(tool, tier) as { resets_at: number | null } | undefined

  const forecast = forecastQuota({ samples, tier, resetsAt: current?.resets_at ?? null, now })
  return { exhaustAt: forecast.exhaustAt, confidence: forecast.confidence }
}

