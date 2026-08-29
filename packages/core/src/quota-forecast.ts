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
  /** Timestamp of the first sample in the window */
  windowStartedAt: number
  /** Window reset time in ms, null when the upstream API did not report one */
  resetsAt: number | null
  /** How far through the window we are, 0–1. null when resetsAt is unknown. */
  elapsedRatio: number | null
  /** (utilization/100) ÷ elapsedRatio. >1 means burning faster than the window allows. */
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
const RECENT_WINDOW_MS = 30 * 60 * 1000

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

export function classifyRisk(
  current: number,
  paceRatio: number | null,
  exhaustBeforeReset: boolean,
  confidence: QuotaConfidence = 'high',
): QuotaRisk {
  if (isFiniteNumber(current) && current >= 95) return 'critical'
  if (exhaustBeforeReset && confidence !== 'low') return 'warn'
  if (paceRatio != null && isFiniteNumber(paceRatio) && paceRatio >= 1.3) return 'watch'
  return 'ok'
}

function classifyConfidence(samples: QuotaSample[]): QuotaConfidence {
  if (samples.length === 0) return 'low'
  const span = samples[samples.length - 1].ts - samples[0].ts
  if (samples.length >= 10 && span >= RECENT_WINDOW_MS) return 'high'
  if (samples.length >= 4) return 'medium'
  return 'low'
}

export function forecastQuota(
  samples: QuotaSample[],
  resetsAt: number | null,
  now: number,
): QuotaForecast {
  const clean = sanitize(samples)
  const reset = isFiniteNumber(resetsAt) ? resetsAt : null
  const nowMs = isFiniteNumber(now) ? now : 0

  if (clean.length === 0) {
    return {
      current: 0,
      windowStartedAt: nowMs,
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

  const windowStartedAt = clean[0].ts
  const current = clean[clean.length - 1].utilization
  const confidence = classifyConfidence(clean)

  // Elapsed ratio needs a window with positive length. A resetsAt already in
  // the past (upstream lag, or a sample taken across the boundary) clamps to 1.
  let elapsedRatio: number | null = null
  if (reset != null && reset > windowStartedAt) {
    const total = reset - windowStartedAt
    elapsedRatio = Math.min(1, Math.max(0, (nowMs - windowStartedAt) / total))
  }

  // At elapsedRatio 0 the ratio is unbounded, so leave it undefined rather
  // than reporting Infinity as a pace.
  const paceRatio =
    elapsedRatio != null && elapsedRatio > 0 ? current / 100 / elapsedRatio : null

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
