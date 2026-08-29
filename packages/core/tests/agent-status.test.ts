import { describe, it, expect } from 'vitest'
import {
  resolveStatus,
  applyDecay,
  classifyNotification,
  statusForKind,
  confidenceForSource,
  isAgentStatus,
  isAgentEventKind,
  SOURCE_CONFIDENCE,
  DECAY_POLICY,
  SILENCE_TO_UNKNOWN_MS,
  SILENCE_TO_COMPLETED_MS,
  STALE_CONFIDENCE,
  type AgentSessionState,
  type IncomingAgentEvent,
  type AgentStatus,
} from '../src/agent-status.js'

const MIN = 60_000
const T0 = 1_700_000_000_000

function state(overrides: Partial<AgentSessionState> = {}): AgentSessionState {
  return {
    status: 'running',
    statusSince: T0,
    statusConfidence: SOURCE_CONFIDENCE.hook,
    statusExpiresAt: T0 + 15 * MIN,
    lastEventAt: T0,
    lastHeartbeatAt: null,
    endedAt: null,
    ...overrides,
  }
}

function event(overrides: Partial<IncomingAgentEvent> = {}): IncomingAgentEvent {
  return { kind: 'stop', source: 'hook', status: 'waiting_for_user', ts: T0 + MIN, ...overrides }
}

describe('confidence table', () => {
  it('ranks sources from manual down to unknown', () => {
    expect(confidenceForSource('manual')).toBe(1)
    expect(confidenceForSource('hook')).toBe(0.95)
    expect(confidenceForSource('log')).toBe(0.7)
    expect(confidenceForSource('heartbeat')).toBe(0.5)
    expect(confidenceForSource('process')).toBe(0.3)
    expect(confidenceForSource('derived')).toBe(0.2)
    expect(confidenceForSource('unknown')).toBe(0)
  })

  it('treats an unrecognised source as worthless rather than trusted', () => {
    expect(confidenceForSource('handcrafted')).toBe(0)
    expect(confidenceForSource(null)).toBe(0)
    expect(confidenceForSource(undefined)).toBe(0)
  })
})

describe('resolveStatus — rule 1: stale timestamps', () => {
  it('rejects an event older than the current status', () => {
    const r = resolveStatus(state({ statusSince: T0 + 5 * MIN }), event({ ts: T0 }), T0 + 6 * MIN)
    expect(r.accepted).toBe(false)
    expect(r.changed).toBe(false)
    expect(r.rejectedReason).toBe('stale_timestamp')
    expect(r.status).toBe('running')
  })

  it('accepts an event exactly at statusSince', () => {
    const r = resolveStatus(state({ statusSince: T0 }), event({ ts: T0 }), T0)
    expect(r.accepted).toBe(true)
  })

  it('rejects a stale event even from a manual source', () => {
    const r = resolveStatus(
      state({ statusSince: T0 + 5 * MIN }),
      event({ ts: T0, source: 'manual', kind: 'manual' }),
      T0 + 6 * MIN,
    )
    expect(r.rejectedReason).toBe('stale_timestamp')
  })
})

describe('resolveStatus — rule 2: terminal sessions', () => {
  const finished = state({
    status: 'completed',
    statusConfidence: SOURCE_CONFIDENCE.hook,
    statusExpiresAt: null,
    endedAt: T0,
  })

  it('refuses a hook event on a completed session', () => {
    const r = resolveStatus(finished, event({ status: 'running', kind: 'user_prompt' }), T0 + MIN)
    expect(r.accepted).toBe(false)
    expect(r.rejectedReason).toBe('terminal')
    expect(r.status).toBe('completed')
  })

  it('refuses a hook event on a failed session', () => {
    const r = resolveStatus(
      state({ status: 'failed', statusExpiresAt: null, endedAt: T0 }),
      event({ status: 'running' }),
      T0 + MIN,
    )
    expect(r.rejectedReason).toBe('terminal')
  })

  it('lets a manual override revive a terminal session', () => {
    const r = resolveStatus(
      finished,
      event({ status: 'running', source: 'manual', kind: 'manual', confidence: 1 }),
      T0 + MIN,
    )
    expect(r.accepted).toBe(true)
    expect(r.changed).toBe(true)
    expect(r.status).toBe('running')
    expect(r.clearsEnded).toBe(true)
  })

  it('lets session_start resume a terminal session', () => {
    const r = resolveStatus(
      finished,
      event({ kind: 'session_start', status: 'waiting_for_user' }),
      T0 + MIN,
    )
    expect(r.accepted).toBe(true)
    expect(r.changed).toBe(true)
    expect(r.status).toBe('waiting_for_user')
    expect(r.clearsEnded).toBe(true)
  })

  it('clears ended even when the resume lands on the same status', () => {
    const r = resolveStatus(
      state({ status: 'completed', statusExpiresAt: null, endedAt: T0 }),
      event({ kind: 'session_start', status: 'completed' }),
      T0 + MIN,
    )
    expect(r.clearsEnded).toBe(true)
  })
})

describe('resolveStatus — rules 3 and 4: confidence', () => {
  it('rejects a weaker source while the current claim is fresh', () => {
    const r = resolveStatus(
      state({ statusConfidence: SOURCE_CONFIDENCE.hook }),
      event({ source: 'process', status: 'idle', kind: 'process_scan' }),
      T0 + MIN,
    )
    expect(r.accepted).toBe(false)
    expect(r.rejectedReason).toBe('low_confidence')
  })

  it('lets a weaker source through once the claim has expired', () => {
    // Past its TTL, a hook claim is demoted to 0.20 — a heartbeat outranks it.
    const stale = state({ statusExpiresAt: T0 + MIN })
    const r = resolveStatus(
      stale,
      event({ source: 'heartbeat', status: 'idle', kind: 'heartbeat', ts: T0 + 20 * MIN }),
      T0 + 20 * MIN,
    )
    expect(r.accepted).toBe(true)
    expect(r.status).toBe('idle')
  })

  it('still rejects a source below the demoted floor', () => {
    const stale = state({ statusExpiresAt: T0 + MIN })
    const r = resolveStatus(
      stale,
      event({ source: 'unknown', status: 'idle', ts: T0 + 20 * MIN }),
      T0 + 20 * MIN,
    )
    expect(r.accepted).toBe(false)
    expect(r.rejectedReason).toBe('low_confidence')
  })

  it('accepts an equal confidence', () => {
    const r = resolveStatus(state(), event({ source: 'hook', status: 'waiting_for_user' }), T0 + MIN)
    expect(r.accepted).toBe(true)
    expect(r.changed).toBe(true)
  })

  it('honours a manual confidence but ignores one from any other source', () => {
    const high = state({ statusConfidence: 1, statusExpiresAt: null, status: 'waiting_for_user' })
    const spoofed = resolveStatus(
      high,
      { kind: 'process_scan', source: 'process', status: 'running', ts: T0 + MIN, confidence: 1 },
      T0 + MIN,
    )
    expect(spoofed.accepted).toBe(false)

    const manual = resolveStatus(
      high,
      { kind: 'manual', source: 'manual', status: 'running', ts: T0 + MIN, confidence: 1 },
      T0 + MIN,
    )
    expect(manual.accepted).toBe(true)
  })
})

describe('resolveStatus — rule 5: same status', () => {
  it('does not restart the span when the status repeats', () => {
    const r = resolveStatus(state(), event({ status: 'running', kind: 'pre_tool_use', ts: T0 + 5 * MIN }), T0 + 5 * MIN)
    expect(r.accepted).toBe(true)
    expect(r.changed).toBe(false)
    expect(r.statusSince).toBe(T0) // unchanged
    expect(r.statusExpiresAt).toBe(T0 + 5 * MIN + 15 * MIN) // clock refreshed
  })

  it('keeps the higher confidence of the two', () => {
    const r = resolveStatus(
      state({ statusConfidence: 1 }),
      event({ status: 'running', source: 'hook', ts: T0 + MIN }),
      T0 + MIN,
    )
    expect(r.statusConfidence).toBe(1)
  })

  it('sets a new statusSince when the status really changes', () => {
    const r = resolveStatus(state(), event({ ts: T0 + 3 * MIN }), T0 + 3 * MIN)
    expect(r.changed).toBe(true)
    expect(r.statusSince).toBe(T0 + 3 * MIN)
  })
})

describe('resolveStatus — events with no opinion', () => {
  it('accepts a heartbeat as liveness without moving the status', () => {
    const r = resolveStatus(
      state(),
      { kind: 'heartbeat', source: 'heartbeat', status: null, ts: T0 + MIN },
      T0 + MIN,
    )
    expect(r.accepted).toBe(true)
    expect(r.changed).toBe(false)
    expect(r.status).toBe('running')
    expect(r.statusSince).toBe(T0)
    expect(r.statusExpiresAt).toBe(T0 + MIN + 15 * MIN)
  })

  it('records subagent_stop without touching the status', () => {
    const r = resolveStatus(
      state(),
      { kind: 'subagent_stop', source: 'hook', status: null, ts: T0 + MIN },
      T0 + MIN,
    )
    expect(r.accepted).toBe(true)
    expect(r.changed).toBe(false)
    expect(r.status).toBe('running')
  })
})

describe('statusForKind', () => {
  it('maps the hook kinds that imply a status', () => {
    expect(statusForKind('session_start')).toBe('waiting_for_user')
    expect(statusForKind('user_prompt')).toBe('running')
    expect(statusForKind('pre_tool_use')).toBe('running')
    expect(statusForKind('post_tool_use')).toBe('running')
    expect(statusForKind('stop')).toBe('waiting_for_user')
    expect(statusForKind('session_end')).toBe('completed')
  })

  it('takes a permission request as definitive, no text matching involved', () => {
    expect(statusForKind('permission_request')).toBe('waiting_for_permission')
  })

  it('keeps the agent running after a permission is denied', () => {
    // A refusal is not a wait: the agent tries another route or explains
    // itself. A Stop right after would overwrite this anyway.
    expect(statusForKind('permission_denied')).toBe('running')
  })

  it('treats stop_failure as the turn ending, not the session dying', () => {
    // StopFailure fires when a turn ends on an API error (rate_limit,
    // overloaded, …). The session survives and the user can retry, so a
    // terminal 'failed' would wrongly freeze it.
    expect(statusForKind('stop_failure')).toBe('waiting_for_user')
  })

  it('returns null for kinds that carry no status of their own', () => {
    expect(statusForKind('heartbeat')).toBeNull()
    expect(statusForKind('subagent_stop')).toBeNull()
    expect(statusForKind('process_scan')).toBeNull()
    expect(statusForKind('notification')).toBeNull()
    expect(statusForKind('manual')).toBeNull()
  })
})

describe('classifyNotification', () => {
  it('prefers notification_type when the upstream provides it', () => {
    expect(classifyNotification('anything at all', 'permission_prompt')).toBe('waiting_for_permission')
    expect(classifyNotification('needs your permission', 'idle_prompt')).toBe('waiting_for_user')
  })

  it('falls back to the English patterns', () => {
    expect(classifyNotification('Claude needs your permission to use Bash')).toBe('waiting_for_permission')
    expect(classifyNotification('Permission to use Write')).toBe('waiting_for_permission')
    expect(classifyNotification('Waiting for your approval')).toBe('waiting_for_permission')
    expect(classifyNotification('Please approve this action')).toBe('waiting_for_permission')
  })

  it('falls back to the Japanese patterns', () => {
    expect(classifyNotification('Bash の実行を許可しますか')).toBe('waiting_for_permission')
    expect(classifyNotification('承認が必要です')).toBe('waiting_for_permission')
    expect(classifyNotification('確認してください')).toBe('waiting_for_permission')
  })

  it('defaults to waiting_for_user for anything else', () => {
    expect(classifyNotification('Claude is waiting for your input')).toBe('waiting_for_user')
    expect(classifyNotification('')).toBe('waiting_for_user')
    expect(classifyNotification(null)).toBe('waiting_for_user')
    expect(classifyNotification(undefined)).toBe('waiting_for_user')
  })

  it('does not match "approve" inside an unrelated word', () => {
    expect(classifyNotification('disapproved the change')).toBe('waiting_for_user')
  })
})

describe('applyDecay', () => {
  it('leaves a fresh session alone', () => {
    const r = applyDecay(state({ lastEventAt: T0 }), T0 + MIN)
    expect(r.changed).toBe(false)
    expect(r.status).toBe('running')
  })

  it('never touches a session that has already ended', () => {
    const r = applyDecay(
      state({ status: 'completed', endedAt: T0, lastEventAt: T0, statusExpiresAt: null }),
      T0 + SILENCE_TO_COMPLETED_MS * 2,
    )
    expect(r.changed).toBe(false)
  })

  it('decays running to idle once its TTL passes', () => {
    const at = T0 + 16 * MIN
    const r = applyDecay(state({ statusExpiresAt: T0 + 15 * MIN, lastEventAt: T0 + 15 * MIN }), at)
    expect(r.changed).toBe(true)
    expect(r.status).toBe('idle')
    expect(r.statusSince).toBe(at)
    expect(r.statusConfidence).toBe(SOURCE_CONFIDENCE.derived)
    expect(r.statusExpiresAt).toBe(at + DECAY_POLICY.idle.ttlMs!)
    expect(r.endedAt).toBeNull()
  })

  it('decays idle to unknown once its TTL passes', () => {
    const at = T0 + 31 * MIN
    const r = applyDecay(
      state({ status: 'idle', statusExpiresAt: T0 + 30 * MIN, lastEventAt: T0 + 29 * MIN }),
      at,
    )
    expect(r.changed).toBe(true)
    expect(r.status).toBe('unknown')
  })

  it('falls to unknown when running goes silent for 30 minutes', () => {
    // The TTL fires first (running → idle at 15 min), so pin the status clock
    // open and let only the silence rule apply.
    const at = T0 + SILENCE_TO_UNKNOWN_MS + MIN
    const r = applyDecay(state({ status: 'running', statusExpiresAt: null }), at)
    expect(r.changed).toBe(true)
    expect(r.status).toBe('unknown')
    expect(r.endedAt).toBeNull()
  })

  it('falls to unknown when idle goes silent for 30 minutes', () => {
    const at = T0 + SILENCE_TO_UNKNOWN_MS + MIN
    const r = applyDecay(state({ status: 'idle', statusExpiresAt: null }), at)
    expect(r.changed).toBe(true)
    expect(r.status).toBe('unknown')
  })

  it('counts a heartbeat as breaking the silence', () => {
    const at = T0 + SILENCE_TO_UNKNOWN_MS + MIN
    const r = applyDecay(
      state({ status: 'running', statusExpiresAt: null, lastHeartbeatAt: at - MIN }),
      at,
    )
    expect(r.changed).toBe(false)
  })

  // A person not answering is the normal case for these, and it is exactly
  // when the waiting is worth acting on. Losing it to 'unknown' would drop
  // the signal at the moment it matters most.
  it('keeps waiting_for_permission through 30 minutes of silence', () => {
    const r = applyDecay(state({ status: 'waiting_for_permission', statusExpiresAt: null }), T0 + SILENCE_TO_UNKNOWN_MS + MIN)
    expect(r.changed).toBe(false)
    expect(r.status).toBe('waiting_for_permission')
  })

  it('keeps waiting_for_user through 30 minutes of silence', () => {
    const r = applyDecay(state({ status: 'waiting_for_user', statusExpiresAt: null }), T0 + SILENCE_TO_UNKNOWN_MS + MIN)
    expect(r.changed).toBe(false)
    expect(r.status).toBe('waiting_for_user')
  })

  it('keeps waiting_for_permission across the 30-minute boundary', () => {
    const waiting = state({ status: 'waiting_for_permission', statusExpiresAt: null })
    for (const at of [
      T0 + SILENCE_TO_UNKNOWN_MS - 1,
      T0 + SILENCE_TO_UNKNOWN_MS,
      T0 + SILENCE_TO_UNKNOWN_MS + 1,
      T0 + 12 * 60 * MIN,
    ]) {
      const r = applyDecay(waiting, at)
      expect(r.changed).toBe(false)
      expect(r.status).toBe('waiting_for_permission')
    }
  })

  it('still closes waiting_for_permission after a day of silence', () => {
    const at = T0 + SILENCE_TO_COMPLETED_MS + MIN
    const r = applyDecay(state({ status: 'waiting_for_permission', statusExpiresAt: null }), at)
    expect(r.changed).toBe(true)
    expect(r.status).toBe('completed')
    expect(r.exitReason).toBe('timeout')
    expect(r.endedAt).toBe(at)
  })

  it('has no silence budget for the waiting states', () => {
    expect(DECAY_POLICY.waiting_for_user.silenceTimeoutMs).toBeNull()
    expect(DECAY_POLICY.waiting_for_permission.silenceTimeoutMs).toBeNull()
    expect(DECAY_POLICY.running.silenceTimeoutMs).toBe(SILENCE_TO_UNKNOWN_MS)
    expect(DECAY_POLICY.idle.silenceTimeoutMs).toBe(SILENCE_TO_UNKNOWN_MS)
  })

  it('closes an open session after a day of silence', () => {
    const at = T0 + SILENCE_TO_COMPLETED_MS + MIN
    const r = applyDecay(state({ status: 'unknown', statusExpiresAt: null }), at)
    expect(r.changed).toBe(true)
    expect(r.status).toBe('completed')
    expect(r.endedAt).toBe(at)
    expect(r.exitReason).toBe('timeout')
    expect(r.statusConfidence).toBe(STALE_CONFIDENCE)
  })

  it('prefers closing over decaying when both are due', () => {
    const at = T0 + SILENCE_TO_COMPLETED_MS + MIN
    const r = applyDecay(state({ status: 'running', statusExpiresAt: T0 + 15 * MIN }), at)
    expect(r.status).toBe('completed')
    expect(r.exitReason).toBe('timeout')
  })

  it('does not re-decay a session already at unknown', () => {
    const r = applyDecay(
      state({ status: 'unknown', statusExpiresAt: null, lastEventAt: T0 }),
      T0 + SILENCE_TO_UNKNOWN_MS + MIN,
    )
    expect(r.changed).toBe(false)
  })
})

describe('type guards', () => {
  it('recognises the status vocabulary', () => {
    for (const s of ['running', 'waiting_for_user', 'waiting_for_permission', 'idle', 'completed', 'failed', 'unknown']) {
      expect(isAgentStatus(s)).toBe(true)
    }
    expect(isAgentStatus('busy')).toBe(false)
    expect(isAgentStatus(null)).toBe(false)
  })

  it('recognises the event vocabulary', () => {
    expect(isAgentEventKind('session_start')).toBe(true)
    expect(isAgentEventKind('stop_failure')).toBe(true)
    expect(isAgentEventKind('SessionStart')).toBe(false)
    expect(isAgentEventKind(42)).toBe(false)
  })
})

describe('a realistic turn', () => {
  it('walks prompt → permission → running → stop → end', () => {
    let s = state({ status: 'waiting_for_user', statusExpiresAt: null, statusConfidence: 0.95 })
    const step = (e: Partial<IncomingAgentEvent>, at: number): AgentStatus => {
      const r = resolveStatus(s, event({ ...e, ts: at }), at)
      expect(r.accepted).toBe(true)
      s = {
        ...s,
        status: r.status,
        statusSince: r.statusSince,
        statusConfidence: r.statusConfidence,
        statusExpiresAt: r.statusExpiresAt,
        lastEventAt: at,
      }
      return r.status
    }

    expect(step({ kind: 'user_prompt', status: 'running' }, T0 + MIN)).toBe('running')
    expect(step({ kind: 'notification', status: 'waiting_for_permission' }, T0 + 2 * MIN)).toBe('waiting_for_permission')
    expect(step({ kind: 'post_tool_use', status: 'running' }, T0 + 3 * MIN)).toBe('running')
    expect(step({ kind: 'stop', status: 'waiting_for_user' }, T0 + 4 * MIN)).toBe('waiting_for_user')
    expect(step({ kind: 'session_end', status: 'completed' }, T0 + 5 * MIN)).toBe('completed')
  })
})
