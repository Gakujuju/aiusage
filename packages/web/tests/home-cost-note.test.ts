import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A total that is short never appears on its own.
 *
 * The home page's cost is missing whatever could not be priced — models with
 * no published rate, and rows whose logs gave no token split. That was said
 * in two full-width boxes at the top of the page, which put an explanation
 * nobody can act on above and larger than the figure it explains, and took a
 * third of a phone screen to do it.
 *
 * The rule this file keeps is the one the whole effort has been about: the
 * explanation sits next to the thing it explains. The note now lives in the
 * cost tile, and the warning that can be acted on stays at the top, because
 * that one goes away when it is dealt with.
 */

const home = readFileSync(
  fileURLToPath(new URL('../src/routes/+page.svelte', import.meta.url)), 'utf8')

/** The markup of the tile holding the total cost. */
const costTile = (() => {
  const at = home.indexOf("{$t('overview.totalCost')}")
  if (at < 0) throw new Error('cost tile not found')
  const start = home.lastIndexOf('<div class="stat-block">', at)
  const end = home.indexOf('</div>', home.indexOf('{#if uncostedRecords', at))
  return home.slice(start, end > 0 ? end : at + 800)
})()

describe('the home total says when it is short', () => {
  it('puts the note inside the cost tile', () => {
    expect(costTile).toContain('formattedCost')
    expect(costTile).toContain('uncostedRecords > 0')
    expect(costTile).toContain('stat-note')
  })

  it('counts both reasons a cost could not be worked out', () => {
    // Either one alone would let the total look complete when it is not.
    expect(home).toContain('acknowledgedUnpricedRecords ?? 0')
    expect(home).toContain('breakdownMissingRecords ?? 0')
    expect(home).toMatch(/uncostedRecords\s*=\s*\(data\?\.acknowledgedUnpricedRecords[^\n]*\n\s*\+\s*\(data\?\.breakdownMissingRecords/)
  })

  it('keeps a way through to the reasons', () => {
    // Summing them is only acceptable because the detail is still reachable.
    expect(costTile).toContain('href="/cost"')
    expect(costTile).toContain('uncostedDetail')
  })

  it('stops repeating the quiet lines at the top of the page', () => {
    expect(home).toContain('showQuiet={false}')
  })

  it('still shows the warning that can be acted on at the top', () => {
    // Red is not moved. It is temporary and it is actionable, which is
    // exactly what earns a banner.
    expect(home).toContain('<CostCaveats')
    expect(home).toContain('unpricedRecords={data?.unpricedRecords ?? 0}')
  })
})

describe('the other screens keep the fuller form', () => {
  const read = (p: string) =>
    readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

  it('leaves /cost, /models, /sessions and /projects showing both lines', () => {
    // Those pages are about the figures the lines qualify, and the rows being
    // described are on the same screen.
    for (const p of ['../src/routes/cost/+page.svelte',
                     '../src/routes/models/+page.svelte',
                     '../src/routes/sessions/+page.svelte',
                     '../src/routes/projects/+page.svelte']) {
      expect(read(p)).not.toContain('showQuiet={false}')
    }
  })
})
