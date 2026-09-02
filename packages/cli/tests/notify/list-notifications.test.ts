import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { listNotifications } from '../../src/db/notifications.js'

/**
 * The contract the widget reads over HTTP.
 *
 * It stopped reading this database directly - one native binding, built for
 * the wrong ABI, took the CLI down with it - and now asks the hub. Two things
 * it needs are tested here because nothing else in this package uses them,
 * and a projection is exactly the kind of thing that gets tidied.
 */

const T = 1_700_000_000_000
let db: Database.Database

function insert(overrides: Partial<{ id: string; at: number; payload: string; subjectId: string }> = {}): void {
  const { id = 'n1', at = T, payload = '{"status":"waiting_for_user","lastEventKind":"stop"}', subjectId = 's1' } = overrides
  db.prepare(`
    INSERT INTO notifications (id, created_at, channel, event_type, subject_kind, subject_id, dedupe_key, title, body, payload, state)
    VALUES (@id, @at, 'discord', 'session_status', 'agent_session', @subjectId, @id, 'title', 'body', @payload, 'sent')
  `).run({ id, at, subjectId, payload })
}

describe('what a polling reader needs from listNotifications', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  it('returns the payload, which is the only thing safe to decide from', () => {
    // The titles are written in the user's language. A reader that decided
    // what to raise from a title would break the first time one was
    // translated, so the decision is made from this.
    insert()

    const [row] = listNotifications(db, {}).notifications as Array<{ payload: string }>

    expect(JSON.parse(row.payload)).toEqual({ status: 'waiting_for_user', lastEventKind: 'stop' })
  })

  it('carries no credential of any kind in that payload', () => {
    // Said out loud because this is the field that was added to be sent
    // across a network to another machine.
    insert({ payload: '{"threshold":80,"utilization":80}' })

    const text = JSON.stringify(listNotifications(db, {}).notifications)

    expect(text).not.toMatch(/token|password|secret|webhook|https?:\/\//i)
  })

  it('returns only what is newer than the caller has seen', () => {
    insert({ id: 'old', at: T })
    insert({ id: 'new', at: T + 1000, subjectId: 's2' })

    const rows = listNotifications(db, { since: T }).notifications as Array<{ id: string }>

    expect(rows.map((r) => r.id)).toEqual(['new'])
  })

  it('treats since as exclusive, so the marker is never re-delivered', () => {
    insert({ id: 'only', at: T })

    expect(listNotifications(db, { since: T }).notifications).toEqual([])
  })

  it('ignores a since that is not a number', () => {
    // A reader on its first run has nowhere to start from; it should get the
    // ordinary answer rather than an empty one or an error.
    insert()

    expect(listNotifications(db, { since: null }).notifications).toHaveLength(1)
  })

  it('does not lose events past the limit when since is used', () => {
    /*
     * The reason since exists. Taking the newest N and filtering by time
     * silently drops anything past N; asking by time cannot.
     */
    for (let i = 0; i < 10; i++) insert({ id: `n${i}`, at: T + i, subjectId: `s${i}` })

    const rows = listNotifications(db, { since: T, limit: 5 }).notifications as Array<{ id: string }>

    expect(rows).toHaveLength(5)
    expect(listNotifications(db, { since: T }).total).toBe(9)
  })
})
