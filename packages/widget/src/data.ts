/**
 * The usage figures, from the hub rather than from the file next door.
 *
 * These are the sections this widget used to be made of - today's tokens,
 * the range total, the breakdown, the trend, the top model and tool. They
 * are off by default now and reachable from settings, and they were kept
 * rather than deleted because "not looked at" is not "not wanted".
 *
 * Keeping them meant they had to move too: with better-sqlite3 gone there is
 * no local database to read. Everything here maps two endpoints the hub
 * already serves onto the shape the panel was written against.
 */

export interface TodayTokens {
  total: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  thinking: number
}

export interface DailyEntry {
  date: string
  tokens: number
  cost: number
}

export interface WidgetData {
  todayTokens: TodayTokens
  todayCost: number
  rangeTokens: { total: number }
  rangeCost: number
  rangeDays: number
  topModel: { name: string; share: number } | null
  topTool: { name: string; share: number } | null
  dailyHistory: DailyEntry[]
  sessionCountToday: number
  lastUpdated: number
}

interface SummaryResponse {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  thinkingTokens?: number
  totalTokens?: number
  totalCost?: number
  totalSessions?: number
  byTool?: Record<string, number>
}

interface CostResponse {
  data?: Array<{ date?: unknown; tokens?: unknown; cost?: unknown }>
  byModel?: Record<string, number>
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** The biggest share of a name-to-number map, as a fraction of the whole. */
function largestShare(map: Record<string, number> | undefined): { name: string; share: number } | null {
  if (!map) return null
  const entries = Object.entries(map).filter(([, value]) => typeof value === 'number')
  if (entries.length === 0) return null

  const total = entries.reduce((sum, [, value]) => sum + value, 0)
  const [name, value] = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best))
  return { name, share: total > 0 ? value / total : 0 }
}

/**
 * Which range name to ask for, given the number of days the user chose.
 *
 * The endpoint takes names rather than a day count, so this picks the
 * smallest one that covers the choice. Anything past a month is `all`, which
 * over-covers - the alternative is from/to arithmetic here, and a widget
 * whose totals disagree with the dashboard's by a day would be worse than
 * one that shows a slightly wider window and says which.
 */
export function rangeNameFor(days: number): string {
  if (days <= 1) return 'day'
  if (days <= 7) return 'week'
  if (days <= 31) return 'month'
  return 'all'
}

export interface DataSource {
  get<T>(path: string): Promise<T>
}

export async function fetchWidgetData(hub: DataSource, rangeDays: number): Promise<WidgetData> {
  const rangeName = rangeNameFor(rangeDays)
  const [today, range, cost] = await Promise.all([
    hub.get<SummaryResponse>('/api/summary?range=day'),
    hub.get<SummaryResponse>(`/api/summary?range=${rangeName}`),
    hub.get<CostResponse>(`/api/cost?range=${rangeName}`),
  ])

  return {
    todayTokens: {
      total: num(today.totalTokens),
      input: num(today.inputTokens),
      output: num(today.outputTokens),
      cacheRead: num(today.cacheReadTokens),
      cacheWrite: num(today.cacheWriteTokens),
      thinking: num(today.thinkingTokens),
    },
    todayCost: num(today.totalCost),
    rangeTokens: { total: num(range.totalTokens) },
    rangeCost: num(range.totalCost),
    rangeDays,
    topModel: largestShare(cost.byModel),
    topTool: largestShare(range.byTool),
    dailyHistory: (cost.data ?? []).map((entry) => ({
      date: typeof entry.date === 'string' ? entry.date : '',
      tokens: num(entry.tokens),
      cost: num(entry.cost),
    })),
    sessionCountToday: num(today.totalSessions),
    lastUpdated: Date.now(),
  }
}

/**
 * The same shape with nothing in it.
 *
 * The panel computes its strings from these fields the moment data arrives,
 * before any `{#if}` decides whether to draw them. Handing it an object
 * without them throws inside a reactive statement and the whole panel stops
 * rendering - which looked exactly like a window that had lost its contents,
 * because it had.
 */
export function emptyWidgetData(rangeDays: number): WidgetData {
  return {
    todayTokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 },
    todayCost: 0,
    rangeTokens: { total: 0 },
    rangeCost: 0,
    rangeDays,
    topModel: null,
    topTool: null,
    dailyHistory: [],
    sessionCountToday: 0,
    lastUpdated: Date.now(),
  }
}
