import { describe, it, expect } from 'vitest'
import {
  forecastQuota,
  percentile,
  p90FinalUtilization,
  classifyRisk,
  windowDurationMs,
  type QuotaSample,
} from '../src/quota-forecast.js'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Samples every `stepMin` minutes rising by `stepPct` each time. */
function ramp(startTs: number, count: number, stepMin: number, startPct: number, stepPct: number): QuotaSample[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: startTs + i * stepMin * MIN,
    utilization: startPct + i * stepPct,
  }))
}

describe('forecastQuota — degenerate inputs', () => {
  const now = 1_000_000_000_000

  it('returns a neutral forecast for zero samples', () => {
    const f = forecastQuota({ samples: [], tier: 'five_hour', resetsAt: now + HOUR, now })
    expect(f.current).toBe(0)
    expect(f.burnRatePerHour).toBe(0)
    expect(f.recentBurnRatePerHour).toBe(0)
    expect(f.exhaustAt).toBeNull()
    expect(f.exhaustBeforeReset).toBe(false)
    expect(f.risk).toBe('ok')
    expect(f.confidence).toBe('low')
  })

  it('reports the value but no burn rate for a single sample', () => {
    // 'chat' has no known duration, so the start stays at first observation.
    const f = forecastQuota({ samples: [{ ts: now, utilization: 42 }], tier: 'chat', resetsAt: now + HOUR, now })
    expect(f.current).toBe(42)
    expect(f.windowStartedAt).toBe(now)
    expect(f.burnRatePerHour).toBe(0)
    expect(f.exhaustAt).toBeNull()
    expect(f.confidence).toBe('low')
  })

  it('sorts samples that arrive with reversed timestamps', () => {
    const samples: QuotaSample[] = [
      { ts: now, utilization: 20 },
      { ts: now - HOUR, utilization: 10 },
    ]
    const f = forecastQuota({ samples: samples, tier: 'five_hour', resetsAt: null, now })
    expect(f.windowStartedAt).toBe(now - HOUR)
    expect(f.current).toBe(20)
    expect(f.burnRatePerHour).toBeCloseTo(10, 6)
  })

  it('drops non-finite samples instead of poisoning the fit', () => {
    const samples = [
      { ts: now - HOUR, utilization: 10 },
      { ts: NaN, utilization: 50 },
      { ts: now, utilization: Infinity },
      { ts: now, utilization: 20 },
    ] as QuotaSample[]
    const f = forecastQuota({ samples: samples, tier: 'five_hour', resetsAt: null, now })
    expect(f.current).toBe(20)
    expect(Number.isFinite(f.burnRatePerHour)).toBe(true)
  })

  it('treats every-sample-at-the-same-instant as no burn', () => {
    const samples: QuotaSample[] = [
      { ts: now, utilization: 10 },
      { ts: now, utilization: 30 },
    ]
    const f = forecastQuota({ samples: samples, tier: 'five_hour', resetsAt: null, now })
    expect(f.burnRatePerHour).toBe(0)
    expect(f.exhaustAt).toBeNull()
  })

  it('produces no exhaustion estimate when utilization decreases', () => {
    const samples = ramp(now - 2 * HOUR, 5, 30, 60, -5)
    const f = forecastQuota({ samples: samples, tier: 'five_hour', resetsAt: now + HOUR, now })
    expect(f.burnRatePerHour).toBeLessThan(0)
    expect(f.exhaustAt).toBeNull()
    expect(f.exhaustBeforeReset).toBe(false)
  })

  it('leaves elapsedRatio and paceRatio null when resetsAt is unknown', () => {
    const f = forecastQuota({ samples: ramp(now - HOUR, 3, 30, 10, 5), tier: 'five_hour', resetsAt: null, now })
    expect(f.resetsAt).toBeNull()
    expect(f.elapsedRatio).toBeNull()
    expect(f.paceRatio).toBeNull()
  })

  it('leaves elapsedRatio null when resetsAt is not after the window start', () => {
    const samples = ramp(now - HOUR, 3, 30, 10, 5)
    // Unknown tier, so the start is the first sample — which here is after the
    // reset. A known tier cannot reach this state, its start is derived.
    const f = forecastQuota({ samples: samples, tier: 'chat', resetsAt: now - 2 * HOUR, now })
    expect(f.elapsedRatio).toBeNull()
    expect(f.paceRatio).toBeNull()
  })
})

describe('forecastQuota — burn rate arithmetic', () => {
  const now = 1_000_000_000_000

  it('recovers an exact linear slope', () => {
    // 0,10,20,30,40 % over four 30-minute steps = 20 %/h.
    const samples = ramp(now - 2 * HOUR, 5, 30, 0, 10)
    const f = forecastQuota({ samples: samples, tier: 'five_hour', resetsAt: null, now })
    expect(f.burnRatePerHour).toBeCloseTo(20, 9)
    expect(f.current).toBe(40)
  })

  it('uses only the last 30 minutes for the recent rate', () => {
    // Flat for two hours, then 10 points climbing 1 %/6min = 10 %/h.
    const flat: QuotaSample[] = Array.from({ length: 5 }, (_, i) => ({
      ts: now - 2 * HOUR + i * 15 * MIN,
      utilization: 10,
    }))
    const recent: QuotaSample[] = Array.from({ length: 6 }, (_, i) => ({
      ts: now - 30 * MIN + i * 6 * MIN,
      utilization: 10 + i,
    }))
    const f = forecastQuota({ samples: [...flat, ...recent], tier: 'five_hour', resetsAt: null, now })
    expect(f.recentBurnRatePerHour).toBeCloseTo(10, 6)
    expect(f.recentBurnRatePerHour).toBeGreaterThan(f.burnRatePerHour)
  })

  it('falls back to the window rate with fewer than 2 recent samples', () => {
    // Only the final sample lands inside the 30-minute recent window.
    const samples = ramp(now - 4 * HOUR, 5, 60, 0, 10)
    const f = forecastQuota({ samples: samples, tier: 'five_hour', resetsAt: null, now })
    expect(f.burnRatePerHour).toBeCloseTo(10, 9)
    expect(f.recentBurnRatePerHour).toBe(f.burnRatePerHour)
  })

  it('projects exhaustAt from the recent rate', () => {
    // current 40 %, recent rate 20 %/h → 3 hours of headroom.
    const samples = ramp(now - 2 * HOUR, 5, 30, 0, 10)
    const f = forecastQuota({ samples: samples, tier: 'five_hour', resetsAt: null, now })
    expect(f.recentBurnRatePerHour).toBeCloseTo(20, 9)
    expect(f.exhaustAt).not.toBeNull()
    expect(f.exhaustAt! - now).toBeCloseTo(3 * HOUR, 0)
  })

  it('reports exhaustBeforeReset=false when the reset comes first', () => {
    const samples = ramp(now - 2 * HOUR, 5, 30, 0, 10) // exhausts in 3h
    const f = forecastQuota({ samples: samples, tier: 'five_hour', resetsAt: now + HOUR, now }) // resets in 1h
    expect(f.exhaustAt).not.toBeNull()
    expect(f.exhaustAt!).toBeGreaterThan(now + HOUR)
    expect(f.exhaustBeforeReset).toBe(false)
  })

  it('reports exhaustBeforeReset=true when exhaustion comes first', () => {
    const samples = ramp(now - 2 * HOUR, 5, 30, 0, 10) // exhausts in 3h
    const f = forecastQuota({ samples: samples, tier: 'five_hour', resetsAt: now + 6 * HOUR, now })
    expect(f.exhaustBeforeReset).toBe(true)
  })

  it('computes elapsedRatio and paceRatio against the observed window', () => {
    // Unknown tier: window runs from the first sample to the reset — 4h long,
    // we are 2h in (half), at 80 % → pace 1.6.
    const samples = ramp(now - 2 * HOUR, 5, 30, 40, 10)
    const f = forecastQuota({ samples: samples, tier: 'chat', resetsAt: now + 2 * HOUR, now })
    expect(f.windowStartInferred).toBe(false)
    expect(f.elapsedRatio).toBeCloseTo(0.5, 9)
    expect(f.paceRatio).toBeCloseTo(1.6, 9)
  })

  it('computes elapsedRatio against the inferred window for a known tier', () => {
    // five_hour resetting in 2h started 3h ago, whatever we happened to observe.
    const samples = ramp(now - 30 * MIN, 5, 5, 40, 10)
    const f = forecastQuota({ samples: samples, tier: 'five_hour', resetsAt: now + 2 * HOUR, now })
    expect(f.windowStartInferred).toBe(true)
    expect(f.windowStartedAt).toBe(now + 2 * HOUR - 5 * HOUR)
    expect(f.elapsedRatio).toBeCloseTo(0.6, 9)
    expect(f.paceRatio).toBeCloseTo(0.8 / 0.6, 9)
  })

  it('clamps elapsedRatio to 1 once the reset time has passed', () => {
    const samples = ramp(now - 4 * HOUR, 5, 60, 10, 5)
    const f = forecastQuota({ samples: samples, tier: 'five_hour', resetsAt: now - HOUR, now })
    expect(f.elapsedRatio).toBe(1)
  })
})

describe('forecastQuota — confidence', () => {
  const now = 1_000_000_000_000

  it('is high with 10+ samples spanning at least 30 minutes', () => {
    const f = forecastQuota({ samples: ramp(now - 90 * MIN, 10, 10, 0, 1), tier: 'five_hour', resetsAt: null, now })
    expect(f.confidence).toBe('high')
  })

  it('is medium with 4 samples', () => {
    const f = forecastQuota({ samples: ramp(now - 90 * MIN, 4, 30, 0, 1), tier: 'five_hour', resetsAt: null, now })
    expect(f.confidence).toBe('medium')
  })

  it('is medium when 10 samples span under 30 minutes', () => {
    const f = forecastQuota({ samples: ramp(now - 9 * MIN, 10, 1, 0, 1), tier: 'five_hour', resetsAt: null, now })
    expect(f.confidence).toBe('medium')
  })

  it('is low with fewer than 4 samples', () => {
    const f = forecastQuota({ samples: ramp(now - HOUR, 3, 30, 0, 1), tier: 'five_hour', resetsAt: null, now })
    expect(f.confidence).toBe('low')
  })
})

describe('windowDurationMs', () => {
  it('knows the Claude tiers', () => {
    expect(windowDurationMs('five_hour')).toBe(5 * HOUR)
    expect(windowDurationMs('seven_day')).toBe(7 * DAY)
    expect(windowDurationMs('seven_day_opus')).toBe(7 * DAY)
    expect(windowDurationMs('seven_day_sonnet')).toBe(7 * DAY)
  })

  it('knows the Codex tiers', () => {
    expect(windowDurationMs('weekly_limit')).toBe(7 * DAY)
  })

  it('knows the daily and monthly tiers', () => {
    expect(windowDurationMs('daily')).toBe(24 * HOUR)
    expect(windowDurationMs('daily_limit')).toBe(24 * HOUR)
    expect(windowDurationMs('monthly')).toBe(30 * DAY)
  })

  it('parses the synthesised `${seconds}s` tier name', () => {
    expect(windowDurationMs('18000s')).toBe(18000 * 1000)
    expect(windowDurationMs('604800s')).toBe(604800 * 1000)
  })

  it('returns null for the Copilot tiers and anything unrecognised', () => {
    expect(windowDurationMs('premium_interactions')).toBeNull()
    expect(windowDurationMs('chat')).toBeNull()
    expect(windowDurationMs('unknown')).toBeNull()
    expect(windowDurationMs('')).toBeNull()
  })

  it('rejects malformed seconds tiers instead of guessing', () => {
    expect(windowDurationMs('0s')).toBeNull()
    expect(windowDurationMs('12.5s')).toBeNull()
    expect(windowDurationMs('s')).toBeNull()
    expect(windowDurationMs('abc18000s')).toBeNull()
    expect(windowDurationMs(undefined as unknown as string)).toBeNull()
  })
})

describe('forecastQuota — window start inference', () => {
  const now = 1_000_000_000_000

  it('derives the start from resetsAt for a known tier', () => {
    const f = forecastQuota({
      samples: [{ ts: now - MIN, utilization: 10 }],
      tier: 'weekly_limit',
      resetsAt: now + 2 * DAY,
      now,
    })
    expect(f.windowStartInferred).toBe(true)
    expect(f.windowStartedAt).toBe(now + 2 * DAY - 7 * DAY)
  })

  it('falls back to the first sample when resetsAt is null', () => {
    const f = forecastQuota({
      samples: ramp(now - HOUR, 3, 30, 10, 5),
      tier: 'five_hour',
      resetsAt: null,
      now,
    })
    expect(f.windowStartInferred).toBe(false)
    expect(f.windowStartedAt).toBe(now - HOUR)
  })

  it('falls back to the first sample for an unknown tier', () => {
    const f = forecastQuota({
      samples: ramp(now - HOUR, 3, 30, 10, 5),
      tier: 'premium_interactions',
      resetsAt: now + HOUR,
      now,
    })
    expect(f.windowStartInferred).toBe(false)
    expect(f.windowStartedAt).toBe(now - HOUR)
  })

  it('infers the start even with no samples at all', () => {
    const f = forecastQuota({ samples: [], tier: 'five_hour', resetsAt: now + HOUR, now })
    expect(f.windowStartInferred).toBe(true)
    expect(f.windowStartedAt).toBe(now + HOUR - 5 * HOUR)
  })
})

describe('forecastQuota — paceRatio safety valve', () => {
  const now = 1_000_000_000_000

  // Regression for the live observation on 2026-08-29: a weekly window first
  // seen seconds ago reported paceRatio 41760 and risk 'watch'.
  it('reports no pace for a weekly window observed for the first time', () => {
    const f = forecastQuota({
      samples: [{ ts: now - 6000, utilization: 54 }, { ts: now, utilization: 54 }],
      tier: 'weekly_limit',
      // Codex reports the reset a full window away while nothing is consumed,
      // which pins elapsedRatio at ~0 however the start is derived.
      resetsAt: now + 7 * DAY,
      now,
    })
    expect(f.current).toBe(54)
    expect(f.elapsedRatio).toBeLessThan(0.02)
    expect(f.paceRatio).toBeNull()
    expect(f.risk).toBe('ok')
  })

  it('suppresses the pace at 1.9 % elapsed and reports it at 2 %', () => {
    const duration = 5 * HOUR
    const at = (ratio: number) => {
      const start = now - duration * ratio
      return forecastQuota({
        samples: [{ ts: start, utilization: 0 }, { ts: now, utilization: 50 }],
        tier: 'five_hour',
        resetsAt: start + duration,
        now,
      })
    }

    const below = at(0.019)
    expect(below.elapsedRatio).toBeCloseTo(0.019, 9)
    expect(below.paceRatio).toBeNull()

    const boundary = at(0.02)
    expect(boundary.elapsedRatio).toBeCloseTo(0.02, 9)
    expect(boundary.paceRatio).toBeCloseTo(0.5 / 0.02, 6)
  })

  it('still reports a pace once the window is genuinely under way', () => {
    const f = forecastQuota({
      samples: ramp(now - 2 * HOUR, 5, 30, 40, 10),
      tier: 'five_hour',
      resetsAt: now + 2 * HOUR,
      now,
    })
    expect(f.paceRatio).not.toBeNull()
  })
})

describe('classifyRisk', () => {
  it('is critical at or above 95 %, whatever the pace', () => {
    expect(classifyRisk(95, null, false)).toBe('critical')
    expect(classifyRisk(99.5, 0.1, false)).toBe('critical')
  })

  it('is warn when exhaustion precedes the reset and confidence is not low', () => {
    expect(classifyRisk(50, 1.0, true, 'medium')).toBe('warn')
    expect(classifyRisk(50, 1.0, true, 'high')).toBe('warn')
  })

  it('does not escalate to warn on a low-confidence projection', () => {
    expect(classifyRisk(50, 1.0, true, 'low')).toBe('ok')
  })

  it('is watch at a pace of 1.3 or more', () => {
    expect(classifyRisk(50, 1.3, false)).toBe('watch')
    expect(classifyRisk(50, 1.29, false)).toBe('ok')
  })

  it('does not escalate to watch on a low-confidence pace', () => {
    expect(classifyRisk(50, 5, false, 'low')).toBe('ok')
    expect(classifyRisk(50, 5, false, 'medium')).toBe('watch')
  })

  it('is critical at 96 % even with low confidence', () => {
    expect(classifyRisk(96, null, false, 'low')).toBe('critical')
  })

  it('is ok below every threshold', () => {
    expect(classifyRisk(94.9, 1.29, false)).toBe('ok')
    expect(classifyRisk(0, null, false)).toBe('ok')
  })

  it('prefers critical over warn and watch', () => {
    expect(classifyRisk(96, 5, true, 'high')).toBe('critical')
  })

  it('prefers warn over watch', () => {
    expect(classifyRisk(50, 5, true, 'high')).toBe('warn')
  })
})

describe('percentile', () => {
  it('returns 0 for an empty list', () => {
    expect(percentile([], 90)).toBe(0)
  })

  it('returns the only value for a single-element list', () => {
    expect(percentile([42], 90)).toBe(42)
  })

  it('interpolates between neighbours', () => {
    // position = 0.9 * 9 = 8.1 → 90 + 0.1 * 10 = 91
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90)).toBeCloseTo(91, 9)
  })

  it('handles the 0th and 100th percentile', () => {
    expect(percentile([5, 1, 9], 0)).toBe(1)
    expect(percentile([5, 1, 9], 100)).toBe(9)
  })

  it('clamps out-of-range percentiles', () => {
    expect(percentile([1, 2, 3], -50)).toBe(1)
    expect(percentile([1, 2, 3], 500)).toBe(3)
  })

  it('ignores non-finite values', () => {
    expect(percentile([1, NaN, 3, Infinity], 50)).toBe(2)
  })
})

describe('p90FinalUtilization', () => {
  it('returns null below 4 closed windows', () => {
    expect(p90FinalUtilization([])).toBeNull()
    expect(p90FinalUtilization([80, 90, 95])).toBeNull()
  })

  it('returns the 90th percentile at 4 windows', () => {
    // position = 0.9 * 3 = 2.7 → 90 + 0.7 * 5 = 93.5
    expect(p90FinalUtilization([70, 80, 90, 95])).toBeCloseTo(93.5, 9)
  })

  it('ignores non-finite finals when counting toward the minimum', () => {
    expect(p90FinalUtilization([70, 80, 90, NaN])).toBeNull()
  })
})
