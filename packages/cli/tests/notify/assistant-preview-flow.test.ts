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

  it('lists the source field when the reply was empty', () => {
    // Nothing was consumed, so it really was thrown away.
    const out = sanitizePayload('task_complete', { last_agent_message: '   ' }, true)
    expect(out.assistant_preview).toBeUndefined()
    expect(out._droppedKeys).toContain('last_agent_message')
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

describe('stage-3 prerequisites, end to end', () => {
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

  function apply(events: Parameters<typeof applyAgentEvents>[1], now: number, ctx: any = {}) {
    return applyAgentEvents(db, events, {
      device: '自宅PC', deviceInstanceId: 'dii', platform: 'win32', now, ...ctx,
    })
  }

  function notify(sessionPk: string, now: number, ctx: any = {}) {
    return notifySessionChange({ db, config: NOTIFY_ON, now, ...ctx }, sessionPk)
  }

  function lastBody(): string {
    const row = db.prepare('SELECT body FROM notifications ORDER BY rowid DESC LIMIT 1')
      .get() as { body: string } | undefined
    return row?.body ?? ''
  }

  function lastTitle(): string {
    const row = db.prepare('SELECT title FROM notifications ORDER BY rowid DESC LIMIT 1')
      .get() as { title: string } | undefined
    return row?.title ?? ''
  }

  it('says nothing when a session merely opened', () => {
    const result = apply([{
      sessionId: 's-start', tool: 'claude-code', kind: 'session_start',
      ts: T0, source: 'hook',
    }], T0)
    const pk = result.sessions[0].id

    // The session is at waiting_for_user, which is correct — it is waiting
    // for the first prompt — but nothing is announced.
    expect((db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(pk) as any).status)
      .toBe('waiting_for_user')
    const decision = notify(pk, T0 + 1000)
    expect(decision).toEqual({ enqueued: false, reason: 'no_label' })
    expect((db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as any).n).toBe(0)
  })

  it('still announces a turn that finished', () => {
    apply([{ sessionId: 's-stop', tool: 'claude-code', kind: 'user_prompt', ts: T0, source: 'hook' }], T0)
    const result = apply([{
      sessionId: 's-stop', tool: 'claude-code', kind: 'stop', ts: T0 + 60_000, source: 'hook',
      payload: { event_type: 'stop', assistant_preview: '完了報告: 直しました' },
    }], T0 + 60_000)
    const pk = result.sessions[result.sessions.length - 1].id

    expect(notify(pk, T0 + 61_000).enqueued).toBe(true)
    expect(lastTitle()).toContain('作業完了')
    expect(lastBody()).toContain('応答: 完了報告: 直しました')
  })

  it('shows the project under its configured name', () => {
    apply([{
      sessionId: 's-alias', tool: 'claude-code', kind: 'user_prompt', ts: T0, source: 'hook',
      cwd: 'C:\\Users\\me\\Desktop\\shijo-parking-guide',
    }], T0, { projectRoots: ['Desktop'] })
    const result = apply([{
      sessionId: 's-alias', tool: 'claude-code', kind: 'stop', ts: T0 + 60_000, source: 'hook',
    }], T0 + 60_000, { projectRoots: ['Desktop'] })
    const pk = result.sessions[result.sessions.length - 1].id

    // Without the alias this reads "shijo-parking-guide", which is what
    // removing the PowerShell notifier would otherwise have caused.
    expect(notify(pk, T0 + 61_000, {
      projectAliases: { 'shijo-parking-guide': '四条駐車場プロジェクト' },
    }).enqueued).toBe(true)
    expect(lastBody()).toContain('プロジェクト: 四条駐車場プロジェクト')
  })

  it('reports throttling when two kinds land on one status in quick succession', () => {
    // Worth stating what throttling can and cannot catch. applyAgentEvents
    // clears notify_state and notified_at whenever the *status* changes, so a
    // new status is always announced however fast it arrives. The interval
    // only bites when the status held and the kind changed — Stop followed by
    // StopFailure, which both sit at waiting_for_user.
    apply([{ sessionId: 's-throttle', tool: 'claude-code', kind: 'user_prompt', ts: T0, source: 'hook' }], T0)
    const first = apply([{
      sessionId: 's-throttle', tool: 'claude-code', kind: 'stop', ts: T0 + 60_000, source: 'hook',
    }], T0 + 60_000)
    const pk = first.sessions[first.sessions.length - 1].id
    expect(notify(pk, T0 + 60_000).enqueued).toBe(true)

    apply([{
      sessionId: 's-throttle', tool: 'claude-code', kind: 'stop_failure', ts: T0 + 62_000, source: 'hook',
    }], T0 + 62_000)

    const decision = notifySessionChange(
      { db, config: { ...NOTIFY_ON, minIntervalMs: 30_000 }, now: T0 + 62_000 },
      pk,
    )
    expect(decision).toEqual({ enqueued: false, reason: 'throttled' })
  })

  it('always announces a new status, however fast it arrives', () => {
    // The other half of the same rule, stated on purpose: back-to-back turns
    // are each announced, because each is a status change.
    apply([{ sessionId: 's-fast', tool: 'claude-code', kind: 'user_prompt', ts: T0, source: 'hook' }], T0)
    const first = apply([{
      sessionId: 's-fast', tool: 'claude-code', kind: 'stop', ts: T0 + 1_000, source: 'hook',
    }], T0 + 1_000)
    const pk = first.sessions[first.sessions.length - 1].id
    expect(notifySessionChange({ db, config: { ...NOTIFY_ON, minIntervalMs: 30_000 }, now: T0 + 1_000 }, pk).enqueued)
      .toBe(true)

    apply([{ sessionId: 's-fast', tool: 'claude-code', kind: 'user_prompt', ts: T0 + 2_000, source: 'hook' }], T0 + 2_000)
    apply([{ sessionId: 's-fast', tool: 'claude-code', kind: 'stop', ts: T0 + 3_000, source: 'hook' }], T0 + 3_000)

    expect(notifySessionChange({ db, config: { ...NOTIFY_ON, minIntervalMs: 30_000 }, now: T0 + 3_000 }, pk).enqueued)
      .toBe(true)
  })
})
