import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildTooltip,
  quotaView,
  formatRemaining,
  rowsFromApi,
  severity,
  shownRows,
  STALE_AFTER_MS,
  TOOLTIP_MAX,
} from '../src/quota'
import type { QuotaRow } from '../src/quota'
import { SEVERITY_COLOURS, tintBitmap } from '../src/tray-icon'

/**
 * A display nobody clicks on has one obligation: to be either right or
 * visibly not right. Every test here is about the second half of that.
 *
 * The rows used to come from a local database. They come from the hub over
 * HTTP now - no native binding, no ABI to match - so these build them
 * directly and the shape of the hub's answer is tested where it is parsed.
 */

const NOW = 1_700_000_000_000
let rows: QuotaRow[] = []

function reset(): void {
  rows = []
}

function insert(overrides: Partial<{
  tool: string; tier: string; utilization: number
  resets_at: number | null; ts: number; cred_status: string
}> = {}): void {
  const row = {
    tool: 'claude-code',
    tier: 'five_hour',
    utilization: 25,
    resets_at: NOW + 2 * 3600_000,
    ts: NOW,
    cred_status: 'valid',
    ...overrides,
  }
  rows.push({
    tool: row.tool,
    tier: row.tier,
    utilization: row.utilization,
    resetsAt: row.resets_at,
    credStatus: row.cred_status,
    ts: row.ts,
  })
}

/** Stands in for the old queryQuota(). */
function queryQuota(): QuotaRow[] {
  return rows
}

describe('the hub answer, flattened', () => {
  it('turns one tool with two tiers into two rows', () => {
    const parsed = rowsFromApi({
      quotas: [{
        tool: 'claude-code',
        credentialStatus: 'valid',
        lastSuccessAt: NOW,
        tiers: [
          { name: 'five_hour', utilization: 40, resetsAt: new Date(NOW + 3600_000).toISOString() },
          { name: 'seven_day', utilization: 12, resetsAt: null },
        ],
      }],
    })

    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual({
      tool: 'claude-code', tier: 'five_hour', utilization: 40,
      resetsAt: NOW + 3600_000, credStatus: 'valid', ts: NOW,
    })
    expect(parsed[1].resetsAt).toBeNull()
  })

  it('prefers when the numbers were last true to when they were last asked for', () => {
    // A poll that failed a second ago does not make a week-old number fresh.
    const [row] = rowsFromApi({
      quotas: [{ tool: 'codex', lastSuccessAt: NOW - 86_400_000, queriedAt: NOW, tiers: [{ name: 'five_hour', utilization: 1 }] }],
    })

    expect(row.ts).toBe(NOW - 86_400_000)
  })

  it('drops a row it cannot read rather than the whole answer', () => {
    // This arrives over a network from a machine that may be a version ahead.
    const parsed = rowsFromApi({
      quotas: [{
        tool: 'claude-code',
        tiers: [{ name: 'five_hour', utilization: 'lots' }, { name: 'seven_day', utilization: 3 }],
      }],
    })

    expect(parsed.map((r) => r.tier)).toEqual(['seven_day'])
  })

  it('says nothing at all when the answer is not the shape it expects', () => {
    for (const answer of [null, undefined, {}, { quotas: 'soon' }, []]) {
      expect(rowsFromApi(answer)).toEqual([])
    }
  })
})

describe('what the tray reads', () => {
  beforeEach(reset)

  it('shows the tiers both tools actually report', () => {
    // Read off production: the two tools do not agree on what a week is
    // called, and neither of them says "weekly" or "daily".
    insert({ tool: 'claude-code', tier: 'five_hour' })
    insert({ tool: 'claude-code', tier: 'seven_day' })
    insert({ tool: 'codex', tier: 'five_hour' })
    insert({ tool: 'codex', tier: 'weekly_limit' })

    expect(shownRows(queryQuota())).toHaveLength(4)
  })

  it('leaves out a tier that cannot say when it resets', () => {
    // nimbus_quill returns no resets_at, so half of what this display is
    // for cannot be shown for it. Half a row is worse than no row.
    insert({ tier: 'nimbus_quill', resets_at: null })

    expect(shownRows(queryQuota())).toEqual([])
  })
})

describe('what is left out, and why', () => {
  beforeEach(reset)

  it('names the tier rather than assuming which one it is', () => {
    // Derived from the data. Naming nimbus_quill here would mean the next
    // tier that arrives in the same state is dropped in silence, which is
    // the thing this exists to prevent.
    insert({ tier: 'nimbus_quill', resets_at: null })

    expect(quotaView(queryQuota(), NOW).hiddenTiers).toEqual([
      { tier: 'nimbus_quill', reason: 'no-reset-time' },
    ])
  })

  it('separates having no reset time from having no label', () => {
    insert({ tier: 'lunar_cycle', resets_at: null })
    insert({ tier: 'fortnight', resets_at: NOW + 1000 })

    const hidden = quotaView(queryQuota(), NOW).hiddenTiers

    expect(hidden.find((h) => h.tier === 'lunar_cycle')?.reason).toBe('no-reset-time')
    expect(hidden.find((h) => h.tier === 'fortnight')?.reason).toBe('unknown-tier')
  })

  it('has nothing to say when nothing was left out', () => {
    insert({ tier: 'five_hour' })

    expect(quotaView(queryQuota(), NOW).hiddenTiers).toEqual([])
  })
})

describe('the icon', () => {
  beforeEach(reset)

  it('is calm below the first threshold', () => {
    insert({ utilization: 69 })
    expect(severity(queryQuota())).toBe('ok')
  })

  it('warns at 70 and alarms at 90', () => {
    insert({ utilization: 70 })
    expect(severity(queryQuota())).toBe('warn')

    reset()
    insert({ utilization: 90 })
    expect(severity(queryQuota())).toBe('danger')
  })

  it('takes the worst of everything on the display', () => {
    // One window nearly gone is the thing worth seeing, whatever the others
    // are doing.
    insert({ tool: 'claude-code', tier: 'five_hour', utilization: 2 })
    insert({ tool: 'codex', tier: 'weekly_limit', utilization: 95 })

    expect(severity(queryQuota())).toBe('danger')
  })

  it('ignores a tier it does not show', () => {
    insert({ tier: 'nimbus_quill', utilization: 99, resets_at: null })
    expect(severity(queryQuota())).toBe('ok')
  })

  it('does not turn red because the reading is old', () => {
    // Stale is an absence of information, not an emergency. Colouring it the
    // same as "nearly out" would make the two indistinguishable, and only
    // one of them means stop working.
    insert({ utilization: 10, ts: NOW - 10 * STALE_AFTER_MS })
    expect(severity(queryQuota())).toBe('ok')
  })

  it('keeps the shape and replaces only the colour', () => {
    // Same glyph in three states, so a change reads as a change of state
    // rather than as a different program.
    const bgra = Buffer.from([
      0x00, 0x00, 0x00, 0x00, // transparent
      0xff, 0xff, 0xff, 0xff, // opaque white
      0x80, 0x80, 0x80, 0x40, // half-lit, partly transparent
    ])
    const tinted = tintBitmap(bgra, SEVERITY_COLOURS.danger)

    expect([...tinted.subarray(0, 4)]).toEqual([0, 0, 0, 0])
    expect(tinted[7]).toBe(0xff)
    expect(tinted[11]).toBe(0x40)
    expect(tinted[6]).toBe(SEVERITY_COLOURS.danger.r)
    expect(tinted).not.toBe(bgra)
  })
})

describe('the tooltip', () => {
  beforeEach(reset)

  it('puts both tiers of a tool on its own line', () => {
    insert({ tool: 'claude-code', tier: 'five_hour', utilization: 25, resets_at: NOW + 2 * 3600_000 + 36 * 60_000 })
    insert({ tool: 'claude-code', tier: 'seven_day', utilization: 49, resets_at: NOW + 3 * 86_400_000 })

    const [line] = buildTooltip(queryQuota(), NOW).split('\n')

    expect(line).toContain('Claude')
    expect(line).toContain('5h  25% (2h36m)')
    expect(line).toContain('週  49% (3d)')
  })

  it('says when a credential is not valid', () => {
    // This happened for real today. A resident display that keeps showing
    // the last good number through it is lying by omission.
    insert({ cred_status: 'expired' })

    expect(buildTooltip(queryQuota(), NOW)).toContain('credentials not valid')
  })

  it('says when the reading has stopped moving', () => {
    insert({ ts: NOW - 40 * 60_000 })

    expect(buildTooltip(queryQuota(), NOW)).toContain('not updating')
  })

  it('says nothing about age while the reading is fresh', () => {
    insert({ ts: NOW - STALE_AFTER_MS + 1000 })

    expect(buildTooltip(queryQuota(), NOW)).not.toContain('not updating')
  })

  it('puts the warnings above the numbers', () => {
    // Windows truncates a long tooltip without saying so, and what survives
    // is the beginning. The line saying the numbers are not to be trusted
    // has to be the part that survives.
    insert({ cred_status: 'expired', ts: NOW - 40 * 60_000 })

    const lines = buildTooltip(queryQuota(), NOW).split('\n')

    expect(lines[0]).toContain('credentials not valid')
    expect(lines[1]).toContain('not updating')
    expect(lines[2]).toContain('Claude')
  })

  it('stays inside what Windows will show', () => {
    for (const tool of ['claude-code', 'codex']) {
      insert({ tool, tier: 'five_hour', utilization: 100, resets_at: NOW + 4 * 3600_000 + 57 * 60_000 })
      insert({ tool, tier: tool === 'codex' ? 'weekly_limit' : 'seven_day', utilization: 100, resets_at: NOW + 6 * 86_400_000 })
    }

    expect(buildTooltip(queryQuota(), NOW).length).toBeLessThanOrEqual(TOOLTIP_MAX)
  })

  it('leaves out a countdown it cannot compute', () => {
    // Rather than deriving one from the window length, which would be a
    // guess wearing the clothes of a measurement.
    insert({ tier: 'weekly', resets_at: null })

    const text = buildTooltip(queryQuota(), NOW)

    expect(text).toContain('週')
    expect(text).not.toContain('(')
  })

  it('says so rather than showing an empty display', () => {
    expect(buildTooltip([], NOW)).toContain('no quota data')
  })
})

describe('time left', () => {
  it('reads the way someone glancing at it would', () => {
    expect(formatRemaining(2 * 3600_000 + 36 * 60_000)).toBe('2h36m')
    expect(formatRemaining(3 * 86_400_000)).toBe('3d')
    expect(formatRemaining(6 * 86_400_000 + 18 * 3600_000)).toBe('6d18h')
    expect(formatRemaining(45 * 60_000)).toBe('45m')
  })

  it('does not count backwards past zero', () => {
    expect(formatRemaining(-1)).toBe('now')
  })
})
