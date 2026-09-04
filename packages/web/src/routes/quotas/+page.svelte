<script>
  import { onMount } from 'svelte'
  import { t, lang } from '$lib/i18n.js'
  import { fetchQuotas, fetchQuotaHistory, fetchQuotaForecast } from '$lib/api.js'
  import QuotaCard from '$lib/components/QuotaCard.svelte'
  import { toolLabel as toolLabelWith } from '$lib/quota.js'

  /** @type {any} */
  let data = null
  /** @type {any} */
  let history = null
  /** @type {any} */
  let forecast = null
  /** @type {any} */
  let error = null
  let loading = true

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

  const toolLabel = (tool) => toolLabelWith(tool, $t)

  // ── Forecast and history ──────────────────────────────────────────────

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
        <QuotaCard {quota} {forecastByKey} {seriesByKey} />
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
</style>
