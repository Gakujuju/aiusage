import { describe, it, expect } from 'vitest'
import {
  notificationLabel,
  shouldNotifySession,
  notifyStateFor,
  quotaThresholdCrossings,
  escalationDue,
  formatSessionMessage,
  formatQuotaMessage,
  renderDiscordContent,
  formatDurationJa,
  isQuietHour,
  toolDisplayName,
  tierDisplayName,
  DISCORD_MAX_BODY,
  DEFAULT_MIN_INTERVAL_MS,
  type NotificationRulesConfig,
  type ShouldNotifySessionInput,
} from '../src/notification-rules.js'

const T0 = new Date('2026-08-30T12:00:00').getTime()
const MIN = 60_000

const on: NotificationRulesConfig = { enabled: true }

function input(overrides: Partial<ShouldNotifySessionInput> = {}): ShouldNotifySessionInput {
  return {
    status: 'waiting_for_permission',
    lastEventKind: 'notification',
    previousNotifyState: null,
    statusSince: T0,
    lastNotifiedAt: null,
    now: T0 + MIN,
    config: on,
    ...overrides,
  }
}

describe('notificationLabel', () => {
  it('names each status a person should hear about', () => {
    expect(notificationLabel('waiting_for_permission', 'notification')).toEqual({ emoji: '🟡', label: '確認・入力待ち' })
    expect(notificationLabel('waiting_for_user', 'stop')).toEqual({ emoji: '🟢', label: '作業完了' })
    expect(notificationLabel('completed', 'session_end')).toEqual({ emoji: '✅', label: 'セッション終了' })
    expect(notificationLabel('failed', 'session_end')).toEqual({ emoji: '🔴', label: '異常終了' })
  })

  // Regression: StopFailure leaves the status at waiting_for_user on purpose,
  // because the session is alive and retryable. Reading only the status would
  // announce "作業完了" for a turn that died on an API error.
  it('reports an API-error turn as 処理エラー終了, not 作業完了', () => {
    expect(notificationLabel('waiting_for_user', 'stop_failure')).toEqual({ emoji: '🔴', label: '処理エラー終了' })
  })

  it('lets stop_failure win over every status', () => {
    for (const status of ['running', 'idle', 'completed', 'waiting_for_permission'] as const) {
      expect(notificationLabel(status, 'stop_failure')?.label).toBe('処理エラー終了')
    }
  })

  it('says nothing about states nobody needs to hear about', () => {
    expect(notificationLabel('running', 'user_prompt')).toBeNull()
    expect(notificationLabel('idle', 'process_scan')).toBeNull()
    expect(notificationLabel('unknown', 'process_scan')).toBeNull()
  })
})

describe('shouldNotifySession — the order of the checks', () => {
  it('1. refuses everything while disabled', () => {
    expect(shouldNotifySession(input({ config: {} }))).toEqual({ notify: false, reason: 'disabled' })
    expect(shouldNotifySession(input({ config: { enabled: false } })).reason).toBe('disabled')
  })

  it('2. refuses a status with no label, even when its event is enabled', () => {
    const decision = shouldNotifySession(input({
      status: 'running', lastEventKind: 'user_prompt',
      config: { enabled: true, events: { running: true } },
    }))
    expect(decision).toEqual({ notify: false, reason: 'no_label' })
  })

  it('3. refuses a muted event kind', () => {
    const decision = shouldNotifySession(input({
      config: { enabled: true, events: { waiting_for_permission: false } },
    }))
    expect(decision).toEqual({ notify: false, reason: 'event_disabled' })
  })

  it('3. honours the defaults: completed on, idle off', () => {
    expect(shouldNotifySession(input({ status: 'completed', lastEventKind: 'session_end' })).notify).toBe(true)
    expect(shouldNotifySession(input({ status: 'idle', lastEventKind: 'process_scan' })).reason).toBe('no_label')
  })

  it('4. refuses to repeat what it already said', () => {
    const previousNotifyState = notifyStateFor('waiting_for_permission', 'notification', T0)
    expect(shouldNotifySession(input({ previousNotifyState }))).toEqual({ notify: false, reason: 'duplicate' })
  })

  it('4. treats the same status reached again as a new event', () => {
    const previousNotifyState = notifyStateFor('waiting_for_permission', 'notification', T0 - 10 * MIN)
    expect(shouldNotifySession(input({ previousNotifyState })).notify).toBe(true)
  })

  it('5. throttles a second notification inside the minimum interval', () => {
    const decision = shouldNotifySession(input({
      lastNotifiedAt: T0 + MIN - 1000,
      now: T0 + MIN,
    }))
    expect(decision).toEqual({ notify: false, reason: 'throttled' })
  })

  it('5. allows it once the interval has elapsed', () => {
    const decision = shouldNotifySession(input({
      lastNotifiedAt: T0,
      now: T0 + DEFAULT_MIN_INTERVAL_MS,
    }))
    expect(decision.notify).toBe(true)
  })

  it('6. holds a non-urgent notification during quiet hours', () => {
    const night = new Date('2026-08-30T23:30:00').getTime()
    const decision = shouldNotifySession(input({
      status: 'completed', lastEventKind: 'session_end',
      statusSince: night, now: night,
      config: { enabled: true, quietHours: { start: '22:00', end: '07:00' } },
    }))
    expect(decision).toEqual({ notify: false, reason: 'quiet_hours' })
  })

  it('6. still wakes you for a permission wait and a failure', () => {
    const night = new Date('2026-08-30T23:30:00').getTime()
    const config: NotificationRulesConfig = { enabled: true, quietHours: { start: '22:00', end: '07:00' } }

    expect(shouldNotifySession(input({ statusSince: night, now: night, config })).notify).toBe(true)
    expect(shouldNotifySession(input({
      status: 'waiting_for_user', lastEventKind: 'stop_failure',
      statusSince: night, now: night, config,
    })).notify).toBe(true)
  })

  it('6. respects a custom allow list', () => {
    const night = new Date('2026-08-30T23:30:00').getTime()
    const decision = shouldNotifySession(input({
      statusSince: night, now: night,
      config: { enabled: true, quietHours: { start: '22:00', end: '07:00' }, quietHoursAllow: [] },
    }))
    expect(decision.reason).toBe('quiet_hours')
  })

  it('7. sends when nothing stands in the way', () => {
    expect(shouldNotifySession(input())).toEqual({ notify: true, reason: 'ok' })
  })
})

describe('isQuietHour', () => {
  const at = (iso: string) => new Date(iso).getTime()

  it('handles a range that wraps past midnight', () => {
    const quiet = { start: '22:00', end: '07:00' }
    expect(isQuietHour(quiet, at('2026-08-30T23:00:00'))).toBe(true)
    expect(isQuietHour(quiet, at('2026-08-30T03:00:00'))).toBe(true)
    expect(isQuietHour(quiet, at('2026-08-30T12:00:00'))).toBe(false)
    expect(isQuietHour(quiet, at('2026-08-30T07:00:00'))).toBe(false)
    expect(isQuietHour(quiet, at('2026-08-30T21:59:00'))).toBe(false)
  })

  it('handles a range inside one day', () => {
    const quiet = { start: '09:00', end: '17:00' }
    expect(isQuietHour(quiet, at('2026-08-30T12:00:00'))).toBe(true)
    expect(isQuietHour(quiet, at('2026-08-30T08:00:00'))).toBe(false)
  })

  it('is never quiet when unset or malformed', () => {
    expect(isQuietHour(undefined, T0)).toBe(false)
    expect(isQuietHour({ start: 'nope', end: '07:00' }, T0)).toBe(false)
    expect(isQuietHour({ start: '25:00', end: '07:00' }, T0)).toBe(false)
    expect(isQuietHour({ start: '22:00', end: '22:00' }, T0)).toBe(false)
  })
})

describe('quotaThresholdCrossings', () => {
  const thresholds = [80, 95, 100]

  it('returns nothing when no line was crossed', () => {
    expect(quotaThresholdCrossings(70, 75, thresholds)).toEqual([])
    expect(quotaThresholdCrossings(96, 97, thresholds)).toEqual([])
  })

  it('returns the single line just crossed', () => {
    expect(quotaThresholdCrossings(75, 82, thresholds)).toEqual([80])
  })

  it('returns every line crossed in one jump', () => {
    expect(quotaThresholdCrossings(75, 97, thresholds)).toEqual([80, 95])
    expect(quotaThresholdCrossings(0, 100, thresholds)).toEqual([80, 95, 100])
  })

  it('reports nothing for a first reading, however high it is', () => {
    // We did not watch it cross 80 — we arrived after it had. Announcing
    // '80% 到達' here would report an event nobody observed.
    expect(quotaThresholdCrossings(null, 85, thresholds)).toEqual([])
    expect(quotaThresholdCrossings(null, 100, thresholds)).toEqual([])
    expect(quotaThresholdCrossings(NaN, 85, thresholds)).toEqual([])
  })

  it('resumes on the reading after the first', () => {
    // The baseline exists from the second reading on, so a genuine crossing
    // is still caught one interval later.
    expect(quotaThresholdCrossings(85, 96, thresholds)).toEqual([95])
  })

  it('treats an explicit 0 as a real baseline', () => {
    // null means 'unknown'; 0 means 'known to have started empty'.
    expect(quotaThresholdCrossings(0, 85, thresholds)).toEqual([80])
  })

  it('returns nothing when utilization falls', () => {
    expect(quotaThresholdCrossings(90, 40, thresholds)).toEqual([])
  })

  it('counts landing exactly on a threshold as crossing it', () => {
    expect(quotaThresholdCrossings(79, 80, thresholds)).toEqual([80])
  })

  it('survives a non-finite reading', () => {
    expect(quotaThresholdCrossings(50, NaN, thresholds)).toEqual([])
  })
})

describe('escalationDue', () => {
  const thresholds = [10 * MIN, 30 * MIN]

  it('says nothing before the first step', () => {
    expect(escalationDue('waiting_for_permission', T0, 0, thresholds, T0 + 9 * MIN)).toBeNull()
  })

  it('returns level 1 at the first step', () => {
    expect(escalationDue('waiting_for_permission', T0, 0, thresholds, T0 + 10 * MIN)).toBe(1)
  })

  it('returns level 2 at the second step', () => {
    expect(escalationDue('waiting_for_permission', T0, 1, thresholds, T0 + 30 * MIN)).toBe(2)
    expect(escalationDue('waiting_for_permission', T0, 1, thresholds, T0 + 29 * MIN)).toBeNull()
  })

  it('stops once every step has been sent', () => {
    expect(escalationDue('waiting_for_permission', T0, 2, thresholds, T0 + 10 * 60 * MIN)).toBeNull()
  })

  it('only escalates a permission wait', () => {
    for (const status of ['waiting_for_user', 'running', 'completed'] as const) {
      expect(escalationDue(status, T0, 0, thresholds, T0 + 60 * MIN)).toBeNull()
    }
  })
})

describe('formatSessionMessage', () => {
  const base = {
    status: 'waiting_for_permission' as const,
    lastEventKind: 'notification',
    device: '自宅PC',
    tool: 'claude-code',
    project: 'aiusage',
    statusSince: T0,
    now: T0 + 2 * MIN + 13_000,
  }

  it('matches the shape of the existing PowerShell notification', () => {
    const message = formatSessionMessage(base)!
    expect(message.title).toBe('[aiusage] 🟡 自宅PC｜Claude Code｜確認・入力待ち')
    expect(message.body).toContain('プロジェクト: aiusage')
    expect(message.body).toContain('待ち時間: 2分13秒')
  })

  it('reports working time on completion', () => {
    const message = formatSessionMessage({
      ...base, status: 'completed', lastEventKind: 'session_end', runningMs: 65 * MIN,
    })!
    expect(message.title).toContain('セッション終了')
    expect(message.body).toContain('作業時間: 1時間5分')
  })

  it('names the error type on an API-error turn', () => {
    const message = formatSessionMessage({
      ...base, status: 'waiting_for_user', lastEventKind: 'stop_failure', errorType: 'rate_limit',
    })!
    expect(message.title).toContain('処理エラー終了')
    expect(message.body).toContain('エラー種別: rate_limit')
  })

  it('marks an escalation in the title', () => {
    const message = formatSessionMessage({ ...base, escalationLevel: 2 })!
    expect(message.title).toContain('再通知2')
  })

  it('withholds the assistant reply unless asked for it', () => {
    const assistantMessage = 'the full text of what Claude said'
    expect(formatSessionMessage({ ...base, assistantMessage })!.body).not.toContain(assistantMessage)
    expect(formatSessionMessage({
      ...base, assistantMessage, config: { includeAssistantMessage: true },
    })!.body).toContain(assistantMessage)
  })

  it('never carries an absolute path', () => {
    const message = formatSessionMessage({ ...base, project: 'aiusage' })!
    expect(message.body).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//)
  })

  it('says nothing for a status with no label', () => {
    expect(formatSessionMessage({ ...base, status: 'running', lastEventKind: 'user_prompt' })).toBeNull()
  })

  it('stays under the Discord limit however long the detail is', () => {
    const message = formatSessionMessage({
      ...base,
      statusDetail: 'x'.repeat(5000),
      assistantMessage: 'y'.repeat(5000),
      config: { includeAssistantMessage: true },
    })!
    expect(renderDiscordContent(message).length).toBeLessThanOrEqual(DISCORD_MAX_BODY)
  })
})

describe('formatQuotaMessage', () => {
  const base = {
    kind: 'threshold' as const,
    device: '自宅PC',
    tool: 'codex',
    tier: 'five_hour',
    threshold: 80,
    utilization: 82.4,
    resetsAt: T0 + 63 * MIN,
    exhaustAt: T0 + 40 * MIN,
    confidence: 'high' as const,
    now: T0,
  }

  it('reads like the spec', () => {
    const message = formatQuotaMessage(base)
    expect(message.title).toBe('[aiusage] ⚠️ 自宅PC｜Codex｜5時間枠 80% 到達')
    expect(message.body).toContain('現在: 82.4%')
    expect(message.body).toContain('あと1時間3分')
    expect(message.body).toContain('頃に上限')
  })

  // Same reasoning as withholding paceRatio in the first 2 % of a window: a
  // projection from too little data should not be dressed up as a forecast.
  it('withholds the projection when confidence is low', () => {
    const message = formatQuotaMessage({ ...base, confidence: 'low' })
    expect(message.body).not.toContain('頃に上限')
    expect(message.body).toContain('現在: 82.4%')
  })

  it('omits the projection when there is none', () => {
    expect(formatQuotaMessage({ ...base, exhaustAt: null }).body).not.toContain('頃に上限')
  })

  it('renders a window reset', () => {
    const message = formatQuotaMessage({ ...base, kind: 'reset', utilization: 0 })
    expect(message.title).toContain('リセット')
    expect(message.body).toContain('現在: 0.0%')
  })

  it('stays under the Discord limit', () => {
    const message = formatQuotaMessage({ ...base, device: 'd'.repeat(4000) })
    expect(renderDiscordContent(message).length).toBeLessThanOrEqual(DISCORD_MAX_BODY)
  })
})

describe('formatting helpers', () => {
  it('renders durations the way the existing hook does', () => {
    expect(formatDurationJa(12_000)).toBe('12秒')
    expect(formatDurationJa(133_000)).toBe('2分13秒')
    expect(formatDurationJa(3_900_000)).toBe('1時間5分')
    expect(formatDurationJa(0)).toBe('1秒')
    expect(formatDurationJa(-5)).toBe('0秒')
    expect(formatDurationJa(NaN)).toBe('0秒')
  })

  it('gives tools and tiers readable names, passing unknowns through', () => {
    expect(toolDisplayName('claude-code')).toBe('Claude Code')
    expect(toolDisplayName('codex')).toBe('Codex')
    expect(toolDisplayName('made-up')).toBe('made-up')
    expect(tierDisplayName('five_hour')).toBe('5時間枠')
    expect(tierDisplayName('weekly_limit')).toBe('週次枠')
    expect(tierDisplayName('18000s')).toBe('18000s')
  })

  it('joins title and body into one capped string', () => {
    expect(renderDiscordContent({ title: 'a', body: 'b' })).toBe('a\nb')
    expect(renderDiscordContent({ title: 'a', body: '' })).toBe('a')
  })
})
