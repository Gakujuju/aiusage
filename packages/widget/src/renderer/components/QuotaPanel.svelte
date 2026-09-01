<script lang="ts">
  /**
   * The window's subject.
   *
   * The tray tooltip is the summary of exactly this, from the same query and
   * the same rules, so the two can never disagree in front of the reader.
   *
   * Deliberately absent: forecast, pace, and anything shaped like a graph.
   * Those live on /quotas, and they are worth reading - but a thing that
   * stays on screen has to be glanceable, and every extra line is one more
   * thing to read before finding the number you came for.
   */
  import type { Translations } from '../i18n'

  interface QuotaLine {
    tier: string
    kind: 'five_hour' | 'week'
    utilization: number
    resetsInMs: number | null
  }
  interface QuotaTool { tool: string; label: string; lines: QuotaLine[] }
  export let quota: {
    tools: QuotaTool[]
    credInvalid: string[]
    staleForMs: number | null
    hiddenTiers: string[]
  }
  export let i18n: Translations

  /** Ten cells, because a bar is read as a proportion and not counted. */
  const CELLS = 10

  function filled(utilization: number): number {
    return Math.min(CELLS, Math.round((utilization / 100) * CELLS))
  }

  /** Two units at most, largest first - the same shape the tooltip uses. */
  function left(ms: number): string {
    const minutes = Math.max(0, Math.floor(ms / 60_000))
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor((minutes % 1440) / 60)
    const mins = minutes % 60
    const d = i18n.unitDay, h = i18n.unitHour, m = i18n.unitMinute
    if (days > 0) return hours > 0 ? `${days}${d}${hours}${h}` : `${days}${d}`
    if (hours > 0) return mins > 0 ? `${hours}${h}${mins}${m}` : `${hours}${h}`
    return `${mins}${m}`
  }
</script>

<div class="quota">
  <!--
    Bad news above the numbers, for the same reason the tooltip does it: what
    a reader takes in first has to include the reason not to trust the rest.
  -->
  {#if quota.credInvalid.length > 0}
    <div class="alert">{i18n.credInvalid(quota.credInvalid.join(', '))}</div>
  {/if}
  {#if quota.staleForMs !== null}
    <div class="alert">{i18n.quotaStale(left(quota.staleForMs))}</div>
  {/if}

  {#each quota.tools as tool (tool.tool)}
    <div class="tool">
      <div class="tool-name">{tool.label}</div>
      {#each tool.lines as line (line.tier)}
        <div class="row">
          <span class="tier">{line.kind === 'five_hour' ? i18n.tierFiveHour : i18n.tierWeek}</span>
          <span class="bar" aria-hidden="true">
            {#each Array(CELLS) as _, i}<span class="cell" class:on={i < filled(line.utilization)}></span>{/each}
          </span>
          <span class="pct">{Math.round(line.utilization)}%</span>
          <span class="left">
            {line.resetsInMs === null ? i18n.resetsUnknown : i18n.resetsIn(left(line.resetsInMs))}
          </span>
        </div>
      {/each}
    </div>
  {/each}

  <!--
    Said, not dropped. A tier that exists in the data and is not on screen is
    otherwise indistinguishable from one that was never collected, and the
    person wondering where their third window went is the one reading this.
  -->
  {#if quota.hiddenTiers.length > 0}
    <div class="note">{i18n.tierHidden(quota.hiddenTiers.join(', '))}</div>
  {/if}
</div>

<style>
  .quota { display: flex; flex-direction: column; gap: 0.75rem; }

  .tool { display: flex; flex-direction: column; gap: 0.25rem; }

  .tool-name {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: 0.02em;
  }

  .row {
    display: grid;
    grid-template-columns: 3.5rem auto 2.5rem 1fr;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.6875rem;
  }

  .tier { color: var(--text-secondary); }

  .bar { display: inline-flex; gap: 2px; }

  .cell {
    width: 6px;
    height: 10px;
    border-radius: 1px;
    background: var(--border);
  }

  .cell.on { background: var(--accent); }

  .pct {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
    font-weight: 600;
  }

  .left {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .alert {
    font-size: 0.6875rem;
    color: var(--danger);
    line-height: 1.4;
  }

  .note {
    font-size: 0.625rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
</style>
