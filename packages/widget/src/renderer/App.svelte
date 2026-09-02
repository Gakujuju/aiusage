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

  interface TodayTokens {
    total: number; input: number; output: number
    cacheRead: number; cacheWrite: number; thinking: number
  }
  interface DailyEntry { date: string; tokens: number; cost: number }
  interface WidgetData {
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
    quota?: {
      tools: Array<{ tool: string; label: string; lines: Array<{ tier: string; kind: 'five_hour' | 'week'; utilization: number; resetsInMs: number | null }> }>
      credInvalid: string[]
      staleForMs: number | null
      hiddenTiers: string[]
    }
  }
  interface WidgetSettings {
    theme: 'system' | 'light' | 'dark'
    refreshIntervalSec: number
    rangeDays: number
    notifications: boolean
    zoomFactor: number
    quotaDetail: 'meter' | 'percent' | 'full'
    hiddenTools: string[]
    showUsage: boolean
    showCost: boolean
    showHeatmap: boolean
    showTokenBreakdown: boolean
    locale: Locale
    currency: CurrencyCode
  }

  function detectInitialLocale(): Locale {
    // Only until the main process sends the saved setting, which is what
    // actually decides. This is so the first frame is not the wrong language.
    const tag = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : ''
    if (tag.startsWith('ja')) return 'ja'
    if (tag.startsWith('zh')) return 'zh'
    return 'en'
  }

  let data: WidgetData | null = null
  let settings: WidgetSettings | null = null
  let exchangeRate: ExchangeRateState | null = null
  let initialLocale: Locale = detectInitialLocale()
  let loading = true
  let showSettings = false
  let panelEl: HTMLDivElement
  let lastReportedHeight = 0
  let lastReportedWidth = 0
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
    data = await (window as any).widget.getData()
    loading = false
  }

  function close() {
    ;(window as any).widget.hideWindow()
  }

  async function doLoadSettings() {
    settings = await (window as any).widget.getSettings()
  }

  async function loadExchangeRate() {
    exchangeRate = await (window as any).widget.getExchangeRate()
  }

  async function saveSettings(e: CustomEvent<WidgetSettings>) {
    settings = await (window as any).widget.saveSettings(e.detail)
    // Re-fetch data since rangeDays may have changed
    refresh()
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
    ;(window as any).widget.resizeWindow({ width, height })
  }

  onMount(() => {
    refresh()
    doLoadSettings()
    loadExchangeRate()
    ;(window as any).widget.onDataUpdate((d: WidgetData) => {
      data = d
      loading = false
    })
    ;(window as any).widget.onInstallStatus((status: { phase: string; error?: string }) => {
      installPhase = status.phase
      installError = status.error ?? null
      if (status.phase === 'done' || status.phase === 'failed') {
        setTimeout(() => { installPhase = null; installError = null }, 3000)
      }
    })
    ;(window as any).widget.onSetupStatus((status: { phase: string; error?: string }) => {
      isSetup = true
      installPhase = status.phase
      installError = status.error ?? null
      if (status.phase === 'done' || status.phase === 'failed') {
        setTimeout(() => { installPhase = null; installError = null; isSetup = false }, 3000)
      }
    })

    const resizeObserver = new ResizeObserver(() => reportWindowHeight())
    resizeObserver.observe(panelEl)
    void tick().then(reportWindowHeight)

    return () => resizeObserver.disconnect()
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
  <Header
    onRefresh={refresh}
    onClose={close}
    onToggleSettings={() => { showSettings = !showSettings }}
    refreshLabel={i18n.refresh}
    settingsLabel={i18n.settings}
    closeLabel={i18n.close}
    statusText={updatedStr}
  />

  {#if showSettings && settings}
    <SettingsPanel
      {settings}
      {exchangeRate}
      knownTools={(data?.quota?.tools ?? []).map((t) => ({ id: t.tool, label: t.label }))}
      hiddenTiers={data?.quota?.hiddenTiers ?? []}
      on:save={saveSettings}
      on:close={() => { showSettings = false }}
    />
  {:else}
    <div class="content">
      <!--
        The quota first, and above everything, because it is the reason the
        window is open. What used to be here is still below it, behind the
        toggles it always had.
      -->
      {#if data?.quota}
        <div class="section">
          <div class="section-title">{i18n.quotaTitle}</div>
          <QuotaPanel
            quota={data.quota}
            {i18n}
            detail={settings?.quotaDetail ?? 'full'}
            hiddenTools={settings?.hiddenTools ?? []}
          />
        </div>
      {/if}

      <!-- Primary metrics -->
      {#if settings?.showUsage}
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
      {#if settings?.showTokenBreakdown && data}
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
      {#if settings?.showHeatmap && data}
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
      {#if settings?.showUsage}
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
