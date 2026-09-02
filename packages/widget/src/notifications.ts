import type Database from 'better-sqlite3'

/**
 * Noticing what the hub already decided to say, rather than deciding again.
 *
 * Everything is in the notifications table: serve writes a row when it sends
 * something, and this process is already reading that database every few
 * minutes. So there is no listener, no port, no push - just a query with a
 * "since" on it. The database stays readonly, which is why the marker for
 * "what has been shown here" lives in the widget's own settings file.
 *
 * The words come from the row. A notification that reads differently on the
 * phone and on the desktop is two events as far as the reader is concerned.
 */

export interface NotificationRow {
  createdAt: number
  title: string
  body: string
  /** JSON as stored; never assumed to parse. */
  payload: string
}

/**
 * One row per channel, and they are the same event.
 *
 * discord and webpush each get a row, so reading the table straight shows
 * everything twice. dedupe_key does not fold them - it is unique per row
 * (767 rows, 767 keys on this machine) because the webpush key is the
 * discord one with a prefix. What identifies the event is what it was about
 * and when: fold on that, and 767 rows become the 467 things that happened,
 * which is exactly the discord count.
 *
 * Folding on the key's prefix would work today and break the next time a
 * channel is added with a different prefix, which is the wrong way round.
 */
const FOLD = 'event_type, subject_kind, subject_id, created_at'

/**
 * How many to put on screen at once.
 *
 * A burst is possible - the machine can be asleep while several sessions
 * finish - and five toasts is already a lot of screen. Anything past this is
 * counted and said in the log rather than shown, because the alternative is
 * a stack of notifications nobody reads and one of them being the one that
 * mattered.
 */
export const MAX_PER_TICK = 5

/**
 * Events written after `since`, oldest first, one per event.
 *
 * Only `sent`: a row in `dropped` is one the hub decided not to deliver, and
 * showing it here would undo that decision on one machine.
 */
export function notificationsSince(db: Database.Database, since: number): NotificationRow[] {
  return db.prepare(`
    SELECT MIN(created_at) AS createdAt, title, body, MAX(payload) AS payload
    FROM notifications
    WHERE created_at > ? AND state = 'sent'
    GROUP BY ${FOLD}
    ORDER BY MIN(created_at) ASC
  `).all(since) as NotificationRow[]
}

/**
 * The one thing worth interrupting someone for: a task that just finished.
 *
 * Everything else the hub sends stays on the phone. A session merely ending,
 * a permission prompt, a quota threshold, a stalled parse - each is real, and
 * none of them is what someone is waiting at the screen for.
 *
 * Read from the payload, never from the title. The titles are written in the
 * user's language and would take this with them the first time anyone
 * translated one; the payload is the same two words in every locale.
 *
 * A payload that will not parse, or does not carry these fields, is not
 * shown. Unknown is not "probably fine": the failure of guessing wrong here
 * is a notification for something nobody asked to be told about, which is
 * exactly what this filter exists to stop.
 *
 * `stop` and not `stop_failure` - both appear in the data, and only one of
 * them means the work finished.
 */
export function isWorkFinished(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as { status?: unknown; lastEventKind?: unknown }
    return parsed.status === 'waiting_for_user' && parsed.lastEventKind === 'stop'
  } catch {
    return false
  }
}

export interface Batch {
  /** What to show, oldest first, never more than MAX_PER_TICK. */
  show: NotificationRow[]
  /** How many were left out of a burst; 0 normally. */
  skipped: number
  /** Where the marker moves to, whether or not everything was shown. */
  seenAt: number
}

/**
 * What to do with what was found.
 *
 * The marker advances past everything, including what was not shown. The
 * alternative - holding the marker back so the rest appear next time - turns
 * one busy minute into a queue that drains over the following hour, long
 * after the events stopped being news.
 */
export function nextBatch(rows: NotificationRow[], fallbackSeenAt: number): Batch {
  if (rows.length === 0) return { show: [], skipped: 0, seenAt: fallbackSeenAt }

  /*
   * The marker passes everything that was read, not everything that was
   * shown. A quota warning this decided not to raise has still been seen and
   * dealt with; leaving it behind the marker would make every later read
   * consider it again, for ever.
   */
  const seenAt = rows[rows.length - 1].createdAt

  const worth = rows.filter((row) => isWorkFinished(row.payload))
  const show = worth.slice(-MAX_PER_TICK)
  return { show, skipped: worth.length - show.length, seenAt }
}
