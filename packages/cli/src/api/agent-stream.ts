import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentSessionEmitter } from '../db/agent-sessions.js'

/**
 * Server-sent events for /agents.
 *
 * What goes down the wire is a nudge, not the data: the client hears that
 * something changed and asks /api/agent/sessions for the current picture. That
 * keeps this endpoint free of any consistency problem — there is no second
 * copy of the state to drift — and it means a burst of ten events costs one
 * refetch on the client rather than ten partial updates.
 */

/**
 * A held-open connection is a subscriber, a timer and a socket that nothing
 * reclaims until the client goes away. Ten is far more than one dashboard
 * needs, and refusing the eleventh is better than quietly accumulating them.
 */
export const MAX_AGENT_STREAMS = 10

/** Long enough to be cheap, short enough to beat an idle-connection timeout. */
export const HEARTBEAT_MS = 20_000

export interface AgentStreamOptions {
  maxStreams?: number
  heartbeatMs?: number
}

export class AgentStreamRegistry {
  private open = 0
  private readonly maxStreams: number
  private readonly heartbeatMs: number

  constructor(options: AgentStreamOptions = {}) {
    this.maxStreams = options.maxStreams ?? MAX_AGENT_STREAMS
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  }

  /** How many connections are being held right now. */
  get active(): number {
    return this.open
  }

  /**
   * Take over the response and hold it open until the client disconnects.
   *
   * @returns false when the connection was refused, so the caller can tell a
   *   served request from a rejected one.
   */
  handle(req: IncomingMessage, res: ServerResponse, emitter: AgentSessionEmitter): boolean {
    if (this.open >= this.maxStreams) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        error: { code: 'TOO_MANY_STREAMS', message: 'Too many open event streams' },
      }))
      return false
    }

    this.open++

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells nginx and friends not to buffer, which would hold every event
      // until the buffer filled and make the stream look dead.
      'X-Accel-Buffering': 'no',
    })
    // A first byte now, so the client's onopen fires without waiting for the
    // first real change — which may be hours away.
    res.write(': connected\n\n')

    const unsubscribe = emitter.subscribe((session) => {
      // The same filter the notifier uses: a re-applied event that changed
      // nothing is not news.
      if (!session.changed && !session.kindChanged) return
      // Deliberately thin. The client refetches; anything more here would be a
      // second source of truth to keep honest.
      const payload = JSON.stringify({ id: session.id, ts: Date.now() })
      res.write(`event: change\ndata: ${payload}\n\n`)
    })

    const heartbeat = setInterval(() => {
      // A comment line: valid SSE, ignored by EventSource, and enough traffic
      // to keep a mobile network or a proxy from reaping the connection.
      res.write(': ping\n\n')
    }, this.heartbeatMs)
    // Never the reason the process stays alive.
    heartbeat.unref?.()

    let closed = false
    const close = () => {
      // 'close' can arrive on both the request and the response; unsubscribing
      // twice is harmless but decrementing twice is not.
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
      this.open--
    }

    res.on('close', close)
    res.on('error', close)
    req.on('close', close)
    req.on('aborted', close)

    return true
  }
}

/** The one every request goes through. Tests build their own. */
export const agentStreams = new AgentStreamRegistry()

export function openAgentStream(
  req: IncomingMessage,
  res: ServerResponse,
  emitter: AgentSessionEmitter,
): boolean {
  return agentStreams.handle(req, res, emitter)
}
