import type Database from 'better-sqlite3'

/**
 * What the tray says, and what it refuses to say.
 *
 * This widget used to read `records` - tokens, cost, session counts - which
 * is not what anyone looks at a permanently-visible thing for. The question
 * a corner-of-the-screen display answers is "how much of my allowance is
 * left, and when does it come back". Everything else is a page you open.
 *
 * So: utilisation and time to reset. No forecast, no pace, no chart. Those
 * exist on /quotas and they are worth reading; a resident display that
 * carries them becomes something you have to read rather than glance at.
 */

/** A row as the tray needs it. The table carries eleven more columns. */
export interface QuotaRow {
  tool: string
  tier: string
  utilization: number
  resetsAt: number | null
  credStatus: string
  ts: number
}

/**
 * The tiers worth showing, and the label each gets.
 *
 * Read off production rather than assumed. The two tools do not agree on
 * what to call a week:
 *
 *   claude-code  five_hour, seven_day, nimbus_quill
 *   codex        five_hour, weekly_limit
 *
 * `weekly` and `daily` do not appear at all. `nimbus_quill` is left out on
 * purpose: it returns no resets_at, so half of what this display exists to
 * show cannot be shown for it (see STATE.md, nimbus_quill の制約).
 */
export const TIER_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '週',
  weekly_limit: '週',
  weekly: '週',
}

/** The order they appear in a line, shortest window first. */
const TIER_ORDER = ['five_hour', 'seven_day', 'weekly_limit', 'weekly']

/** How each tool is written when there is room for six characters. */
export const TOOL_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
}

/**
 * How old a reading may be before the display says so.
 *
 * The snapshot runs every five minutes, so one missed round is normal and
 * three is not. Fifteen minutes is that, and it is a guess - the honest kind:
 * nobody has measured how often the fetch actually fails on this machine. It
 * is deliberately not tight, because the cost of being wrong in that
 * direction is a display that cries stale while it is fine, which teaches
 * people to ignore the word.
 */
export const STALE_AFTER_MS = 15 * 60_000

export function queryQuota(db: Database.Database): QuotaRow[] {
  return db.prepare(`
    SELECT tool, tier, utilization, resets_at AS resetsAt, cred_status AS credStatus, ts
    FROM quota_current
    ORDER BY tool, tier
  `).all() as QuotaRow[]
}

/** Only the tiers this display shows, in window-length order, per tool. */
export function shownRows(rows: QuotaRow[]): QuotaRow[] {
  return rows
    .filter((r) => TIER_ORDER.includes(r.tier))
    .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0)
      || TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
}

/**
 * The window's version of the same reading.
 *
 * The tooltip is the summary and this is the detail behind it, so both come
 * from one query and one set of rules. Two readers of the same table that
 * each decided for themselves what counts as stale would eventually disagree
 * in front of the user.
 *
 * Shaped for display and nothing else: no raw timestamps to subtract, no
 * tier names to translate, no decisions left for the renderer to make.
 */
export interface QuotaLine {
  tier: string
  /** 'five_hour' | 'week' - which of the two words to print, not the raw name. */
  kind: 'five_hour' | 'week'
  utilization: number
  /** Milliseconds until it resets, or null when the tier does not say. */
  resetsInMs: number | null
}

export interface QuotaTool {
  tool: string
  label: string
  lines: QuotaLine[]
}

export interface QuotaView {
  tools: QuotaTool[]
  /** Tools whose credential is not valid, by label. */
  credInvalid: string[]
  /** How old the oldest reading is, when that is worth saying; null otherwise. */
  staleForMs: number | null
  /**
   * Tiers that exist in the data and are deliberately not drawn.
   *
   * Carried through to the window so it can say so. A row dropped in silence
   * is indistinguishable from a row that was never there, and the person
   * looking at the panel is the one who would otherwise wonder where their
   * third Claude window went.
   */
  hiddenTiers: string[]
}

export function quotaView(rows: QuotaRow[], now: number): QuotaView {
  const shown = shownRows(rows)
  const tools: QuotaTool[] = []
  for (const row of shown) {
    let entry = tools.find((t) => t.tool === row.tool)
    if (!entry) {
      entry = { tool: row.tool, label: TOOL_LABELS[row.tool] ?? row.tool, lines: [] }
      tools.push(entry)
    }
    entry.lines.push({
      tier: row.tier,
      kind: row.tier === 'five_hour' ? 'five_hour' : 'week',
      utilization: row.utilization,
      resetsInMs: row.resetsAt == null ? null : row.resetsAt - now,
    })
  }

  const oldest = shown.length > 0 ? Math.min(...shown.map((r) => r.ts)) : null
  return {
    tools,
    credInvalid: [...new Set(shown.filter((r) => r.credStatus !== 'valid').map((r) => TOOL_LABELS[r.tool] ?? r.tool))],
    staleForMs: oldest != null && now - oldest > STALE_AFTER_MS ? now - oldest : null,
    hiddenTiers: [...new Set(rows.filter((r) => !TIER_ORDER.includes(r.tier)).map((r) => r.tier))],
  }
}

export type Severity = 'ok' | 'warn' | 'danger'

/**
 * How alarming the icon should look, from the worst number on the display.
 *
 * 70 and 90 are placeholders. They are not derived from anything: nobody has
 * yet run out of a window on these machines, so there is no evidence about
 * where the useful warning sits. They are here to be changed once there is -
 * the same position the silence threshold for a quiet spoke is in.
 *
 * A reading that is stale, or one whose credential is not valid, is not a
 * severity. It is an absence of information, and it is said in words in the
 * tooltip rather than coloured in the icon: an icon that goes red because
 * the fetch failed would mean the same thing as one that goes red because
 * the allowance is nearly gone.
 */
export function severity(rows: QuotaRow[]): Severity {
  const worst = shownRows(rows).reduce((max, r) => Math.max(max, r.utilization), 0)
  if (worst >= 90) return 'danger'
  if (worst >= 70) return 'warn'
  return 'ok'
}

/** "2h36m", "3d", "6d18h", "now" - two units at most, largest first. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return 'now'
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`
  return `${mins}m`
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, ' ')
}

/**
 * Windows will not show more than this, and cuts the rest without saying so.
 *
 * Shell_NotifyIcon takes 128 characters including the terminator. Two tools
 * with two tiers each fits inside it; a third line about staleness may not,
 * which is why that line goes first when it exists.
 */
export const TOOLTIP_MAX = 127

/**
 * The whole of what the tray says on hover.
 *
 * Built as text rather than assembled in main.ts so that it can be tested
 * without starting Electron - the same reason the severity is a function.
 */
export function buildTooltip(rows: QuotaRow[], now: number): string {
  const shown = shownRows(rows)
  if (shown.length === 0) return 'AIUsage — no quota data on this machine'

  const lines: string[] = []

  /*
   * Bad news first, because it is the part that can be cut off.
   *
   * A tooltip that has been truncated still shows its beginning, so the line
   * that says "these numbers are not to be trusted" has to be above the
   * numbers rather than under them.
   */
  const invalid = [...new Set(shown.filter((r) => r.credStatus !== 'valid').map((r) => r.tool))]
  if (invalid.length > 0) {
    lines.push(`! ${invalid.map((t) => TOOL_LABELS[t] ?? t).join(', ')}: credentials not valid`)
  }

  const oldest = Math.min(...shown.map((r) => r.ts))
  if (now - oldest > STALE_AFTER_MS) {
    lines.push(`! last read ${formatRemaining(now - oldest)} ago — not updating`)
  }

  const byTool = new Map<string, QuotaRow[]>()
  for (const row of shown) {
    const list = byTool.get(row.tool) ?? []
    list.push(row)
    byTool.set(row.tool, list)
  }

  for (const [tool, toolRows] of byTool) {
    const parts = toolRows.map((r) => {
      const label = TIER_LABELS[r.tier] ?? r.tier
      const pct = `${pad(Math.round(r.utilization), 3)}%`
      /*
       * No reset time rather than a guessed one. A tier that does not
       * return resets_at cannot have a countdown, and inventing one from
       * the window length would be a number that looks measured.
       */
      const left = r.resetsAt == null ? '' : ` (${formatRemaining(r.resetsAt - now)})`
      return `${label} ${pct}${left}`
    })
    lines.push(`${(TOOL_LABELS[tool] ?? tool).padEnd(6)} ${parts.join('  ')}`)
  }

  const text = lines.join('\n')
  return text.length <= TOOLTIP_MAX ? text : `${text.slice(0, TOOLTIP_MAX - 1)}…`
}
