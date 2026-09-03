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
  import type { QuotaDetail } from '../../size'

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
  }
  export let i18n: Translations
  /**
   * How much of each line to draw. 'number' is the digits with no meter -
   * the smallest size fixes it, since at that zoom the bar stops being
   * readable before the digits do. See size.ts.
   */
  export let detail: QuotaDetail = 'full'
  /** Tool ids the user has switched off. */
  export let hiddenTools: string[] = []
  /**
   * One line per tool: name, then the meters, and nothing else.
   *
   * For the folded strip. The tier words are dropped and the meaning carried
   * by position instead - five-hour left, week right, in TIER_ORDER, the same
   * order as when open. A legend costs most of the strip's width, and
   * something read out of the corner of an eye does not get read twice.
   */
  export let compact = false

  /*
   * Ordered here rather than trusted from the caller, because in the strip
   * the position is the label. A tool whose lines arrived in another order
   * would silently mean the opposite thing.
   */
  const KIND_ORDER: Array<'five_hour' | 'week'> = ['five_hour', 'week']
  function ordered(lines: QuotaLine[]): QuotaLine[] {
    return [...lines].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
  }

  $: visible = quota.tools.filter((t) => !hiddenTools.includes(t.tool))

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

<div
  class="quota"
  class:compact
  style="--row-columns: {detail === 'number' ? '3.5rem 2.5rem' : detail === 'meter' ? '3.5rem auto' : detail === 'percent' ? '3.5rem auto 2.5rem' : '3.5rem auto 2.5rem 1fr'}"
>
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

  {#each visible as tool (tool.tool)}
    {#if compact}
      <div class="strip-row">
        <span class="strip-name">{tool.label}</span>
        {#each ordered(tool.lines) as line (line.tier)}
          <span
            class="strip-meter"
            aria-label="{tool.label} {line.kind === 'five_hour' ? i18n.tierFiveHour : i18n.tierWeek} {Math.round(line.utilization)}%"
          >
            {#if detail !== 'number'}
              <span class="bar" aria-hidden="true">
                {#each Array(CELLS) as _, i}<span class="cell" class:on={i < filled(line.utilization)}></span>{/each}
              </span>
            {/if}
            <!--
              The number, because a meter only ever says "roughly". Somebody
              watching a limit wants to know whether it is 62 or 68, and the
              bar cannot tell them apart at ten cells.

              What is deliberately not here is the countdown. It is long, and
              it answers a different question from the one the strip is for.
            -->
            <span class="strip-pct">{Math.round(line.utilization)}%</span>
          </span>
        {/each}
      </div>
    {:else}
    <div class="tool">
      <div class="tool-name">{tool.label}</div>
      {#each tool.lines as line (line.tier)}
        <div class="row">
          <span class="tier">{line.kind === 'five_hour' ? i18n.tierFiveHour : i18n.tierWeek}</span>
          {#if detail !== 'number'}
            <span class="bar" aria-hidden="true">
              {#each Array(CELLS) as _, i}<span class="cell" class:on={i < filled(line.utilization)}></span>{/each}
            </span>
          {/if}
          {#if detail !== 'meter'}
            <span class="pct">{Math.round(line.utilization)}%</span>
          {/if}
          {#if detail === 'full'}
            <span class="left">
              {line.resetsInMs === null ? i18n.resetsUnknown : i18n.resetsIn(left(line.resetsInMs))}
            </span>
          {/if}
        </div>
      {/each}
    </div>
    {/if}
  {/each}

  <!--
    An empty panel is not a state. If everything is switched off, the panel
    says which situation this is rather than leaving a blank rectangle that
    looks like a failure to load.
  -->
  {#if visible.length === 0}
    <div class="note">{i18n.nothingToShow}</div>
  {/if}

</div>

<style>
  .quota { display: flex; flex-direction: column; gap: 0.75rem; }

  /* Folded. Tighter than .tool by design: the gap is most of a strip. */
  .strip-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    line-height: 1.4;
  }

  .strip-name {
    font-size: 0.6875rem;
    font-weight: 700;
    color: var(--text-primary);
    white-space: nowrap;
    /* So two tools' meters line up under each other and can be compared. */
    min-width: 3.5rem;
  }

  .strip-meter {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  /*
   * Fixed width and fixed digits, so nothing moves as the numbers do.
   *
   * These change every minute, and the second meter sits after the first
   * one's number: without a reserved width, 9% becoming 100% would shove the
   * week meter sideways, and proportional digits would nudge it on almost
   * every update. A thing meant to be read out of the corner of an eye
   * cannot twitch - the movement is what catches the eye, and it would be
   * catching it for no reason.
   *
   * 2.5rem is what "100%" needs at this size, which is the widest it goes.
   */
  .strip-pct {
    min-width: 2.5rem;
    text-align: right;
    font-size: 0.6875rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
  }

  .tool { display: flex; flex-direction: column; gap: 0.25rem; }

  .tool-name {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: 0.02em;
  }

  .row {
    display: grid;
    /* Set from the detail level, so a hidden column takes no width. */
    grid-template-columns: var(--row-columns);
    align-items: center;
    gap: 0.5rem;
    font-size: 0.6875rem;
  }

  .tier { color: var(--text-secondary); }

  .quota.compact { gap: 0.25rem; }

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

  /*
   * These two are sentences, and a sentence is not what the panel should be
   * as wide as. width:0 with min-width:100% keeps them out of the intrinsic
   * width calculation and then stretches them to whatever the rows settled
   * on, so they wrap instead of deciding the size.
   *
   * Without it the footnote about nimbus_quill was the widest thing here and
   * every detail level came out the same size.
   */
  .alert,
  .note {
    width: 0;
    min-width: 100%;
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
