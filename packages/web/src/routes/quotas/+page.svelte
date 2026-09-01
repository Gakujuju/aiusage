<script>
  import { onMount } from 'svelte'
  import { t, lang } from '$lib/i18n.js'
  import { fetchQuotas, fetchQuotaHistory, fetchQuotaForecast } from '$lib/api.js'
  import QuotaChart from '$lib/components/QuotaChart.svelte'
  import { formatDuration as formatDurationWith } from '$lib/duration.js'

  /** @type {any} */
  let data = null
  /** @type {any} */
  let history = null
  /** @type {any} */
  let forecast = null
  /** @type {any} */
  let error = null
  let loading = true

  const TIER_LABEL_KEYS = {
    five_hour: 'quotas.fiveHour',
    seven_day: 'quotas.sevenDay',
    seven_day_opus: 'quotas.sevenDayOpus',
    seven_day_sonnet: 'quotas.sevenDaySonnet',
    seven_day_omelette: 'quotas.sevenDayOmelette',
    weekly_limit: 'quotas.weeklyLimit',
  }

  const TOOL_LABEL_KEYS = {
    'claude-code': 'quotas.toolLabels.claude-code',
    codex: 'quotas.toolLabels.codex',
  }

  async function load() {
    loading = true
    error = null
    try {
      data = await fetchQuotas()
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load quota data'
      data = null
    } finally {
      loading = false
    }

    // History and forecast are extra detail, not the page. If either fails the
    // live numbers above still render, so their errors are swallowed rather
    // than replacing the page with an error state.
    try {
      history = await fetchQuotaHistory({ range: 'week' })
    } catch {
      history = null
    }
    try {
      forecast = await fetchQuotaForecast()
    } catch {
      forecast = null
    }
  }

  onMount(load)

  // Fallback: convert snake_case tier names to readable labels
  // e.g. "seven_day_omelette" → "7d Omelette", "five_hour" → "5h"
  function formatUnknownTier(name) {
    return name
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .replace(/^Five Hour/i, '5h')
      .replace(/^Seven Day/i, '7d')
      .replace(/^Weekly Limit/i, 'Weekly')
  }

  function tierLabel(name) {
    const key = TIER_LABEL_KEYS[name]
    return key ? $t(key) : formatUnknownTier(name)
  }

  function toolLabel(tool) {
    const key = TOOL_LABEL_KEYS[tool]
    return key ? $t(key) : tool
  }

  function utilizationColor(pct) {
    if (pct >= 90) return 'red'
    if (pct >= 70) return 'orange'
    return 'green'
  }

  function utilizationBarColor(pct) {
    if (pct >= 90) return 'var(--rose)'
    if (pct >= 70) return 'var(--warn-solid)'
    return 'var(--green)'
  }

  function countdownStr(resetsAt) {
    if (!resetsAt) return null
    const diffMs = new Date(resetsAt).getTime() - Date.now()
    if (diffMs <= 0) return null
    const hours = Math.floor(diffMs / (1000 * 60 * 60))
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
    if (hours > 24) {
      const days = Math.floor(hours / 24)
      return `${days}d ${hours % 24}h`
    }
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  function formatQueryTime(ms) {
    if (!ms) return $t('quotas.never')
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  /** True if this quota card has any interesting data to show */
  function hasContent(quota) {
    return quota.credentialStatus !== 'not_found'
  }

  // ── Forecast and history ──────────────────────────────────────────────

  /** BCP-47 tag for Intl, from the app's language setting. */
  $: locale = $lang === 'ja' ? 'ja-JP' : $lang === 'zh' ? 'zh-CN' : 'en-US'

  /** "8/30 14:12" in ja, "Aug 30, 2:12 PM" in en — Intl decides, not us. */
  function formatDateTime(ms) {
    if (!Number.isFinite(ms)) return null
    return new Date(ms).toLocaleString(locale, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  /** Shared with /agents so the two pages measure time the same way. */
  const formatDuration = (/** @type {number} */ ms) => formatDurationWith(ms, $t)

  $: forecastByKey = new Map(
    (forecast?.forecasts ?? []).map((f) => [`${f.tool}:${f.tier}`, f]),
  )

  /**
   * Samples keyed by tool, tier and window.
   *
   * Both maps are read straight from the markup rather than through a helper.
   * Svelte tracks the reactive values an expression names, and a helper hides
   * them: a template calling seriesFor(...) never re-rendered when `history`
   * arrived, so every tier reported having no samples.
   */
  $: seriesByKey = new Map(
    (history?.series ?? []).map((s) => [`${s.tool}:${s.tier}:${s.windowId}`, s.points ?? []]),
  )

  /**
   * Whether the forecast is worth showing as numbers.
   *
   * 'low' means too few samples, or samples too far apart, to say anything —
   * the same reason quotaThresholdCrossings reports nothing without a
   * baseline. A pace and an exhaustion time carry more authority than
   * anything else on this page, so they are the first things withheld.
   */
  function isTrusted(f) {
    return f != null && f.confidence !== 'low'
  }

  /** null when there is nothing to say — 'ok' is the quiet default. */
  function riskLabel(risk) {
    if (!risk || risk === 'ok') return null
    return $t(`quotas.forecast.risk.${risk}`)
  }

  /** Quotas with credentials (to show), plus not_found ones for context */
  $: visibleQuotas = data?.quotas ?? []
  $: activeQuotas = visibleQuotas.filter(q => q.credentialStatus !== 'not_found')
  $: inactiveQuotas = visibleQuotas.filter(q => q.credentialStatus === 'not_found')
</script>

<svelte:head>
  <title>{$t('quotas.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <div class="page-header-row">
    <div>
      <h1>{$t('quotas.title')}</h1>
      <p>{$t('quotas.desc')}</p>
    </div>
    <button class="refresh-btn" on:click={load} disabled={loading}>
      <span class="refresh-icon" class:spinning={loading}>↻</span>
      {loading ? $t('quotas.refreshing') : $t('quotas.refresh')}
    </button>
  </div>
</div>

{#if loading && !data}
  <div class="state-msg"><p>{$t('common.loading')}</p></div>
{:else if error}
  <div class="state-msg error"><p>{error}</p></div>
{:else if visibleQuotas.length === 0}
  <div class="state-msg"><p>{$t('common.noData')}</p></div>
{:else}
  <!-- Active tools with credentials -->
  {#if activeQuotas.length > 0}
    <div class="quota-grid">
      {#each activeQuotas as quota (quota.tool)}
        <div class="quota-card card">
          <div class="card-header">
            <span class="tool-name">{toolLabel(quota.tool)}</span>
            <span class="query-time">{$t('quotas.lastUpdated')}: {formatQueryTime(quota.queriedAt)}</span>
          </div>

          {#if quota.credentialStatus === 'expired' && !quota.success}
            <div class="status-msg status-warn">
              <span class="status-icon">⚠</span>
              <div>
                <div class="status-title">{$t('quotas.expired')}</div>
                <div class="status-hint">{$t('quotas.expiredHint')}</div>
              </div>
            </div>
          {:else if quota.credentialStatus === 'parse_error'}
            <div class="status-msg status-error">
              <span class="status-icon">✕</span>
              <div>
                <div class="status-title">{$t('quotas.queryFailed')}</div>
                {#if quota.credentialMessage}
                  <div class="status-hint">{quota.credentialMessage}</div>
                {/if}
              </div>
            </div>
          <!-- A failed poll with stored tiers is not the same as having
               nothing: the last known numbers and this window's history are
               still worth showing. They are labelled stale below rather than
               hidden, which is what the previous version did. -->
          {:else if !quota.success && quota.tiers.length === 0}
            <div class="status-msg status-error">
              <span class="status-icon">✕</span>
              <div>
                <div class="status-title">{$t('quotas.queryFailed')}</div>
                {#if quota.error}
                  <div class="status-hint">{quota.error}</div>
                {/if}
              </div>
            </div>
          {:else if quota.tiers.length === 0}
            <div class="status-msg status-neutral">
              <span class="status-icon">○</span>
              <div class="status-title">{$t('quotas.noTiers')}</div>
            </div>
          {:else}
            <!-- Once per card, not once per tier: the whole tool is stale,
                 and saying so three times is noise, not emphasis. -->
            {#if quota.stale}
              <div class="tier-stale">
                {$t('quotas.staleValue').replace('{time}', formatQueryTime(quota.lastSuccessAt))}
              </div>
            {/if}

            <div class="tiers">
              {#each quota.tiers as tier (tier.name)}
                {@const pct = Math.min(Math.round(tier.utilization), 100)}
                {@const countdown = countdownStr(tier.resetsAt)}
                {@const f = forecastByKey.get(`${quota.tool}:${tier.name}`) ?? null}
                <!-- Keyed on the current window, so a closed window's series
                     is never drawn as though it were the present one. -->
                {@const series = (f?.windowId && seriesByKey.get(`${quota.tool}:${tier.name}:${f.windowId}`)) || []}
                {@const trusted = isTrusted(f)}
                {@const risk = riskLabel(f?.risk)}
                <div class="tier-row">
                  <div class="tier-label">
                    <span class="tier-name">{tierLabel(tier.name)}</span>
                    {#if risk}
                      <span class="risk-badge risk-{f.risk}">{risk}</span>
                    {/if}
                    {#if countdown}
                      <span class="tier-reset">↻ {countdown}</span>
                    {/if}
                  </div>
                  <div class="tier-bar-wrap">
                    <div class="tier-bar">
                      <div
                        class="tier-fill"
                        style="width: {pct}%; background: {utilizationBarColor(tier.utilization)}"
                      ></div>
                    </div>
                    <span class="tier-pct" style="color: {utilizationBarColor(tier.utilization)}">{pct}%</span>
                  </div>

                  {#if series.length > 0}
                    <QuotaChart
                      points={series}
                      resetsAt={f?.resetsAt ?? null}
                      color={utilizationBarColor(tier.utilization)}
                      ariaLabel={`${toolLabel(quota.tool)} ${tierLabel(tier.name)} ${$t('quotas.chart.label')}`}
                    />
                  {:else}
                    <div class="tier-empty">{$t('quotas.chart.empty')}</div>
                  {/if}

                  {#if f}
                    <dl class="forecast">
                      {#if trusted && f.paceRatio != null}
                        <div class="forecast-row">
                          <dt>{$t('quotas.forecast.pace')}</dt>
                          <dd class:over={f.paceRatio > 1}>
                            {f.paceRatio.toFixed(2)}×
                            <span class="forecast-note">
                              {f.paceRatio > 1
                                ? $t('quotas.forecast.paceFast')
                                : $t('quotas.forecast.paceOk')}
                            </span>
                          </dd>
                        </div>
                      {/if}

                      {#if trusted && f.exhaustAt != null}
                        <div class="forecast-row">
                          <dt>{$t('quotas.forecast.exhaustAt')}</dt>
                          <dd class:over={f.exhaustBeforeReset}>
                            {formatDateTime(f.exhaustAt)}
                            {#if f.exhaustBeforeReset}
                              <span class="forecast-note">{$t('quotas.forecast.beforeReset')}</span>
                            {/if}
                          </dd>
                        </div>
                      {/if}

                      <!-- Tiers with no resets_at (nimbus_quill) have no reset
                           row at all rather than an empty one. -->
                      {#if f.resetsAt != null}
                        {@const remaining = formatDuration(f.resetsAt - Date.now())}
                        {#if remaining}
                          <div class="forecast-row">
                            <dt>{$t('quotas.forecast.resetsIn')}</dt>
                            <dd>{remaining}<span class="forecast-note">{formatDateTime(f.resetsAt)}</span></dd>
                          </div>
                        {/if}
                      {/if}

                      {#if f.p90FinalUtilization != null}
                        <div class="forecast-row">
                          <dt>{$t('quotas.forecast.p90')}</dt>
                          <dd>{Math.round(f.p90FinalUtilization)}%<span class="forecast-note">{$t('quotas.forecast.p90Note')}</span></dd>
                        </div>
                      {/if}

                      {#if !trusted}
                        <div class="forecast-row forecast-unknown">
                          {$t('quotas.forecast.lowConfidence')}
                        </div>
                      {/if}
                    </dl>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Inactive tools (no credentials) -->
  {#if inactiveQuotas.length > 0}
    <div class="section-title" style="margin-top: {activeQuotas.length > 0 ? '2rem' : '0'}">
      {$t('common.noData')}
    </div>
    <div class="inactive-list">
      {#each inactiveQuotas as quota (quota.tool)}
        <div class="inactive-card card">
          <span class="tool-name">{toolLabel(quota.tool)}</span>
          <div class="inactive-hint">
            <span class="hint-icon">○</span>
            <span>{$t('quotas.noCredentials')} — {$t('quotas.noCredentialsHint')}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .page-header-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .refresh-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.875rem;
    background: var(--accent-dim);
    color: var(--accent);
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-input);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .refresh-btn:hover:not(:disabled) {
    background: var(--accent-dim);
    border-color: var(--accent);
  }
  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .refresh-icon {
    font-size: 0.875rem;
    display: inline-block;
  }
  .refresh-icon.spinning {
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  .quota-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 1rem;
  }

  .quota-card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .tool-name {
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text);
  }

  .query-time {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* Tiers */
  .tiers {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .tier-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .tier-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .tier-name {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .tier-reset {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .tier-bar-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .tier-bar {
    flex: 1;
    height: 6px;
    background: var(--raised);
    border-radius: 99px;
    overflow: hidden;
  }

  .tier-fill {
    height: 100%;
    border-radius: 99px;
    transition: width 0.4s ease;
  }

  .tier-pct {
    font-family: var(--mono);
    font-size: 0.75rem;
    font-weight: 600;
    width: 3rem;
    text-align: right;
    flex-shrink: 0;
  }

  /* Status messages */
  .status-msg {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.75rem;
    border-radius: var(--radius-input);
    font-size: 0.8125rem;
  }

  /* The dark variant moved into --warn-bg / --warn-fg, so this rule no longer
     needs a copy of it — and a theme now has one place to change. */
  .status-warn {
    background: var(--warn-bg);
    color: var(--warn-fg);
  }

  .status-error {
    background: var(--rose-dim);
    color: var(--rose);
  }

  .status-neutral {
    background: var(--raised);
    color: var(--text-muted);
  }

  .status-icon {
    font-size: 0.875rem;
    flex-shrink: 0;
    margin-top: 0.05rem;
  }

  .status-title {
    font-weight: 600;
    margin-bottom: 0.125rem;
  }

  .status-hint {
    font-size: 0.75rem;
    opacity: 0.8;
    line-height: 1.4;
  }

  /* Inactive list */
  .inactive-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .inactive-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.875rem 1.25rem;
    opacity: 0.6;
  }

  .inactive-hint {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .hint-icon {
    font-size: 0.75rem;
  }

  @media (max-width: 800px) {
    .quota-grid {
      grid-template-columns: 1fr;
    }
  }

  /* ── Forecast, chart and risk ──────────────────────────────────────── */

  .tier-row {
    /* Each tier now owns a block, not a line. */
    padding-bottom: 0.75rem;
  }

  .tier-row + .tier-row {
    border-top: var(--border-width) solid var(--border-subtle);
    padding-top: 0.75rem;
  }

  .risk-badge {
    font-size: 0.6875rem;
    font-weight: 550;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-badge);
  }

  /* DESIGN.md has no warning colour, and inventing one is not mine to do.
     'watch' borrows --color-info, and 'warn' and 'critical' share the error
     hue at different strengths: warn is the low-opacity badge the design
     already prescribes, critical is the solid one. Two weights of the same
     colour still read as an escalation without adding to the palette. */
  .risk-watch {
    background: var(--info-bg);
    color: var(--info-fg);
  }

  .risk-warn {
    background: var(--danger-bg);
    color: var(--danger-fg);
  }

  .risk-critical {
    background: var(--danger-solid);
    color: var(--on-danger);
  }

  .tier-stale {
    margin-bottom: 0.6rem;
    font-size: 0.75rem;
    color: var(--danger-fg);
  }

  .tier-empty {
    margin-top: 0.5rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .forecast {
    margin: 0.5rem 0 0;
    display: grid;
    gap: 0.25rem;
  }

  .forecast-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.75rem;
  }

  .forecast-row dt {
    color: var(--text-muted);
    min-width: 7.5rem;
  }

  .forecast-row dd {
    margin: 0;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .forecast-row dd.over {
    color: var(--danger-fg);
  }

  .forecast-note {
    margin-left: 0.4rem;
    font-family: inherit;
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .forecast-unknown {
    color: var(--text-muted);
    font-style: normal;
  }
</style>
