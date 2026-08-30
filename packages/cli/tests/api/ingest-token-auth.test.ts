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
