import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import {
  DISCORD_CHANNEL,
  WEBPUSH_CHANNEL,
  enqueueNotification,
  listNotifications,
} from '../../src/db/notifications.js'
import {
  deletePushSubscription,
  listPushSubscriptions,
  savePushSubscription,
  summarisePushSubscriptions,
} from '../../src/db/push-subscriptions.js'
import { generateVapidKeys } from '../../src/notify/webpush-crypto.js'

const { pushConfig } = vi.hoisted(() => ({
  pushConfig: { value: {} as Record<string, unknown> },
}))
let vapidPrivateKey: string | null = null

// The tick reads config and credentials at call time, so without this the
// suite would depend on whatever the developer's machine has configured.
vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js')
  return {
    ...actual,
    loadConfig: () => pushConfig.value,
    loadCredential: (key: string) =>
      key === actual.VAPID_PRIVATE_KEY_CREDENTIAL ? vapidPrivateKey : null,
  }
})

const { runPushNotificationTick } = await import('../../src/notify/webpush-tick.js')
const { enabledChannels, notifyQuotaSummary } = await import('../../src/notify/enqueue.js')

const T0 = 1_700_000_000_000

/** A subscription whose keys are real, so encryption actually runs. */
function subscriber(endpoint: string, label = '') {
  const keys = generateVapidKeys()
  return {
    endpoint,
    // The subscriber's public key is an uncompressed P-256 point, exactly
    // like a VAPID public key, so this is a valid one to encrypt against.
    p256dh: keys.publicKey,
    auth: Buffer.from('0123456789abcdef', 'utf8').toString('base64url'),
    label,
    userAgent: 'test',
    deviceInstanceId: 'dev-1',
  }
}

function pending(db: Database.Database) {
  return listNotifications(db, { limit: 50 }).notifications
}

describe('push delivery', () => {
  let db: Database.Database
  const writes: Array<() => unknown> = []
  const runDbWrite = async <T,>(fn: () => T): Promise<T> => {
    writes.push(fn)
    return fn()
  }

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    writes.length = 0
    vapidPrivateKey = null
    pushConfig.value = {}
  })

  describe('channel selection', () => {
    it('sends to Discord when nothing has been configured', () => {
      // Discord predates channels entirely. An untouched config has to keep
      // behaving exactly as it did.
      expect(enabledChannels(undefined)).toEqual([DISCORD_CHANNEL])
      expect(enabledChannels({} as never)).toEqual([DISCORD_CHANNEL])
    })

    it('adds push only when it is switched on', () => {
      expect(enabledChannels({ channels: { webpush: true } } as never))
        .toEqual([DISCORD_CHANNEL, WEBPUSH_CHANNEL])
    })

    it('can switch Discord off without switching push off', () => {
      expect(enabledChannels({ channels: { discord: false, webpush: true } } as never))
        .toEqual([WEBPUSH_CHANNEL])
    })
  })

  describe('the outbox', () => {
    /**
     * The enqueue path binds every column by name. A parameter left out of
     * the bound object is not a type error and not a SQL error until the
     * statement runs, so this is worth asserting directly.
     */
    it('records the channel it was enqueued for', () => {
      enqueueNotification(db, {
        eventType: 'session_status',
        subjectKind: 'agent_session',
        subjectId: 's1',
        dedupeKey: 'k1',
        title: 't',
        body: 'b',
      }, T0)
      enqueueNotification(db, {
        channel: WEBPUSH_CHANNEL,
        eventType: 'session_status',
        subjectKind: 'agent_session',
        subjectId: 's1',
        dedupeKey: 'webpush:k1',
        title: 't',
        body: 'b',
      }, T0)

      const channels = pending(db).map((row) => row.channel).sort()
      expect(channels).toEqual([DISCORD_CHANNEL, WEBPUSH_CHANNEL])
    })

    it('defaults to Discord so existing callers are unchanged', () => {
      enqueueNotification(db, {
        eventType: 'session_status',
        subjectKind: 'agent_session',
        subjectId: 's1',
        dedupeKey: 'k1',
        title: 't',
        body: 'b',
      }, T0)
      expect(pending(db)[0].channel).toBe(DISCORD_CHANNEL)
    })
  })

  describe('the subscription store', () => {
    it('treats a re-subscribe as the same device', () => {
      const first = savePushSubscription(db, subscriber('https://push.example/abc', 'Phone'), T0)
      const second = savePushSubscription(db, subscriber('https://push.example/abc'), T0 + 1000)
      expect(second).toBe(first)
      expect(listPushSubscriptions(db)).toHaveLength(1)
      // An unnamed re-subscribe must not wipe the name already given.
      expect(summarisePushSubscriptions(db)[0].label).toBe('Phone')
    })

    /**
     * These two values are what allow a message to be encrypted for a
     * browser. A GET that returned them would turn read access to the
     * dashboard into the ability to push to every registered device.
     */
    it('never returns the subscriber keys in the summary', () => {
      savePushSubscription(db, subscriber('https://push.example/abc', 'Phone'), T0)
      const summary = summarisePushSubscriptions(db)
      expect(summary).toHaveLength(1)
      expect(Object.keys(summary[0]).sort())
        .toEqual(['consecutiveFailures', 'createdAt', 'id', 'label', 'lastSuccessAt'])
      expect(JSON.stringify(summary)).not.toContain(listPushSubscriptions(db)[0].p256dh)
      expect(JSON.stringify(summary)).not.toContain(listPushSubscriptions(db)[0].auth)
    })

    it('reports whether anything was deleted', () => {
      const id = savePushSubscription(db, subscriber('https://push.example/abc'), T0)
      expect(deletePushSubscription(db, id)).toBe(true)
      expect(deletePushSubscription(db, id)).toBe(false)
    })
  })

  describe('the tick', () => {
    const deps = () => ({
      db,
      runDbWrite,
      isParseInFlight: () => false,
      now: () => T0,
    })

    function enablePush() {
      const keys = generateVapidKeys()
      vapidPrivateKey = keys.privateKey
      pushConfig.value = {
        notifications: { enabled: true, channels: { webpush: true } },
        vapid: { publicKey: keys.publicKey },
      }
    }

    function queueOne(dedupeKey = 'webpush:k1') {
      enqueueNotification(db, {
        channel: WEBPUSH_CHANNEL,
        eventType: 'session_status',
        subjectKind: 'agent_session',
        subjectId: 's1',
        dedupeKey,
        title: 'title',
        body: 'body',
      }, T0)
    }

    it('says why it did nothing, per reason', async () => {
      expect((await runPushNotificationTick(deps())).skipped).toBe('disabled')

      pushConfig.value = { notifications: { enabled: true } }
      expect((await runPushNotificationTick(deps())).skipped).toBe('channel_off')

      pushConfig.value = { notifications: { enabled: true, channels: { webpush: true } } }
      expect((await runPushNotificationTick(deps())).skipped).toBe('no_vapid_key')

      enablePush()
      expect((await runPushNotificationTick(deps())).skipped).toBe('no_subscriptions')
    })

    it('does not run during a parse', async () => {
      enablePush()
      const result = await runPushNotificationTick({ ...deps(), isParseInFlight: () => true })
      expect(result.skipped).toBe('parse_in_flight')
    })

    it('leaves the Discord queue alone', async () => {
      enablePush()
      savePushSubscription(db, subscriber('https://push.example/a'), T0)
      enqueueNotification(db, {
        eventType: 'session_status',
        subjectKind: 'agent_session',
        subjectId: 's1',
        dedupeKey: 'k1',
        title: 'title',
        body: 'body',
      }, T0)

      const result = await runPushNotificationTick({
        ...deps(),
        fetchImpl: (async () => new Response(null, { status: 201 })) as typeof fetch,
      })

      expect(result.claimed).toBe(0)
      expect(pending(db)[0].state).toBe('pending')
    })

    it('marks the row sent once any one device is reached', async () => {
      enablePush()
      savePushSubscription(db, subscriber('https://push.example/a'), T0)
      savePushSubscription(db, subscriber('https://push.example/b'), T0)
      queueOne()

      let call = 0
      const result = await runPushNotificationTick({
        ...deps(),
        fetchImpl: (async () => {
          call++
          // The second device is unreachable. Retrying the row would notify
          // the first device twice, which is worse than the gap.
          return call === 1
            ? new Response(null, { status: 201 })
            : new Response('nope', { status: 500 })
        }) as typeof fetch,
      })

      expect(result.sent).toBe(1)
      expect(result.failed).toBe(0)
      expect(pending(db)[0].state).toBe('sent')

      const summary = summarisePushSubscriptions(db)
      expect(summary.find((s) => s.lastSuccessAt === T0)).toBeDefined()
      expect(summary.find((s) => s.consecutiveFailures === 1)).toBeDefined()
    })

    it('fails the row when no device could be reached', async () => {
      enablePush()
      savePushSubscription(db, subscriber('https://push.example/a'), T0)
      queueOne()

      const result = await runPushNotificationTick({
        ...deps(),
        fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
      })

      expect(result.sent).toBe(0)
      expect(result.failed).toBe(1)
      expect(pending(db)[0].state).toBe('pending')
      expect(listPushSubscriptions(db)).toHaveLength(1)
    })

    it.each([404, 410])('deletes a subscription the push service says is gone (%i)', async (status) => {
      enablePush()
      savePushSubscription(db, subscriber('https://push.example/a'), T0)
      queueOne()

      const result = await runPushNotificationTick({
        ...deps(),
        fetchImpl: (async () => new Response(null, { status })) as typeof fetch,
      })

      expect(result.pruned).toBe(1)
      expect(listPushSubscriptions(db)).toHaveLength(0)
    })

    /**
     * A 500 is the push service having a bad day, not the browser going
     * away. Deleting on anything other than 404/410 would silently
     * unsubscribe a device that is working fine.
     */
    it('keeps a subscription that merely failed', async () => {
      enablePush()
      savePushSubscription(db, subscriber('https://push.example/a'), T0)
      queueOne()

      await runPushNotificationTick({
        ...deps(),
        fetchImpl: (async () => new Response('boom', { status: 503 })) as typeof fetch,
      })

      expect(listPushSubscriptions(db)).toHaveLength(1)
      expect(summarisePushSubscriptions(db)[0].consecutiveFailures).toBe(1)
    })

    it('sends the VAPID header and an encrypted body', async () => {
      enablePush()
      savePushSubscription(db, subscriber('https://push.example/a'), T0)
      queueOne()

      /** @type {RequestInit | undefined} */
      let seen: RequestInit | undefined
      let seenUrl = ''
      await runPushNotificationTick({
        ...deps(),
        fetchImpl: (async (url: string, init: RequestInit) => {
          seenUrl = String(url)
          seen = init
          return new Response(null, { status: 201 })
        }) as unknown as typeof fetch,
      })

      expect(seenUrl).toBe('https://push.example/a')
      const headers = new Headers(seen?.headers)
      expect(headers.get('authorization')).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
      expect(headers.get('content-encoding')).toBe('aes128gcm')
      expect(headers.get('ttl')).toBeTruthy()
      // The body is ciphertext, so the plain text must not be findable in it.
      const body = Buffer.from(seen?.body as ArrayBuffer)
      expect(body.includes(Buffer.from('title', 'utf8'))).toBe(false)
      expect(body.length).toBeGreaterThan(0)
    })
  })
})

/**
 * Four push rows were queued between 1:27 and 1:31 with no browser
 * registered, sat pending, and were all delivered at 1:33:12 — the instant
 * the first phone subscribed. The expiry window kept the damage small, but
 * queueing something nothing can send is not a state worth having.
 */
describe('push rows with nobody to send to', () => {
  let db: Database.Database
  const T = 1_700_000_000_000

  const CONFIG = {
    enabled: true,
    channels: { discord: true, webpush: true },
    events: { completed: true },
  } as never

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  function subscriberFor(endpoint: string) {
    const keys = generateVapidKeys()
    return {
      endpoint,
      p256dh: keys.publicKey,
      auth: Buffer.from('0123456789abcdef', 'utf8').toString('base64url'),
      label: '',
      userAgent: 'test',
      deviceInstanceId: 'dev-1',
    }
  }

  /** Drives the real fan-out rather than enqueueNotification directly. */
  function announceQuotaCrossing() {
    return notifyQuotaSummary({
      db,
      config: CONFIG,
      isNotifier: true,
      deviceInstanceId: 'dev-1',
      device: 'テスト機',
      now: T,
    }, {
      attempted: 1,
      succeeded: 1,
      inserted: 0,
      updated: 0,
      windowsClosed: 0,
      failedTools: [],
      errorKinds: [],
      credentialFailures: [],
      crossings: [{
        tool: 'claude-code',
        tier: 'session',
        windowId: 'w1',
        threshold: 80,
        utilization: 0.82,
        resetsAt: null,
      }],
      resets: [],
    })
  }

  function rows() {
    return db.prepare(`
      SELECT channel, state, last_error FROM notifications ORDER BY channel
    `).all() as Array<{ channel: string; state: string; last_error: string | null }>
  }

  it('records the push row as dropped when nothing is subscribed', () => {
    announceQuotaCrossing()

    const push = rows().find((r) => r.channel === WEBPUSH_CHANNEL)
    expect(push?.state).toBe('dropped')
    // Dropped, not absent: /notifications still answers "why did nothing
    // arrive" after the fact.
    expect(push?.last_error).toBe('no push subscriptions')
  })

  it('queues the push row once a browser is subscribed', () => {
    savePushSubscription(db, subscriberFor('https://push.example/a'), T)

    announceQuotaCrossing()

    const push = rows().find((r) => r.channel === WEBPUSH_CHANNEL)
    expect(push?.state).toBe('pending')
    expect(push?.last_error).toBeNull()
  })

  it('leaves Discord alone either way', () => {
    announceQuotaCrossing()
    expect(rows().find((r) => r.channel === DISCORD_CHANNEL)?.state).toBe('pending')

    db.prepare('DELETE FROM notifications').run()
    savePushSubscription(db, subscriberFor('https://push.example/a'), T)
    announceQuotaCrossing()
    expect(rows().find((r) => r.channel === DISCORD_CHANNEL)?.state).toBe('pending')
  })

  /**
   * The non-notifier drop has to win: a machine that only watches must not
   * start explaining itself with a different reason just because it also has
   * no subscriptions.
   */
  it('keeps the non-notifier reason when both apply', () => {
    notifyQuotaSummary({
      db,
      config: CONFIG,
      isNotifier: false,
      deviceInstanceId: 'dev-1',
      device: 'テスト機',
      now: T,
    }, {
      attempted: 1, succeeded: 1, inserted: 0, updated: 0, windowsClosed: 0,
      failedTools: [], errorKinds: [], credentialFailures: [],
      crossings: [{
        tool: 'claude-code', tier: 'session', windowId: 'w1',
        threshold: 80, utilization: 0.82, resetsAt: null,
      }],
      resets: [],
    })

    for (const row of rows()) {
      expect(row.state).toBe('dropped')
      expect(row.last_error).toBe('not the notifier device')
    }
  })
})
