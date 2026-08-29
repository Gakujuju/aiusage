/**
 * Quota burn-rate forecasting.
 *
 * Pure functions over a series of utilization samples — no database, no
 * network, no clock of its own. `now` is always passed in so the caller
 * (API handler, notifier, test) controls time.
 *
 * The inputs come from an upstream API we do not control, so every function
 * here has to survive garbage: empty series, a single sample, timestamps that
 * go backwards, utilization that drops mid-window, NaN. Nothing throws.
 */

export interface QuotaSample {
  /** Observation time in ms since epoch */
  ts: number
  /** Utilization percentage 0–100 */
  utilization: number
}

export type QuotaRisk = 'ok' | 'watch' | 'warn' | 'critical'
export type QuotaConfidence = 'low' | 'medium' | 'high'

export interface QuotaForecast {
  /** Latest observed utilization */
  current: number
  /**
   * Start of the window: `resetsAt - windowDurationMs(tier)` where the tier's
   * length is known, otherwise the first sample we happen to hold.
   */
  windowStartedAt: number
  /** True when windowStartedAt was derived from resetsAt rather than observed */
  windowStartInferred: boolean
  /** Window reset time in ms, null when the upstream API did not report one */
  resetsAt: number | null
  /** How far through the window we are, 0–1. null when resetsAt is unknown. */
  elapsedRatio: number | null
  /**
   * (utilization/100) ÷ elapsedRatio. >1 means burning faster than the window
   * allows. null in the first 2 % of a window, where the divisor is too small
   * for the quotient to mean anything.
   */
  paceRatio: number | null
  /** Least-squares slope over the whole window, in percentage points per hour */
  burnRatePerHour: number
  /** Same, over the last 30 minutes only */
  recentBurnRatePerHour: number
  /** Projected time of hitting 100%, null when not on track to get there */
  exhaustAt: number | null
  /** Whether exhaustAt lands before the window resets */
  exhaustBeforeReset: boolean
  risk: QuotaRisk
  confidence: QuotaConfidence
}

const HOUR_MS = 3600000
const DAY_MS = 86400000
const RECENT_WINDOW_MS = 30 * 60 * 1000

/**
 * Below this much of the window elapsed, paceRatio is a division by almost
 * zero and reports nonsense (a freshly observed weekly window produced 41760).
 */
const MIN_ELAPSED_RATIO_FOR_PACE = 0.02

const WINDOW_DURATIONS: Record<string, number> = {
  five_hour: 5 * HOUR_MS,
  seven_day: 7 * DAY_MS,
  seven_day_opus: 7 * DAY_MS,
  seven_day_sonnet: 7 * DAY_MS,
  weekly_limit: 7 * DAY_MS,
  daily: 24 * HOUR_MS,
  daily_limit: 24 * HOUR_MS,
  monthly: 30 * DAY_MS,
}

/** Tier names the CLI synthesises for unrecognised windows, e.g. "18000s". */
const SECONDS_TIER = /^(\d+)s$/

/**
 * How long one window of this tier lasts, or null when we cannot know.
 *
 * Copilot's premium_interactions/chat have no fixed period we can name, and a
 * tier we have never seen is better treated as unknown than guessed at — the
 * callers all degrade gracefully on null.
 */
export function windowDurationMs(tier: string): number | null {
  if (typeof tier !== 'string') return null
  const known = WINDOW_DURATIONS[tier]
  if (known != null) return known

  // windowSecondsToTierName falls through to `${seconds}s` for windows it does
  // not recognise. Codex has only ever returned 5h/7d, but if it starts
  // reporting a daily or monthly window this keeps working instead of quietly
  // losing the duration.
  const match = SECONDS_TIER.exec(tier)
  if (match) {
    const seconds = Number(match[1])
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  }
  return null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Drop unusable samples and sort by time — upstream order is not guaranteed. */
function sanitize(samples: QuotaSample[]): QuotaSample[] {
  if (!Array.isArray(samples)) return []
  return samples
    .filter((s) => s != null && isFiniteNumber(s.ts) && isFiniteNumber(s.utilization))
    .map((s) => ({ ts: s.ts, utilization: s.utilization }))
    .sort((a, b) => a.ts - b.ts)
}

/**
 * Least-squares slope in percentage points per hour.
 *
 * Returns 0 rather than null for a degenerate fit (fewer than 2 points, or
 * every sample at the same instant) so callers can treat "no measurable burn"
 * and "flat burn" identically.
 */
function slopePerHour(samples: QuotaSample[]): number {
  if (samples.length < 2) return 0

  let sumX = 0
  let sumY = 0
  for (const s of samples) {
    sumX += s.ts
    sumY += s.utilization
  }
  const meanX = sumX / samples.length
  const meanY = sumY / samples.length

  let numerator = 0
  let denominator = 0
  for (const s of samples) {
    const dx = s.ts - meanX
    numerator += dx * (s.utilization - meanY)
    denominator += dx * dx
  }
  // All samples share a timestamp — no slope is defined.
  if (denominator === 0) return 0

  const perMs = numerator / denominator
  if (!Number.isFinite(perMs)) return 0
  return perMs * HOUR_MS
}

/**
 * Linear-interpolated percentile. `p` is 0–100 and clamped; out-of-range or
 * empty input yields NaN-free behaviour by returning 0 for an empty list.
 */
export function percentile(values: number[], p: number): number {
  const clean = (Array.isArray(values) ? values : []).filter(isFiniteNumber).sort((a, b) => a - b)
  if (clean.length === 0) return 0
  if (clean.length === 1) return clean[0]

  const ratio = Math.min(100, Math.max(0, isFiniteNumber(p) ? p : 0)) / 100
  const position = ratio * (clean.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return clean[lower]
  return clean[lower] + (clean[upper] - clean[lower]) * (position - lower)
}

/**
 * "Where does this window usually end up?" — the 90th percentile of past
 * windows' final utilization.
 *
 * Returns null below 4 closed windows: with fewer than that the percentile is
 * driven entirely by one outlier and would read as authoritative when it isn't.
 */
export function p90FinalUtilization(finals: number[]): number | null {
  const clean = (Array.isArray(finals) ? finals : []).filter(isFiniteNumber)
  if (clean.length < 4) return null
  return percentile(clean, 90)
}

/**
 * `critical` is not gated on confidence: a measured 95 % is a fact, however
 * few samples we hold. `warn` and `watch` are both projections, so both are
 * withheld until we have enough of a series to stand behind them.
 */
export function classifyRisk(
  current: number,
  paceRatio: number | null,
  exhaustBeforeReset: boolean,
  confidence: QuotaConfidence = 'high',
): QuotaRisk {
  if (isFiniteNumber(current) && current >= 95) return 'critical'
  if (exhaustBeforeReset && confidence !== 'low') return 'warn'
  if (paceRatio != null && isFiniteNumber(paceRatio) && paceRatio >= 1.3 && confidence !== 'low') return 'watch'
  return 'ok'
}

function classifyConfidence(samples: QuotaSample[]): QuotaConfidence {
  if (samples.length === 0) return 'low'
  const span = samples[samples.length - 1].ts - samples[0].ts
  if (samples.length >= 10 && span >= RECENT_WINDOW_MS) return 'high'
  if (samples.length >= 4) return 'medium'
  return 'low'
}

export interface ForecastQuotaInput {
  samples: QuotaSample[]
  /** Tier name, used to look up the window length */
  tier: string
  resetsAt: number | null
  now: number
}

export function forecastQuota(input: ForecastQuotaInput): QuotaForecast {
  const { samples, tier, resetsAt, now } = input ?? ({} as ForecastQuotaInput)
  const clean = sanitize(samples)
  const reset = isFiniteNumber(resetsAt) ? resetsAt : null
  const nowMs = isFiniteNumber(now) ? now : 0

  // Prefer the real window boundary over the first sample we happen to hold.
  // Starting the clock at first observation makes elapsedRatio ≈ 0 for any
  // window we joined late, which is most of them after a restart.
  const duration = windowDurationMs(tier)
  const inferredStart = duration != null && reset != null ? reset - duration : null

  if (clean.length === 0) {
    return {
      current: 0,
      windowStartedAt: inferredStart ?? nowMs,
      windowStartInferred: inferredStart != null,
      resetsAt: reset,
      elapsedRatio: null,
      paceRatio: null,
      burnRatePerHour: 0,
      recentBurnRatePerHour: 0,
      exhaustAt: null,
      exhaustBeforeReset: false,
      risk: 'ok',
      confidence: 'low',
    }
  }

  const windowStartedAt = inferredStart ?? clean[0].ts
  const current = clean[clean.length - 1].utilization
  const confidence = classifyConfidence(clean)

  // Elapsed ratio needs a window with positive length. A resetsAt already in
  // the past (upstream lag, or a sample taken across the boundary) clamps to 1.
  let elapsedRatio: number | null = null
  if (reset != null && reset > windowStartedAt) {
    const total = reset - windowStartedAt
    elapsedRatio = Math.min(1, Math.max(0, (nowMs - windowStartedAt) / total))
  }

  // Inferring the start fixes most of the near-zero divisors, but not all:
  // Codex reports a rolling "now + 5h" reset for an untouched window, which
  // keeps elapsedRatio pinned near 0 no matter how the start is derived. Below
  // 2 % elapsed the quotient is noise, so report no pace rather than a number
  // in the tens of thousands.
  const paceRatio =
    elapsedRatio != null && elapsedRatio >= MIN_ELAPSED_RATIO_FOR_PACE
      ? current / 100 / elapsedRatio
      : null

  const burnRatePerHour = slopePerHour(clean)

  const recentSamples = clean.filter((s) => s.ts >= nowMs - RECENT_WINDOW_MS)
  const recentBurnRatePerHour =
    recentSamples.length >= 2 ? slopePerHour(recentSamples) : burnRatePerHour

  // Project with the recent rate: a burst in the last half hour matters more
  // than the window average when the question is "will I run out".
  let exhaustAt: number | null = null
  if (recentBurnRatePerHour > 0 && current < 100) {
    const hoursLeft = (100 - current) / recentBurnRatePerHour
    const projected = nowMs + hoursLeft * HOUR_MS
    if (Number.isFinite(projected)) exhaustAt = projected
  }

  const exhaustBeforeReset = exhaustAt != null && reset != null && exhaustAt < reset

  return {
    current,
    windowStartedAt,
    windowStartInferred: inferredStart != null,
    resetsAt: reset,
    elapsedRatio,
    paceRatio,
    burnRatePerHour,
    recentBurnRatePerHour,
    exhaustAt,
    exhaustBeforeReset,
    risk: classifyRisk(current, paceRatio, exhaustBeforeReset, confidence),
    confidence,
  }
}
