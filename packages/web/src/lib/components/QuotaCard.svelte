<script>
  /**
   * One tool's quota: its tiers, their bars and numbers, and - where the
   * caller fetched them - the chart and forecast under each tier.
   *
   * Lifted out of the quotas page so the home page can draw the same thing.
   * Not a second rendering: this is the one card, placed in two routes. A
   * home-page copy would have been the widget's lesson again - two paths for
   * one display, and a day when only one of them is fixed.
   */
  import { t, lang } from '$lib/i18n.js'
  import QuotaChart from '$lib/components/QuotaChart.svelte'
  import { formatDuration as formatDurationWith } from '$lib/duration.js'
  import {
    tierLabel as tierLabelWith,
    toolLabel as toolLabelWith,
    utilizationBarColor,
    utilizationColor,
    countdownStr,
    formatQueryTime as formatQueryTimeWith,
    isTrusted,
    riskLabel as riskLabelWith,
  } from '$lib/quota.js'

  /** One entry of /api/quotas. */
  export let quota
  /** Forecasts keyed "tool:tier", from /api/quotas/forecast. Empty when not fetched. */
  export let forecastByKey = new Map()
  /** Sample series keyed "tool:tier:windowId", from /api/quotas/history. Empty when not fetched. */
  export let seriesByKey = new Map()
  /**
   * Draw the chart slot under each tier. Off where no history was fetched:
   * a card that says "no chart data" about data nobody asked for is a
   * card announcing a fault that is not there.
   */
  export let charts = true

  const tierLabel = (name) => tierLabelWith(name, $t)
  const toolLabel = (tool) => toolLabelWith(tool, $t)
  const formatQueryTime = (ms) => formatQueryTimeWith(ms, $t)
  const riskLabel = (risk) => riskLabelWith(risk, $t)

  /** BCP-47 tag for Intl, from the app's language setting. */
  $: locale = $lang === 'ja' ? 'ja-JP' : $lang === 'zh' ? 'zh-CN' : 'en-US'

  /** "8/30 14:12" in ja, "Aug 30, 2:12 PM" in en - Intl decides, not us. */
  function formatDateTime(ms) {
    if (!Number.isFinite(ms)) return null
    return new Date(ms).toLocaleString(locale, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  /** Shared with /agents so the two pages measure time the same way. */
  const formatDuration = (/** @type {number} */ ms) => formatDurationWith(ms, $t)
</script>

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
            <!-- level-* names the threshold band so a theme without colour
                 can mark it another way (see the mono rules in the layout). -->
            <span class="tier-pct level-{utilizationColor(tier.utilization)}">{pct}%</span>
          </div>

          {#if charts}
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

<style>
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

  /*
   * Coloured by class, not inline. An inline colour beats every stylesheet
   * rule, which is how the mono theme first drew its inverted 95% as ink on
   * ink: the white digits were set by a rule, the ink by the attribute, and the
   * attribute won. The three tokens are the ones utilizationBarColor gives the
   * bar, so the number and the bar still agree.
   */
  .tier-pct.level-green { color: var(--green); }
  .tier-pct.level-orange { color: var(--warn-solid); }
  .tier-pct.level-red { color: var(--rose); }

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
