/**
 * How the agents board groups and labels sessions.
 *
 * Kept out of the page so the labels can be checked against the Discord ones
 * by a test — the two are read by the same person about the same event, and a
 * session that Discord called 作業完了 must not be called something else here.
 */

/**
 * Grouped by whether anything is expected of the reader, not by time.
 *
 * A board sorted newest-first buries the one thing that is actually blocked
 * on a person underneath a stream of finished work. Approval waits come
 * first because nothing progresses until they are answered; finished work
 * next because it wants looking at; running work below that because watching
 * it changes nothing.
 */
export const STATUS_GROUPS = [
  { id: 'needsAction', statuses: ['waiting_for_permission'] },
  { id: 'done', statuses: ['waiting_for_user', 'completed'] },
  { id: 'active', statuses: ['running', 'idle'] },
  { id: 'unknown', statuses: ['unknown', 'failed'] },
]

const GROUP_OF = new Map(
  STATUS_GROUPS.flatMap((g) => g.statuses.map((s) => [s, g.id])),
)

/** @param {string} status */
export function groupFor(status) {
  return GROUP_OF.get(status) ?? 'unknown'
}

/**
 * The i18n key for a session's label.
 *
 * The mapping mirrors core's notificationLabel, including its rule that
 * stop_failure wins over the status: Stop and StopFailure both leave a
 * session at waiting_for_user, and calling the second one 作業完了 would be
 * a lie the notification does not tell.
 *
 * The statuses core returns null for are ones it never announces. They still
 * have to be named here, because a board shows everything.
 *
 * @param {string} status
 * @param {string} lastEventKind
 */
export function statusLabelKey(status, lastEventKind) {
  if (lastEventKind === 'stop_failure') return 'agents.status.stopFailure'
  switch (status) {
    case 'waiting_for_permission': return 'agents.status.waitingForPermission'
    case 'waiting_for_user': return 'agents.status.waitingForUser'
    case 'completed': return 'agents.status.completed'
    case 'failed': return 'agents.status.failed'
    case 'running': return 'agents.status.running'
    case 'idle': return 'agents.status.idle'
    default: return 'agents.status.unknown'
  }
}

/**
 * The same emoji Discord uses, so the two read as one vocabulary.
 *
 * @param {string} status
 * @param {string} lastEventKind
 */
export function statusEmoji(status, lastEventKind) {
  if (lastEventKind === 'stop_failure') return '🔴'
  switch (status) {
    case 'waiting_for_permission': return '🟡'
    case 'waiting_for_user': return '🟢'
    case 'completed': return '✅'
    case 'failed': return '🔴'
    case 'running': return '🔵'
    case 'idle': return '⚪'
    default: return '⚫'
  }
}

/**
 * Sessions bucketed into the groups above, oldest first within each.
 *
 * Oldest-first is the point: the approval that has been waiting longest is
 * the one most worth answering, and it ends up at the top of the top group.
 *
 * @param {Array<any>} sessions
 */
export function groupSessions(sessions) {
  /** @type {Map<string, any[]>} */
  const groups = new Map(STATUS_GROUPS.map((g) => [g.id, /** @type {any[]} */ ([])]))
  for (const session of sessions ?? []) {
    groups.get(groupFor(session.status))?.push(session)
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.statusSince ?? 0) - (b.statusSince ?? 0))
  }
  return STATUS_GROUPS
    .map((g) => ({ id: g.id, sessions: groups.get(g.id) ?? [] }))
    .filter((g) => g.sessions.length > 0)
}

/**
 * Whether a session belongs in the default view.
 *
 * Everything unfinished, plus a day of finished work for context. Older
 * finished sessions are history, which is what /sessions is for.
 *
 * @param {any} session
 * @param {number} now
 */
export function isRecent(session, now) {
  if (session?.endedAt == null) return true
  return now - session.endedAt <= 24 * 60 * 60 * 1000
}
