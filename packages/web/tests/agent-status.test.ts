import { describe, it, expect } from 'vitest'
import { get } from 'svelte/store'
// Imported by path, not as a dependency: packages/web does not depend on
// core and this task must not add one. The point is to read the real
// function rather than a copy of its table.
import { notificationLabel } from '../../core/src/notification-rules.js'
import { t, setLang } from '../src/lib/i18n.js'
import {
  groupFor,
  groupSessions,
  isRecent,
  statusEmoji,
  statusLabelKey,
} from '../src/lib/agent-status.js'

const T0 = 1_788_000_000_000

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: String(Math.random()),
    status: 'running',
    lastEventKind: 'user_prompt',
    statusSince: T0,
    endedAt: null,
    ...overrides,
  }
}

/**
 * The same event is described in two places — a Discord message and this
 * board — and the reader is the same person. If the two drift, one event
 * looks like two.
 */
describe('board labels match the Discord wording', () => {
  const cases: Array<[string, string]> = [
    ['waiting_for_permission', 'notification'],
    ['waiting_for_user', 'stop'],
    ['completed', 'session_end'],
    ['failed', 'session_end'],
    // The exception core makes: stop_failure overrides the status, because
    // Stop and StopFailure both land on waiting_for_user.
    ['waiting_for_user', 'stop_failure'],
  ]

  it('uses core\'s Japanese label verbatim for every status core announces', () => {
    setLang('ja')
    const translate = get(t)
    for (const [status, kind] of cases) {
      const fromCore = notificationLabel(status as never, kind)
      expect(fromCore, `${status}/${kind}`).not.toBeNull()
      expect(translate(statusLabelKey(status, kind)), `${status}/${kind}`)
        .toBe(fromCore!.label)
    }
  })

  it('uses core\'s emoji too', () => {
    for (const [status, kind] of cases) {
      expect(statusEmoji(status, kind), `${status}/${kind}`)
        .toBe(notificationLabel(status as never, kind)!.emoji)
    }
  })

  it('names the statuses core stays silent about', () => {
    // core returns null for these because they are not worth a notification.
    // A board still has to show them, so the labels are the UI's own.
    setLang('ja')
    const translate = get(t)
    for (const status of ['running', 'idle', 'unknown']) {
      expect(notificationLabel(status as never, 'user_prompt')).toBeNull()
      const key = statusLabelKey(status, 'user_prompt')
      expect(translate(key)).not.toBe(key)
    }
  })
})

describe('grouping', () => {
  it('puts each status in the group that says what is expected of the reader', () => {
    expect(groupFor('waiting_for_permission')).toBe('needsAction')
    expect(groupFor('waiting_for_user')).toBe('done')
    expect(groupFor('completed')).toBe('done')
    expect(groupFor('running')).toBe('active')
    expect(groupFor('idle')).toBe('active')
    expect(groupFor('unknown')).toBe('unknown')
    expect(groupFor('failed')).toBe('unknown')
    expect(groupFor('something-new')).toBe('unknown')
  })

  it('orders the groups by whether anything is blocked on a person', () => {
    const grouped = groupSessions([
      session({ status: 'running' }),
      session({ status: 'unknown' }),
      session({ status: 'completed' }),
      session({ status: 'waiting_for_permission' }),
    ])
    expect(grouped.map((g) => g.id)).toEqual(['needsAction', 'done', 'active', 'unknown'])
  })

  it('puts the longest wait first inside a group', () => {
    // The whole reason for the page: the approval nobody has answered for an
    // hour should be the first thing on screen.
    const grouped = groupSessions([
      session({ id: 'recent', status: 'waiting_for_permission', statusSince: T0 + 60_000 }),
      session({ id: 'oldest', status: 'waiting_for_permission', statusSince: T0 }),
      session({ id: 'middle', status: 'waiting_for_permission', statusSince: T0 + 30_000 }),
    ])
    expect(grouped[0].sessions.map((s) => s.id)).toEqual(['oldest', 'middle', 'recent'])
  })

  it('leaves out groups with nothing in them', () => {
    const grouped = groupSessions([session({ status: 'running' })])
    expect(grouped.map((g) => g.id)).toEqual(['active'])
  })

  it('copes with no sessions at all', () => {
    expect(groupSessions([])).toEqual([])
    expect(groupSessions(undefined as never)).toEqual([])
  })
})

describe('default range', () => {
  const now = T0

  it('always keeps a session that has not ended', () => {
    expect(isRecent(session({ endedAt: null }), now)).toBe(true)
  })

  it('keeps a day of finished work and no more', () => {
    const day = 24 * 60 * 60 * 1000
    expect(isRecent(session({ endedAt: now - day + 1000 }), now)).toBe(true)
    expect(isRecent(session({ endedAt: now - day - 1000 }), now)).toBe(false)
  })
})
