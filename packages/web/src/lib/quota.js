/**
 * How a quota is named, coloured and counted down - in one place.
 *
 * These used to live inside the quotas page. The home page now draws the
 * same cards, and a second copy of "90 is red, 70 is orange" is a copy that
 * gets changed on one side and not the other. Everything here is a pure
 * function; the translator is passed in rather than imported, so the same
 * code serves a component (with $t) and anything without a store.
 */

export const TIER_LABEL_KEYS = {
  five_hour: 'quotas.fiveHour',
  seven_day: 'quotas.sevenDay',
  seven_day_opus: 'quotas.sevenDayOpus',
  seven_day_sonnet: 'quotas.sevenDaySonnet',
  seven_day_omelette: 'quotas.sevenDayOmelette',
  weekly_limit: 'quotas.weeklyLimit',
}

export const TOOL_LABEL_KEYS = {
  'claude-code': 'quotas.toolLabels.claude-code',
  codex: 'quotas.toolLabels.codex',
}

/**
 * Fallback for a tier the translations do not know.
 * "seven_day_omelette" -> "7d Omelette", "five_hour" -> "5h".
 */
export function formatUnknownTier(name) {
  return String(name)
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .replace(/^Five Hour/i, '5h')
    .replace(/^Seven Day/i, '7d')
    .replace(/^Weekly Limit/i, 'Weekly')
}

/** @param {(key: string) => string} t */
export function tierLabel(name, t) {
  const key = TIER_LABEL_KEYS[name]
  return key ? t(key) : formatUnknownTier(name)
}

/** @param {(key: string) => string} t */
export function toolLabel(tool, t) {
  const key = TOOL_LABEL_KEYS[tool]
  return key ? t(key) : tool
}

/*
 * 70 and 90 are the same two numbers the widget's tray uses, and as there,
 * they were chosen by looking rather than measured. If one of them moves,
 * the other side should move with it.
 */
export function utilizationColor(pct) {
  if (pct >= 90) return 'red'
  if (pct >= 70) return 'orange'
  return 'green'
}

export function utilizationBarColor(pct) {
  if (pct >= 90) return 'var(--rose)'
  if (pct >= 70) return 'var(--warn-solid)'
  return 'var(--green)'
}

/**
 * "2d 5h", "3h 12m", "45m" - or null when there is no reset or it has passed.
 * @param {string | number | null | undefined} resetsAt
 * @param {number} [now]
 */
export function countdownStr(resetsAt, now = Date.now()) {
  if (!resetsAt) return null
  const diffMs = new Date(resetsAt).getTime() - now
  if (!Number.isFinite(diffMs) || diffMs <= 0) return null
  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
  if (hours > 24) {
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
  }
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** @param {(key: string) => string} t */
export function formatQueryTime(ms, t) {
  if (!ms) return t('quotas.never')
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Whether a forecast is worth showing as numbers.
 *
 * 'low' means too few samples, or samples too far apart, to say anything -
 * the same reason quotaThresholdCrossings reports nothing without a
 * baseline. A pace and an exhaustion time carry more authority than
 * anything else on the page, so they are the first things withheld.
 */
export function isTrusted(f) {
  return f != null && f.confidence !== 'low'
}

/**
 * null when there is nothing to say - 'ok' is the quiet default.
 * @param {(key: string) => string} t
 */
export function riskLabel(risk, t) {
  if (!risk || risk === 'ok') return null
  return t(`quotas.forecast.risk.${risk}`)
}
