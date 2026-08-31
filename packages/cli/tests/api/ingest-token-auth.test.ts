import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

/**
 * A dashboard password must not lock out the machine's own hooks.
 *
 * agent-event runs as a separate process with no cookie jar, so once a
 * password was set every POST it made came back 401 — and agent-event spools
 * what it cannot send, so nothing errored, nothing logged, and notifications
 * just stopped. The token is the hook's credential and has to satisfy the
 * password gate on its own.
 */
// getIngestToken reads AIUSAGE_INGEST_TOKEN before it reads state.json, so
// the token can be supplied without touching a data directory. Mocking
// AIUSAGE_DIR would not work anyway: server.ts binds it at import time.

const TOKEN = 'test-ingest-token-0123456789'
const PASSWORD = 'a-dashboard-password'

let db: Database.Database

const { initializeDatabase } = await import('../../src/db/index.js')
const { createApiServer } = await import('../../src/api/server.js')

/** Drive the handler directly; no socket, no port. */
async function request(
  server: ReturnType<typeof createApiServer>,
  path: string,
  { method = 'GET', headers = {} as Record<string, string>, body = '' } = {},
): Promise<{ status: number; body: string }> {
  const { Readable } = await import('node:stream')
  const req: any = Readable.from(body ? [Buffer.from(body)] : [])
  req.url = path
  req.method = method
  req.headers = { host: '127.0.0.1', ...headers }

  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const res: any = {
      statusCode: 200,
      headersSent: false,
      setHeader() {},
      getHeader() { return undefined },
      writeHead(status: number) { this.statusCode = status; return this },
      write(chunk: any) { chunks.push(Buffer.from(chunk)); return true },
      end(chunk?: any) {
        if (chunk) chunks.push(Buffer.from(chunk))
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString('utf-8') })
      },
      on() { return this },
      once() { return this },
      emit() { return false },
    }
    server.emit('request', req, res)
  })
}

describe('the ingest token satisfies the dashboard password', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    process.env.AIUSAGE_INGEST_TOKEN = TOKEN
    process.env.AIUSAGE_DASHBOARD_PASSWORD = PASSWORD
  })

  afterEach(() => {
    db.close()
    delete process.env.AIUSAGE_INGEST_TOKEN
    delete process.env.AIUSAGE_DASHBOARD_PASSWORD
  })

  function server() {
    return createApiServer(db, { isLoopbackBind: false })
  }

  const event = JSON.stringify({
    events: [{ sessionId: 's1', tool: 'claude-code', kind: 'stop' }],
  })

  it('accepts a hook POST carrying a valid token', async () => {
    const response = await request(server(), '/api/agent/events', {
      method: 'POST',
      headers: { 'x-aiusage-token': TOKEN, 'content-type': 'application/json' },
      body: event,
    })
    expect(response.status).not.toBe(401)
  })

  it('refuses the same POST with no token and no cookie', async () => {
    const response = await request(server(), '/api/agent/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: event,
    })
    expect(response.status).toBe(401)
  })

  it('refuses a wrong token', async () => {
    const response = await request(server(), '/api/agent/events', {
      method: 'POST',
      headers: { 'x-aiusage-token': 'not-the-token', 'content-type': 'application/json' },
      body: event,
    })
    expect(response.status).toBe(401)
  })

  it('does not let a dashboard cookie stand in for the token', async () => {
    // The substitution runs one way. A browser session may read the
    // dashboard; only the machine's own hook may write events.
    const { buildAuthCookie } = await import('../../src/auth.js')
    const cookie = buildAuthCookie(PASSWORD).split(';')[0]
    const response = await request(server(), '/api/agent/events', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: event,
    })
    expect(response.status).toBe(401)
  })

  it('still accepts the token when no password is set at all', async () => {
    delete process.env.AIUSAGE_DASHBOARD_PASSWORD
    const response = await request(server(), '/api/agent/events', {
      method: 'POST',
      headers: { 'x-aiusage-token': TOKEN, 'content-type': 'application/json' },
      body: event,
    })
    expect(response.status).not.toBe(401)
  })

  it('does not let the token read anything outside /api/agent/', async () => {
    // The token is a write credential for the hooks, not a login. It travels
    // the network on every POST, so letting it also unlock the dashboard's
    // data would make a leaked header as bad as a leaked password.
    const withToken = await request(server(), '/api/summary', {
      headers: { 'x-aiusage-token': TOKEN },
    })
    expect(withToken.status).toBe(401)

    const without = await request(server(), '/api/summary')
    expect(without.status).toBe(401)
  })

  it('opens the agent endpoints and nothing else', async () => {
    const agent = await request(server(), '/api/agent/sessions', {
      headers: { 'x-aiusage-token': TOKEN },
    })
    expect(agent.status).toBe(200)

    for (const path of ['/api/quotas', '/api/cost', '/api/sessions', '/api/config']) {
      const response = await request(server(), path, { headers: { 'x-aiusage-token': TOKEN } })
      expect(response.status, path).toBe(401)
    }
  })

  it('lets the cookie holder read the dashboard, as before', async () => {
    const { buildAuthCookie } = await import('../../src/auth.js')
    const cookie = buildAuthCookie(PASSWORD).split(';')[0]
    const response = await request(server(), '/api/summary', { headers: { cookie } })
    expect(response.status).toBe(200)
  })
})

describe('the event stream is a read, so the token does not open it', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    process.env.AIUSAGE_INGEST_TOKEN = TOKEN
    process.env.AIUSAGE_DASHBOARD_PASSWORD = PASSWORD
  })

  afterEach(() => {
    db.close()
    delete process.env.AIUSAGE_INGEST_TOKEN
    delete process.env.AIUSAGE_DASHBOARD_PASSWORD
  })

  function server() {
    return createApiServer(db, { isLoopbackBind: false })
  }

  it('refuses a token-only subscriber', async () => {
    // Everything else the token unlocks under /api/agent/ is a hook writing
    // what it just observed. This one hands back the session state the
    // dashboard shows, and the token travels the network on every POST — so
    // opening it here would undo the point of narrowing the exemption.
    const response = await request(server(), '/api/agent/stream', {
      headers: { 'x-aiusage-token': TOKEN },
    })
    expect(response.status).toBe(401)
  })

  it('opens it for a dashboard cookie', async () => {
    // This one never calls end(): the whole point is that it stays open. So
    // the assertion is on the head, not on a finished response.
    const { buildAuthCookie } = await import('../../src/auth.js')
    const { Readable } = await import('node:stream')
    const cookie = buildAuthCookie(PASSWORD).split(';')[0]

    const req: any = Readable.from([])
    req.url = '/api/agent/stream'
    req.method = 'GET'
    req.headers = { host: '127.0.0.1', cookie }

    const head = await new Promise<{ status: number; headers: Record<string, string> }>((resolve) => {
      const res: any = {
        statusCode: 200,
        headersSent: false,
        setHeader() {},
        getHeader() { return undefined },
        writeHead(status: number, headers?: Record<string, string>) {
          resolve({ status, headers: headers ?? {} })
          return this
        },
        write() { return true },
        end() {},
        on() { return this },
        once() { return this },
        emit() { return false },
      }
      server().emit('request', req, res)
    })

    expect(head.status).toBe(200)
    expect(head.headers['Content-Type']).toContain('text/event-stream')
  })

  it('still opens the write endpoints for the token', async () => {
    // The narrowing is one path, not the whole prefix.
    const response = await request(server(), '/api/agent/events', {
      method: 'POST',
      headers: { 'x-aiusage-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ sessionId: 's1', tool: 'claude-code', kind: 'stop' }] }),
    })
    expect(response.status).not.toBe(401)
  })
})

/**
 * The same token, now also good for record uploads from another machine.
 *
 * The rule the original narrowing expressed was never "only agent paths" —
 * it was "the token is a write key, never a read key". A laptop posting its
 * usage records is in the same position a hook is: another process, on
 * another machine, with no cookie jar, whose only purpose is to write. What
 * must not move is the other half of the rule.
 */
describe('the ingest token opens writes under /api/sync/, never reads', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    process.env.AIUSAGE_INGEST_TOKEN = TOKEN
    process.env.AIUSAGE_DASHBOARD_PASSWORD = PASSWORD
  })

  afterEach(() => {
    db.close()
    delete process.env.AIUSAGE_INGEST_TOKEN
    delete process.env.AIUSAGE_DASHBOARD_PASSWORD
  })

  function server() {
    return createApiServer(db, { isLoopbackBind: false })
  }

  const payload = JSON.stringify({
    records: [{
      id: 'rec-1', ts: 1_700_000_000_000, tool: 'claude-code', model: 'claude-opus-4',
      provider: 'anthropic', inputTokens: 10, outputTokens: 5, cost: 0.001,
      costSource: 'pricing', sessionKey: 'k', device: '職場PC',
      deviceInstanceId: 'dev-work', platform: 'win32', updatedAt: 1_700_000_000_000,
      sourceFile: 'C:/logs/1.jsonl', cwd: 'C:/work',
    }],
  })

  it('accepts an upload carrying a valid token', async () => {
    const response = await request(server(), '/api/sync/records', {
      method: 'POST',
      headers: { 'x-aiusage-token': TOKEN, 'content-type': 'application/json' },
      body: payload,
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body).accepted).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM synced_records').get()).toEqual({ n: 1 })
  })

  it('refuses the same upload with no token', async () => {
    const response = await request(server(), '/api/sync/records', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    expect(response.status).toBe(401)
    expect(db.prepare('SELECT COUNT(*) AS n FROM synced_records').get()).toEqual({ n: 0 })
  })

  /**
   * The point of the whole narrowing. The token travels the network on every
   * hook and every upload; cache.db never leaves the disk. A token that
   * opened reads would turn the first into a key for the second.
   */
  it('still answers 401 on a read, token or not', async () => {
    for (const path of ['/api/summary', '/api/records', '/api/sessions', '/api/agent/stream']) {
      const response = await request(server(), path, {
        headers: { 'x-aiusage-token': TOKEN },
      })
      expect(response.status, `${path} must not open to the token`).toBe(401)
    }
  })

  it('does not open the sync trigger, which is not a record write', async () => {
    // /api/sync (no trailing slash) starts a GitHub sync from the dashboard.
    // It is outside the /api/sync/ prefix on purpose.
    const response = await request(server(), '/api/sync', {
      headers: { 'x-aiusage-token': TOKEN },
    })
    expect(response.status).toBe(401)
  })

  it('refuses a batch over the record limit with 413', async () => {
    const { MAX_SYNC_RECORDS_PER_REQUEST } = await import('../../src/sync/direct.js')
    const many = Array.from({ length: MAX_SYNC_RECORDS_PER_REQUEST + 1 }, (_, i) => ({
      id: `r${i}`, ts: 1_700_000_000_000, tool: 'claude-code',
      deviceInstanceId: 'dev-work', updatedAt: 1_700_000_000_000,
    }))
    const response = await request(server(), '/api/sync/records', {
      method: 'POST',
      headers: { 'x-aiusage-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ records: many }),
    })
    expect(response.status).toBe(413)
    // The sender is told both ceilings so it can split without guessing.
    const error = JSON.parse(response.body).error
    expect(error.maxRecords).toBe(MAX_SYNC_RECORDS_PER_REQUEST)
    expect(error.maxBytes).toBeGreaterThan(0)
  })

  it('counts what it could not make sense of rather than failing the batch', async () => {
    const response = await request(server(), '/api/sync/records', {
      method: 'POST',
      headers: { 'x-aiusage-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ records: [JSON.parse(payload).records[0], { nonsense: true }] }),
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ accepted: 1, rejected: 1 })
  })
})

/**
 * synced_records is a holding table; records is what every dashboard query
 * reads. The merge between them runs as the last step of a sync pass — and a
 * hub that only receives direct uploads never makes a sync pass. Without the
 * merge on this path, uploads answered 200 and the dashboard stayed empty.
 */
describe('records arriving directly reach the dashboard', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    process.env.AIUSAGE_INGEST_TOKEN = TOKEN
    process.env.AIUSAGE_DASHBOARD_PASSWORD = PASSWORD
  })

  afterEach(() => {
    db.close()
    delete process.env.AIUSAGE_INGEST_TOKEN
    delete process.env.AIUSAGE_DASHBOARD_PASSWORD
  })

  const upload = (records: unknown[]) => request(
    createApiServer(db, { isLoopbackBind: false }),
    '/api/sync/records',
    {
      method: 'POST',
      headers: { 'x-aiusage-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ records }),
    },
  )

  const record = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, ts: 1_700_000_000_000, tool: 'claude-code', model: 'claude-opus-4',
    provider: 'anthropic', inputTokens: 10, outputTokens: 5, cost: 0.25,
    costSource: 'pricing', sessionKey: 'k', device: '職場PC',
    deviceInstanceId: 'dev-work', platform: 'win32', updatedAt: 1_700_000_000_000,
    sourceFile: 'C:/logs/1.jsonl', cwd: 'C:/work', ...overrides,
  })

  it('lands in the table the dashboard reads, not just the holding one', async () => {
    const response = await upload([record('rec-1'), record('rec-2')])

    expect(JSON.parse(response.body)).toMatchObject({ accepted: 2, merged: 2 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 2 })
    expect(db.prepare('SELECT device FROM records WHERE id = ?').get('rec-1'))
      .toEqual({ device: '職場PC' })
  })

  it('counts the other machine in the totals', async () => {
    await upload([record('rec-1'), record('rec-2')])
    const total = db.prepare('SELECT SUM(cost) AS c FROM records').get() as { c: number }
    expect(total.c).toBeCloseTo(0.5)
  })

  it('does not merge the same record twice when it is sent again', async () => {
    await upload([record('rec-1')])
    const second = await upload([record('rec-1')])

    expect(JSON.parse(second.body).merged).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM records').get()).toEqual({ n: 1 })
  })
})
