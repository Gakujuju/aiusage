import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A figure on screen is the figure that was fetched.
 *
 * The four headline numbers on the home page used to be tweened stores that
 * restarted from zero on every load and took up to 2.6 seconds to arrive,
 * while the breakdown beside them rendered its final value immediately. For
 * those seconds the page showed a total that was in no database. Twice
 * someone photographed one and reported it as the total falling, and each
 * time it cost an evening to establish that nothing had been lost.
 *
 * Checked at the source rather than by sampling a rendered page, which is
 * how the rest of this suite works and is the stronger claim of the two:
 * sampling can only show that no divergence was caught at the instants
 * sampled, whereas an interpolation straight from the response has no
 * intermediate state to catch.
 */

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const home = src('../src/routes/+page.svelte')

/** Every .svelte and .js under src, for the repo-wide check below. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.(svelte|js|ts)$/.test(entry) ? [full] : []
  })
}

describe('the home page shows the numbers it was given', () => {
  it('renders the total from the response, not from an animated store', () => {
    expect(home).toContain('{fmtMain(data.totalTokens)}')
  })

  it('renders cost, sessions and days from the response too', () => {
    // All four were tweened. Fixing only the loudest one would leave the
    // same trap under the other three.
    expect(home).toContain('formatCost(data?.totalCost ?? 0)')
    expect(home).toContain('{(data.totalSessions || 0).toLocaleString()}')
    expect(home).toContain('{(data.activeDays || 0).toLocaleString()}')
  })

  it('has no tweened or spring store left on the page', () => {
    expect(home).not.toMatch(/\btweened\s*\(/)
    expect(home).not.toMatch(/\bspring\s*\(/)
    expect(home).not.toContain('svelte/motion')
  })

  it('does not reset a displayed figure to zero while loading', () => {
    // loadData() used to snap all four to 0 before fetching, which is what
    // made a mid-load screenshot show a number far below the truth.
    expect(home).not.toMatch(/t(Tokens|Cost|Sessions|Days)\.set\(0/)
  })

  it('animates the entrance in CSS, where it cannot misreport a value', () => {
    expect(home).toContain('.counter-number.revealed')
    // Opacity and position only. Nothing here can change a digit.
    const rule = home.match(/\.counter-number\.revealed\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/opacity/)
    expect(rule).not.toMatch(/content|counter-increment/)
  })

  it('lets a reader who asked for less motion opt out', () => {
    // The count-up honoured no such preference; a CSS transition can.
    expect(home).toContain('prefers-reduced-motion')
  })

  /**
   * The total and the breakdown disagreed because they came from different
   * places. They must keep coming from the same object.
   */
  it('takes the total and the breakdown from the same response object', () => {
    expect(home).toContain('{fmtMain(data.totalTokens)}')
    expect(home).toContain('{fmtShort(data.inputTokens)}')
    expect(home).toContain('{fmtShort(data.outputTokens)}')
  })
})

describe('no other screen animates a number', () => {
  it('has no numeric tween anywhere under src', () => {
    const offenders = walk(fileURLToPath(new URL('../src', import.meta.url)))
      .filter((f) => /svelte\/motion|\btweened\s*\(|\bspring\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(/\\/g, '/').split('/src/')[1])

    expect(offenders).toEqual([])
  })
})
