import { describe, it, expect, beforeEach } from 'vitest'
import { eventsFromApi, isWorthShowing, MAX_PER_TICK, nextBatch, notificationsPath } from '../src/notifications'
import type { NotificationRow } from '../src/notifications'

/**
 * The two ways a notifier is worse than none: saying the same thing twice,
 * and saying everything at once on startup. Both are tested here.
 *
 * The rows arrive from the hub over HTTP now rather than from a local
 * database, so these build the hub's answer and let the parser fold it.
 */

const T = 1_700_000_000_000
const FINISHED = JSON.stringify({ status: 'waiting_for_user', lastEventKind: 'stop' })

/** The two rows one event produces, as /api/notifications returns them. */
let answer: { notifications: Array<Record<string, unknown>> }

function reset(): void {
  answer = { notifications: [] }
}

function event(overrides: Partial<{ at: number; subject: string; title: string; state: string; payload: string }> = {}): void {
  const { at = T, subject = 's1', title = 'done', payload = FINISHED } = overrides
  for (const channel of ['discord', 'webpush']) {
    answer.notifications.push({
      createdAt: at,
      channel,
      eventType: 'session_status',
      subjectKind: 'agent_session',
      subjectId: subject,
      title,
      body: 'body',
      payload,
    })
  }
}

/** Stands in for the old notificationsSince(since). */
function notificationsSince(since: number): NotificationRow[] {
  return eventsFromApi({
    notifications: answer.notifications.filter((row) => Number(row.createdAt) > since),
  })
}

describe('asking the hub', () => {
  beforeEach(reset)

  it('asks only for what it has not seen, and only for what was sent', () => {
    /*
     * state=sent is where "a dropped row stays dropped" now lives. The hub
     * decided not to deliver it; asking for it here would undo that
     * decision on one machine, so this never asks.
     */
    const path = notificationsPath(T)

    expect(path).toContain('since=1700000000000')
    expect(path).toContain('state=sent')
  })

  it('folds the two channel rows back into one event', () => {
    // dedupe_key cannot do this: the webpush key is the discord one with a
    // prefix, so every row has a distinct key.
    event()

    expect(eventsFromApi(answer)).toHaveLength(1)
  })

  it('returns them oldest first, whatever order they arrived in', () => {
    // The endpoint answers newest-first; the screen wants the other order.
    event({ at: T + 100, subject: 'b', title: 'second' })
    event({ at: T, subject: 'a', title: 'first' })

    expect(eventsFromApi(answer).map((r) => r.title)).toEqual(['first', 'second'])
  })

  it('ignores anything it cannot read a time from', () => {
    answer.notifications.push({ title: 'no timestamp', payload: FINISHED })

    expect(eventsFromApi(answer)).toEqual([])
  })

  it('says nothing at all when the answer is not the shape it expects', () => {
    for (const payload of [null, undefined, {}, { notifications: 'later' }]) {
      expect(eventsFromApi(payload)).toEqual([])
    }
  })
})

describe('one event, one notification', () => {
  beforeEach(reset)

  it('folds the channels back into the thing that happened', () => {
    // discord and webpush each get a row. dedupe_key does not fold them -
    // the webpush key is the discord one with a prefix - so the fold is on
    // what the event was about and when.
    event()

    expect(notificationsSince(T - 1)).toHaveLength(1)
  })

  it('keeps two events that happened at different moments', () => {
    event({ at: T })
    event({ at: T + 1000 })

    expect(notificationsSince(T - 1)).toHaveLength(2)
  })

  it('keeps two sessions that finished in the same millisecond', () => {
    event({ at: T, subject: 's1' })
    event({ at: T, subject: 's2' })

    expect(notificationsSince(T - 1)).toHaveLength(2)
  })

  it('carries the hub words through unchanged', () => {
    event({ title: '[aiusage] 🟢 作業完了' })

    expect(notificationsSince(T - 1)[0].title).toBe('[aiusage] 🟢 作業完了')
  })
})

describe('nothing already seen', () => {
  beforeEach(reset)

  it('ignores everything up to and including the marker', () => {
    event({ at: T })
    event({ at: T + 5 })

    expect(notificationsSince(T)).toHaveLength(1)
  })

  it('moves the marker to the newest thing it found', () => {
    event({ at: T })
    event({ at: T + 5 })

    expect(nextBatch(notificationsSince(T - 1), 0).seenAt).toBe(T + 5)
  })

  it('leaves the marker alone when nothing is new', () => {
    // Not "now": moving it on an empty read would skip an event written a
    // moment ago with an older timestamp.
    expect(nextBatch([], T).seenAt).toBe(T)
  })
})

describe('three endings are worth interrupting for, and five are not', () => {
  beforeEach(reset)

  /* The seven shapes that appear in the real table, plus the one that does not. */
  const REAL = {
    finished: { status: 'waiting_for_user', lastEventKind: 'stop' },
    stopFailed: { status: 'waiting_for_user', lastEventKind: 'stop_failure' },
    down: { status: 'failed', lastEventKind: 'stop' },
    sessionEnded: { status: 'completed', lastEventKind: 'session_end' },
    started: { status: 'waiting_for_user', lastEventKind: 'session_start' },
    permission: { status: 'waiting_for_permission', lastEventKind: 'permission_request' },
    completedOnStop: { status: 'completed', lastEventKind: 'stop' },
    processScan: { status: 'completed', lastEventKind: 'process_scan' },
  }
  const SHOWN = ['finished', 'stopFailed', 'down']

  it('shows the three the hub gives an ending label to', () => {
    for (const name of SHOWN) {
      expect(isWorthShowing(JSON.stringify(REAL[name as keyof typeof REAL])), name).toBe(true)
    }
  })

  it('leaves the other five alone', () => {
    for (const [name, payload] of Object.entries(REAL)) {
      if (SHOWN.includes(name)) continue
      expect(isWorthShowing(JSON.stringify(payload)), name).toBe(false)
    }
  })

  it('catches stop_failure on the kind, since its status stays waiting_for_user', () => {
    // The rules file makes the same check first and for the same reason: the
    // status alone cannot tell this from an ordinary finish.
    expect(REAL.stopFailed.status).toBe(REAL.finished.status)
    expect(isWorthShowing(JSON.stringify(REAL.stopFailed))).toBe(true)
  })

  it('shows a failed session whatever the last event was', () => {
    // Nothing in this database has ever been failed. The hub can produce it,
    // and the first time it does is the wrong moment to find out this was
    // not watching for it.
    for (const kind of ['stop', 'session_end', 'process_scan', 'anything']) {
      expect(isWorthShowing(JSON.stringify({ status: 'failed', lastEventKind: kind })), kind).toBe(true)
    }
  })

  it('leaves the quota and parse events to the phone', () => {
    for (const payload of ['{"threshold":80,"utilization":80}', '{"lastSuccessAt":1788146162963}', '{"level":1}', '{}']) {
      expect(isWorthShowing(payload), payload).toBe(false)
    }
  })

  it('says nothing when it cannot read the payload', () => {
    // Unknown is not "probably fine". Guessing wrong here produces exactly
    // the notification this filter exists to stop.
    for (const payload of ['', 'not json', 'null', '[]', '"stop"', '5']) {
      expect(isWorthShowing(payload), JSON.stringify(payload)).toBe(false)
    }
  })

  it('shows the endings and passes over the rest', () => {
    event({ at: T + 1, subject: 'a', payload: JSON.stringify(REAL.permission) })
    event({ at: T + 2, subject: 'b', payload: JSON.stringify(REAL.finished), title: 'finished' })
    event({ at: T + 3, subject: 'c', payload: JSON.stringify(REAL.sessionEnded) })
    event({ at: T + 4, subject: 'd', payload: JSON.stringify(REAL.stopFailed), title: 'error' })
    event({ at: T + 5, subject: 'e', payload: JSON.stringify(REAL.down), title: 'down' })

    const batch = nextBatch(notificationsSince(T), 0)

    expect(batch.show.map((r) => r.title)).toEqual(['finished', 'error', 'down'])
  })

  it('still moves past the ones it passed over', () => {
    // They have been read and judged. Leaving them behind the marker would
    // mean judging them again on every tick, for ever.
    event({ at: T + 1, subject: 'a', payload: JSON.stringify(REAL.permission) })
    event({ at: T + 2, subject: 'b', payload: JSON.stringify(REAL.sessionEnded) })

    const batch = nextBatch(notificationsSince(T), 0)

    expect(batch.show).toEqual([])
    expect(batch.seenAt).toBe(T + 2)
  })
})

describe('a burst', () => {
  beforeEach(reset)

  it('shows the newest few and counts the rest', () => {
    for (let i = 0; i < MAX_PER_TICK + 3; i++) event({ at: T + i, subject: `s${i}` })

    const batch = nextBatch(notificationsSince(T - 1), 0)

    expect(batch.show).toHaveLength(MAX_PER_TICK)
    expect(batch.skipped).toBe(3)
    expect(batch.show[batch.show.length - 1].createdAt).toBe(T + MAX_PER_TICK + 2)
  })

  it('does not hold the unshown ones back for next time', () => {
    // A queue that drains over the following hour delivers news long after
    // it stopped being news.
    for (let i = 0; i < MAX_PER_TICK + 3; i++) event({ at: T + i, subject: `s${i}` })

    const batch = nextBatch(notificationsSince(T - 1), 0)

    expect(notificationsSince(batch.seenAt)).toEqual([])
  })
})
