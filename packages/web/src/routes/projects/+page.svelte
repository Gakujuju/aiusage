<script>
  import { dateRange, selectedDevice, selectedTool, formatTokens, formatCost, formatNumber } from '$lib/stores.js'
  import { fetchProjects } from '$lib/api.js'
  import { t } from '$lib/i18n.js'
  import CostCaveats from '$lib/components/CostCaveats.svelte'
  import DateRangeSelector from '$lib/components/DateRangeSelector.svelte'
  import DeviceSelector from '$lib/components/DeviceSelector.svelte'
  import ToolSelector from '$lib/components/ToolSelector.svelte'

  /** @type {any} */


  let data = null
  /** @type {any} */

  let error = null
  let loading = true

  async function loadData() {
    loading = true
    error = null
    try {
      data = await fetchProjects({ ...$dateRange, device: $selectedDevice, tool: $selectedTool })
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load data'
      data = null
    } finally {
      loading = false
    }
  }

  $: $dateRange, $selectedDevice, $selectedTool, loadData()
</script>

<svelte:head>
  <title>{$t('projects.title')} — AIUsage</title>
</svelte:head>

<CostCaveats
  unpricedRecords={data?.unpricedRecords ?? 0}
  unpricedModels={data?.unpricedModels ?? []}
  breakdownMissingRecords={data?.breakdownMissingRecords ?? 0}
  acknowledgedUnpricedRecords={data?.acknowledgedUnpricedRecords ?? 0}
  acknowledgedUnpricedModels={data?.acknowledgedUnpricedModels ?? []}
/>

<div class="page-header">
  <h1>{$t('projects.title')}</h1>
  <p>{$t('projects.desc')}</p>
</div>

<div class="filter-bar">
  <DateRangeSelector />
  <DeviceSelector />
  <ToolSelector />
</div>

{#if loading}
  <div class="state-msg">{$t('common.loading')}</div>
{:else if error}
  <div class="state-msg error">{error}</div>
{:else if !data?.projects.length}
  <div class="state-msg">
    <h2>{$t('projects.noData')}</h2>
    <p>{$t('projects.noDataHint')}</p>
  </div>
{:else}
  <div class="ranking">
    {#each data.projects as proj, i}
      <div class="row animate-row">
        <span class="rank mono">#{i + 1}</span>
        <span class="name mono" title={proj.fullPath || proj.name}>
          {proj.name}
          {#if proj.fullPath && proj.fullPath !== proj.name}
            <span class="path">{proj.fullPath}</span>
          {/if}
        </span>
        <div class="bar-container">
          <div class="bar" style="width: {proj.percentage}%"></div>
        </div>
        <span class="tokens mono">{formatTokens(proj.tokens)}</span>
        <span class="cost mono accent">{formatCost(proj.cost)}</span>
        <span class="pct mono">{proj.percentage.toFixed(1)}%</span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .ranking {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .row {
    display: grid;
    grid-template-columns: 2.5rem 16rem 1fr 5.5rem 4.5rem 3.5rem;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 0.85rem;
    background: var(--surface);
    border-radius: var(--radius-card);
    transition: background 0.15s;
  }
  .row:hover {
    background: var(--hover);
  }
  .rank {
    color: var(--text-muted);
    font-size: 0.75rem;
  }
  .name {
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .path {
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar-container {
    height: 6px;
    background: var(--raised);
    border-radius: var(--radius-xs);
    overflow: hidden;
  }
  .bar {
    height: 100%;
    background: var(--accent);
    border-radius: var(--radius-xs);
    transition: width 0.6s ease;
  }
  .tokens {
    text-align: right;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text);
  }
  .cost {
    text-align: right;
    font-size: 0.8rem;
  }
  .pct {
    text-align: right;
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .animate-row {
    animation: fadeIn 0.2s ease both;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /*
   * The desktop row is a six-column grid whose fixed columns alone need
   * 572px, so on a phone it dragged the whole page sideways. Unlike the
   * tables on /sessions and /tokens this list has no header row, so the
   * columns that scrolled out of view would have come back as three bare
   * numbers with nothing naming them — that is why this one page stacks
   * instead of scrolling. 640px is where the row stops fitting (viewport
   * minus the 1rem page padding at the mobile breakpoint), not a new
   * design breakpoint; above it the grid above is untouched.
   */
  @media (max-width: 640px) {
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem 0.6rem;
    }
    .rank {
      flex: 0 0 auto;
    }
    .name {
      flex: 1 1 0;
      min-width: 0;
    }
    .bar-container {
      flex: 1 0 100%;
    }
    .tokens {
      flex: 1 1 auto;
      text-align: left;
    }
    .cost,
    .pct {
      flex: 0 0 auto;
    }
  }
</style>
