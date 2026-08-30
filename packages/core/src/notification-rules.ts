/**
 * Deciding what to notify about, and what to say.
 *
 * Pure functions: no database, no network, no clock of its own. `now` is
 * always passed in, so the caller — API handler, sender, test — controls time.
 *
 * Every "do not send" answer carries a reason. Without one, a user who did not
 * get a notification has no way to tell a deliberate suppression from a bug,
 * and neither does anyone debugging it later.
 */

import type { AgentStatus, AgentEventKind } from './agent-status.js'
import type { QuotaConfidence } from './quota-forecast.js'

export type NotificationEventType =
  | 'session_status'
  | 'session_escalation'
  | 'quota_threshold'
  | 'quota_reset'
  | 'test'

export interface NotificationEventsConfig {
  waiting_for_permission?: boolean
  waiting_for_user?: boolean
  failed?: boolean
  completed?: boolean
  running?: boolean
  idle?: boolean
}

export interface NotificationRulesConfig {
  enabled?: boolean
  prefix?: string
  minIntervalMs?: number
  includeAssistantMessage?: boolean
  events?: NotificationEventsConfig
  escalation?: { waiting_for_permission?: number[] }
  quota?: { thresholds?: number[]; notifyOnReset?: boolean }
  quietHours?: { start: string; end: string }
  /**
   * Per-tool mute. Unset means enabled, so a tool added later starts
   * announcing itself rather than staying silently off.
   */
  tools?: Record<string, boolean>
  quietHoursAllow?: string[]
}

export const DEFAULT_NOTIFICATION_PREFIX = '[aiusage] '
export const DEFAULT_MIN_INTERVAL_MS = 30_000
export const DEFAULT_QUOTA_THRESHOLDS: readonly number[] = [80, 95, 100]
export const DEFAULT_ESCALATION_MS: readonly number[] = [600_000, 1_800_000]
export const DEFAULT_QUIET_HOURS_ALLOW: readonly string[] = ['waiting_for_permission', 'failed']

/** Statuses worth announcing unless told otherwise. */
export const DEFAULT_NOTIFICATION_EVENTS: Required<NotificationEventsConfig> = {
  waiting_for_permission: true,
  waiting_for_user: true,
  failed: true,
  completed: true,
  // Starting work is not news; the person asked for it a second ago.
  running: false,
  idle: false,
}

/** Discord rejects a message body over this. */
export const DISCORD_MAX_BODY = 2000

export interface NotificationLabel {
  emoji: string
  label: string
}

/**
 * What to call what happened.
 *
 * Status alone is not enough. StopFailure deliberately leaves the status at
 * waiting_for_user — the turn died on an API error but the session is alive
 * and retryable — so the only way to say "処理エラー終了" is to look at the
 * event that got us here. Hence the kind is checked before the status.
 *
 * Wording matches the existing PowerShell hooks so the two can be compared
 * side by side while they run together.
 */
export function notificationLabel(
  status: AgentStatus,
  lastEventKind: AgentEventKind | string,
): NotificationLabel | null {
  if (lastEventKind === 'stop_failure') return { emoji: '🔴', label: '処理エラー終了' }

  switch (status) {
    case 'waiting_for_permission': return { emoji: '🟡', label: '確認・入力待ち' }
    case 'waiting_for_user': return { emoji: '🟢', label: '作業完了' }
    case 'completed': return { emoji: '✅', label: 'セッション終了' }
    case 'failed': return { emoji: '🔴', label: '異常終了' }
    // Nothing a person needs to hear about.
    default: return null
  }
}

/** 'HH:MM' → minutes since midnight, or null when unparseable. */
function parseClock(value: string | undefined): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * Whether `now` falls inside the configured quiet hours. Ranges that wrap past
 * midnight (22:00–07:00) are the normal case, so both orders are handled.
 */
export function isQuietHour(
  quietHours: { start: string; end: string } | undefined,
  now: number,
): boolean {
  const start = parseClock(quietHours?.start)
  const end = parseClock(quietHours?.end)
  if (start == null || end == null || start === end) return false

  const date = new Date(now)
  const minutes = date.getHours() * 60 + date.getMinutes()
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end
}

export type NotifyDecisionReason =
  | 'ok'
  | 'disabled'
  | 'tool_disabled'
  | 'no_label'
  | 'event_disabled'
  | 'duplicate'
  | 'throttled'
  | 'quiet_hours'

export interface NotifyDecision {
  notify: boolean
  reason: NotifyDecisionReason
}

export interface ShouldNotifySessionInput {
  status: AgentStatus
  lastEventKind: AgentEventKind | string
  /** What we last told the user about this session, if anything. */
  previousNotifyState: string | null
  statusSince: number
  lastNotifiedAt: number | null
  /** Which tool the session belongs to, for the per-tool mute. */
  tool?: string
  now: number
  config: NotificationRulesConfig | undefined
}

/**
 * The checks run in a fixed order, and the order is the specification — see
 * the tests, which walk it one rule at a time.
 */
export function shouldNotifySession(input: ShouldNotifySessionInput): NotifyDecision {
  const config = input.config ?? {}

  // 1. Switched off entirely.
  if (config.enabled !== true) return { notify: false, reason: 'disabled' }

  // 2. This tool is muted. Ahead of the label check because 'I do not want
  //    to hear about Codex' is about the source, not about what happened.
  if (input.tool != null && config.tools?.[input.tool] === false) {
    return { notify: false, reason: 'tool_disabled' }
  }

  // 3. Nothing worth saying about this state.
  const label = notificationLabel(input.status, input.lastEventKind)
  if (!label) return { notify: false, reason: 'no_label' }

  // 4. This particular kind of news is muted.
  const events = { ...DEFAULT_NOTIFICATION_EVENTS, ...(config.events ?? {}) }
  if (events[input.status as keyof NotificationEventsConfig] !== true) {
    return { notify: false, reason: 'event_disabled' }
  }

  // 5. We already said exactly this.
  const state = notifyStateFor(input.status, input.lastEventKind, input.statusSince)
  if (input.previousNotifyState === state) return { notify: false, reason: 'duplicate' }

  // 6. Too soon after the last one, whatever it was.
  const minInterval = config.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  if (input.lastNotifiedAt != null && input.now - input.lastNotifiedAt < minInterval) {
    return { notify: false, reason: 'throttled' }
  }

  // 7. Quiet hours, unless this is one of the things worth waking up for.
  if (isQuietHour(config.quietHours, input.now)) {
    const allow = config.quietHoursAllow ?? DEFAULT_QUIET_HOURS_ALLOW
    const key = input.lastEventKind === 'stop_failure' ? 'failed' : input.status
    if (!allow.includes(key)) return { notify: false, reason: 'quiet_hours' }
  }

  return { notify: true, reason: 'ok' }
}

/**
 * Identity of "the thing we last said" about a session. status_since is part
 * of it so the same status reached twice is two events, not a repeat.
 */
export function notifyStateFor(
  status: AgentStatus,
  lastEventKind: AgentEventKind | string,
  statusSince: number,
): string {
  return `${status}:${lastEventKind}:${statusSince}`
}

/**
 * Which thresholds a utilization reading has just crossed.
 *
 * Returns all of them; the caller announces only the highest. Keeping the
 * filtering out of here makes the boundary behaviour testable on its own.
 *
 * A null `previous` means there is no baseline — a first observation, or the
 * first reading of a new window — and returns nothing. Pass 0 explicitly to
 * say "the window is known to have started empty".
 */
export function quotaThresholdCrossings(
  previous: number | null,
  current: number,
  thresholds: number[] = [...DEFAULT_QUOTA_THRESHOLDS],
): number[] {
  if (!Number.isFinite(current)) return []
  // No baseline, no crossing. A first observation at 85 % is not the moment
  // the quota reached 80 % — it is the moment we started looking, and
  // announcing "80% 到達" for it reports an event that was never seen. The
  // same applies after a rollover, where the caller passes null deliberately:
  // the new window's history begins here.
  if (!Number.isFinite(previous as number)) return []
  const from = previous as number
  return thresholds
    .filter((t) => Number.isFinite(t))
    .filter((t) => from < t && current >= t)
    .sort((a, b) => a - b)
}

/**
 * The next escalation level due for a session that has been waiting.
 *
 * Levels are 1-based and correspond to entries in `thresholds`; null means
 * nothing new is due — either not enough time has passed, or every step has
 * already been sent.
 */
export function escalationDue(
  status: AgentStatus,
  statusSince: number,
  currentLevel: number,
  thresholds: number[] = [...DEFAULT_ESCALATION_MS],
  now: number = 0,
): number | null {
  if (status !== 'waiting_for_permission') return null
  if (!Number.isFinite(statusSince)) return null

  const waited = now - statusSince
  const level = Math.max(0, Math.floor(currentLevel) || 0)
  if (level >= thresholds.length) return null

  const next = thresholds[level]
  if (!Number.isFinite(next) || waited < next) return null
  return level + 1
}

/** "1時間5分" / "2分13秒" / "12秒" */
export function formatDurationJa(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0秒'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}時間${minutes}分`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${Math.max(1, seconds)}秒`
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini',
  cursor: 'Cursor',
}

export function toolDisplayName(tool: string): string {
  return TOOL_DISPLAY_NAMES[tool] ?? tool
}

const TIER_DISPLAY_NAMES: Record<string, string> = {
  five_hour: '5時間枠',
  seven_day: '7日枠',
  seven_day_opus: '7日枠(Opus)',
  seven_day_sonnet: '7日枠(Sonnet)',
  weekly_limit: '週次枠',
  daily: '日次枠',
  daily_limit: '日次枠',
  monthly: '月次枠',
  premium_interactions: 'プレミアム',
  chat: 'チャット',
}

export function tierDisplayName(tier: string): string {
  return TIER_DISPLAY_NAMES[tier] ?? tier
}

function clockHHMM(ms: number): string {
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function truncate(value: string | null | undefined, max: number): string {
  if (typeof value !== 'string' || !value) return ''
  return value.length <= max ? value : value.slice(0, max) + '…'
}

/** As long as the notification will ever show; see normalizeAssistantPreview. */
export const ASSISTANT_PREVIEW_MAX = 200

/**
 * An assistant reply reduced to what a notification can use.
 *
 * Applied where the text is *captured*, not where it is displayed. Storing the
 * whole reply and trimming it later would put entire conversations in the
 * database for the sake of two lines of Discord message — and the database is
 * synced, backed up and read by other tools, none of which need it.
 *
 * Newlines and runs of spaces collapse to one space: a reply is many lines,
 * a notification is one, and a multi-line value in a payload column is
 * awkward for everything downstream.
 */
export function normalizeAssistantPreview(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  return truncate(collapsed, ASSISTANT_PREVIEW_MAX)
}

export interface SessionMessageInput {
  status: AgentStatus
  lastEventKind: AgentEventKind | string
  device: string
  tool: string
  project: string
  statusSince: number
  now: number
  runningMs?: number
  statusDetail?: string | null
  errorType?: string | null
  assistantMessage?: string | null
  escalationLevel?: number
  config?: NotificationRulesConfig
}

export interface DiscordMessage {
  title: string
  body: string
}

export function formatSessionMessage(input: SessionMessageInput): DiscordMessage | null {
  const label = notificationLabel(input.status, input.lastEventKind)
  if (!label) return null

  const prefix = input.config?.prefix ?? DEFAULT_NOTIFICATION_PREFIX
  const device = input.device || 'unknown'
  const waited = formatDurationJa(input.now - input.statusSince)

  let title = `${prefix}${label.emoji} ${device}｜${toolDisplayName(input.tool)}｜${label.label}`
  if (input.escalationLevel && input.escalationLevel > 0) {
    title += `（${waited}経過・再通知${input.escalationLevel}）`
  }

  const lines: string[] = []
  // Project name only — an absolute cwd says more about the machine than the
  // recipient needs, and this goes to a third-party service.
  if (input.project) lines.push(`プロジェクト: ${input.project}`)

  if (input.status === 'completed' && Number.isFinite(input.runningMs)) {
    lines.push(`作業時間: ${formatDurationJa(input.runningMs as number)}`)
  } else {
    lines.push(`${input.status === 'waiting_for_permission' ? '待ち時間' : '経過'}: ${waited}`)
  }

  if (input.lastEventKind === 'stop_failure' && input.errorType) {
    lines.push(`エラー種別: ${truncate(input.errorType, 60)}`)
  }
  if (input.statusDetail) lines.push(`詳細: ${truncate(input.statusDetail, 200)}`)

  // Opt-in only: this is response content leaving the machine.
  if (input.config?.includeAssistantMessage && input.assistantMessage) {
    lines.push(`応答: ${truncate(input.assistantMessage, 200)}`)
  }

  return capMessage(title, lines.join('\n'))
}

export interface QuotaMessageInput {
  kind: 'threshold' | 'reset'
  device: string
  tool: string
  tier: string
  threshold?: number
  utilization: number
  resetsAt: number | null
  exhaustAt: number | null
  confidence: QuotaConfidence
  now: number
  config?: NotificationRulesConfig
}

export function formatQuotaMessage(input: QuotaMessageInput): DiscordMessage {
  const prefix = input.config?.prefix ?? DEFAULT_NOTIFICATION_PREFIX
  const device = input.device || 'unknown'
  const tool = toolDisplayName(input.tool)
  const tier = tierDisplayName(input.tier)

  const title = input.kind === 'reset'
    ? `${prefix}🔄 ${device}｜${tool}｜${tier} リセット`
    : `${prefix}⚠️ ${device}｜${tool}｜${tier} ${input.threshold}% 到達`

  const lines: string[] = []
  lines.push(`現在: ${input.utilization.toFixed(1)}%`)

  if (input.resetsAt != null) {
    const remaining = input.resetsAt - input.now
    lines.push(
      remaining > 0
        ? `リセット: ${clockHHMM(input.resetsAt)}（あと${formatDurationJa(remaining)}）`
        : `リセット: ${clockHHMM(input.resetsAt)}`,
    )
  }

  // A projection built on two samples is not worth acting on, and putting it
  // in a notification lends it an authority it has not earned — the same
  // reason paceRatio is withheld below 2 % of a window.
  if (input.exhaustAt != null && input.confidence !== 'low') {
    lines.push(`このペースだと ${clockHHMM(input.exhaustAt)} 頃に上限`)
  }

  return capMessage(title, lines.join('\n'))
}

/** Keep title and body together under Discord's limit. */
export function capMessage(title: string, body: string): DiscordMessage {
  const cappedTitle = title.length > DISCORD_MAX_BODY
    ? title.slice(0, DISCORD_MAX_BODY - 1) + '…'
    : title
  const room = DISCORD_MAX_BODY - cappedTitle.length - 1
  if (room <= 0) return { title: cappedTitle, body: '' }
  const cappedBody = body.length > room ? body.slice(0, Math.max(0, room - 1)) + '…' : body
  return { title: cappedTitle, body: cappedBody }
}

/** The single string posted to the webhook. */
export function renderDiscordContent(message: DiscordMessage): string {
  const content = message.body ? `${message.title}\n${message.body}` : message.title
  return content.length > DISCORD_MAX_BODY ? content.slice(0, DISCORD_MAX_BODY - 1) + '…' : content
}
