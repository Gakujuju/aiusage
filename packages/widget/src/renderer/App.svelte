<script lang="ts">
  import { afterUpdate, onMount, tick } from 'svelte'
  import Header from './components/Header.svelte'
  import StatRow from './components/StatRow.svelte'
  import TokenBreakdown from './components/TokenBreakdown.svelte'
  import ActivityChart from './components/ActivityChart.svelte'
  import SettingsPanel from './components/SettingsPanel.svelte'
  import QuotaPanel from './components/QuotaPanel.svelte'
  import { t } from './i18n'
  import type { Locale } from './i18n'
  import { formatUsdCost } from '../currency'
  import type { CurrencyCode, ExchangeRateState } from '../currency'
  import type { WidgetUpdate } from '../update'
  import type { WidgetSettings } from '../settings'

  /*
   * Both imported, not restated.
   *
   * These two shapes used to be written out again here, by hand, because
   * nothing type-checked this directory and a copy was easier than an import.
   * Both copies had drifted: settings was missing two fields the settings
   * panel already reads, and the quota block described hiddenTiers as strings
   * after it had become objects. Neither showed up anywhere, because the
   * renderer was not being compiled - only stripped.
   */

  function detectInitialLocale(): Locale {
    // Only until the main process sends the saved setting, which is what
    // actually decides. This is so the first frame is not the wrong language.
    const tag = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : ''
    if (tag.startsWith('ja')) return 'ja'
    if (tag.startsWith('zh')) return 'zh'
    return 'en'
  }

  let data: WidgetUpdate | null = null
  let settings: WidgetSettings | null = null
  let exchangeRate: ExchangeRateState | null = null
  let initialLocale: Locale = detectInitialLocale()
  let loading = true
  let showSettings = false
  let panelEl: HTMLDivElement
  let lastReportedHeight = 0
  let lastReportedWidth = 0
  /**
   * What went wrong inside the widget, as opposed to out at the hub.
   *
   * Kept apart from hubProblem deliberately. "Cannot reach the hub" and "the
   * widget did not load" call for completely different next steps, and a
   * window that says the same thing for both makes the difference
   * impossible to see from the outside.
   */
  let fault: { kind: 'no-bridge' } | { kind: 'start-failed'; reason: string } | null = null

  /**
   * Set when nothing has arrived for a while and nothing has gone wrong.
   *
   * A panel that is merely waiting looks exactly like one that has quietly
   * died - three times today it was the second - so after ten seconds it
   * says which it is rather than staying blank.
   */
  let noDataYet = false

  /**
   * Opened once, on the first 401, and not again.
   *
   * The window is the only place the password can be typed, so a hub that
   * refuses it has to bring the panel forward - but only the first time.
   * Reopening it every refresh would take the panel away from someone who
   * had closed it and gone back to looking at the numbers.
   */
  /**
   * Folded to a strip. Read from settings so it survives a restart.
   *
   * Kept as its own variable rather than read from `settings` inline because
   * settings arrives asynchronously, and the panel has to draw something in
   * the meantime; false is the right thing to draw before the answer lands.
   */
  let collapsed = false
  $: collapsed = settings?.collapsed ?? false

  async function setCollapsed(next: boolean) {
    if (!settings) return
    // Through the same save path as every other setting, so the persisted
    // value and the drawn value cannot drift apart.
    settings = (await window.widget?.saveSettings({ ...settings, collapsed: next })) ?? settings
    void tick().then(reportWindowHeight)
  }

  /*
   * The strip is both the handle and the way back, and those cannot be told
   * apart until the mouse comes back up.
   *
   * With the header gone the strip has no -webkit-app-region: drag, and it
   * could not have one: a drag region does not hand its clicks back to the
   * page, so the strip would either be movable or clickable and not both.
   * Watching the pointer here gives both from the same surface, with no small
   * target to aim at - a press that goes nowhere unfolds, a press that
   * travels moves the window.
   *
   * Four pixels because a click with a mouse is rarely perfectly still and a
   * deliberate drag is never within four.
   */
  const DRAG_THRESHOLD_PX = 4
  let dragFrom: { x: number; y: number } | null = null
  let dragMoved = false

  function stripPointerDown(event: MouseEvent) {
    if (event.button !== 0) return
    dragFrom = { x: event.screenX, y: event.screenY }
    dragMoved = false
  }

  function stripPointerMove(event: MouseEvent) {
    if (!dragFrom) return
    const dx = event.screenX - dragFrom.x
    const dy = event.screenY - dragFrom.y
    if (!dragMoved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
    dragMoved = true
    // Deltas from the last position, not from the press: the window has
    // already moved by everything reported so far.
    dragFrom = { x: event.screenX, y: event.screenY }
    ;window.widget?.moveWindowBy({ dx, dy })
  }

  function stripPointerUp() {
    const wasClick = dragFrom !== null && !dragMoved
    dragFrom = null
    dragMoved = false
    if (wasClick) void setCollapsed(false)
  }

  let passwordPromptShown = false
  $: if (data?.hubProblem === 'unauthorized' && !passwordPromptShown) {
    passwordPromptShown = true
    showSettings = true
  }

  let installPhase: string | null = null
  let installError: string | null = null
  let isSetup = false

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return String(n)
  }

  $: locale = settings?.locale ?? initialLocale
  $: i18n = t(locale)
  $: currency = settings?.currency ?? 'USD'

  function rangeLabel(days: number): string {
    return i18n.lastNDays(days)
  }

  function formatSyncTime(ts: number): string {
    const d = new Date(ts)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return i18n.syncedAt(`${hh}:${mm}`)
  }

  async function refresh() {
    loading = true
    data = (await window.widget?.getData()) ?? null
    loading = false
  }

  function close() {
    ;window.widget?.hideWindow()
  }

  async function doLoadSettings() {
    settings = (await window.widget?.getSettings()) ?? null
  }

  async function loadExchangeRate() {
    exchangeRate = (await window.widget?.getExchangeRate()) ?? null
  }

  async function saveSettings(e: CustomEvent<WidgetSettings>) {
    settings = (await window.widget?.saveSettings(e.detail)) ?? null
    // Re-fetch data since rangeDays may have changed
    refresh()
  }

  /**
   * The smallest this panel could legitimately be, in the state it is in.
   *
   * Measured, not chosen. Folded, that is one tool's strip row plus the
   * strip's own padding - anything shorter than that has been caught
   * mid-render. Open, it is the old 120: a number that came from watching a
   * cold start report 51 for the header before the body existed.
   *
   * Sent with the height rather than kept in main, because main would then
   * need its own copy of "which state is this", and a second copy of a fact
   * is how four separate failures happened today.
   */
  function measuredFloor(): number {
    if (!collapsed) return 120
    const row = panelEl?.querySelector('.strip-row')
    if (!row) return 24
    const strip = panelEl!.querySelector('.strip') as HTMLElement | null
    const padding = strip
      ? parseFloat(getComputedStyle(strip).paddingTop) + parseFloat(getComputedStyle(strip).paddingBottom)
      : 0
    return Math.ceil(row.getBoundingClientRect().height + padding)
  }

  function reportWindowHeight() {
    if (!panelEl) return

    const box = panelEl.getBoundingClientRect()
    const height = Math.ceil(box.height)
    const width = Math.ceil(box.width)
    if (height <= 0 || width <= 0) return
    if (Math.abs(height - lastReportedHeight) < 2 && Math.abs(width - lastReportedWidth) < 2) return

    lastReportedHeight = height
    lastReportedWidth = width
    ;window.widget?.resizeWindow({ width, height, minHeight: measuredFloor() })
  }

  onMount(() => {
    /*
     * Everything below used to run bare and in order, so the first thing to
     * throw took the rest with it - including the ResizeObserver, which is
     * what tells the window how big to be. The result was a header-sized
     * window with nothing in it, three times today, for three different
     * reasons, and every time it looked like a design rather than a fault.
     */
    const bridge = window.widget
    if (!bridge) {
      fault = { kind: 'no-bridge' }
      loading = false
      void tick().then(reportWindowHeight)
      return
    }

    let resizeObserver: ResizeObserver | undefined
    try {
      refresh()
      doLoadSettings()
      loadExchangeRate()
      bridge.onDataUpdate((d: WidgetUpdate) => {
        data = d
        loading = false
      })
      bridge.onInstallStatus((status: { phase: string; error?: string }) => {
      installPhase = status.phase
      installError = status.error ?? null
      if (status.phase === 'done' || status.phase === 'failed') {
        setTimeout(() => { installPhase = null; installError = null }, 3000)
      }
    })
      bridge.onSetupStatus((status: { phase: string; error?: string }) => {
      isSetup = true
      installPhase = status.phase
      installError = status.error ?? null
      if (status.phase === 'done' || status.phase === 'failed') {
        setTimeout(() => { installPhase = null; installError = null; isSetup = false }, 3000)
      }
    })

      setTimeout(() => { noDataYet = data == null && fault == null }, 10_000)
    } catch (error) {
      /*
       * Drawn, not swallowed. Whatever failed, the window has to say that
       * something did - a person looking at it is the only detector this
       * has, and only if there is something to see.
       */
      fault = { kind: 'start-failed', reason: error instanceof Error ? error.message : String(error) }
      loading = false
    }

    resizeObserver = new ResizeObserver(() => reportWindowHeight())
    resizeObserver.observe(panelEl)
    void tick().then(reportWindowHeight)

    return () => resizeObserver?.disconnect()
  })

  afterUpdate(() => {
    void tick().then(reportWindowHeight)
  })

  $: todayStr = data ? formatTokens(data.todayTokens.total) : '--'
  $: rangeStr = data ? formatTokens(data.rangeTokens.total) : '--'
  $: todayCostStr = data ? formatUsdCost(data.todayCost, currency, locale, exchangeRate) : '--'
  $: rangeCostStr = data ? formatUsdCost(data.rangeCost, currency, locale, exchangeRate) : '--'
  $: rangeLabelStr = data ? rangeLabel(data.rangeDays) : i18n.lastNDays(30)
  $: modelStr = data?.topModel ? data.topModel.name : '--'
  $: modelSubStr = data?.topModel ? `${data.topModel.share}%` : ''
  $: toolStr = data?.topTool?.name ?? '--'
  $: toolSubStr = data?.topTool ? `${data.topTool.share}%` : ''
  $: sessionStr = data ? String(data.sessionCountToday) : '--'
  $: updatedStr = data ? formatSyncTime(data.lastUpdated) : ''
  $: installMessage = installPhase === 'checking' ? i18n.setupChecking
    : installPhase === 'parsing' ? i18n.setupParsing
    : installPhase === 'installing' ? i18n.installInstalling
    : installPhase === 'launching' ? i18n.installLaunching
    : installPhase === 'done' ? (isSetup ? i18n.setupDone : i18n.installDone)
    : installPhase === 'failed' ? (isSetup ? i18n.setupFailed : i18n.installFailed)
    : i18n.installPreparing
</script>

<div class="panel" class:loading bind:this={panelEl}>
  {#if installPhase}
    <div class="install-overlay" class:failed={installPhase === 'failed'} class:done={installPhase === 'done'}>
      <div class="install-content">
        <div class="install-spinner" class:hidden={installPhase === 'done' || installPhase === 'failed'}></div>
        <div class="install-title">{isSetup ? i18n.setupTitle : i18n.installTitle}</div>
        <div class="install-message">{installMessage}</div>
        {#if installError}
          <div class="install-error">{installError}</div>
        {/if}
      </div>
    </div>
  {/if}
  <!--
    The header is the whole of what folding removes. Everything below it is
    drawn in both states, from the same blocks - see the note on .content.
  -->
  {#if !collapsed}
    <Header
      onRefresh={refresh}
      onClose={close}
      onCollapse={() => setCollapsed(true)}
      onToggleSettings={() => { showSettings = !showSettings }}
      refreshLabel={i18n.refresh}
      settingsLabel={i18n.settings}
      closeLabel={i18n.close}
      collapseLabel={i18n.collapse}
      statusText={updatedStr}
    />
  {/if}

  {#if showSettings && settings && !collapsed}
    <SettingsPanel
      {settings}
      {exchangeRate}
      needPassword={data?.hubProblem === 'unauthorized'}
      resolvedHubUrl={data?.hubUrl ?? null}
      knownTools={(data?.quota?.tools ?? []).map((t) => ({ id: t.tool, label: t.label }))}
      hiddenTiers={data?.quota?.hiddenTiers ?? []}
      on:save={saveSettings}
      on:close={() => { showSettings = false }}
    />
  {:else}
    <!--
      One content block for both states.

      Folding is a display mode for the quota section, not a second panel.
      Every message below - a config that will not parse, a bridge that did
      not load, a hub that will not answer, nothing received yet, numbers that
      have stopped moving - is drawn by the same {#if} whether the window is
      folded or open, and the window sizes itself to its contents, so a strip
      that has something to say simply grows enough to say it.

      Written this way on purpose. The alternative - a separate strip that
      renders its own subset - is a second path, and today four failures came
      from one thing having two paths and only one of them being fixed. There
      is no place here to forget to draw a message, because there is only one
      place that draws them.
    -->
    <div class="content" class:collapsed>
      <!--
        The quota first, and above everything, because it is the reason the
        window is open. What used to be here is still below it, behind the
        toggles it always had.
      -->
      <!--
        The widget's own failures come first and on their own. They are not
        the hub being unreachable, and saying so with the same words would
        make the two impossible to tell apart from the outside.
      -->
      <!--
        First, and above the numbers, because it is the one failure that does
        not look like one: the panel underneath may be entirely correct about
        a machine nobody asked about.
      -->
      {#if data?.configProblem}
        <div class="section">
          <div class="widget-fault">{i18n.configUnreadable(data.configProblem)}</div>
        </div>
      {/if}

      {#if fault}
        <div class="section">
          <div class="widget-fault">
            {fault.kind === 'no-bridge' ? i18n.widgetNoBridge : i18n.widgetStartFailed(fault.reason)}
          </div>
        </div>
      {:else if noDataYet}
        <div class="section">
          <div class="widget-fault">{i18n.widgetNoData}</div>
        </div>
      {/if}

      <!--
        Said, not left blank. A resident panel that goes empty reads as
        broken; one that names the situation has told you what to do.
      -->
      {#if data?.hubProblem}
        <div class="section">
          <div class="hub-problem">
            {data.hubProblem === 'unauthorized'
              ? i18n.hubUnauthorized(data.hubUrl ?? '')
              : i18n.hubUnreachable(data.hubUrl ?? '')}
          </div>
        </div>
      {/if}

      {#if data?.quota}
        <!--
          A11y: noninteractive element cannot have nonnegative tabIndex value

          Silenced with the reason, not deleted, because the reason is that
          the check is wrong here and someone should be able to see why
          without re-deriving it.

          role, tabindex and the key handler are all switched by the same
          `collapsed`. Folded, this is a button and behaves like one: it has
          role="button", it is in the tab order, and Enter and Space unfold it
          exactly as a click does. Open, it is a plain div with none of the
          three. The two states are never half-applied.

          svelte-check evaluates attributes statically, so it sees a tabindex
          it cannot prove is paired with a role and reports the pairing it
          cannot see. That is a limit of the check, not a gap in the markup.

          Left as a warning it would fire on every single build. A warning
          that is always wrong is worse than no warning: it teaches everyone
          to scroll past that colour, and the day a real one appears it
          arrives in a colour people have learned to ignore. There is a
          second one of these on the laptop - see STATE.md, "常に間違う警告".
        -->
        <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
        <div
          class="section"
          role={collapsed ? 'button' : undefined}
          tabindex={collapsed ? 0 : undefined}
          title={collapsed ? i18n.expandHint : undefined}
          on:mousedown={collapsed ? stripPointerDown : undefined}
          on:mousemove={collapsed ? stripPointerMove : undefined}
          on:mouseup={collapsed ? stripPointerUp : undefined}
          on:keydown={collapsed ? (e) => { if (e.key === 'Enter' || e.key === ' ') setCollapsed(false) } : undefined}
        >
          {#if !collapsed}
            <div class="section-title">{i18n.quotaTitle}</div>
          {/if}
          <QuotaPanel
            quota={data.quota}
            {i18n}
            detail={collapsed ? 'meter' : (settings?.quotaDetail ?? 'full')}
            compact={collapsed}
            hiddenTools={settings?.hiddenTools ?? []}
          />
        </div>
      {/if}

      <!-- Primary metrics -->
      {#if settings?.showUsage && !collapsed}
      <div class="section">
        <div class="metric-grid">
          <div class="metric">
            <span class="metric-label">{i18n.today}</span>
            <span class="metric-value">{todayStr}</span>
            {#if settings?.showCost}
              <span class="metric-cost">{todayCostStr}</span>
            {/if}
          </div>
          <div class="metric">
            <span class="metric-label">{rangeLabelStr}</span>
            <span class="metric-value">{rangeStr}</span>
            {#if settings?.showCost}
              <span class="metric-cost">{rangeCostStr}</span>
            {/if}
          </div>
        </div>
      </div>
      {/if}

      <!-- Token breakdown -->
      {#if settings?.showTokenBreakdown && data && !collapsed}
        <div class="section">
          <div class="section-title">{i18n.tokenBreakdownToday}</div>
          <TokenBreakdown
            input={data.todayTokens.input}
            output={data.todayTokens.output}
            cacheRead={data.todayTokens.cacheRead}
            cacheWrite={data.todayTokens.cacheWrite}
            thinking={data.todayTokens.thinking}
          />
        </div>
      {/if}

      <!-- Activity chart -->
      {#if settings?.showHeatmap && data && !collapsed}
        <div class="section">
          <div class="section-title">{i18n.trend}</div>
          <ActivityChart
            data={data.dailyHistory}
            showCost={settings?.showCost ?? false}
            {locale}
            {currency}
            {exchangeRate}
          />
        </div>
      {/if}

      <!-- Details -->
      {#if settings?.showUsage && !collapsed}
      <div class="section details">
        <StatRow label={i18n.topModel} value={modelStr} sub={modelSubStr} />
        <StatRow label={i18n.topTool} value={toolStr} sub={toolSubStr} />
        <StatRow label={i18n.sessions} value={sessionStr} />
      </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  :global(html),
  :global(body) {
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  :global(body) {
    background: transparent;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  :global(:root) {
    --bg: oklch(0.985 0.004 175);
    --surface: oklch(0.995 0.003 175);
    --bg-hover: oklch(0.955 0.008 175);
    --border: oklch(0.92 0.008 175);
    --border-medium: oklch(0.87 0.01 175);
    --text-primary: oklch(0.18 0.012 175);
    --text-secondary: oklch(0.42 0.015 175);
    --text-muted: oklch(0.6 0.012 175);
    --accent: oklch(0.55 0.12 175);
    /* For the two lines that say the numbers above are not to be trusted. */
    --danger: oklch(0.5 0.2 25);
    --chart-input: oklch(0.65 0.14 175);
    --chart-output: oklch(0.6 0.15 250);
    --chart-cache-read: oklch(0.7 0.1 65);
    --chart-cache-write: oklch(0.65 0.12 310);
    --chart-thinking: oklch(0.6 0.16 300);
    --shadow: none;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: oklch(0.18 0.008 175);
      --surface: oklch(0.22 0.006 175);
      --bg-hover: oklch(0.26 0.01 175);
      --border: oklch(0.3 0.01 175);
      --border-medium: oklch(0.35 0.012 175);
      --text-primary: oklch(0.94 0.006 175);
      --text-secondary: oklch(0.76 0.01 175);
      --text-muted: oklch(0.58 0.008 175);
      --accent: oklch(0.65 0.12 175);
      --danger: oklch(0.75 0.17 25);
      --chart-input: oklch(0.65 0.14 175);
      --chart-output: oklch(0.6 0.15 250);
      --chart-cache-read: oklch(0.7 0.1 65);
      --chart-cache-write: oklch(0.65 0.12 310);
      --chart-thinking: oklch(0.6 0.16 300);
      --shadow: none;
    }
  }
  /*
   * Deliberately louder than the hub message. That one is a fact about
   * another machine; this one means the thing you are looking at is broken.
   */
  .widget-fault {
    font-size: 0.6875rem;
    color: var(--danger);
    font-weight: 600;
    line-height: 1.5;
  }

  .hub-problem {
    font-size: 0.6875rem;
    color: var(--danger);
    line-height: 1.5;
  }

  .panel {
    position: relative;
    background: var(--bg);
    border-radius: 10px;
    border: 1px solid var(--border);
    overflow: hidden;
    /*
     * Sized by its contents, not by the window.
     *
     * 100vw made the width whatever the window already was, so measuring it
     * could only ever report back the current size - the window could grow
     * but never shrink. max-content gives a width that does not depend on
     * the container, which is what makes it measurable.
     *
     * The bounds only guard the degenerate cases. In practice the floor is
     * the header - icon, name, time and three buttons come to about 224 -
     * so the meter-only panel stops there rather than at this number.
     */
    width: max-content;
    min-width: 200px;
    max-width: 560px;
    box-shadow: var(--shadow);
    transition: opacity 0.15s;
  }
  .panel.loading {
    opacity: 0.7;
  }
  .content {
    padding: 0 14px 8px;
  }

  /*
   * Folded: tight, and no rounded gap where the header used to be.
   *
   * The messages above the strip keep the ordinary padding, because a strip
   * that has something to say is no longer only a strip.
   */
  .content.collapsed {
    padding: 5px 10px;
  }

  .content.collapsed :global(.strip-row) {
    cursor: grab;
  }
  .section {
    padding: 8px 0;
  }
  .section:not(:last-child):not(.details) {
    border-bottom: 1px solid var(--border);
  }
  .section-title {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 8px;
  }
  .metric-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .metric {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .metric-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .metric-value {
    font-family: 'Geist Mono', 'SF Mono', 'Menlo', monospace;
    font-size: 20px;
    font-weight: 700;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }
  .metric-cost {
    font-family: 'Geist Mono', 'SF Mono', 'Menlo', monospace;
    font-size: 11px;
    font-weight: 550;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .details {
    padding: 4px 0;
  }
  .install-overlay {
    position: absolute;
    inset: 0;
    background: var(--bg);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    border-radius: 10px;
  }
  .install-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 24px;
    text-align: center;
  }
  .install-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .install-message {
    font-size: 12px;
    color: var(--text-secondary);
  }
  .install-error {
    font-size: 11px;
    color: #e74c3c;
    max-width: 280px;
    word-break: break-word;
  }
  .install-overlay.done .install-message {
    color: var(--accent);
  }
  .install-spinner {
    width: 24px;
    height: 24px;
    border: 2.5px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .install-spinner.hidden {
    display: none;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
