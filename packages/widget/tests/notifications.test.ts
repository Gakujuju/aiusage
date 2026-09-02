import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { isWorkFinished, MAX_PER_TICK, nextBatch, notificationsSince } from '../src/notifications'

/**
 * The two ways a notifier is worse than none: saying the same thing twice,
 * and saying everything at once on startup. Both are tested here.
 */

const T = 1_700_000_000_000
let db: Database.Database

function createTestDb(): Database.Database {
  const database = new Database(':memory:')
  database.exec(`
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      channel TEXT NOT NULL,
      event_type TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      payload TEXT NOT NULL,
      state TEXT NOT NULL
    )
  `)
  return database
}

let seq = 0
/** One event, as serve writes it: a row per channel, keys differing by prefix. */
const FINISHED = JSON.stringify({ status: 'waiting_for_user', lastEventKind: 'stop' })

function event(overrides: Partial<{ at: number; subject: string; title: string; state: string; payload: string }> = {}): void {
  const { at = T, subject = 's1', title = 'done', state = 'sent', payload = FINISHED } = overrides
  const key = `session:${subject}:stop:${at}`
  for (const channel of ['discord', 'webpush']) {
    db.prepare(`
      INSERT INTO notifications (id, created_at, channel, event_type, subject_kind, subject_id, dedupe_key, title, body, payload, state)
      VALUES (@id, @at, @channel, 'session_status', 'agent_session', @subject, @key, @title, 'body', @payload, @state)
    `).run({
      id: `n${seq++}`,
      at,
      channel,
      subject,
      key: channel === 'webpush' ? `webpush:${key}` : key,
      title,
      payload,
      state,
    })
  }
}

describe('one event, one notification', () => {
  beforeEach(() => { db = createTestDb(); seq = 0 })

  it('folds the channels back into the thing that happened', () => {
    // discord and webpush each get a row. dedupe_key does not fold them -
    // the webpush key is the discord one with a prefix - so the fold is on
    // what the event was about and when.
    event()

    expect(notificationsSince(db, T - 1)).toHaveLength(1)
  })

  it('keeps two events that happened at different moments', () => {
    event({ at: T })
    event({ at: T + 1000 })

    expect(notificationsSince(db, T - 1)).toHaveLength(2)
  })

  it('keeps two sessions that finished in the same millisecond', () => {
    event({ at: T, subject: 's1' })
    event({ at: T, subject: 's2' })

    expect(notificationsSince(db, T - 1)).toHaveLength(2)
  })

  it('leaves out what the hub decided not to send', () => {
    // Showing a dropped row here would undo that decision on one machine.
    event({ state: 'dropped' })

    expect(notificationsSince(db, T - 1)).toEqual([])
  })

  it('carries the hub words through unchanged', () => {
    event({ title: '[aiusage] 🟢 作業完了' })

    expect(notificationsSince(db, T - 1)[0].title).toBe('[aiusage] 🟢 作業完了')
  })
})

describe('nothing already seen', () => {
  beforeEach(() => { db = createTestDb(); seq = 0 })

  it('ignores everything up to and including the marker', () => {
    event({ at: T })
    event({ at: T + 5 })

    expect(notificationsSince(db, T)).toHaveLength(1)
  })

  it('moves the marker to the newest thing it found', () => {
    event({ at: T })
    event({ at: T + 5 })

    expect(nextBatch(notificationsSince(db, T - 1), 0).seenAt).toBe(T + 5)
  })

  it('leaves the marker alone when nothing is new', () => {
    // Not "now": moving it on an empty read would skip an event written a
    // moment ago with an older timestamp.
    expect(nextBatch([], T).seenAt).toBe(T)
  })
})

describe('only a finished task is worth interrupting for', () => {
  beforeEach(() => { db = createTestDb(); seq = 0 })

  /* Every shape that appears in the real table, read off production. */
  const REAL = {
    finished: { status: 'waiting_for_user', lastEventKind: 'stop' },
    sessionEnded: { status: 'completed', lastEventKind: 'session_end' },
    started: { status: 'waiting_for_user', lastEventKind: 'session_start' },
    permission: { status: 'waiting_for_permission', lastEventKind: 'permission_request' },
    stopFailed: { status: 'waiting_for_user', lastEventKind: 'stop_failure' },
    completedOnStop: { status: 'completed', lastEventKind: 'stop' },
    processScan: { status: 'completed', lastEventKind: 'process_scan' },
  }

  it('recognises the one that means the work is done', () => {
    expect(isWorkFinished(JSON.stringify(REAL.finished))).toBe(true)
  })

  it('leaves every other session shape alone', () => {
    for (const [name, payload] of Object.entries(REAL)) {
      if (name === 'finished') continue
      expect(isWorkFinished(JSON.stringify(payload)), name).toBe(false)
    }
  })

  it('does not confuse stop_failure with stop', () => {
    // Both are waiting_for_user, and only one of them finished anything.
    expect(isWorkFinished(JSON.stringify(REAL.stopFailed))).toBe(false)
  })

  it('leaves the quota and parse events to the phone', () => {
    for (const payload of ['{"threshold":80,"utilization":80}', '{"lastSuccessAt":1788146162963}', '{"level":1}', '{}']) {
      expect(isWorkFinished(payload), payload).toBe(false)
    }
  })

  it('says nothing when it cannot read the payload', () => {
    // Unknown is not "probably fine". Guessing wrong here produces exactly
    // the notification this filter exists to stop.
    for (const payload of ['', 'not json', 'null', '[]', '"stop"']) {
      expect(isWorkFinished(payload), JSON.stringify(payload)).toBe(false)
    }
  })

  it('shows the finished one and passes over the rest', () => {
    event({ at: T + 1, subject: 'a', payload: JSON.stringify(REAL.permission) })
    event({ at: T + 2, subject: 'b', payload: JSON.stringify(REAL.finished), title: 'finished' })
    event({ at: T + 3, subject: 'c', payload: JSON.stringify(REAL.sessionEnded) })

    const batch = nextBatch(notificationsSince(db, T), 0)

    expect(batch.show.map((r) => r.title)).toEqual(['finished'])
  })

  it('still moves past the ones it passed over', () => {
    // They have been read and judged. Leaving them behind the marker would
    // mean judging them again on every tick, for ever.
    event({ at: T + 1, subject: 'a', payload: JSON.stringify(REAL.permission) })
    event({ at: T + 2, subject: 'b', payload: JSON.stringify(REAL.sessionEnded) })

    const batch = nextBatch(notificationsSince(db, T), 0)

    expect(batch.show).toEqual([])
    expect(batch.seenAt).toBe(T + 2)
  })
})

describe('a burst', () => {
  beforeEach(() => { db = createTestDb(); seq = 0 })

  it('shows the newest few and counts the rest', () => {
    for (let i = 0; i < MAX_PER_TICK + 3; i++) event({ at: T + i, subject: `s${i}` })

    const batch = nextBatch(notificationsSince(db, T - 1), 0)

    expect(batch.show).toHaveLength(MAX_PER_TICK)
    expect(batch.skipped).toBe(3)
    expect(batch.show[batch.show.length - 1].createdAt).toBe(T + MAX_PER_TICK + 2)
  })

  it('does not hold the unshown ones back for next time', () => {
    // A queue that drains over the following hour delivers news long after
    // it stopped being news.
    for (let i = 0; i < MAX_PER_TICK + 3; i++) event({ at: T + i, subject: `s${i}` })

    const batch = nextBatch(notificationsSince(db, T - 1), 0)

    expect(notificationsSince(db, batch.seenAt)).toEqual([])
  })
})
