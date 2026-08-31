import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { Readable } from 'node:stream'

/**
 * What the log cannot say.
 *
 * A scheduled parse writes a line only when it found something, so an empty
 * log means either "nothing to parse" or "not parsing" and there is no way to
 * tell those apart from outside. The rule this endpoint exists to keep is
 * that the silence of a log is never the only way to learn the state: the log
 * carries events, this carries the state, and it can be asked at any time
 * rather than only while someone happens to be watching a terminal.
 */

let db: Database.Database

const { initializeDatabase } = await import('../../src/db/index.js')
const { createApiServer } = await import('../../src/api/server.js')

async function health(server: ReturnType<typeof createApiServer>): Promise<any> {
  const req: any = Readable.from([])
  req.url = '/api/health'
  req.method = 'GET'
  req.headers = { host: '127.0.0.1' }

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
        resolve({
          status: this.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
        })
      },
      on() { return this },
      once() { return this },
      emit() { return false },
    }
    server.emit('request', req, res)
  })
}

const HEALTHY = {
  lastParseOkAt: 1_700_000_000_000,
  intervalMs: 5 * 60_000,
  thresholdMs: 15 * 60_000,
  stalled: false,
  stalledSince: null as number | null,
}

describe('/api/health answers what the log leaves ambiguous', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('says when a parse last completed', async () => {
    // The number the log cannot give: a quiet log is compatible with any
    // value here, including none at all.
    const { body } = await health(createApiServer(db, {
      isLoopbackBind: true,
      getParseHealth: () => HEALTHY,
    }))

    expect(body.parse.lastParseOkAt).toBe(HEALTHY.lastParseOkAt)
    expect(body.ok).toBe(true)
  })

  it('reports the interval and the threshold it is judged against', async () => {
    // Without these, "last parsed 12 minutes ago" cannot be read: whether
    // that is normal depends entirely on how often it is meant to run.
    const { body } = await health(createApiServer(db, {
      isLoopbackBind: true,
      getParseHealth: () => HEALTHY,
    }))

    expect(body.parse.intervalMs).toBe(5 * 60_000)
    expect(body.parse.thresholdMs).toBe(15 * 60_000)
  })

  it('carries the stall through, verdict and start time both', async () => {
    const stalledSince = 1_700_000_000_000
    const { body } = await health(createApiServer(db, {
      isLoopbackBind: true,
      getParseHealth: () => ({ ...HEALTHY, stalled: true, stalledSince }),
    }))

    // Not recomputed here — the controller decided, and both outputs repeat
    // the one verdict so the banner and the notification cannot disagree.
    expect(body.parse.stalled).toBe(true)
    expect(body.parse.stalledSince).toBe(stalledSince)
    expect(body.ok).toBe(false)
  })

  it('answers rather than erroring when nothing is watching parsing', async () => {
    // Sub-commands build a server without a controller. A 500 here would be
    // read as "the server is broken", which is the opposite of the truth.
    const { status, body } = await health(createApiServer(db, { isLoopbackBind: true }))

    expect(status).toBe(200)
    expect(body.parse).toBeNull()
    expect(body.ok).toBe(true)
  })

  /*
   * A read, so it is gated like the other reads.
   *
   * It is only timestamps, but they say when this machine was last used
   * and how it is configured, and nothing here needs answering before a
   * login: the band that displays it lives inside the dashboard.
   */
  it('needs the dashboard cookie once a password is set', async () => {
    process.env.AIUSAGE_DASHBOARD_PASSWORD = 'a-dashboard-password'
    try {
      const { status } = await health(createApiServer(db, {
        isLoopbackBind: true,
        getParseHealth: () => HEALTHY,
      }))

      expect(status).toBe(401)
    } finally {
      delete process.env.AIUSAGE_DASHBOARD_PASSWORD
    }
  })
})
