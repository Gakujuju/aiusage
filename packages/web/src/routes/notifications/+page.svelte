<script>
  /**
   * What was sent, what failed, and what is still queued.
   *
   * Not polled. Unlike /agents this does not change while you watch it — a
   * notification is written once and then either goes out or does not — so a
   * request every five seconds would buy nothing. The reload button is there
   * for the one moment it matters, right after retrying something.
   */
  import { onMount } from 'svelte'
  import { t, lang } from '$lib/i18n.js'
  import {
    fetchNotifications,
    fetchNotificationSummary,
    retryNotification,
  } from '$lib/api.js'
  import { formatDuration } from '$lib/duration.js'

  /** @type {any} */
  let rows = []
  /** @type {any} */
  let summary = null
  /** @type {any} */
  let error = null
  let loading = true
  let total = 0
  let stateFilter = ''
  /** @type {string | null} */
  let retrying = null
  /** @type {Set<string>} */
  let expanded = new Set()

  const MAX_ROWS = 100

  /** The states the outbox moves through, in the order it moves through them. */
  const STATES = ['pending', 'sending', 'sent', 'failed', 'dropped']

  async function load() {
    loading = true
    try {
      const [nextSummary, nextRows] = await Promise.all([
        fetchNotificationSummary(),
        fetchNotifications({
          limit: String(MAX_ROWS),
          state: stateFilter || undefined,
        }),
      ])
      summary = nextSummary
      rows = nextRows?.notifications ?? []
      total = nextRows?.total ?? rows.length
      error = null
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load notifications'
    } finally {
      loading = false
    }
  }

  onMount(load)

  /** @param {string} id */
  async function retry(id) {
    retrying = id
    try {
      await retryNotification(id)
      // Re-read rather than patching the row: retry changes state, attempts
      // and next_attempt_at, and guessing at them here would drift.
      await load()
    } catch (e) {
      error = e instanceof Error ? e.message : 'Retry failed'
    } finally {
      retrying = null
    }
  }

  /** @param {string} id */
  function toggle(id) {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expanded = next
  }

  $: locale = $lang === 'ja' ? 'ja-JP' : $lang === 'zh' ? 'zh-CN' : 'en-US'

  /** @param {number} ms */
  function formatTime(ms) {
    if (!Number.isFinite(ms)) return null
    return new Date(ms).toLocaleString(locale, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  }

  $: truncated = Math.max(0, total - rows.length)

  function applyFilter() {
    void load()
  }
</script>

<svelte:head>
  <title>{$t('notifications.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <div class="page-header-row">
    <div>
      <h1>{$t('notifications.title')}</h1>
      <p>{$t('notifications.desc')}</p>
    </div>
    <button class="refresh-btn" on:click={load} disabled={loading}>
      {loading ? $t('quotas.refreshing') : $t('quotas.refresh')}
    </button>
  </div>
</div>

{#if error}
  <div class="state-msg error"><p>{error}</p></div>
{/if}

{#if summary?.stateCounts}
  <div class="counts">
    {#each STATES as state (state)}
      {#if summary.stateCounts[state]}
        <div class="count">
          <span class="count-n">{summary.stateCounts[state]}</span>
          <span class="count-label state-{state}">{$t(`notifications.state.${state}`)}</span>
        </div>
      {/if}
    {/each}
  </div>
{/if}

<div class="filter-bar">
  <select bind:value={stateFilter} on:change={applyFilter} class="field-input" aria-label={$t('notifications.filterState')}>
    <option value="">{$t('common.all')}</option>
    {#each STATES as state (state)}
      <option value={state}>{$t(`notifications.state.${state}`)}</option>
    {/each}
  </select>
</div>

{#if loading && rows.length === 0}
  <div class="state-msg"><p>{$t('common.loading')}</p></div>
{:else if rows.length === 0}
  <div class="state-msg"><p>{$t('notifications.empty')}</p></div>
{:else}
  <div class="rows">
    {#each rows as row (row.id)}
      <div class="notif card">
        <div class="notif-head">
          <span class="notif-state state-{row.state}">{$t(`notifications.state.${row.state}`)}</span>
          <span class="notif-time">{formatTime(row.createdAt)}</span>
          <span class="notif-event">{row.eventType}</span>
          {#if row.attempts > 0}
            <span class="notif-attempts">
              {$t('notifications.attempts').replace('{n}', String(row.attempts))}
            </span>
          {/if}
        </div>

        <div class="notif-title">{row.title}</div>

        {#if row.body}
          <!-- Collapsed by default: the body carries the response preview and
               is several lines, which would swamp a list of fifty. -->
          <button type="button" class="notif-toggle" on:click={() => toggle(row.id)}>
            {expanded.has(row.id) ? $t('notifications.hideBody') : $t('notifications.showBody')}
          </button>
          {#if expanded.has(row.id)}
            <pre class="notif-body">{row.body}</pre>
          {/if}
        {/if}

        {#if row.lastError}
          <!-- Already masked server-side; displayed as-is so a real failure
               is legible rather than reduced to "an error occurred". -->
          <div class="notif-error">{row.lastError}</div>
        {/if}

        <div class="notif-foot">
          {#if row.sentAt}
            <span>{$t('notifications.sentAt')}: {formatTime(row.sentAt)}</span>
          {/if}
          {#if row.nextAttemptAt && row.state !== 'sent'}
            {@const wait = formatDuration(row.nextAttemptAt - Date.now(), $t)}
            {#if wait}
              <span>{$t('notifications.nextAttempt').replace('{time}', wait)}</span>
            {/if}
          {/if}
          {#if row.state === 'failed'}
            <button type="button" class="btn-ghost retry-btn"
              on:click={() => retry(row.id)} disabled={retrying === row.id}>
              {retrying === row.id ? '...' : $t('notifications.retry')}
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  {#if truncated > 0}
    <div class="truncated">
      {$t('notifications.truncated').replace('{n}', String(truncated))}
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
    padding: 0.4rem 0.875rem;
    background: var(--accent-dim);
    color: var(--accent);
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-input);
    font-size: 0.8125rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin-bottom: 1rem;
  }

  .count {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    font-size: 0.8125rem;
  }

  .count-n {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .filter-bar {
    margin-bottom: 1rem;
  }

  .filter-bar select {
    max-width: 14rem;
  }

  .notif {
    padding: 0.7rem 0.875rem;
    margin-bottom: 0.5rem;
  }

  .notif-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.6rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .notif-state {
    font-weight: 550;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  /* Two weights of the same error hue, as elsewhere: failed is the state to
     act on, dropped is one nothing can be done about. */
  .state-failed { color: var(--danger-fg); }
  .state-dropped { color: var(--text-muted); }
  .state-sent { color: var(--success-fg); }
  .state-pending,
  .state-sending { color: var(--info-fg); }

  .notif-title {
    margin-top: 0.25rem;
    font-size: 0.875rem;
  }

  .notif-toggle {
    margin-top: 0.35rem;
    padding: 0;
    background: none;
    border: none;
    color: var(--accent);
    font-size: 0.75rem;
    cursor: pointer;
  }

  .notif-body {
    margin: 0.35rem 0 0;
    padding: 0.5rem 0.6rem;
    background: var(--raised);
    border-radius: var(--radius-input);
    font-size: 0.75rem;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .notif-error {
    margin-top: 0.35rem;
    font-size: 0.75rem;
    color: var(--danger-fg);
    word-break: break-word;
  }

  .notif-foot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-top: 0.4rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .retry-btn {
    margin-left: auto;
  }

  .truncated {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
</style>
