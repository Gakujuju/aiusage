import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * Folding must not become a second display path.
 *
 * On 2026-09-02 the same window broke four times, and every time the cause
 * was one thing having two paths with only one of them fixed: an incomplete
 * payload on the success path, then the identical bug on the failure path, a
 * preload that could not load, and get-data returning null where the push
 * path sent a complete object.
 *
 * Folding is the fifth opportunity. A strip that renders its own subset of
 * the panel is exactly that shape, and the failure would be the worst kind:
 * a strip that is visible, therefore assumed working, and silently unable to
 * say that the hub is unreachable.
 *
 * So the strip is a display mode for the quota section, and every message is
 * drawn by one {#if} regardless. These tests read the markup and hold that
 * property, because it is a property of where the code is written and no
 * runtime assertion can see it.
 */
const app = readFileSync(join(__dirname, '..', 'src', 'renderer', 'App.svelte'), 'utf-8')

/** The blocks that must survive folding, by the expression that draws them. */
const MESSAGES = [
  // config.json is present and will not parse - the numbers may be about
  // another machine entirely.
  'data?.configProblem',
  // The bridge did not load, or onMount threw.
  '{#if fault}',
  // Nothing has arrived and nothing has gone wrong.
  'noDataYet',
  // Cannot reach the hub, or the hub refused the password.
  'data?.hubProblem',
]

describe('folding does not create a second display path', () => {
  it('draws every message outside any collapsed branch', () => {
    for (const message of MESSAGES) {
      const at = app.indexOf(message)
      expect(at, `${message} is not in App.svelte any more`).toBeGreaterThan(-1)

      // The section it lives in must not be gated on the fold. Looking at the
      // enclosing block start is enough: these all sit directly in .content.
      const enclosing = app.slice(Math.max(0, at - 400), at)
      expect(enclosing, `${message} appears to sit inside a collapsed branch`)
        .not.toMatch(/\{#if\s+(!?)collapsed\}[^]*$/)
    }
  })

  it('gates only the header, the settings panel and the legacy sections', () => {
    // Everything the fold is allowed to remove. If something is added to this
    // list, it should be because it genuinely cannot appear in a strip - not
    // because it was easier to hide.
    const allowed = [
      '{#if !collapsed}',              // the header
      'showSettings && settings && !collapsed',
      "settings?.showUsage && !collapsed",
      'settings?.showTokenBreakdown && data && !collapsed',
      'settings?.showHeatmap && data && !collapsed',
    ]
    for (const clause of allowed) {
      expect(app, `${clause} is no longer in App.svelte`).toContain(clause)
    }
  })

  it('keeps the quota section itself unconditional', () => {
    // The strip is this section in another mode, so the section may not be
    // wrapped in a fold check - only its contents change.
    const at = app.indexOf('{#if data?.quota}')
    expect(at).toBeGreaterThan(-1)
    const before = app.slice(Math.max(0, at - 200), at)
    expect(before).not.toContain('collapsed}')
  })

  it('asks QuotaPanel for meters only while folded', () => {
    // The strip's whole point is being small; percentages and countdowns are
    // what it exists not to show.
    expect(app).toContain("detail={collapsed ? 'meter' : (settings?.quotaDetail ?? 'full')}")
    expect(app).toContain('compact={collapsed}')
  })

  it('sends a floor measured for the state it just drew', () => {
    // Not a constant in main: main would need its own copy of "which state is
    // this", which is the same shape as the four failures above.
    expect(app).toContain('minHeight: measuredFloor()')
    expect(app).toMatch(/function measuredFloor\(\)/)
  })
})
