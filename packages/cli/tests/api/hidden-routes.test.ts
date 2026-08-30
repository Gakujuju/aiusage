import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Hiding a screen is a preference, and a preference has to be reversible.
 *
 * The failure to avoid is a config that hides /settings — the only screen
 * that can un-hide anything — leaving the dashboard with no way back short of
 * editing JSON by hand, which is the thing this feature exists to avoid
 * asking for.
 */

// config.js resolves the data directory when it is first imported, so this
// has to be set before anything pulls it in. Everything below writes to a
// throwaway directory, never to ~/.aiusage.
const HOME = mkdtempSync(join(tmpdir(), 'aiusage-hidden-routes-'))
process.env.AIUSAGE_HOME = HOME

const { HIDEABLE_ROUTES, normalizeHiddenRoutes } = await import('../../src/config.js')
const { initializeDatabase } = await import('../../src/db/index.js')
const { createApiServer } = await import('../../src/api/server.js')

const CONFIG_FILE = join(HOME, 'config.json')

afterAll(() => {
  delete process.env.AIUSAGE_HOME
  rmSync(HOME, { recursive: true, force: true })
})

describe('normalizeHiddenRoutes', () => {
  it('keeps the paths it recognises', () => {
    expect(normalizeHiddenRoutes(['/leaderboard', '/support'])).toEqual(['/leaderboard', '/support'])
  })

  it('refuses to hide settings or home', () => {
    // Settings is the way back; home is the installed app's start_url.
    expect(normalizeHiddenRoutes(['/settings'])).toEqual([])
    expect(normalizeHiddenRoutes(['/'])).toEqual([])
    expect(normalizeHiddenRoutes(['/settings', '/support'])).toEqual(['/support'])
  })

  it('drops paths that are not screens', () => {
    // An unrecognised entry would hide nothing and appear nowhere in the
    // settings list, so it could never be removed again.
    expect(normalizeHiddenRoutes(['/nope', '/api/summary', ''])).toEqual([])
  })

  it('returns a stable order regardless of how they arrived', () => {
    // The order comes from the canonical list, so the config file does not
    // churn when the same set is saved twice.
    expect(normalizeHiddenRoutes(['/support', '/leaderboard']))
      .toEqual(normalizeHiddenRoutes(['/leaderboard', '/support']))
  })

  it('deduplicates', () => {
    expect(normalizeHiddenRoutes(['/support', '/support'])).toEqual(['/support'])
  })

  it('treats anything that is not a list as nothing hidden', () => {
    for (const value of [undefined, null, '', '/support', 42, {}]) {
      expect(normalizeHiddenRoutes(value)).toEqual([])
    }
  })

  it('ignores surrounding whitespace', () => {
    expect(normalizeHiddenRoutes([' /support '])).toEqual(['/support'])
  })
})

describe('the config endpoint', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    writeFileSync(CONFIG_FILE, '{}')
  })

  function storedConfig(): Record<string, any> {
    return existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {}
  }

  async function call(method: string, body?: unknown): Promise<any> {
    const payload = body == null ? '' : JSON.stringify(body)
    const req: any = Readable.from(payload ? [Buffer.from(payload)] : [])
    req.url = '/api/config'
    req.method = method
    req.headers = { host: '127.0.0.1', 'content-type': 'application/json' }

    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      const res: any = {
        statusCode: 200,
        headersSent: false,
        setHeader() {}, getHeader() { return undefined },
        writeHead(status: number) { this.statusCode = status; return this },
        write(chunk: any) { chunks.push(Buffer.from(chunk)); return true },
        end(chunk?: any) {
          if (chunk) chunks.push(Buffer.from(chunk))
          const text = Buffer.concat(chunks).toString('utf-8')
          resolve(text ? JSON.parse(text) : {})
        },
        on() { return this }, once() { return this }, emit() { return false },
      }
      createApiServer(db).emit('request', req, res)
    })
  }

  it('reports an empty list when nothing is hidden', async () => {
    // Always an array. The client filters its navigation with it, and null
    // would have to be special-cased at every use.
    const cfg = await call('GET')
    expect(cfg.ui.hiddenRoutes).toEqual([])
  })

  it('tells the client which screens may be hidden', async () => {
    // So the settings list cannot offer something the server would reject.
    const cfg = await call('GET')
    expect(cfg.hideableRoutes).toEqual([...HIDEABLE_ROUTES])
    expect(cfg.hideableRoutes).not.toContain('/settings')
    expect(cfg.hideableRoutes).not.toContain('/')
  })

  it('stores what it is given and reads it back', async () => {
    await call('PUT', { hiddenRoutes: ['/leaderboard', '/support'] })
    expect(storedConfig().ui.hiddenRoutes).toEqual(['/leaderboard', '/support'])
    const cfg = await call('GET')
    expect(cfg.ui.hiddenRoutes).toEqual(['/leaderboard', '/support'])
  })

  it('does not store a route it would refuse to honour', async () => {
    await call('PUT', { hiddenRoutes: ['/settings', '/nonsense'] })
    const cfg = await call('GET')
    expect(cfg.ui.hiddenRoutes).toEqual([])
  })

  it('clears the key rather than leaving an empty list behind', async () => {
    await call('PUT', { hiddenRoutes: ['/support'] })
    await call('PUT', { hiddenRoutes: [] })
    expect(storedConfig().ui).toBeUndefined()
    const cfg = await call('GET')
    expect(cfg.ui.hiddenRoutes).toEqual([])
  })

  it('leaves the rest of the config alone', async () => {
    await call('PUT', { device: 'desk' })
    await call('PUT', { hiddenRoutes: ['/support'] })
    const cfg = await call('GET')
    expect(cfg.device).toBe('desk')
    expect(cfg.ui.hiddenRoutes).toEqual(['/support'])
  })

  it('hides nothing when the request does not mention it', async () => {
    // A settings page saving something else must not wipe the choice.
    await call('PUT', { hiddenRoutes: ['/support'] })
    await call('PUT', { device: 'desk' })
    expect(storedConfig().ui.hiddenRoutes).toEqual(['/support'])
  })
})
