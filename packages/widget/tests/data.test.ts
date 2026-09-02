import { describe, it, expect } from 'vitest'
import { fetchWidgetData, rangeNameFor } from '../src/data'

/**
 * The usage sections, which are off by default and reachable from settings.
 *
 * They used to be SQL against the local database. With better-sqlite3 gone
 * they map two endpoints the hub already serves, so what is worth testing is
 * the mapping - especially what it does with an answer that is missing
 * things, since it now arrives from another machine.
 */

function hubReturning(byPath: Record<string, unknown>) {
  return {
    async get<T>(path: string): Promise<T> {
      if (!(path in byPath)) throw new Error(`unexpected path ${path}`)
      return byPath[path] as T
    },
  }
}

describe('which range to ask for', () => {
  it('picks the smallest window that covers the choice', () => {
    expect(rangeNameFor(1)).toBe('day')
    expect(rangeNameFor(7)).toBe('week')
    expect(rangeNameFor(30)).toBe('month')
  })

  it('over-covers rather than doing date arithmetic of its own', () => {
    // A widget whose totals disagree with the dashboard's by a day would be
    // worse than one showing a slightly wider window.
    expect(rangeNameFor(90)).toBe('all')
  })
})

describe('mapping the hub answer', () => {
  it('splits today from the range, and reads the breakdown', async () => {
    const hub = hubReturning({
      '/api/summary?range=day': {
        totalTokens: 100, inputTokens: 10, outputTokens: 20,
        cacheReadTokens: 30, cacheWriteTokens: 40, thinkingTokens: 0,
        totalCost: 1.5, totalSessions: 4,
      },
      '/api/summary?range=month': { totalTokens: 9000, totalCost: 42, byTool: { 'claude-code': 8000, codex: 2000 } },
      '/api/cost?range=month': { data: [{ date: '2026-09-01', tokens: 5, cost: 0.5 }], byModel: { 'opus-5': 30, 'sonnet-5': 10 } },
    })

    const data = await fetchWidgetData(hub, 30)

    expect(data.todayTokens).toEqual({ total: 100, input: 10, output: 20, cacheRead: 30, cacheWrite: 40, thinking: 0 })
    expect(data.todayCost).toBe(1.5)
    expect(data.sessionCountToday).toBe(4)
    expect(data.rangeTokens.total).toBe(9000)
    expect(data.rangeCost).toBe(42)
    expect(data.dailyHistory).toEqual([{ date: '2026-09-01', tokens: 5, cost: 0.5 }])
  })

  it('reports the largest share, as a fraction of the whole', async () => {
    const hub = hubReturning({
      '/api/summary?range=day': {},
      '/api/summary?range=week': { byTool: { 'claude-code': 3, codex: 1 } },
      '/api/cost?range=week': { byModel: { 'opus-5': 30, 'sonnet-5': 10 } },
    })

    const data = await fetchWidgetData(hub, 7)

    expect(data.topTool).toEqual({ name: 'claude-code', share: 0.75 })
    expect(data.topModel).toEqual({ name: 'opus-5', share: 0.75 })
  })

  it('shows zero rather than NaN when a field is missing', async () => {
    // The hub may be a version ahead or behind. A blank figure is readable;
    // NaN in a panel is a bug report.
    const hub = hubReturning({
      '/api/summary?range=day': {},
      '/api/summary?range=month': {},
      '/api/cost?range=month': {},
    })

    const data = await fetchWidgetData(hub, 30)

    expect(data.todayTokens.total).toBe(0)
    expect(data.rangeCost).toBe(0)
    expect(data.topModel).toBeNull()
    expect(data.topTool).toBeNull()
    expect(data.dailyHistory).toEqual([])
  })
})
