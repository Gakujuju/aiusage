import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'

/**
 * The reply preview from capture to Discord body, for both producers.
 *
 * The capture side is covered per-tool elsewhere; what matters here is that
 * the two tools agree on the key name, that the notification picks it up, and
 * that nothing longer than the cap ever reaches a column.
 */
const config = vi.hoisted(() => ({ value: undefined as any }))
vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>()
  return { ...actual, loadConfig: () => config.value }
})

const { initializeDatabase } = await import('../../src/db/index.js')
const { applyAgentEvents } = await import('../../src/db/agent-sessions.js')
const { notifySessionChange } = await import('../../src/notify/enqueue.js')
const { sanitizePayload } = await import('../../src/agent/codex-log-watcher.js')

const T0 = 1_788_000_000_000
const MARKER = 'MARKER-PAST-THE-CAP'
const LONG_REPLY = 'y'.repeat(400) + MARKER

const NOTIFY_ON = {
  enabled: true,
  includeAssistantMessage: true,
  minIntervalMs: 0,
  quietHoursAllow: ['waiting_for_user', 'waiting_for_permission', 'failed', 'completed'],
}

describe('codex sanitizePayload — assistant preview', () => {
  it('keeps nothing while the setting is off', () => {
    const out = sanitizePayload('task_complete', { turn_id: 't', last_agent_message: LONG_REPLY }, false)
    expect(out.assistant_preview).toBeUndefined()
    expect(out._droppedKeys).toContain('last_agent_message')
    expect(JSON.stringify(out)).not.toContain(MARKER)
  })

  it('stores a cut-down preview under the shared key when it is on', () => {
    const out = sanitizePayload('task_complete', { turn_id: 't', last_agent_message: LONG_REPLY }, true)
    // The same key the Claude Code hook client writes, so nothing downstream
    // has to know which tool produced it.
    expect((out.assistant_preview as string).length).toBe(201)
    expect(JSON.stringify(out)).not.toContain(MARKER)
    // Consumed, so it is not also reported as dropped.
    expect(out._droppedKeys ?? []).not.toContain('last_agent_message')
  })

  it('keeps nothing from a line that is not a finished turn', () => {
    const out = sanitizePayload('user_message', { message: LONG_REPLY }, true)
    expect(out.assistant_preview).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain(MARKER)
  })
})

describe('preview reaches the notification body', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    config.value = { notifications: NOTIFY_ON }
  })

  afterEach(() => {
    db.close()
    config.value = undefined
  })

  function apply(events: Parameters<typeof applyAgentEvents>[1], now: number) {
    return applyAgentEvents(db, events, {
      device: '自宅PC', deviceInstanceId: 'dii', platform: 'win32', now,
    })
  }

  function notify(sessionPk: string, now: number) {
    return notifySessionChange({ db, config: NOTIFY_ON, now }, sessionPk)
  }

  function lastBody(): string {
    const row = db.prepare('SELECT body FROM notifications ORDER BY rowid DESC LIMIT 1')
      .get() as { body: string } | undefined
    return row?.body ?? ''
  }

  function finishATurn(tool: string, preview: string | null) {
    const sessionId = `s-${tool}`
    apply([{ sessionId, tool, kind: 'user_prompt', ts: T0, source: 'log' }], T0)
    const result = apply([{
      sessionId, tool, kind: 'stop', ts: T0 + 60_000, source: 'log',
      detail: 'task_complete',
      payload: preview == null ? { event_type: 'stop' } : { event_type: 'stop', assistant_preview: preview },
    }], T0 + 60_000)
    return result.sessions[result.sessions.length - 1].id
  }

  it('shows the reply for a finished Codex turn', () => {
    const pk = finishATurn('codex', '実装が完了しました')
    expect(notify(pk, T0 + 61_000).enqueued).toBe(true)
    expect(lastBody()).toContain('応答: 実装が完了しました')
  })

  it('shows the reply for a finished Claude Code turn', () => {
    const pk = finishATurn('claude-code', 'done, tests green')
    expect(notify(pk, T0 + 61_000).enqueued).toBe(true)
    expect(lastBody()).toContain('応答: done, tests green')
  })

  it('says nothing about a reply when none was captured', () => {
    const pk = finishATurn('codex', null)
    expect(notify(pk, T0 + 61_000).enqueued).toBe(true)
    expect(lastBody()).not.toContain('応答')
  })

  it('leaves the reply out of a session-end notification', () => {
    // The reply belongs to a finished turn. A session ending is a different
    // event, and the last stop's text would be stale by then.
    const sessionId = 's-end'
    apply([{
      sessionId, tool: 'codex', kind: 'stop', ts: T0, source: 'log',
      payload: { event_type: 'stop', assistant_preview: 'turn reply' },
    }], T0)
    const result = apply([{
      sessionId, tool: 'codex', kind: 'session_end', ts: T0 + 60_000, source: 'hook',
    }], T0 + 60_000)
    const pk = result.sessions[result.sessions.length - 1].id

    expect(notify(pk, T0 + 61_000).enqueued).toBe(true)
    expect(lastBody()).not.toContain('応答')
    expect(lastBody()).not.toContain('turn reply')
  })

  it('never lets a reply longer than the cap into the events table', () => {
    // The end-to-end guarantee: whatever a tool hands over, the column holds
    // at most the preview. Searched across the whole payload column.
    const preview = sanitizePayload('task_complete', { last_agent_message: LONG_REPLY }, true)
      .assistant_preview as string
    finishATurn('codex', preview)

    const payloads = (db.prepare('SELECT payload FROM agent_session_events').all() as Array<{ payload: string }>)
      .map((r) => r.payload).join('\n')
    expect(payloads).not.toContain(MARKER)
    expect(payloads).toContain('assistant_preview')
  })
})
