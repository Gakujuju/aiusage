import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import { createApiServer } from '../../src/api/server.js'
import { initializeDatabase } from '../../src/db/index.js'
import { applyAgentEvents, decayStaleSessions, AgentSessionEmitter } from '../../src/db/agent-sessions.js'
import { generateAgentSessionId, SILENCE_TO_COMPLETED_MS } from '@aiusage/core'

const DEVICE_ID = 'agent-device-uuid'
const TOKEN = 'test-ingest-token'
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function ctx(now: number, storePromptPreview = false) {
  return { device: 'test-host', deviceInstanceId: DEVICE_ID, platform: 'win32', now, storePromptPreview }
}

function ev(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    tool: 'claude-code',
    kind: 'user_prompt',
    source: 'hook',
    cwd: 'C:\\Users\\x\\Projects\\aiusage',
    ...overrides,
  } as never
}

describe('migration v14', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => db.close())

  it('records schema version 14', () => {
    const versions = (db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>)
      .map((r) => r.version)
    expect(versions).toContain(14)
  })

  it('creates the three agent tables and the view', () => {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent%'"
    ).all() as Array<{ name: string }>).map((r) => r.name).sort()
    expect(tables).toEqual(['agent_session_events', 'agent_session_spans', 'agent_sessions'])

    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'v_agent_sessions'"
    ).get()).toBeTruthy()
  })

  it('leaves the quota tables from v13 intact', () => {
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE 'quota%' OR name = 'v_quota_snapshots'"
    ).all() as Array<{ name: string }>).map((r) => r.name).sort()
    expect(names).toEqual(['quota_current', 'quota_snapshots', 'quota_windows', 'v_quota_snapshots'])
  })

  it('joins usage into the view through the session id', () => {
    const now = Date.now()
    applyAgentEvents(db, [ev()], ctx(now))
    db.prepare(`
      INSERT INTO records (id, ts, ingested_at, updated_at, line_offset, tool, model, provider,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens,
        cost, cost_source, session_id, source_file, device, device_instance_id)
      VALUES ('r1', ?, ?, ?, 0, 'claude-code', 'm', 'anthropic', 100, 50, 0, 0, 0,
              0.5, 'pricing', ?, '/x.jsonl', 'test-host', ?)
    `).run(now, now, now, SESSION, DEVICE_ID)

    const row = db.prepare('SELECT record_count, total_tokens, total_cost FROM v_agent_sessions').get() as any
    expect(row.record_count).toBe(1)
    expect(row.total_tokens).toBe(150)
    expect(row.total_cost).toBe(0.5)
  })
})

describe('applyAgentEvents', () => {
  let db: Database.Database
  const t0 = 1_700_000_000_000

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => db.close())

  it('creates a session on the first event and opens a span', () => {
    const result = applyAgentEvents(db, [ev({ ts: t0 })], ctx(t0))
    expect(result.applied).toBe(1)

    const pk = generateAgentSessionId(DEVICE_ID, 'claude-code', SESSION)
    const row = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(pk) as any
    expect(row.status).toBe('running')
    expect(row.turn_count).toBe(1)
    expect(row.project).toBe('aiusage')
    expect(row.ended_at).toBeNull()

    const spans = db.prepare('SELECT status, started_at, ended_at FROM agent_session_spans').all() as any[]
    expect(spans).toEqual([{ status: 'running', started_at: t0, ended_at: null }])
  })

  it('walks a whole turn and accumulates running time', () => {
    const MIN = 60_000
    applyAgentEvents(db, [ev({ ts: t0 })], ctx(t0))
    applyAgentEvents(db, [ev({
      ts: t0 + MIN, kind: 'notification',
      payload: { message: 'Claude needs your permission to use Bash' },
    })], ctx(t0 + MIN))
    applyAgentEvents(db, [ev({ ts: t0 + 2 * MIN, kind: 'post_tool_use' })], ctx(t0 + 2 * MIN))
    applyAgentEvents(db, [ev({ ts: t0 + 5 * MIN, kind: 'stop' })], ctx(t0 + 5 * MIN))
    applyAgentEvents(db, [ev({ ts: t0 + 6 * MIN, kind: 'session_end', payload: { reason: 'exit' } })], ctx(t0 + 6 * MIN))

    const pk = generateAgentSessionId(DEVICE_ID, 'claude-code', SESSION)
    const row = db.prepare('SELECT status, ended_at, exit_reason FROM agent_sessions WHERE id = ?').get(pk) as any
    expect(row.status).toBe('completed')
    expect(row.ended_at).toBe(t0 + 6 * MIN)

    const spans = db.prepare(
      'SELECT status, started_at, ended_at FROM agent_session_spans ORDER BY started_at'
    ).all() as any[]
    expect(spans.map((s) => s.status)).toEqual([
      'running', 'waiting_for_permission', 'running', 'waiting_for_user', 'completed',
    ])
    // running: t0→+1min and +2min→+5min
    const runningMs = spans
      .filter((s) => s.status === 'running')
      .reduce((acc, s) => acc + ((s.ended_at ?? 0) - s.started_at), 0)
    expect(runningMs).toBe(4 * MIN)
  })

  it('names the project from the cwd, per the shared extractor', () => {
    // Desktop is not one of the known workspace roots, so a project living
    // directly under it is reported as "Desktop". This mirrors what
    // /api/projects already does — changing it would regroup existing data.
    applyAgentEvents(db, [ev({ ts: t0, cwd: 'C:\\Users\\x\\Desktop\\aiusage' })], ctx(t0))
    expect((db.prepare('SELECT project FROM agent_sessions').get() as any).project).toBe('Desktop')
  })

  it('takes permission_request as waiting_for_permission outright', () => {
    applyAgentEvents(db, [ev({ ts: t0 })], ctx(t0))
    applyAgentEvents(db, [ev({
      ts: t0 + 1000, kind: 'permission_request', payload: { tool_name: 'Bash' },
    })], ctx(t0 + 1000))
    expect((db.prepare('SELECT status FROM agent_sessions').get() as any).status)
      .toBe('waiting_for_permission')
  })

  it('returns to running when a permission is denied', () => {
    applyAgentEvents(db, [ev({ ts: t0, kind: 'permission_request' })], ctx(t0))
    applyAgentEvents(db, [ev({ ts: t0 + 1000, kind: 'permission_denied' })], ctx(t0 + 1000))
    expect((db.prepare('SELECT status FROM agent_sessions').get() as any).status).toBe('running')
  })

  it('classifies a Japanese permission notification', () => {
    applyAgentEvents(db, [ev({ ts: t0, kind: 'notification', payload: { message: 'Bash の実行を許可しますか' } })], ctx(t0))
    const row = db.prepare('SELECT status FROM agent_sessions').get() as any
    expect(row.status).toBe('waiting_for_permission')
  })

  it('prefers notification_type over the message text', () => {
    // A message that the patterns *would* match, overruled by a type that says
    // otherwise — proving the order, not just the happy path.
    applyAgentEvents(db, [ev({
      ts: t0, kind: 'notification',
      payload: { notification_type: 'idle_prompt', message: 'needs your permission to use Bash' },
    })], ctx(t0))
    expect((db.prepare('SELECT status FROM agent_sessions').get() as any).status).toBe('waiting_for_user')

    applyAgentEvents(db, [ev({
      ts: t0 + 1000, kind: 'notification',
      payload: { notification_type: 'permission_prompt', message: 'anything at all' },
    })], ctx(t0 + 1000))
    expect((db.prepare('SELECT status FROM agent_sessions').get() as any).status).toBe('waiting_for_permission')
  })

  it('falls through to waiting_for_user and keeps the unmatched message', () => {
    const message = 'Claude has something to tell you'
    applyAgentEvents(db, [ev({ ts: t0, kind: 'notification', payload: { message } })], ctx(t0))

    expect((db.prepare('SELECT status FROM agent_sessions').get() as any).status).toBe('waiting_for_user')
    // Kept so the patterns can be improved from what actually arrived.
    const payload = JSON.parse((db.prepare(
      "SELECT payload FROM agent_session_events WHERE kind = 'notification'"
    ).get() as any).payload)
    expect(payload.message).toBe(message)
  })

  it('treats stop_failure as the turn ending, keeping the session open', () => {
    applyAgentEvents(db, [ev({ ts: t0 })], ctx(t0))
    applyAgentEvents(db, [ev({
      ts: t0 + 1000, kind: 'stop_failure', payload: { error_type: 'rate_limit' },
    })], ctx(t0 + 1000))

    const row = db.prepare('SELECT status, ended_at FROM agent_sessions').get() as any
    expect(row.status).toBe('waiting_for_user')
    // Not terminal: the user can retry and the session continues.
    expect(row.ended_at).toBeNull()

    applyAgentEvents(db, [ev({ ts: t0 + 2000 })], ctx(t0 + 2000))
    expect((db.prepare('SELECT status FROM agent_sessions').get() as any).status).toBe('running')
  })

  it('marks session_end with an error reason as failed', () => {
    applyAgentEvents(db, [ev({ ts: t0 })], ctx(t0))
    applyAgentEvents(db, [ev({ ts: t0 + 1000, kind: 'session_end', payload: { reason: 'error' } })], ctx(t0 + 1000))
    const row = db.prepare('SELECT status, exit_reason FROM agent_sessions').get() as any
    expect(row.status).toBe('failed')
    expect(row.exit_reason).toBe('error')
  })

  it('lets session_start resume a completed session', () => {
    applyAgentEvents(db, [ev({ ts: t0, kind: 'session_end', payload: { reason: 'exit' } })], ctx(t0))
    expect((db.prepare('SELECT ended_at FROM agent_sessions').get() as any).ended_at).toBe(t0)

    applyAgentEvents(db, [ev({ ts: t0 + 1000, kind: 'session_start', payload: { source: 'resume' } })], ctx(t0 + 1000))
    const row = db.prepare('SELECT status, ended_at FROM agent_sessions').get() as any
    expect(row.status).toBe('waiting_for_user')
    expect(row.ended_at).toBeNull()
  })

  it('records a rejected event with a null status_after', () => {
    applyAgentEvents(db, [ev({ ts: t0, kind: 'session_end', payload: { reason: 'exit' } })], ctx(t0))
    const result = applyAgentEvents(db, [ev({ ts: t0 + 1000 })], ctx(t0 + 1000))

    expect(result.applied).toBe(0)
    expect(result.skipped).toBe(1)
    const rejected = db.prepare(
      "SELECT status_before, status_after FROM agent_session_events WHERE kind = 'user_prompt'"
    ).get() as any
    expect(rejected.status_before).toBe('completed')
    expect(rejected.status_after).toBeNull()
  })

  it('skips a duplicate dedupeKey without applying it twice', () => {
    const first = applyAgentEvents(db, [ev({ ts: t0, dedupeKey: 'k1' })], ctx(t0))
    expect(first.applied).toBe(1)
    const second = applyAgentEvents(db, [ev({ ts: t0 + 1000, dedupeKey: 'k1' })], ctx(t0 + 1000))
    expect(second.applied).toBe(0)
    expect(second.skipped).toBe(1)
    expect((db.prepare('SELECT turn_count FROM agent_sessions').get() as any).turn_count).toBe(1)
  })

  it('does not store the prompt unless asked to', () => {
    applyAgentEvents(db, [ev({ ts: t0, payload: { user_message: 'my secret plan' } })], ctx(t0))
    expect((db.prepare('SELECT last_prompt_preview FROM agent_sessions').get() as any).last_prompt_preview).toBe('')

    applyAgentEvents(db, [ev({ ts: t0 + 1000, payload: { user_message: 'my secret plan' } })], ctx(t0 + 1000, true))
    expect((db.prepare('SELECT last_prompt_preview FROM agent_sessions').get() as any).last_prompt_preview)
      .toBe('my secret plan')
  })

  it('truncates an oversized payload to valid JSON', () => {
    applyAgentEvents(db, [ev({ ts: t0, payload: { message: 'x'.repeat(10_000) } })], ctx(t0))
    const row = db.prepare('SELECT payload FROM agent_session_events').get() as any
    expect(Buffer.byteLength(row.payload)).toBeLessThan(4096)
    expect(() => JSON.parse(row.payload)).not.toThrow()
    expect(JSON.parse(row.payload).truncated).toBe(true)
  })

  it('keeps sessions on different devices apart', () => {
    applyAgentEvents(db, [ev({ ts: t0 })], ctx(t0))
    applyAgentEvents(db, [ev({ ts: t0, deviceInstanceId: 'other-device' })], ctx(t0))
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get() as any).n).toBe(2)
  })

  it('emits on a status change and on a kind change, not on a repeat', () => {
    const emitter = new AgentSessionEmitter()
    const seen: Array<{ status: string; changed: boolean; kindChanged: boolean }> = []
    emitter.subscribe((s) => seen.push({ status: s.status, changed: s.changed, kindChanged: s.kindChanged }))

    applyAgentEvents(db, [ev({ ts: t0 })], ctx(t0), emitter)
    applyAgentEvents(db, [ev({ ts: t0 + 1000, kind: 'pre_tool_use' })], ctx(t0 + 1000), emitter)
    // Same kind twice at the same status: nothing new to say.
    applyAgentEvents(db, [ev({ ts: t0 + 1500, kind: 'pre_tool_use' })], ctx(t0 + 1500), emitter)
    applyAgentEvents(db, [ev({ ts: t0 + 2000, kind: 'stop' })], ctx(t0 + 2000), emitter)

    expect(seen).toEqual([
      { status: 'running', changed: true, kindChanged: true },
      { status: 'running', changed: false, kindChanged: true },
      { status: 'waiting_for_user', changed: true, kindChanged: true },
    ])
  })

  // Stop and StopFailure both leave the session at waiting_for_user, but one
  // means 作業完了 and the other 処理エラー終了. Watching only the status
  // would announce the first and swallow the second.
  it('emits for stop_failure arriving at an unchanged status', () => {
    const emitter = new AgentSessionEmitter()
    const seen: Array<{ status: string; changed: boolean; kindChanged: boolean }> = []
    emitter.subscribe((s) => seen.push({ status: s.status, changed: s.changed, kindChanged: s.kindChanged }))

    applyAgentEvents(db, [ev({ ts: t0, kind: 'stop' })], ctx(t0), emitter)
    applyAgentEvents(db, [ev({
      ts: t0 + 1000, kind: 'stop_failure', payload: { error_type: 'rate_limit' },
    })], ctx(t0 + 1000), emitter)

    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual({ status: 'waiting_for_user', changed: false, kindChanged: true })
  })

  it('ignores events with an unknown kind or tool', () => {
    const result = applyAgentEvents(db, [
      ev({ ts: t0, kind: 'not_a_kind' }),
      ev({ ts: t0, sessionId: '' }),
    ], ctx(t0))
    expect(result.applied).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get() as any).n).toBe(0)
  })
})

describe('decayStaleSessions', () => {
  let db: Database.Database
  const t0 = 1_700_000_000_000

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => db.close())

  it('ages a running session to idle after its TTL', () => {
    applyAgentEvents(db, [ev({ ts: t0 })], ctx(t0))
    const at = t0 + 16 * 60_000
    const summary = decayStaleSessions(db, at)

    expect(summary.decayed).toBe(1)
    const row = db.prepare('SELECT status, status_source, ended_at FROM agent_sessions').get() as any
    expect(row.status).toBe('idle')
    expect(row.status_source).toBe('derived')
    expect(row.ended_at).toBeNull()

    const spans = db.prepare('SELECT status, ended_at FROM agent_session_spans ORDER BY started_at').all() as any[]
    expect(spans.map((s) => s.status)).toEqual(['running', 'idle'])
    expect(spans[0].ended_at).toBe(at)
  })

  it('leaves a fresh session alone', () => {
    applyAgentEvents(db, [ev({ ts: t0 })], ctx(t0))
    expect(decayStaleSessions(db, t0 + 60_000).decayed).toBe(0)
  })

  it('closes a session after a day of silence and ends its span', () => {
    applyAgentEvents(db, [ev({ ts: t0, kind: 'stop' })], ctx(t0))
    const at = t0 + SILENCE_TO_COMPLETED_MS + 60_000
    const summary = decayStaleSessions(db, at)

    expect(summary.closed).toBe(1)
    const row = db.prepare('SELECT status, ended_at, exit_reason FROM agent_sessions').get() as any
    expect(row.status).toBe('completed')
    expect(row.exit_reason).toBe('timeout')
    const open = db.prepare('SELECT COUNT(*) AS n FROM agent_session_spans WHERE ended_at IS NULL').get() as any
    expect(open.n).toBe(0)
  })

  it('never touches an already-ended session', () => {
    applyAgentEvents(db, [ev({ ts: t0, kind: 'session_end', payload: { reason: 'exit' } })], ctx(t0))
    expect(decayStaleSessions(db, t0 + SILENCE_TO_COMPLETED_MS * 3).decayed).toBe(0)
  })
})

describe('agent sessions API', () => {
  let db: Database.Database
  let server: http.Server
  let baseUrl: string
  const t0 = Date.now() - 600_000

  beforeEach(async () => {
    process.env.AIUSAGE_INGEST_TOKEN = TOKEN
    db = new Database(':memory:')
    initializeDatabase(db)
    server = createApiServer(db, { currentDeviceInstanceId: DEVICE_ID })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    delete process.env.AIUSAGE_INGEST_TOKEN
    if (server?.listening) {
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    db.close()
  })

  const postEvents = (events: unknown[], token: string | null = TOKEN) =>
    fetch(`${baseUrl}/api/agent/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Aiusage-Token': token } : {}),
      },
      body: JSON.stringify({ events }),
    })

  it('rejects an unauthenticated write with 401', async () => {
    const res = await postEvents([ev({ ts: t0 })], null)
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('UNAUTHORIZED')
  })

  it('rejects a wrong token with 401', async () => {
    const res = await postEvents([ev({ ts: t0 })], 'not-the-token')
    expect(res.status).toBe(401)
  })

  it('accepts a batch with the right token', async () => {
    const res = await postEvents([ev({ ts: t0 })])
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.applied).toBe(1)
    expect(data.sessions[0].status).toBe('running')
  })

  it('rejects an unknown tool and an unknown kind', async () => {
    const badTool = await postEvents([ev({ ts: t0, tool: 'not-a-tool' })])
    expect(badTool.status).toBe(400)
    expect((await badTool.json()).error.code).toBe('INVALID_PARAM')

    const badKind = await postEvents([ev({ ts: t0, kind: 'SessionStart' })])
    expect(badKind.status).toBe(400)
  })

  it('rejects a batch over the limit', async () => {
    const res = await postEvents(Array.from({ length: 201 }, () => ev({ ts: t0 })))
    expect(res.status).toBe(400)
  })

  it('lists sessions with durations, usage and staleness', async () => {
    await postEvents([ev({ ts: t0 })])
    await postEvents([ev({ ts: t0 + 60_000, kind: 'stop' })])

    const res = await fetch(`${baseUrl}/api/agent/sessions`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.total).toBe(1)
    const s = data.sessions[0]
    expect(s.status).toBe('waiting_for_user')
    expect(s.durations.runningMs).toBe(60_000)
    expect(s.durations.waitingForUserMs).toBeGreaterThan(0)
    expect(s.usage).toEqual({ recordCount: 0, totalCost: 0, totalTokens: 0 })
    expect(s.stale).toBe(false)
    expect(s.project).toBe('aiusage')
  })

  it('filters the list by status, tool and active', async () => {
    await postEvents([ev({ ts: t0 })])
    await postEvents([ev({ ts: t0, sessionId: 'other', kind: 'session_end', payload: { reason: 'exit' } })])

    const running = await (await fetch(`${baseUrl}/api/agent/sessions?status=running`)).json()
    expect(running.total).toBe(1)

    const active = await (await fetch(`${baseUrl}/api/agent/sessions?active=true`)).json()
    expect(active.total).toBe(1)

    const byTool = await (await fetch(`${baseUrl}/api/agent/sessions?tool=codex`)).json()
    expect(byTool.total).toBe(0)
  })

  it('rejects an unknown status filter', async () => {
    const res = await fetch(`${baseUrl}/api/agent/sessions?status=busy`)
    expect(res.status).toBe(400)
  })

  it('returns detail with events and spans', async () => {
    await postEvents([ev({ ts: t0 })])
    const list = await (await fetch(`${baseUrl}/api/agent/sessions`)).json()
    const id = list.sessions[0].id

    const res = await fetch(`${baseUrl}/api/agent/sessions/${id}`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.session.id).toBe(id)
    expect(data.events.length).toBe(1)
    expect(data.events[0].kind).toBe('user_prompt')
    expect(data.spans.length).toBe(1)
  })

  it('404s on an unknown session', async () => {
    expect((await fetch(`${baseUrl}/api/agent/sessions/nope`)).status).toBe(404)
  })

  it('finds a session by id however many others exist', async () => {
    // The detail lookup filters on the primary key rather than paging through
    // the list, so a long-lived device does not lose access to its sessions.
    await postEvents(
      Array.from({ length: 60 }, (_, i) => ev({ ts: t0 + i, sessionId: `bulk-${i}` })),
    )
    const list = await (await fetch(`${baseUrl}/api/agent/sessions?limit=1&offset=59`)).json()
    expect(list.total).toBe(60)

    const target = list.sessions[0]
    const res = await fetch(`${baseUrl}/api/agent/sessions/${target.id}`)
    expect(res.status).toBe(200)
    expect((await res.json()).session.id).toBe(target.id)
  })

  it('summarises by status, tool and attention', async () => {
    await postEvents([ev({ ts: t0 })])
    await postEvents([ev({
      ts: t0 + 1000, sessionId: 'perm', kind: 'notification',
      payload: { notification_type: 'permission_prompt' },
    })])

    const data = await (await fetch(`${baseUrl}/api/agent/summary`)).json()
    expect(data.statusCounts.running).toBe(1)
    expect(data.statusCounts.waiting_for_permission).toBe(1)
    expect(data.attentionNeeded).toBe(1)
    expect(data.active).toBe(2)
  })

  it('accepts a heartbeat without moving the status', async () => {
    await postEvents([ev({ ts: t0 })])
    const res = await fetch(`${baseUrl}/api/agent/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Aiusage-Token': TOKEN },
      body: JSON.stringify({ sessionId: SESSION, tool: 'claude-code' }),
    })
    expect(res.status).toBe(200)

    const list = await (await fetch(`${baseUrl}/api/agent/sessions`)).json()
    expect(list.sessions[0].status).toBe('running')
    expect(list.sessions[0].lastHeartbeatAt).toBeGreaterThan(0)
  })

  it('applies a manual status override', async () => {
    await postEvents([ev({ ts: t0 })])
    const list = await (await fetch(`${baseUrl}/api/agent/sessions`)).json()
    const id = list.sessions[0].id

    const res = await fetch(`${baseUrl}/api/agent/sessions/${id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Aiusage-Token': TOKEN },
      body: JSON.stringify({ status: 'idle', detail: 'parked by hand' }),
    })
    expect(res.status).toBe(200)

    const after = await (await fetch(`${baseUrl}/api/agent/sessions`)).json()
    expect(after.sessions[0].status).toBe('idle')
    expect(after.sessions[0].statusSource).toBe('manual')
    expect(after.sessions[0].statusConfidence).toBe(1)
  })

  it('requires a token for the manual override too', async () => {
    await postEvents([ev({ ts: t0 })])
    const list = await (await fetch(`${baseUrl}/api/agent/sessions`)).json()
    const res = await fetch(`${baseUrl}/api/agent/sessions/${list.sessions[0].id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'idle' }),
    })
    expect(res.status).toBe(401)
  })

  it('leaves the pre-existing endpoints untouched', async () => {
    for (const path of ['/api/summary?range=all', '/api/sessions?range=all', '/api/quotas/history', '/api/quotas/forecast']) {
      const res = await fetch(`${baseUrl}${path}`)
      expect(res.status).toBe(200)
    }
  })
})
