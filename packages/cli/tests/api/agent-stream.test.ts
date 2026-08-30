import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { AgentStreamRegistry } from '../../src/api/agent-stream.js'
import { AgentSessionEmitter } from '../../src/db/agent-sessions.js'

/**
 * A held-open connection is the one kind of endpoint that can leak.
 *
 * Everything else here answers and forgets; this one keeps a subscriber, an
 * interval and a socket alive until the client goes away. If the cleanup is
 * wrong the symptom is not an error — it is a server that gets slower over
 * days and sends each event several times.
 */

/** Stands in for the http request/response pair, recording what was written. */
function pair() {
  const req: any = new EventEmitter()
  const res: any = new EventEmitter()
  res.statusCode = 200
  res.headers = {}
  res.chunks = []
  res.writeHead = (status: number, headers?: Record<string, string>) => {
    res.statusCode = status
    Object.assign(res.headers, headers ?? {})
    return res
  }
  res.write = (chunk: string) => { res.chunks.push(String(chunk)); return true }
  res.end = (chunk?: string) => { if (chunk) res.chunks.push(String(chunk)) }
  res.text = () => res.chunks.join('')
  return { req, res }
}

/** An applied-session shape, only the fields the stream looks at. */
function applied(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    changed: true,
    kindChanged: false,
    ...overrides,
  } as never
}

describe('agent event stream', () => {
  let emitter: AgentSessionEmitter

  beforeEach(() => {
    emitter = new AgentSessionEmitter()
  })

  it('opens as an event stream and says hello immediately', () => {
    // Without a first byte the client's onopen waits for the first real
    // change, which may be hours away, and the page cannot tell "connected"
    // from "hung".
    const registry = new AgentStreamRegistry()
    const { req, res } = pair()

    expect(registry.handle(req, res, emitter)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toContain('text/event-stream')
    expect(res.headers['Cache-Control']).toContain('no-cache')
    expect(res.text()).toBe(': connected\n\n')
  })

  it('sends a nudge, not the session', () => {
    const registry = new AgentStreamRegistry()
    const { req, res } = pair()
    registry.handle(req, res, emitter)

    emitter.emit(applied({ id: 'sess-42' }))

    const text = res.text()
    expect(text).toContain('event: change')
    const payload = JSON.parse(/data: (.*)\n/.exec(text)![1])
    // Only an id and a timestamp. Anything more would be a second copy of the
    // state for the client to reconcile.
    expect(Object.keys(payload).sort()).toEqual(['id', 'ts'])
    expect(payload.id).toBe('sess-42')
  })

  it('stays quiet when nothing actually changed', () => {
    const registry = new AgentStreamRegistry()
    const { req, res } = pair()
    registry.handle(req, res, emitter)
    const before = res.text()

    emitter.emit(applied({ changed: false, kindChanged: false }))

    expect(res.text()).toBe(before)
  })

  it('speaks up when only the event kind changed', () => {
    // Stop and StopFailure both land on waiting_for_user. The board shows them
    // differently, so it has to hear about the second one.
    const registry = new AgentStreamRegistry()
    const { req, res } = pair()
    registry.handle(req, res, emitter)

    emitter.emit(applied({ changed: false, kindChanged: true }))

    expect(res.text()).toContain('event: change')
  })

  it('releases the subscription when the client goes away', () => {
    const registry = new AgentStreamRegistry()
    const { req, res } = pair()
    registry.handle(req, res, emitter)
    expect(emitter.size).toBe(1)
    expect(registry.active).toBe(1)

    res.emit('close')

    expect(emitter.size).toBe(0)
    expect(registry.active).toBe(0)
  })

  it('counts a disconnect once even when close arrives twice', () => {
    // 'close' can fire on the request and on the response. Unsubscribing twice
    // is harmless; decrementing twice would let the cap drift until it stopped
    // capping anything.
    const registry = new AgentStreamRegistry({ maxStreams: 1 })
    const { req, res } = pair()
    registry.handle(req, res, emitter)

    res.emit('close')
    req.emit('close')

    expect(registry.active).toBe(0)

    const second = pair()
    expect(registry.handle(second.req, second.res, emitter)).toBe(true)
  })

  it('refuses more connections than it is willing to hold', () => {
    const registry = new AgentStreamRegistry({ maxStreams: 2 })
    const first = pair()
    const second = pair()
    const third = pair()

    expect(registry.handle(first.req, first.res, emitter)).toBe(true)
    expect(registry.handle(second.req, second.res, emitter)).toBe(true)
    expect(registry.handle(third.req, third.res, emitter)).toBe(false)

    expect(third.res.statusCode).toBe(503)
    expect(third.res.text()).toContain('TOO_MANY_STREAMS')
    // The refused one must not have subscribed to anything.
    expect(emitter.size).toBe(2)
  })

  it('takes a slot back after a disconnect', () => {
    const registry = new AgentStreamRegistry({ maxStreams: 1 })
    const first = pair()
    registry.handle(first.req, first.res, emitter)
    first.res.emit('close')

    const second = pair()
    expect(registry.handle(second.req, second.res, emitter)).toBe(true)
  })

  it('keeps the connection warm with comment lines', () => {
    // Mobile networks and proxies drop a connection that says nothing. A
    // comment is valid SSE and EventSource ignores it.
    vi.useFakeTimers()
    try {
      const registry = new AgentStreamRegistry({ heartbeatMs: 1000 })
      const { req, res } = pair()
      registry.handle(req, res, emitter)

      vi.advanceTimersByTime(3500)
      expect(res.text().match(/: ping\n\n/g)).toHaveLength(3)

      res.emit('close')
      vi.advanceTimersByTime(5000)
      // And it stops when the client does.
      expect(res.text().match(/: ping\n\n/g)).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not write to a stream whose client already left', () => {
    const registry = new AgentStreamRegistry()
    const { req, res } = pair()
    registry.handle(req, res, emitter)
    res.emit('close')
    const after = res.text()

    emitter.emit(applied())

    expect(res.text()).toBe(after)
  })
})
