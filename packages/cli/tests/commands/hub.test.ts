import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Sending one machine's hook events to another machine's serve.
 *
 * Three laptops, one of which decides what is worth announcing. The other two
 * keep a serve running for their own logs but hand their agent events over.
 * The thing most worth pinning down is that a forwarding machine's serve does
 * not quietly absorb events addressed elsewhere — the failure is silent and
 * looks exactly like success.
 */

/*
 * One directory for the whole file, made before the module under test is
 * imported: it freezes the spool and port-file paths at import time, exactly
 * as it does in a real install. Each test clears the contents instead.
 */
const { home, cfg } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return {
    // The directory tests/setup.ts isolated for this file.
    home: process.env.AIUSAGE_HOME as string,
    cfg: { value: null as Record<string, unknown> | null },
  }
})
let credential: string | null = null

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js')
  return {
    ...actual,
    // AIUSAGE_DIR is left alone — setup.ts owns it. Only values here.
    loadConfig: () => cfg.value,
    loadCredential: (key: string) =>
      key === actual.HUB_FORWARD_TOKEN_CREDENTIAL ? credential : null,
  }
})

const agentEvent = await import('../../src/commands/agent-event.js')
const { initializeDatabase } = await import('../../src/db/index.js')

const LOCAL_TOKEN = 'local-machine-token'

function writeState() {
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    deviceInstanceId: 'dev-work-laptop',
    ingestToken: LOCAL_TOKEN,
  }))
}

function writePortFile(port: number) {
  writeFileSync(join(home, '.serve-port'), String(port))
}

function spoolPath() {
  return join(home, 'agent-events.spool.jsonl')
}

function anEvent(id = 's1') {
  return {
    sessionId: id,
    tool: 'claude-code',
    kind: 'stop',
    ts: 1_700_000_000_000,
    source: 'hook',
    device: '職場PC',
    deviceInstanceId: 'dev-work-laptop',
    platform: 'win32',
    payload: {},
    dedupeKey: `${id}:stop:1`,
  } as never
}

/** Records what was posted without ever reaching the network. */
function recordingFetch(ok = true) {
  const calls: Array<{ url: string; token: string | null; body: unknown }> = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      token: new Headers(init.headers).get('X-Aiusage-Token'),
      body: JSON.parse(String(init.body)),
    })
    return new Response(null, { status: ok ? 200 : 500 })
  }) as unknown as typeof fetch
  return { calls, impl }
}

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('agent event forwarding', () => {
  beforeEach(() => {
    for (const f of ['agent-events.spool.jsonl', '.serve-port', 'state.json']) {
      rmSync(join(home, f), { force: true })
    }
    cfg.value = null
    credential = null
    writeState()
  })

  describe('destination', () => {
    it('is the local serve when nothing is configured', () => {
      writePortFile(3847)
      const dest = agentEvent.resolveDestination()
      expect(dest).toEqual({
        url: 'http://127.0.0.1:3847/api/agent/events',
        token: LOCAL_TOKEN,
        remote: false,
      })
    })

    it('is the configured machine when a forward is set', () => {
      writePortFile(3847)
      cfg.value = { hubForward: { url: 'https://desktop-abc.tail1234.ts.net' } }
      credential = 'the-other-machines-token'

      const dest = agentEvent.resolveDestination()
      expect(dest?.url).toBe('https://desktop-abc.tail1234.ts.net/api/agent/events')
      expect(dest?.remote).toBe(true)
    })

    /**
     * The receiver checks its own ingest token, so ours would simply be
     * rejected. Sending it anyway would also hand this machine's token to
     * another host for no reason.
     */
    it('uses the receiving machine token, not the local one', () => {
      writePortFile(3847)
      cfg.value = { hubForward: { url: 'https://desktop-abc.tail1234.ts.net' } }
      credential = 'the-other-machines-token'

      expect(agentEvent.resolveDestination()?.token).toBe('the-other-machines-token')
      expect(agentEvent.resolveDestination()?.token).not.toBe(LOCAL_TOKEN)
    })

    it('keeps only the origin, so a stray path cannot redirect the post', () => {
      cfg.value = { hubForward: { url: 'https://desktop-abc.tail1234.ts.net/agents?x=1' } }
      credential = 't'
      expect(agentEvent.resolveDestination()?.url)
        .toBe('https://desktop-abc.tail1234.ts.net/api/agent/events')
    })

    it('sends nothing when the forward has no token', () => {
      writePortFile(3847)
      cfg.value = { hubForward: { url: 'https://desktop-abc.tail1234.ts.net' } }
      credential = null
      // Falling back to the local serve here would put the events in the
      // wrong database, which is the whole thing being avoided.
      expect(agentEvent.resolveDestination()).toBeNull()
    })
  })

  describe('sending', () => {
    it('posts to the local serve when unconfigured', async () => {
      writePortFile(4100)
      const { calls, impl } = recordingFetch()

      expect(await agentEvent.sendAgentEvent(anEvent(), impl)).toBe('sent')
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe('http://127.0.0.1:4100/api/agent/events')
      expect(calls[0].token).toBe(LOCAL_TOKEN)
    })

    it('posts to the configured machine with its token', async () => {
      writePortFile(4100)
      cfg.value = { hubForward: { url: 'https://desktop-abc.tail1234.ts.net' } }
      credential = 'remote-token'
      const { calls, impl } = recordingFetch()

      expect(await agentEvent.sendAgentEvent(anEvent(), impl)).toBe('sent')
      expect(calls[0].url).toBe('https://desktop-abc.tail1234.ts.net/api/agent/events')
      expect(calls[0].token).toBe('remote-token')
    })

    it('spools instead of failing when the destination is unreachable', async () => {
      cfg.value = { hubForward: { url: 'https://desktop-abc.tail1234.ts.net' } }
      credential = 'remote-token'
      const impl = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch

      expect(await agentEvent.sendAgentEvent(anEvent(), impl)).toBe('spooled')
      expect(existsSync(spoolPath())).toBe(true)
      expect(readFileSync(spoolPath(), 'utf-8').trim().split('\n')).toHaveLength(1)
    })

    /**
     * The rule this file exists to protect: a hook must never make the agent
     * wait. One second, whatever the other machine is doing.
     */
    it('gives up within a second and still reports success to the caller', async () => {
      cfg.value = { hubForward: { url: 'https://desktop-abc.tail1234.ts.net' } }
      credential = 'remote-token'
      // Never resolves on its own; only the abort signal ends it.
      const impl = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch

      const started = Date.now()
      const result = await agentEvent.sendAgentEvent(anEvent(), impl)
      const elapsed = Date.now() - started

      expect(result).toBe('spooled')
      expect(elapsed).toBeLessThan(1500)
      expect(process.exitCode ?? 0).toBe(0)
    })

    it('carries the backlog along and clears it once it lands', async () => {
      writePortFile(4100)
      const { calls, impl } = recordingFetch()
      const failing = (async () => { throw new Error('down') }) as unknown as typeof fetch

      await agentEvent.sendAgentEvent(anEvent('s1'), failing)
      await agentEvent.sendAgentEvent(anEvent('s2'), failing)
      expect(readFileSync(spoolPath(), 'utf-8').trim().split('\n')).toHaveLength(2)

      await agentEvent.sendAgentEvent(anEvent('s3'), impl)
      expect((calls[0].body as { events: unknown[] }).events).toHaveLength(3)
      expect(existsSync(spoolPath())).toBe(false)
    })
  })

  describe('who owns the spool', () => {
    let db: Database.Database

    beforeEach(() => {
      db = new Database(':memory:')
      initializeDatabase(db)
      writeFileSync(spoolPath(), JSON.stringify(anEvent()) + '\n')
    })

    afterEach(() => db.close())

    it('serve drains it when this machine is the destination', () => {
      expect(agentEvent.drainAgentEventSpool(db)).toBe(1)
      expect(existsSync(spoolPath())).toBe(false)
    })

    /**
     * Otherwise the events land in the local database: the sessions show up
     * on the wrong dashboard, and the machine that is supposed to notify
     * never hears about them. It looks like it worked, which is the worst
     * part.
     */
    it('serve leaves it alone when the events belong to another machine', () => {
      cfg.value = { hubForward: { url: 'https://desktop-abc.tail1234.ts.net' } }
      credential = 'remote-token'

      expect(agentEvent.drainAgentEventSpool(db)).toBe(0)
      expect(existsSync(spoolPath())).toBe(true)
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get()).toEqual({ n: 0 })
    })

    it('reports forwarding from the config alone', () => {
      expect(agentEvent.forwardsToHub()).toBe(false)
      cfg.value = { hubForward: { url: '  ' } }
      expect(agentEvent.forwardsToHub()).toBe(false)
      cfg.value = { hubForward: { url: 'https://desktop-abc.tail1234.ts.net' } }
      expect(agentEvent.forwardsToHub()).toBe(true)
    })
  })
})
