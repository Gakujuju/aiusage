/**
 * Agent session state model (Phase 6-B).
 *
 * Pure functions over a session's current state and an incoming event. No
 * database, no clock of its own — `now` is always passed in.
 *
 * The hard part is not the state machine but arbitrating between sources that
 * disagree. A hook knows exactly what happened; a process scan only knows a
 * PID still exists. So every source carries a confidence, the server assigns
 * it (never the caller), and a lower-confidence source cannot overwrite a
 * higher-confidence one until the latter has gone stale.
 */

export type AgentStatus =
  | 'running'
  | 'waiting_for_user'
  | 'waiting_for_permission'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'unknown'

export const AGENT_STATUSES: readonly AgentStatus[] = [
  'running',
  'waiting_for_user',
  'waiting_for_permission',
  'idle',
  'completed',
  'failed',
  'unknown',
]

/** Statuses from which a session does not come back on its own. */
export const TERMINAL_STATUSES: readonly AgentStatus[] = ['completed', 'failed']

export type AgentEventSource =
  | 'manual'
  | 'hook'
  | 'log'
  | 'heartbeat'
  | 'process'
  | 'derived'
  | 'unknown'

export type AgentEventKind =
  | 'session_start'
  | 'user_prompt'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'permission_request'
  | 'permission_denied'
  | 'notification'
  | 'stop'
  | 'stop_failure'
  | 'subagent_stop'
  | 'session_end'
  | 'heartbeat'
  | 'process_scan'
  | 'manual'

export const AGENT_EVENT_KINDS: readonly AgentEventKind[] = [
  'session_start',
  'user_prompt',
  'pre_tool_use',
  'post_tool_use',
  'permission_request',
  'permission_denied',
  'notification',
  'stop',
  'stop_failure',
  'subagent_stop',
  'session_end',
  'heartbeat',
  'process_scan',
  'manual',
]

/**
 * How much a claim from each source is worth. Assigned server-side: a client
 * that could name its own confidence could overwrite anything.
 */
export const SOURCE_CONFIDENCE: Record<AgentEventSource, number> = {
  manual: 1.0,
  hook: 0.95,
  log: 0.7,
  heartbeat: 0.5,
  process: 0.3,
  derived: 0.2,
  unknown: 0.0,
}

export function confidenceForSource(source: string | null | undefined): number {
  if (typeof source !== 'string') return SOURCE_CONFIDENCE.unknown
  return SOURCE_CONFIDENCE[source as AgentEventSource] ?? SOURCE_CONFIDENCE.unknown
}

export function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value)
}

export function isAgentEventKind(value: unknown): value is AgentEventKind {
  return typeof value === 'string' && (AGENT_EVENT_KINDS as readonly string[]).includes(value)
}

const MINUTE = 60_000

/**
 * When a status stops being believable, and what it decays into.
 *
 * Two clocks, and the difference between them is the whole point:
 *
 *   ttlMs           how long the status itself stays plausible
 *   silenceTimeoutMs  how long total silence is tolerated before we admit we
 *                     have lost track
 *
 * Silence is only evidence of a problem for a status that implies something is
 * happening. `running` going quiet for half an hour means we missed the end of
 * it. `waiting_for_permission` going quiet for half an hour means the person
 * has not answered yet — which is exactly when the waiting matters most.
 * Decaying it to `unknown` would drop the most valuable signal this project
 * has at the moment it becomes worth acting on.
 *
 * So both are null for the waiting states. What still ends them:
 *   - a day of silence, via SILENCE_TO_COMPLETED_MS below
 *   - a process disappearing (exit_reason 'process_gone'); the reason exists
 *     now, the detection lands with process monitoring in a later phase
 */
export interface DecayRule {
  ttlMs: number | null
  silenceTimeoutMs: number | null
  next: AgentStatus
}

export const DECAY_POLICY: Record<AgentStatus, DecayRule> = {
  // Should be making progress; silence means we missed something.
  running: { ttlMs: 15 * MINUTE, silenceTimeoutMs: 30 * MINUTE, next: 'idle' },
  idle: { ttlMs: 30 * MINUTE, silenceTimeoutMs: 30 * MINUTE, next: 'unknown' },
  // Waiting on a person. Silence is the normal case, not a fault.
  waiting_for_user: { ttlMs: null, silenceTimeoutMs: null, next: 'unknown' },
  waiting_for_permission: { ttlMs: null, silenceTimeoutMs: null, next: 'unknown' },
  // Already terminal, or already the fallback — nothing to decay into.
  completed: { ttlMs: null, silenceTimeoutMs: null, next: 'completed' },
  failed: { ttlMs: null, silenceTimeoutMs: null, next: 'failed' },
  unknown: { ttlMs: null, silenceTimeoutMs: null, next: 'unknown' },
}

/**
 * The silence budget for statuses that have one. Kept as a named export
 * because tests and callers reason about it; DECAY_POLICY decides who it
 * applies to.
 */
export const SILENCE_TO_UNKNOWN_MS = 30 * MINUTE

/** An open session this quiet is presumed over. */
export const SILENCE_TO_COMPLETED_MS = 24 * 60 * MINUTE

/** Confidence a stale claim is demoted to, so a weak source can take over. */
export const STALE_CONFIDENCE = 0.2

export interface AgentSessionState {
  status: AgentStatus
  statusSince: number
  statusConfidence: number
  statusExpiresAt: number | null
  lastEventAt: number
  lastHeartbeatAt: number | null
  endedAt: number | null
}

export interface IncomingAgentEvent {
  kind: AgentEventKind
  source: AgentEventSource
  status: AgentStatus | null
  ts: number
  /** Only honoured for source 'manual'; otherwise derived from the source. */
  confidence?: number
}

export interface StatusResolution {
  /** Whether the session's status actually moved */
  changed: boolean
  /** Whether the event is allowed to update last_event_at and friends */
  accepted: boolean
  status: AgentStatus
  statusSince: number
  statusConfidence: number
  statusExpiresAt: number | null
  /** Set when the event revives a terminal session (a resume) */
  clearsEnded: boolean
  /** Why the event was turned down, for the event log */
  rejectedReason: 'stale_timestamp' | 'terminal' | 'low_confidence' | null
}

function expiryFor(status: AgentStatus, from: number): number | null {
  const rule = DECAY_POLICY[status]
  if (!rule || rule.ttlMs == null) return null
  return from + rule.ttlMs
}

/**
 * Effective weight of what we currently believe. A claim past its TTL is
 * demoted rather than dropped: it is still the best guess, but it should no
 * longer beat a fresh weak signal.
 */
function effectiveConfidence(current: AgentSessionState, now: number): number {
  if (current.statusExpiresAt != null && now > current.statusExpiresAt) {
    return Math.min(current.statusConfidence, STALE_CONFIDENCE)
  }
  return current.statusConfidence
}

/**
 * Decide what an incoming event does to a session.
 *
 * The order of the checks is the specification — see the tests, which walk
 * them one by one.
 */
export function resolveStatus(
  current: AgentSessionState,
  incoming: IncomingAgentEvent,
  now: number,
): StatusResolution {
  const keep = (reason: StatusResolution['rejectedReason']): StatusResolution => ({
    changed: false,
    accepted: false,
    status: current.status,
    statusSince: current.statusSince,
    statusConfidence: current.statusConfidence,
    statusExpiresAt: current.statusExpiresAt,
    clearsEnded: false,
    rejectedReason: reason,
  })

  // 1. The event describes a moment we have already moved past.
  if (incoming.ts < current.statusSince) return keep('stale_timestamp')

  // 2. A finished session stays finished — unless a person says otherwise, or
  //    it is genuinely starting again.
  const isTerminal = (TERMINAL_STATUSES as readonly string[]).includes(current.status)
  const isResume = incoming.kind === 'session_start'
  if (isTerminal && incoming.source !== 'manual' && !isResume) return keep('terminal')

  // An event that carries no opinion about status (subagent_stop, a plain
  // heartbeat) is accepted as activity but leaves the status alone. It is
  // exempt from the confidence contest below because it is not claiming
  // anything to contest — a heartbeat that lost to a fresh hook claim could
  // never do the one job it has, which is to keep that claim alive.
  if (incoming.status == null) {
    return {
      changed: false,
      accepted: true,
      status: current.status,
      statusSince: current.statusSince,
      statusConfidence: current.statusConfidence,
      statusExpiresAt: expiryFor(current.status, incoming.ts),
      clearsEnded: false,
      rejectedReason: null,
    }
  }

  const confidence = incoming.source === 'manual' && typeof incoming.confidence === 'number'
    ? incoming.confidence
    : confidenceForSource(incoming.source)

  // 3/4. Outrank what we already believe, allowing for it having gone stale.
  //      A resume is exempt: restarting a finished session is not a contest.
  if (!(isTerminal && isResume) && confidence < effectiveConfidence(current, now)) {
    return keep('low_confidence')
  }

  // 5. Same status: refresh the clock, but do not restart the span. A run that
  //    reports "still running" every minute is one run, not sixty.
  if (incoming.status === current.status) {
    return {
      changed: false,
      accepted: true,
      status: current.status,
      statusSince: current.statusSince,
      statusConfidence: Math.max(current.statusConfidence, confidence),
      statusExpiresAt: expiryFor(current.status, incoming.ts),
      clearsEnded: isTerminal && isResume,
      rejectedReason: null,
    }
  }

  return {
    changed: true,
    accepted: true,
    status: incoming.status,
    statusSince: incoming.ts,
    statusConfidence: confidence,
    statusExpiresAt: expiryFor(incoming.status, incoming.ts),
    clearsEnded: isTerminal,
    rejectedReason: null,
  }
}

export interface DecayResult {
  changed: boolean
  status: AgentStatus
  statusSince: number
  statusConfidence: number
  statusExpiresAt: number | null
  endedAt: number | null
  exitReason: string | null
}

/**
 * What an untouched session should decay to. Called by the reaper on every
 * open session; returns changed:false for the ones still within their TTL.
 */
export function applyDecay(current: AgentSessionState, now: number): DecayResult {
  const unchanged: DecayResult = {
    changed: false,
    status: current.status,
    statusSince: current.statusSince,
    statusConfidence: current.statusConfidence,
    statusExpiresAt: current.statusExpiresAt,
    endedAt: current.endedAt,
    exitReason: null,
  }

  if (current.endedAt != null) return unchanged

  const lastSignal = Math.max(current.lastEventAt, current.lastHeartbeatAt ?? 0)

  // A whole day of silence: assume it ended and we simply never saw it.
  if (now - lastSignal >= SILENCE_TO_COMPLETED_MS) {
    return {
      changed: true,
      status: 'completed',
      statusSince: now,
      statusConfidence: STALE_CONFIDENCE,
      statusExpiresAt: null,
      endedAt: now,
      exitReason: 'timeout',
    }
  }

  // The status's own TTL ran out — running becomes idle, idle becomes unknown.
  const rule = DECAY_POLICY[current.status]
  if (rule?.ttlMs != null && current.statusExpiresAt != null && now > current.statusExpiresAt) {
    if (rule.next !== current.status) {
      return {
        changed: true,
        status: rule.next,
        statusSince: now,
        statusConfidence: SOURCE_CONFIDENCE.derived,
        statusExpiresAt: expiryFor(rule.next, now),
        endedAt: null,
        exitReason: null,
      }
    }
  }

  // Silence, for the statuses where silence is evidence of a problem. The
  // waiting states opt out via silenceTimeoutMs: null — see DECAY_POLICY.
  if (
    rule?.silenceTimeoutMs != null &&
    now - lastSignal >= rule.silenceTimeoutMs &&
    current.status !== 'unknown'
  ) {
    return {
      changed: true,
      status: 'unknown',
      statusSince: now,
      statusConfidence: SOURCE_CONFIDENCE.derived,
      statusExpiresAt: null,
      endedAt: null,
      exitReason: null,
    }
  }

  return unchanged
}

/**
 * Does this notification mean Claude is blocked on a permission decision, or
 * just asking for input?
 *
 * Four levels, most reliable first:
 *   1. a permission_request event — decided by statusForKind, never reaches here
 *   2. notification_type from the upstream
 *   3. the message text, English and Japanese
 *   4. otherwise, someone is being asked for input
 *
 * Levels 3 and 4 are guesses, which is why the raw message is kept in the
 * payload: the patterns can only be improved by looking at what actually
 * arrived and did not match.
 */
const PERMISSION_PATTERNS: readonly RegExp[] = [
  /needs? your permission/i,
  /permission to use/i,
  /\bapprove\b/i,
  /waiting for your approval/i,
  /許可/,
  /承認/,
  /確認してください/,
]

export function classifyNotification(
  message: string | null | undefined,
  notificationType?: string | null,
): AgentStatus {
  if (typeof notificationType === 'string' && notificationType) {
    if (/permission/i.test(notificationType)) return 'waiting_for_permission'
    return 'waiting_for_user'
  }
  if (typeof message !== 'string' || !message) return 'waiting_for_user'
  for (const pattern of PERMISSION_PATTERNS) {
    if (pattern.test(message)) return 'waiting_for_permission'
  }
  return 'waiting_for_user'
}

/**
 * The status an event kind implies on its own, before any arbitration.
 * null means "record it, but it says nothing about status".
 */
export function statusForKind(kind: AgentEventKind): AgentStatus | null {
  switch (kind) {
    case 'session_start': return 'waiting_for_user'
    case 'user_prompt': return 'running'
    case 'pre_tool_use': return 'running'
    case 'post_tool_use': return 'running'
    // The definitive signal, where the upstream emits it — no text matching.
    case 'permission_request': return 'waiting_for_permission'
    // A refusal does not stop the agent: it tries another route or explains
    // itself, either of which is work. If a Stop follows immediately it
    // overwrites this anyway.
    case 'permission_denied': return 'running'
    case 'stop': return 'waiting_for_user'
    // StopFailure means the *turn* ended on an API error (rate_limit,
    // overloaded, server_error…), not that the session died. The user can
    // retry, so the session is waiting on them — marking it failed would be
    // terminal and would freeze a session that is still very much alive.
    case 'stop_failure': return 'waiting_for_user'
    case 'session_end': return 'completed'
    case 'heartbeat': return null
    case 'subagent_stop': return null
    case 'process_scan': return null
    // notification and manual carry their own status.
    default: return null
  }
}
