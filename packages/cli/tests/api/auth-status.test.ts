import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { Readable } from 'node:stream'

/**
 * The client cannot see what this server bound to, so the server has to say
 * whether the home page is worth showing without a login.
 *
 * Getting this wrong is not a visible error: the home page renders its public
 * variant, every figure on it comes back 401, and the only control is a
 * refresh button that produces the same page again. That is what a phone on
 * Tailscale actually saw.
 */

const PASSWORD = 'a-dashboard-password'

let db: Database.Database

const { initializeDatabase } = await import('../../src/db/index.js')
const { createApiServer } = await import('../../src/api/server.js')

async function authStatus(
  server: ReturnType<typeof createApiServer>,
  headers: Record<string, string> = {},
): Promise<any> {
  const req: any = Readable.from([])
  req.url = '/api/auth/status'
  req.method = 'GET'
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
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      },
      on() { return this },
      once() { return this },
      emit() { return false },
    }
    server.emit('request', req, res)
  })
}

describe('/api/auth/status reports whether the home page is public', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    process.env.AIUSAGE_DASHBOARD_PASSWORD = PASSWORD
  })

  afterEach(() => {
    db.close()
    delete process.env.AIUSAGE_DASHBOARD_PASSWORD
  })

  it('says home is public on a loopback bind', async () => {
    // Loopback leaves /api/summary and /api/quotas open, which is what the
    // public home page is made of.
    const status = await authStatus(createApiServer(db, { isLoopbackBind: true }))
    expect(status.publicHome).toBe(true)
  })

  it('says home is not public once the bind reaches the network', async () => {
    const status = await authStatus(createApiServer(db, { isLoopbackBind: false }))
    expect(status.publicHome).toBe(false)
  })

  it('answers the same whether or not the caller is logged in', async () => {
    // It describes the server, not the session. A logged-in reader who signs
    // out must not find the home page suddenly claiming to be public.
    const { buildAuthCookie } = await import('../../src/auth.js')
    const cookie = buildAuthCookie(PASSWORD).split(';')[0]
    const server = createApiServer(db, { isLoopbackBind: false })

    const anonymous = await authStatus(server)
    const loggedIn = await authStatus(server, { cookie })

    expect(anonymous.authenticated).toBe(false)
    expect(loggedIn.authenticated).toBe(true)
    expect(anonymous.publicHome).toBe(false)
    expect(loggedIn.publicHome).toBe(false)
  })

  it('tracks the gate rather than restating it', async () => {
    // The value has to be whatever the auth gate would do to /api/summary.
    // Two copies of that rule would eventually disagree, and the symptom
    // would be a page of 401s with no way out.
    const { shouldProtectApiPath } = await import('../../src/auth.js')
    for (const isLoopbackBind of [true, false]) {
      const status = await authStatus(createApiServer(db, { isLoopbackBind }))
      expect(status.publicHome).toBe(!shouldProtectApiPath('/api/summary', isLoopbackBind))
    }
  })

  it('keeps saying home is public when no password is set at all', async () => {
    delete process.env.AIUSAGE_DASHBOARD_PASSWORD
    const status = await authStatus(createApiServer(db, { isLoopbackBind: true }))
    expect(status.enabled).toBe(false)
    expect(status.publicHome).toBe(true)
  })
})
