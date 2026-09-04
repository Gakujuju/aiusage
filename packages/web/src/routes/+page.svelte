<script>
  import { onMount, onDestroy } from 'svelte'

  import { fetchSummary, refreshData as triggerRefresh, fetchConfig, fetchQuotas, SETTINGS_UPDATED_EVENT } from '$lib/api.js'
  import QuotaCard from '$lib/components/QuotaCard.svelte'
  import CostCaveats from '$lib/components/CostCaveats.svelte'
  import { t } from '$lib/i18n.js'
  import { formatCost, displayCurrency, exchangeRate } from '$lib/stores.js'

  const DISPLAY_KEY = 'aiusage-home-display'

  const RANGE_OPTIONS = [
    { tKey: 'range.allTime', value: 'all' },
    { tKey: 'range.today',   value: 'day' },
    { tKey: 'range.week',    value: 'week' },
    { tKey: 'range.month',   value: 'month' },
    { tKey: 'range.last30',  value: 'last30' },
  ]

  function defaultDisplay() {
    return { range: 'all', precision: 'exact' }
  }

  function loadDisplay() {
    if (typeof window === 'undefined') return defaultDisplay()
    try { return { ...defaultDisplay(), ...JSON.parse(localStorage.getItem(DISPLAY_KEY) || '{}') } }
    catch { return defaultDisplay() }
  }

  function saveDisplay(d) {
    if (typeof window !== 'undefined') localStorage.setItem(DISPLAY_KEY, JSON.stringify(d))
  }

  let display = defaultDisplay()
  let showConfig = false

  let globalRefreshMs = 30000

  $: fmtMain = (n) => {
    const r = Math.round(n)
    if (display.precision === 'abbr') {
      if (r >= 1_000_000_000) return (r / 1_000_000_000).toFixed(3) + 'B'
      if (r >= 1_000_000)     return (r / 1_000_000).toFixed(3) + 'M'
      if (r >= 1_000)         return (r / 1_000).toFixed(1) + 'K'
    }
    return r.toLocaleString()
  }

  /** @type {any} */
  let data       = null
  /** @type {any} */
  let error      = null
  let loading    = true
  let refreshing = false
  let barsReady  = false

  /*
   * The figures used to be tweened stores that restarted from zero on every
   * load and took up to 2.6 seconds to arrive, while the breakdown beside
   * them rendered its final value at once. For those seconds the screen
   * showed a total that was in no database, and twice someone photographed
   * one and reported the number as a drop — costing an evening each time.
   *
   * A figure on screen is now always the figure that was fetched. The
   * entrance is still animated, but in CSS and on appearance only: opacity
   * and a small rise, which cannot misreport anything because the digits
   * are correct in the first painted frame.
   */
  let revealed = false

  async function fetchAndApply(fast = false) {
    const d = fast ? 500 : 2600
    error = null
    try {
      const newData = await fetchSummary({ range: display.range })
      if (newData) {
        data = newData
        revealed = true
        // The bars are a picture of the split, not a reading of it — their
        // widths may grow. Every number they stand for is in the titles.
        barsReady = false
        setTimeout(() => { barsReady = true }, fast ? 80 : 400)
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load'
      data = null
    }
  }

  async function loadData() {
    loading = true
    revealed = false
    barsReady = false
    await fetchAndApply(false)
    loading = false
  }

  async function silentRefresh() {
    refreshing = true
    await fetchAndApply(true)
    refreshing = false
  }

  let countdown      = 0
  let countdownTimer = null
  let refreshTimeout = null

  function startRefreshCycle() {
    clearInterval(countdownTimer)
    clearTimeout(refreshTimeout)
    const secs = Math.round(globalRefreshMs / 1000)
    if (!secs) { countdown = 0; return }
    countdown = secs
    countdownTimer = setInterval(() => { countdown = Math.max(0, countdown - 1) }, 1000)
    refreshTimeout = setTimeout(() => {
      silentRefresh().then(startRefreshCycle)
    }, globalRefreshMs)
  }

  function manualRefresh() {
    clearInterval(countdownTimer)
    clearTimeout(refreshTimeout)
    silentRefresh().then(() => startRefreshCycle())
  }

  function handleSettingsUpdated(event) {
    globalRefreshMs = event?.detail?.refreshInterval ?? 30000
    startRefreshCycle()
  }

  let now         = new Date()
  let clockTimer  = null

  onMount(async () => {
    display = loadDisplay()
    clockTimer = setInterval(() => { now = new Date() }, 1000)

    try {
      const cfg = await fetchConfig()
      if (cfg?.refreshInterval) globalRefreshMs = cfg.refreshInterval
    } catch {}

    // Render whatever is already in the database first so the landing page is
    // never blocked on log parsing. Trae/large log sources can make /api/refresh
    // take tens of seconds; awaiting it here left the page stuck loading (issue #40).
    await Promise.all([loadData(), loadQuotas()])
    startRefreshCycle()

    // Kick off a fresh parse in the background, then quietly update once it lands.
    triggerRefresh()
      .then(() => Promise.all([silentRefresh(), loadQuotas()]))
      .catch(() => {})

    window.addEventListener(SETTINGS_UPDATED_EVENT, handleSettingsUpdated)
  })

  onDestroy(() => {
    clearInterval(clockTimer)
    clearInterval(countdownTimer)
    clearTimeout(refreshTimeout)
    if (typeof window !== 'undefined') {
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handleSettingsUpdated)
    }
  })

  $: timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  $: dateStr  = now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })

  $: tokenParts    = data ? (data.inputTokens||0)+(data.outputTokens||0)+(data.cacheReadTokens||0)+(data.cacheWriteTokens||0) : 0
  $: inputPct      = tokenParts > 0 ? (data.inputTokens     / tokenParts) * 100 : 0
  $: outputPct     = tokenParts > 0 ? (data.outputTokens    / tokenParts) * 100 : 0
  $: cacheReadPct  = tokenParts > 0 ? (data.cacheReadTokens / tokenParts) * 100 : 0
  $: cacheWritePct = tokenParts > 0 ? (data.cacheWriteTokens/ tokenParts) * 100 : 0

  $: refreshSecs  = Math.round(globalRefreshMs / 1000)
  $: refreshPct   = refreshSecs > 0 ? (1 - countdown / refreshSecs) * 100 : 0
  $: rangeKey     = RANGE_OPTIONS.find(r => r.value === display.range)?.tKey ?? 'range.allTime'

  // Reactive cost formatting — depends on $displayCurrency and $exchangeRate so it re-evaluates on currency change
  $: formattedCost = (() => { void $displayCurrency; void $exchangeRate; return formatCost(data?.totalCost ?? 0) })()

  /*
   * How much of the total cost could not be worked out, and why.
   *
   * Two causes with nothing the reader can do about either — no published
   * rate, and no token split to price. Added together here because beside
   * the figure the useful fact is "this total is short", and the reasons
   * are one click away on /cost rather than lost.
   */
  $: uncostedRecords = (data?.acknowledgedUnpricedRecords ?? 0)
    + (data?.breakdownMissingRecords ?? 0)
  $: uncostedNote = $t('home.uncostedNote').replace('{n}', String(uncostedRecords))
  $: uncostedDetail = [
    (data?.acknowledgedUnpricedRecords ?? 0) > 0
      ? $t('cost.noPublishedRateNote')
          .replace('{n}', String(data.acknowledgedUnpricedRecords))
          .replace('{models}', (data.acknowledgedUnpricedModels ?? []).join(', '))
      : '',
    (data?.breakdownMissingRecords ?? 0) > 0
      ? $t('cost.breakdownMissingNote').replace('{n}', String(data.breakdownMissingRecords))
      : '',
  ].filter(Boolean).join('\n')

  /*
   * The quotas, fetched once, feeding two things: the cards at the top of
   * the page and the warning banner. One fetch on purpose - the banner and
   * the cards must never disagree, and two calls a minute apart can.
   */
  /** @type {any[]} */
  let quotas = []
  /** @type {string | null} Why the quotas could not be read; null while they can. */
  let quotaError = null

  async function loadQuotas() {
    try {
      const result = await fetchQuotas()
      quotas = result?.quotas ?? []
      quotaError = null
    } catch (e) {
      // Said on the page rather than swallowed: an empty space where the
      // limits should be reads as "nothing to worry about", which is the one
      // thing an unreachable hub does not mean.
      quotaError = e instanceof Error ? e.message : 'Failed to load quota data'
    }
  }

  /** The ones with credentials - the same filter the quotas page applies. */
  $: activeQuotas = quotas.filter((q) => q.credentialStatus !== 'not_found')

  // Banner for any tier at or past 80%, derived from the same result.
  $: quotaWarnings = quotas.flatMap((quota) =>
    !quota.success ? [] : (quota.tiers ?? [])
      .filter((tier) => tier.utilization >= 80)
      .map((tier) => ({ tool: quota.tool, tier: tier.name, utilization: Math.round(tier.utilization) })),
  )

  const TOOL_SHORT = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
  }
  const TIER_SHORT = {
    five_hour: '5h',
    seven_day: '7d',
    seven_day_opus: '7d Opus',
    seven_day_sonnet: '7d Sonnet',
    seven_day_omelette: '7d Design',
    weekly_limit: 'weekly',
  }

  function warningColor(pct) {
    return pct >= 90 ? 'red' : 'orange'
  }

  function fmtShort(n) {
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B'
    if (n >= 1_000_000)     return (n / 1_000_000).toFixed(1) + 'M'
    if (n >= 1_000)         return (n / 1_000).toFixed(1) + 'K'
    return n.toLocaleString()
  }

  function setRange(v) {
    display = { ...display, range: v }
    saveDisplay(display)
    loadData().then(() => startRefreshCycle())
  }

  function setPrecision(v) {
    display = { ...display, precision: v }
    saveDisplay(display)
  }
</script>

<svelte:head>
  <title>AIUsage</title>
</svelte:head>

{#if showConfig}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="overlay-backdrop" on:click={() => showConfig = false}></div>
  <div class="config-panel" role="dialog">
    <div class="cfg-header">
      <span class="cfg-title">{$t('home.cfgTitle')}</span>
      <button class="cfg-close" on:click={() => showConfig = false}>✕</button>
    </div>

    <div class="cfg-section">
      <div class="cfg-label">{$t('home.timeRange')}</div>
      <div class="cfg-pills">
        {#each RANGE_OPTIONS as opt}
          <button class="pill" class:active={display.range === opt.value} on:click={() => setRange(opt.value)}>
            {$t(opt.tKey)}
          </button>
        {/each}
      </div>
    </div>

    <div class="cfg-section">
      <div class="cfg-label">{$t('home.numFormat')}</div>
      <div class="cfg-pills">
        <button class="pill" class:active={display.precision === 'exact'} on:click={() => setPrecision('exact')}>
          {$t('home.numExact')} <span class="pill-eg">{$t('home.numExactEx')}</span>
        </button>
        <button class="pill" class:active={display.precision === 'abbr'} on:click={() => setPrecision('abbr')}>
          {$t('home.numShort')} <span class="pill-eg">{$t('home.numShortEx')}</span>
        </button>
      </div>
    </div>

    <div class="cfg-refresh-info">
      <span class="refresh-info-text">
        {$t('home.refreshInfo')}
        <a href="/settings" class="settings-link" on:click={() => showConfig = false}>{$t('nav.settings')}</a>
        · {refreshSecs}{$t('home.seconds')}
      </span>
    </div>
  </div>
{/if}

<div class="top-bar">
  <div class="live-indicator">
    <span class="live-dot"></span>
    <span class="live-label">LIVE</span>
  </div>

  <span class="range-badge">{$t(rangeKey)}</span>

  <div class="clock-block">
    <span class="clock-time">{timeStr}</span>
    <span class="clock-date">{dateStr}</span>
  </div>

  <button class="cfg-btn" on:click={() => showConfig = !showConfig} title={$t('home.cfgTitle')}>
    ⚙
  </button>
</div>

{#if quotaWarnings.length > 0}
  <div class="quota-warning-list">
    {#each quotaWarnings as w (w.tool + w.tier)}
      {@const color = warningColor(w.utilization)}
      <div class="quota-warning" class:quota-red={color === 'red'} class:quota-orange={color === 'orange'}>
        <span class="warn-icon">{color === 'red' ? '▲' : '△'}</span>
        <span class="warn-text">
          <strong>{TOOL_SHORT[w.tool] ?? w.tool}</strong>
          {TIER_SHORT[w.tier] ?? w.tier}
          {$t('home.quotaWarningDesc')}: <strong>{w.utilization}%</strong>
        </span>
        <a href="/quotas" class="warn-link">{$t('home.quotaWarningLink')} →</a>
      </div>
    {/each}
  </div>
{/if}

<!--
  The limits, first. They are what the person opening this page is watching,
  and they sit above the token figures on purpose. Same card as /quotas,
  without the chart slot (no history is fetched here), from the one fetch
  the banner above also reads.
-->
{#if quotaError}
  <div class="home-quotas-error state-msg error"><p>{quotaError}</p></div>
{:else if activeQuotas.length > 0}
  <div class="home-quotas">
    {#each activeQuotas as quota (quota.tool)}
      <QuotaCard {quota} charts={false} />
    {/each}
  </div>
{/if}

<CostCaveats
  unpricedRecords={data?.unpricedRecords ?? 0}
  unpricedModels={data?.unpricedModels ?? []}
  breakdownMissingRecords={data?.breakdownMissingRecords ?? 0}
  acknowledgedUnpricedRecords={data?.acknowledgedUnpricedRecords ?? 0}
  acknowledgedUnpricedModels={data?.acknowledgedUnpricedModels ?? []}
  showQuiet={false}
/>

{#if loading}
  <div class="splash-loading">
    <span class="splash-text">{$t('common.loading')}</span>
  </div>
{:else if error}
  <div class="splash-error">
    <span class="err-msg">{error}</span>
    <button class="retry-btn" on:click={manualRefresh}>{$t('home.refreshBtn')}</button>
  </div>
{:else if !data || data.totalTokens === 0}
  <div class="splash-empty">
    <span class="empty-title">{$t('common.noData')}</span>
    <span class="empty-hint">{$t('common.noDataHint')}</span>
  </div>
{:else}

  <section class="counter-section">
    <div class="counter-label">{$t('home.counterLabel')}</div>

    <div class="counter-number" class:refreshing class:revealed>
      {fmtMain(data.totalTokens)}
    </div>

    <div class="counter-sub">
      <div class="sub-item">
        <span class="sub-label">{$t('home.input')}</span>
        <span class="sub-value">{fmtShort(data.inputTokens)}</span>
      </div>
      <div class="sub-divider"></div>
      <div class="sub-item">
        <span class="sub-label">{$t('home.output')}</span>
        <span class="sub-value">{fmtShort(data.outputTokens)}</span>
      </div>
      <div class="sub-divider"></div>
      <div class="sub-item">
        <span class="sub-label">{$t('home.cache')}</span>
        <span class="sub-value">{fmtShort((data.cacheReadTokens||0)+(data.cacheWriteTokens||0))}</span>
      </div>
    </div>

    <div class="refresh-bar-track">
      {#if refreshSecs > 0}
        <div class="refresh-bar-fill" style="width: {refreshPct}%"></div>
      {/if}
    </div>
    <div class="refresh-meta">
      {#if refreshSecs > 0}
        {#if countdown > 0}
          <span>{$t('home.nextRefresh')} {countdown}{$t('home.seconds')}</span>
        {:else}
          <span class="refreshing-label">{$t('home.refreshing')}</span>
        {/if}
      {:else}
        <span>{$t('home.manualMode')}</span>
      {/if}
      <button class="now-btn" on:click={manualRefresh}>
        {refreshSecs > 0 ? $t('home.refreshNow') : $t('home.refreshBtn')}
      </button>
    </div>
  </section>

  <div class="stats-strip">
    <div class="stat-block">
      <span class="stat-label">{$t('overview.totalCost')}</span>
      <span class="stat-value stat-cost">{formattedCost}</span>
      <!--
        Beside the figure it qualifies, not above the whole page. A total
        that is short must never appear on its own; the reasons are in the
        tooltip and in full on /cost.
      -->
      {#if uncostedRecords > 0}
        <a class="stat-note" href="/cost" title={uncostedDetail}>
          <span aria-hidden="true">ⓘ</span> {uncostedNote}
        </a>
      {/if}
    </div>
    <div class="stat-block">
      <span class="stat-label">{$t('overview.totalSessions')}</span>
      <span class="stat-value">{(data.totalSessions || 0).toLocaleString()}</span>
    </div>
    <div class="stat-block">
      <span class="stat-label">{$t('overview.activeDays')}</span>
      <span class="stat-value">{(data.activeDays || 0).toLocaleString()}</span>
    </div>
  </div>

  <div class="comp-wrap">
    <div class="comp-bar">
      <div class="seg seg-input"  style="width:{barsReady ? inputPct     : 0}%" title="{$t('home.input')} {inputPct.toFixed(1)}%">
        {#if inputPct > 9}<span class="seg-lbl">{$t('home.input')} {inputPct.toFixed(0)}%</span>{/if}
      </div>
      <div class="seg seg-output" style="width:{barsReady ? outputPct    : 0}%" title="{$t('home.output')} {outputPct.toFixed(1)}%">
        {#if outputPct > 9}<span class="seg-lbl">{$t('home.output')} {outputPct.toFixed(0)}%</span>{/if}
      </div>
      <div class="seg seg-cr"     style="width:{barsReady ? cacheReadPct : 0}%" title="Cache R {cacheReadPct.toFixed(1)}%">
        {#if cacheReadPct > 9}<span class="seg-lbl">Cache R {cacheReadPct.toFixed(0)}%</span>{/if}
      </div>
      <div class="seg seg-cw"     style="width:{barsReady ? cacheWritePct: 0}%" title="Cache W {cacheWritePct.toFixed(1)}%">
        {#if cacheWritePct > 9}<span class="seg-lbl">Cache W {cacheWritePct.toFixed(0)}%</span>{/if}
      </div>
    </div>
    <div class="comp-legend">
      <span class="leg leg-i">{$t('home.input')}</span>
      <span class="leg leg-o">{$t('home.output')}</span>
      <span class="leg leg-cr">Cache Read</span>
      <span class="leg leg-cw">Cache Write</span>
    </div>
  </div>

{/if}

<style>
  .top-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
    padding: 0.5rem 0.75rem;
    background: var(--raised);
    border-radius: var(--radius-card);
  }

  .live-indicator {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-badge);
    background: var(--green-dim);
    flex-shrink: 0;
  }
  .live-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--green);
  }
  .live-label {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.1em;
    color: var(--green);
  }

  .range-badge {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
    background: var(--accent-dim);
    border-radius: var(--radius-badge);
    padding: 0.125rem 0.5rem;
  }

  .clock-block {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    margin-left: auto;
    gap: 0;
  }
  .clock-time {
    font-family: var(--mono);
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .clock-date {
    font-family: var(--mono);
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .cfg-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: var(--border-width) solid var(--border-subtle);
    border-radius: var(--radius-input);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: color 0.12s;
    flex-shrink: 0;
    font-size: 0.8rem;
  }
  .cfg-btn:hover { color: var(--text); }

  /* ── Counter ─────────────────────────────────────────────────────────── */
  .counter-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2.5rem 2rem 1.5rem;
    margin-bottom: 1rem;
    background: var(--surface);
    border-radius: var(--radius-panel);
  }

  .counter-label {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
  }

  .counter-number {
    font-family: var(--mono);
    font-size: clamp(2.5rem, 6vw, 4.5rem);
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    /* The entrance, now that the digits do not move.

       Opacity and a small rise: the number is right in the first painted
       frame, so a screenshot taken at any moment is a screenshot of the
       real figure. Honouring prefers-reduced-motion below, which the
       count-up never did. */
    opacity: 0;
    transform: translateY(0.25rem);
    transition: opacity 0.45s ease-out, transform 0.45s ease-out;
  }
  .counter-number.revealed {
    opacity: 1;
    transform: none;
  }
  .counter-number.refreshing { opacity: 0.5; }

  @media (prefers-reduced-motion: reduce) {
    .counter-number {
      opacity: 1;
      transform: none;
      transition: none;
    }
  }

  .counter-sub {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    margin-top: 1.25rem;
  }
  .sub-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.125rem;
  }
  .sub-label {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .sub-value {
    font-family: var(--mono);
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .sub-divider {
    width: 1px;
    height: 24px;
    background: var(--border-subtle);
  }

  .refresh-bar-track {
    width: 100%;
    height: 2px;
    background: var(--border-subtle);
    border-radius: 1px;
    margin-top: 1.5rem;
    overflow: hidden;
  }
  .refresh-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 1px;
    transition: width 1s linear;
  }
  .refresh-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.375rem;
    font-family: var(--mono);
    font-size: 0.75rem;
    font-weight: 550;
    color: var(--text-muted);
    width: 100%;
  }
  .refreshing-label { color: var(--accent); }
  .now-btn {
    margin-left: auto;
    padding: 0.125rem 0.5rem;
    border: var(--border-width) solid var(--border-subtle);
    border-radius: var(--radius-badge);
    background: transparent;
    font-size: 0.75rem;
    font-weight: 550;
    color: var(--text-muted);
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
  }
  .now-btn:hover { color: var(--text); border-color: var(--border-medium); }

  /* ── Stats strip ─────────────────────────────────────────────────────── */
  .stats-strip {
    display: flex;
    background: var(--surface);
    border-radius: var(--radius-card);
    margin-bottom: 1rem;
    overflow: hidden;
  }
  .stat-block {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 1rem 1.25rem;
    transition: background 0.1s;
  }
  .stat-block:not(:last-child) {
    border-right: var(--border-width) solid var(--border-subtle);
  }
  .stat-block:hover { background: var(--raised); }
  .stat-label {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .stat-value {
    font-family: var(--mono);
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  /* Smaller than the figure and quieter in colour: it qualifies the number
     above it rather than competing with it. A link, because the reasons
     belong somewhere with room for them. */
  .stat-note {
    display: block;
    margin-top: 0.35rem;
    font-size: 0.6875rem;
    line-height: 1.4;
    color: var(--text-muted);
    text-decoration: none;
  }
  .stat-note:hover {
    color: var(--text-secondary);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .stat-cost { color: var(--accent); }

  /* ── Composition bar ─────────────────────────────────────────────────── */
  .comp-wrap { margin-bottom: 0.5rem; }
  .comp-bar {
    display: flex;
    height: 24px;
    border-radius: var(--radius-input);
    overflow: hidden;
    background: var(--raised);
  }
  .seg {
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    min-width: 0;
    transition: width 1.5s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  }
  .seg-lbl {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    padding: 0 4px;
    color: var(--surface);
  }
  .seg-input  { background: var(--chart-input); }
  .seg-output { background: var(--chart-output); }
  .seg-cr     { background: var(--chart-cache-read); }
  .seg-cw     { background: var(--chart-cache-write); }

  .comp-legend {
    display: flex;
    gap: 1rem;
    margin-top: 0.375rem;
    flex-wrap: wrap;
  }
  .leg {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .leg::before {
    content: '■';
    margin-right: 0.25rem;
    font-size: 0.5rem;
  }
  .leg-i  { color: var(--chart-input); }
  .leg-o  { color: var(--chart-output); }
  .leg-cr { color: var(--chart-cache-read); }
  .leg-cw { color: var(--chart-cache-write); }
  .leg-i::before  { color: var(--chart-input); }
  .leg-o::before  { color: var(--chart-output); }
  .leg-cr::before { color: var(--chart-cache-read); }
  .leg-cw::before { color: var(--chart-cache-write); }

  /* ── Config panel ────────────────────────────────────────────────────── */
  .overlay-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: var(--overlay);
    animation: fadeIn 0.15s ease;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .config-panel {
    position: fixed;
    z-index: 201;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(400px, 90vw);
    background: var(--surface);
    border-radius: var(--radius-panel);
    padding: 1.25rem;
    box-shadow: var(--shadow-lg);
  }

  .cfg-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  .cfg-title {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .cfg-close {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: var(--border-width) solid var(--border-subtle);
    border-radius: var(--radius-badge);
    background: transparent;
    color: var(--text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    transition: color 0.12s;
  }
  .cfg-close:hover { color: var(--rose); }

  .cfg-section { margin-bottom: 1rem; }
  .cfg-label {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 0.375rem;
  }
  .cfg-pills { display: flex; gap: 0.25rem; flex-wrap: wrap; }
  .pill {
    padding: 0.25rem 0.625rem;
    border: var(--border-width) solid var(--border-subtle);
    border-radius: 5px;
    background: transparent;
    font-size: 0.75rem;
    font-weight: 550;
    color: var(--text-secondary);
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
    white-space: nowrap;
  }
  .pill:hover { border-color: var(--accent); color: var(--accent); }
  .pill.active { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
  .pill-eg { opacity: 0.5; font-size: 0.75rem; margin-left: 0.25rem; }

  .cfg-refresh-info {
    margin-top: 0.5rem;
    padding: 0.5rem 0.625rem;
    border-radius: var(--radius-input);
    background: var(--raised);
  }
  .refresh-info-text {
    font-size: 0.75rem;
    font-weight: 550;
    color: var(--text-muted);
  }
  .settings-link {
    color: var(--accent);
    text-decoration: none;
  }
  .settings-link:hover { text-decoration: underline; }

  /* ── Quota warning banner ────────────────────────────────────────────── */
  .quota-warning-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-bottom: 0.875rem;
  }

  .quota-warning {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem;
    border-radius: 7px;
    font-size: 0.8rem;
    border: var(--border-width) solid transparent;
  }

  /* Its dark variant lives in --notice-* now, so this is one rule instead of
     two and a theme has a single place to reach. */
  .quota-orange {
    background: var(--notice-bg);
    border-color: var(--notice-border);
    color: var(--notice-fg);
  }

  .quota-red {
    background: var(--rose-dim);
    border-color: var(--danger-border);
    color: var(--rose);
  }

  .warn-icon {
    font-size: 0.75rem;
    flex-shrink: 0;
  }

  .warn-text {
    flex: 1;
    min-width: 0;
  }

  .warn-link {
    font-size: 0.75rem;
    font-weight: 600;
    text-decoration: none;
    color: inherit;
    opacity: 0.8;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .warn-link:hover { opacity: 1; text-decoration: underline; }

  /* ── Splash states ───────────────────────────────────────────────────── */
  .splash-loading, .splash-error, .splash-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    min-height: 320px;
    text-align: center;
  }
  .splash-text {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.1em;
    color: var(--text-muted);
  }

  .err-msg { font-size: 0.8125rem; color: var(--text-muted); }
  .retry-btn {
    margin-top: 0.25rem;
    padding: 0.375rem 1rem;
    border: var(--border-width) solid var(--rose);
    border-radius: var(--radius-input);
    background: transparent;
    font-size: 0.75rem;
    font-weight: 550;
    color: var(--rose);
    cursor: pointer;
    transition: background 0.12s;
  }
  .retry-btn:hover { background: var(--rose-dim); }

  .empty-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .empty-hint { font-size: 0.8125rem; color: var(--text-muted); }

  /* ── Responsive ──────────────────────────────────────────────────────── */
  @media (max-width: 800px) {
    .counter-section { padding: 2rem 1rem 1.25rem; }
    .counter-sub { gap: 1rem; }
    .stats-strip { flex-direction: column; }
    .stat-block:not(:last-child) { border-right: none; border-bottom: var(--border-width) solid var(--border-subtle); }
    .top-bar {
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      gap: 0.5rem;
    }
    .clock-block {
      margin-left: 0;
      align-items: flex-end;
      justify-self: end;
    }
    .cfg-btn { justify-self: end; }
  }

  .home-quotas {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .home-quotas-error {
    margin-bottom: 1rem;
  }
</style>
