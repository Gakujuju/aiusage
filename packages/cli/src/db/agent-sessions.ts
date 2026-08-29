import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  applyDecay,
  classifyNotification,
  resolveProjectDisplayName,
  confidenceForSource,
  generateAgentSessionId,
  isAgentEventKind,
  resolveStatus,
  statusForKind,
  type AgentEventKind,
  type AgentEventSource,
  type AgentSessionState,
  type AgentStatus,
} from '@aiusage/core'
import { extractProjectFromCwd } from '../api/project-extraction.js'
import { loadConfig } from '../config.js'

/**
 * Storage for agent session state (Phase 6-B).
 *
 * Every write here runs inside one transaction and must be reached through
 * runDbWrite, like every other writer in the process.
 */

/** Payloads come from hook stdin, which can be arbitrarily large. */
const MAX_PAYLOAD_BYTES = 4096
const MAX_DETAIL_CHARS = 200
const MAX_PROMPT_PREVIEW_CHARS = 120

export interface AgentEventInput {
  sessionId: string
  tool: string
  kind: AgentEventKind
  ts?: number
  source?: AgentEventSource
  cwd?: string
  pid?: number
  device?: string
  deviceInstanceId?: string
  platform?: string
  detail?: string
  status?: AgentStatus
  payload?: Record<string, unknown>
  dedupeKey?: string
}

export interface AgentEventContext {
  /** Extra workspace roots from config, for naming the project. */
  projectRoots?: string[]
  device: string
  deviceInstanceId: string
  platform: string
  now: number
  /** Off by default: prompt text is the most sensitive thing a hook carries. */
  storePromptPreview?: boolean
}

export interface AppliedSession {
  id: string
  sessionId: string
  tool: string
  status: AgentStatus
  statusSince: number
  changed: boolean
  /**
   * Whether the kind of the latest event changed, even if the status did not.
   *
   * Needed because two different events can share a status while meaning
   * different things to a person: StopFailure and Stop both leave a session at
   * waiting_for_user, but one is "作業完了" and the other "処理エラー終了".
   * Watching only `changed` would announce the first and swallow the second.
   */
  kindChanged: boolean
}

export interface ApplyEventsResult {
  applied: number
  skipped: number
  sessions: AppliedSession[]
}

interface SessionRow {
  id: string
  agent_session_id: string
  tool: string
  device: string
  device_instance_id: string
  platform: string
  cwd: string
  project: string
  pid: number | null
  status: AgentStatus
  status_detail: string
  status_source: string
  status_confidence: number
  status_since: number
  status_expires_at: number | null
  last_event_at: number
  last_event_kind: string
  last_heartbeat_at: number | null
  started_at: number
  ended_at: number | null
  exit_reason: string | null
  last_prompt_at: number | null
  last_prompt_preview: string
  turn_count: number
  notify_state: string
  notified_at: number | null
  record_link_state: string
  created_at: number
  updated_at: number
}

function truncate(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.length <= max ? value : value.slice(0, max)
}

/** JSON, capped. A payload we cannot serialise is recorded as empty, not fatal. */
function serialisePayload(payload: unknown): string {
  if (payload == null) return '{}'
  let text: string
  try {
    text = JSON.stringify(payload)
  } catch {
    return '{}'
  }
  if (typeof text !== 'string') return '{}'
  if (Buffer.byteLength(text, 'utf8') <= MAX_PAYLOAD_BYTES) return text
  // Keep it valid JSON rather than a truncated fragment nothing can read.
  return JSON.stringify({ truncated: true, bytes: Buffer.byteLength(text, 'utf8') })
}

function eventId(sessionPk: string, ts: number, kind: string, salt: string): string {
  return createHash('sha256')
    .update(sessionPk + '\0' + ts + '\0' + kind + '\0' + salt)
    .digest('hex')
    .slice(0, 16)
}

function toState(row: SessionRow): AgentSessionState {
  return {
    status: row.status,
    statusSince: row.status_since,
    statusConfidence: row.status_confidence,
    statusExpiresAt: row.status_expires_at,
    lastEventAt: row.last_event_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    endedAt: row.ended_at,
  }
}

/**
 * The status an event asserts. `notification` and `manual` bring their own;
 * everything else is fixed by its kind.
 */
function incomingStatusFor(event: AgentEventInput): AgentStatus | null {
  if (event.kind === 'notification') {
    const payload = event.payload ?? {}
    return classifyNotification(
      typeof payload.message === 'string' ? payload.message : event.detail,
      typeof payload.notification_type === 'string' ? payload.notification_type : null,
    )
  }
  if (event.kind === 'manual') return event.status ?? null
  if (event.kind === 'session_end') {
    // SessionEnd carries a reason; only the error ones are a failure.
    const reason = (event.payload?.reason ?? '') as string
    if (typeof reason === 'string' && /error|crash|fail/i.test(reason)) return 'failed'
    return 'completed'
  }
  return statusForKind(event.kind)
}

export class AgentSessionEmitter {
  private readonly listeners = new Set<(session: AppliedSession) => void>()

  subscribe(listener: (session: AppliedSession) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(session: AppliedSession): void {
    for (const listener of this.listeners) {
      try {
        listener(session)
      } catch {
        // A bad subscriber must not take the ingest path down with it.
      }
    }
  }

  get size(): number {
    return this.listeners.size
  }
}

export function applyAgentEvents(
  db: Database.Database,
  events: AgentEventInput[],
  ctx: AgentEventContext,
  emitter?: AgentSessionEmitter,
): ApplyEventsResult {
  const result: ApplyEventsResult = { applied: 0, skipped: 0, sessions: [] }
  if (!Array.isArray(events) || events.length === 0) return result

  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now()

  const selectSession = db.prepare('SELECT * FROM agent_sessions WHERE id = ?')
  const insertSession = db.prepare(`
    INSERT INTO agent_sessions (
      id, agent_session_id, tool, device, device_instance_id, platform, cwd, project, pid,
      status, status_detail, status_source, status_confidence, status_since, status_expires_at,
      last_event_at, last_event_kind, last_heartbeat_at,
      started_at, ended_at, exit_reason,
      last_prompt_at, last_prompt_preview, turn_count,
      notify_state, notified_at, record_link_state, created_at, updated_at
    ) VALUES (
      @id, @agentSessionId, @tool, @device, @deviceInstanceId, @platform, @cwd, @project, @pid,
      'unknown', '', 'unknown', 0, @ts, NULL,
      @ts, '', NULL,
      @ts, NULL, NULL,
      NULL, '', 0,
      '', NULL, 'pending', @ts, @ts
    )
  `)
  const updateSession = db.prepare(`
    UPDATE agent_sessions SET
      status = @status, status_detail = @statusDetail, status_source = @statusSource,
      status_confidence = @statusConfidence, status_since = @statusSince,
      status_expires_at = @statusExpiresAt,
      last_event_at = @lastEventAt, last_event_kind = @lastEventKind,
      last_heartbeat_at = @lastHeartbeatAt,
      ended_at = @endedAt, exit_reason = @exitReason,
      cwd = @cwd, project = @project, pid = @pid, device = @device, platform = @platform,
      last_prompt_at = @lastPromptAt, last_prompt_preview = @lastPromptPreview,
      turn_count = @turnCount,
      notify_state = @notifyState, notified_at = @notifiedAt,
      updated_at = @updatedAt
    WHERE id = @id
  `)
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO agent_session_events (
      id, session_pk, ts, received_at, kind, source,
      status_before, status_after, confidence, payload, dedupe_key
    ) VALUES (
      @id, @sessionPk, @ts, @receivedAt, @kind, @source,
      @statusBefore, @statusAfter, @confidence, @payload, @dedupeKey
    )
  `)
  const closeSpan = db.prepare(`
    UPDATE agent_session_spans
    SET ended_at = @endedAt, duration_ms = MAX(0, @endedAt - started_at)
    WHERE session_pk = @sessionPk AND ended_at IS NULL
  `)
  const openSpan = db.prepare(`
    INSERT INTO agent_session_spans (id, session_pk, status, source, confidence, started_at, ended_at, duration_ms)
    VALUES (@id, @sessionPk, @status, @source, @confidence, @startedAt, NULL, NULL)
  `)
  const dedupeExists = db.prepare('SELECT 1 FROM agent_session_events WHERE dedupe_key = ?')

  const emitted: AppliedSession[] = []

  const apply = db.transaction(() => {
    for (const event of events) {
      if (!event || typeof event.sessionId !== 'string' || !event.sessionId) continue
      if (!isAgentEventKind(event.kind)) continue

      // A repeat of an event we already stored — the spool retries with the
      // same key, so this is the normal path after a failed send.
      if (event.dedupeKey && dedupeExists.get(event.dedupeKey)) {
        result.skipped++
        continue
      }

      const deviceInstanceId = event.deviceInstanceId || ctx.deviceInstanceId || ''
      const pk = generateAgentSessionId(deviceInstanceId, event.tool, event.sessionId)
      const ts = Number.isFinite(event.ts) ? (event.ts as number) : now
      const source: AgentEventSource = event.source ?? 'hook'
      const cwd = typeof event.cwd === 'string' ? event.cwd : ''

      let row = selectSession.get(pk) as SessionRow | undefined
      if (!row) {
        insertSession.run({
          id: pk,
          agentSessionId: event.sessionId,
          tool: event.tool,
          device: event.device || ctx.device || '',
          deviceInstanceId,
          platform: event.platform || ctx.platform || '',
          cwd,
          project: cwd ? extractProjectFromCwd(cwd, ctx.projectRoots) : '',
          pid: Number.isFinite(event.pid) ? event.pid : null,
          ts,
        })
        row = selectSession.get(pk) as SessionRow
      }

      const before = row.status
      const incomingStatus = incomingStatusFor(event)
      const resolution = resolveStatus(
        toState(row),
        {
          kind: event.kind,
          source,
          status: incomingStatus,
          ts,
          confidence: source === 'manual' ? confidenceForSource('manual') : undefined,
        },
        now,
      )

      insertEvent.run({
        id: eventId(pk, ts, event.kind, event.dedupeKey ?? randomUUID()),
        sessionPk: pk,
        ts,
        receivedAt: now,
        kind: event.kind,
        source,
        statusBefore: before,
        // NULL records "this event did not move the status", which is the
        // difference between a rejected event and an accepted no-op.
        statusAfter: resolution.changed ? resolution.status : null,
        confidence: confidenceForSource(source),
        payload: serialisePayload(event.payload),
        dedupeKey: event.dedupeKey ?? null,
      })

      if (!resolution.accepted) {
        result.skipped++
        continue
      }

      if (resolution.changed) {
        closeSpan.run({ sessionPk: pk, endedAt: resolution.statusSince })
        openSpan.run({
          id: eventId(pk, resolution.statusSince, 'span:' + resolution.status, randomUUID()),
          sessionPk: pk,
          status: resolution.status,
          source,
          confidence: resolution.statusConfidence,
          startedAt: resolution.statusSince,
        })
      } else if (row.status_since === resolution.statusSince) {
        // First accepted event on a brand-new session: no span exists yet.
        const open = db.prepare(
          'SELECT 1 FROM agent_session_spans WHERE session_pk = ? AND ended_at IS NULL'
        ).get(pk)
        if (!open) {
          openSpan.run({
            id: eventId(pk, resolution.statusSince, 'span:' + resolution.status, randomUUID()),
            sessionPk: pk,
            status: resolution.status,
            source,
            confidence: resolution.statusConfidence,
            startedAt: resolution.statusSince,
          })
        }
      }

      const isTerminal = resolution.status === 'completed' || resolution.status === 'failed'
      const promptText = event.kind === 'user_prompt'
        ? (event.payload?.user_message ?? event.payload?.prompt ?? event.detail)
        : null

      updateSession.run({
        id: pk,
        status: resolution.status,
        statusDetail: truncate(event.detail, MAX_DETAIL_CHARS),
        statusSource: source,
        statusConfidence: resolution.statusConfidence,
        statusSince: resolution.statusSince,
        statusExpiresAt: resolution.statusExpiresAt,
        lastEventAt: Math.max(row.last_event_at, ts),
        lastEventKind: event.kind,
        lastHeartbeatAt: event.kind === 'heartbeat' ? ts : row.last_heartbeat_at,
        endedAt: resolution.clearsEnded ? null : (isTerminal ? ts : row.ended_at),
        exitReason: resolution.clearsEnded
          ? null
          : (isTerminal ? (resolution.status === 'failed' ? 'error' : 'session_end') : row.exit_reason),
        cwd: cwd || row.cwd,
        project: cwd ? extractProjectFromCwd(cwd, ctx.projectRoots) : row.project,
        pid: Number.isFinite(event.pid) ? event.pid : row.pid,
        device: event.device || row.device,
        platform: event.platform || row.platform,
        lastPromptAt: event.kind === 'user_prompt' ? ts : row.last_prompt_at,
        lastPromptPreview: ctx.storePromptPreview && promptText
          ? truncate(promptText, MAX_PROMPT_PREVIEW_CHARS)
          : row.last_prompt_preview,
        turnCount: event.kind === 'user_prompt' ? row.turn_count + 1 : row.turn_count,
        // Phase 7 owns these; a status change re-arms whatever it decides.
        notifyState: resolution.changed ? '' : row.notify_state,
        notifiedAt: resolution.changed ? null : row.notified_at,
        updatedAt: now,
      })

      result.applied++
      const applied: AppliedSession = {
        id: pk,
        sessionId: event.sessionId,
        tool: event.tool,
        status: resolution.status,
        statusSince: resolution.statusSince,
        changed: resolution.changed,
        kindChanged: row.last_event_kind !== event.kind,
      }
      result.sessions.push(applied)
      // A new kind can be new news at an unchanged status — see kindChanged.
      if (resolution.changed || applied.kindChanged) emitted.push(applied)
    }
  })

  apply()
  // Outside the transaction: a subscriber must never be able to hold a write
  // lock open, and must only hear about state that is already committed.
  for (const session of emitted) emitter?.emit(session)
  return result
}

export interface DecayResultSummary {
  decayed: number
  closed: number
}

/**
 * Age out sessions nothing has reported on. Runs on a timer; every change goes
 * through the same span bookkeeping as a real event.
 */
export function decayStaleSessions(
  db: Database.Database,
  now: number,
  emitter?: AgentSessionEmitter,
): DecayResultSummary {
  const summary: DecayResultSummary = { decayed: 0, closed: 0 }
  const rows = db.prepare('SELECT * FROM agent_sessions WHERE ended_at IS NULL').all() as SessionRow[]
  if (rows.length === 0) return summary

  const closeSpan = db.prepare(`
    UPDATE agent_session_spans
    SET ended_at = @endedAt, duration_ms = MAX(0, @endedAt - started_at)
    WHERE session_pk = @sessionPk AND ended_at IS NULL
  `)
  const openSpan = db.prepare(`
    INSERT INTO agent_session_spans (id, session_pk, status, source, confidence, started_at, ended_at, duration_ms)
    VALUES (@id, @sessionPk, @status, 'derived', @confidence, @startedAt, NULL, NULL)
  `)
  const update = db.prepare(`
    UPDATE agent_sessions SET
      status = @status, status_source = 'derived', status_confidence = @confidence,
      status_since = @statusSince, status_expires_at = @statusExpiresAt,
      ended_at = @endedAt, exit_reason = @exitReason, updated_at = @now
    WHERE id = @id
  `)
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO agent_session_events (
      id, session_pk, ts, received_at, kind, source,
      status_before, status_after, confidence, payload, dedupe_key
    ) VALUES (@id, @sessionPk, @ts, @ts, 'process_scan', 'derived', @before, @after, @confidence, '{}', NULL)
  `)

  const emitted: AppliedSession[] = []

  const run = db.transaction(() => {
    for (const row of rows) {
      const decay = applyDecay(toState(row), now)
      if (!decay.changed) continue

      closeSpan.run({ sessionPk: row.id, endedAt: decay.statusSince })
      openSpan.run({
        id: eventId(row.id, decay.statusSince, 'decay:' + decay.status, randomUUID()),
        sessionPk: row.id,
        status: decay.status,
        confidence: decay.statusConfidence,
        startedAt: decay.statusSince,
      })
      // A closed session's final span ends where it closed.
      if (decay.endedAt != null) {
        closeSpan.run({ sessionPk: row.id, endedAt: decay.endedAt })
      }

      update.run({
        id: row.id,
        status: decay.status,
        confidence: decay.statusConfidence,
        statusSince: decay.statusSince,
        statusExpiresAt: decay.statusExpiresAt,
        endedAt: decay.endedAt,
        exitReason: decay.exitReason,
        now,
      })
      insertEvent.run({
        id: eventId(row.id, decay.statusSince, 'decay', randomUUID()),
        sessionPk: row.id,
        ts: decay.statusSince,
        before: row.status,
        after: decay.status,
        confidence: decay.statusConfidence,
      })

      summary.decayed++
      if (decay.endedAt != null) summary.closed++
      emitted.push({
        id: row.id,
        sessionId: row.agent_session_id,
        tool: row.tool,
        status: decay.status,
        statusSince: decay.statusSince,
        changed: true,
        kindChanged: false,
      })
    }
  })

  run()
  for (const session of emitted) emitter?.emit(session)
  return summary
}

export interface SessionDurations {
  runningMs: number
  waitingForUserMs: number
  waitingForPermissionMs: number
  idleMs: number
  totalMs: number
}

/**
 * Time spent per status. The open span is measured up to `now`, otherwise a
 * session that is still running would report zero.
 */
export function computeDurations(
  db: Database.Database,
  sessionPks: string[],
  now: number,
): Map<string, SessionDurations> {
  const out = new Map<string, SessionDurations>()
  if (sessionPks.length === 0) return out

  const placeholders = sessionPks.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT session_pk, status, started_at, ended_at, duration_ms
    FROM agent_session_spans
    WHERE session_pk IN (${placeholders})
  `).all(...sessionPks) as Array<{
    session_pk: string
    status: AgentStatus
    started_at: number
    ended_at: number | null
    duration_ms: number | null
  }>

  for (const pk of sessionPks) {
    out.set(pk, {
      runningMs: 0, waitingForUserMs: 0, waitingForPermissionMs: 0, idleMs: 0, totalMs: 0,
    })
  }

  for (const span of rows) {
    const bucket = out.get(span.session_pk)
    if (!bucket) continue
    const ms = span.ended_at != null
      ? (span.duration_ms ?? Math.max(0, span.ended_at - span.started_at))
      : Math.max(0, now - span.started_at)

    if (span.status === 'running') bucket.runningMs += ms
    else if (span.status === 'waiting_for_user') bucket.waitingForUserMs += ms
    else if (span.status === 'waiting_for_permission') bucket.waitingForPermissionMs += ms
    else if (span.status === 'idle') bucket.idleMs += ms
    bucket.totalMs += ms
  }

  return out
}

export interface ListSessionsQuery {
  /** Primary key, for the detail endpoint. Matches at most one row. */
  id?: string | null
  status?: string | null
  tool?: string | null
  device?: string | null
  project?: string | null
  active?: boolean
  limit?: number
  offset?: number
}

export function listAgentSessions(db: Database.Database, query: ListSessionsQuery, now: number) {
  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (query.id) { where.push('s.id = @id'); params.id = query.id }
  if (query.status) { where.push('s.status = @status'); params.status = query.status }
  if (query.tool) { where.push('s.tool = @tool'); params.tool = query.tool }
  if (query.device) { where.push('s.device_instance_id = @device'); params.device = query.device }
  if (query.project) { where.push('s.project = @project'); params.project = query.project }
  if (query.active) where.push('s.ended_at IS NULL')

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(1, query.limit ?? 50), 500)
  const offset = Math.max(0, query.offset ?? 0)

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM agent_sessions s ${clause}`).get(params) as { n: number }).n
  const rows = db.prepare(`
    SELECT s.*, u.record_count, u.total_cost, u.total_tokens
    FROM agent_sessions s
    LEFT JOIN (
      SELECT session_id, tool, device_instance_id,
             COUNT(*) AS record_count, SUM(cost) AS total_cost,
             SUM(input_tokens + output_tokens + cache_read_tokens
                 + cache_write_tokens + thinking_tokens) AS total_tokens
      FROM records WHERE source_file NOT LIKE 'synced/%'
      GROUP BY session_id, tool, device_instance_id
    ) u ON u.tool = s.tool AND u.device_instance_id = s.device_instance_id
       -- Suffix match too: on Windows records.session_id holds the whole path
       -- rather than the bare id. See migration v16.
       AND (u.session_id = s.agent_session_id
            OR u.session_id LIKE '%' || s.agent_session_id)
    ${clause}
    ORDER BY s.last_event_at DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }) as Array<SessionRow & {
    record_count: number | null; total_cost: number | null; total_tokens: number | null
  }>

  const durations = computeDurations(db, rows.map((r) => r.id), now)
  const projectAliases = loadConfig()?.projectAliases

  return {
    total,
    limit,
    offset,
    sessions: rows.map((row) => ({
      id: row.id,
      sessionId: row.agent_session_id,
      tool: row.tool,
      device: row.device,
      deviceInstanceId: row.device_instance_id,
      platform: row.platform,
      cwd: row.cwd,
      project: row.project,
      // Cosmetic layer only — `project` stays the join key against records.
      projectDisplayName: resolveProjectDisplayName(row.project, projectAliases),
      pid: row.pid,
      status: row.status,
      statusDetail: row.status_detail,
      statusSource: row.status_source,
      statusConfidence: row.status_confidence,
      statusSince: row.status_since,
      statusExpiresAt: row.status_expires_at,
      lastEventAt: row.last_event_at,
      lastEventKind: row.last_event_kind,
      lastHeartbeatAt: row.last_heartbeat_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      exitReason: row.exit_reason,
      turnCount: row.turn_count,
      lastPromptAt: row.last_prompt_at,
      lastPromptPreview: row.last_prompt_preview,
      recordLinkState: row.record_count ? 'linked' : row.record_link_state,
      stale: row.status_expires_at != null && now > row.status_expires_at,
      durations: durations.get(row.id)!,
      usage: {
        recordCount: row.record_count ?? 0,
        totalCost: row.total_cost ?? 0,
        totalTokens: row.total_tokens ?? 0,
      },
    })),
  }
}

export function getAgentSession(db: Database.Database, id: string, now: number) {
  // Reuse the list shaping so detail and list can never drift apart, filtered
  // on the primary key so exactly one row comes back however many exist.
  const detail = listAgentSessions(db, { id, limit: 1 }, now).sessions[0]
  if (!detail) return null

  const events = db.prepare(`
    SELECT id, ts, received_at, kind, source, status_before, status_after, confidence, payload
    FROM agent_session_events WHERE session_pk = ? ORDER BY ts DESC LIMIT 100
  `).all(id) as Array<Record<string, unknown>>

  const spans = db.prepare(`
    SELECT id, status, source, confidence, started_at, ended_at, duration_ms
    FROM agent_session_spans WHERE session_pk = ? ORDER BY started_at
  `).all(id)

  return {
    session: detail,
    events: events.map((e) => ({
      id: e.id,
      ts: e.ts,
      receivedAt: e.received_at,
      kind: e.kind,
      source: e.source,
      statusBefore: e.status_before,
      statusAfter: e.status_after,
      confidence: e.confidence,
      payload: e.payload,
    })),
    spans,
  }
}

export function summariseAgentSessions(db: Database.Database, now: number) {
  const byStatus = db.prepare(
    'SELECT status, COUNT(*) AS n FROM agent_sessions GROUP BY status'
  ).all() as Array<{ status: string; n: number }>
  const byTool = db.prepare(
    'SELECT tool, status, COUNT(*) AS n FROM agent_sessions GROUP BY tool, status'
  ).all() as Array<{ tool: string; status: string; n: number }>
  const byDevice = db.prepare(
    'SELECT device_instance_id AS device, status, COUNT(*) AS n FROM agent_sessions GROUP BY device_instance_id, status'
  ).all() as Array<{ device: string; status: string; n: number }>

  const attentionNeeded = (db.prepare(`
    SELECT COUNT(*) AS n FROM agent_sessions
    WHERE ended_at IS NULL AND status IN ('waiting_for_user', 'waiting_for_permission')
  `).get() as { n: number }).n

  const active = (db.prepare(
    'SELECT COUNT(*) AS n FROM agent_sessions WHERE ended_at IS NULL'
  ).get() as { n: number }).n

  const statusCounts: Record<string, number> = {}
  for (const row of byStatus) statusCounts[row.status] = row.n

  return { statusCounts, byTool, byDevice, attentionNeeded, active, generatedAt: now }
}
