<script>
  /**
   * What every agent is doing right now.
   *
   * Deliberately not a second /sessions. That page is the record of finished
   * work, with tokens and cost as the subject, and it reads oldest-to-newest
   * like a ledger. This one answers "is anything waiting on me", so it is
   * grouped by whether action is needed and sorted by how long the wait has
   * been — a chronological list would bury the one blocked session under a
   * stream of completed ones.
   */
  import { onMount, onDestroy } from 'svelte'
  import { t, lang } from '$lib/i18n.js'
  import { fetchAgentSummary, fetchAgentSessions } from '$lib/api.js'
  import {
    groupSessions,
    isRecent,
    statusEmoji,
    statusLabelKey,
  } from '$lib/agent-status.js'
  import { formatDuration as formatDurationWith } from '$lib/duration.js'

  /** @type {any} */
  let sessions = []
  /** @type {any} */
  let summary = null
  /** @type {any} */
  let error = null
  let loading = true
  let showAll = false
  let total = 0

  const POLL_MS = 5000
  const MAX_ROWS = 50

  /** @type {any} */
  let timer = null

  /** @type {Record<string, string>} */
  const TOOL_LABEL_KEYS = {
    'claude-code': 'quotas.toolLabels.claude-code',
    codex: 'quotas.toolLabels.codex',
  }

  /** @param {string} tool */
  function toolLabel(tool) {
    const key = TOOL_LABEL_KEYS[tool]
    return key ? $t(key) : tool
  }

  async function load() {
    try {
      const [nextSummary, nextSessions] = await Promise.all([
        fetchAgentSummary(),
        fetchAgentSessions({ limit: String(MAX_ROWS * 4) }),
      ])
      summary = nextSummary
      sessions = nextSessions?.sessions ?? []
      total = nextSessions?.total ?? sessions.length
      error = null
    } catch (e) {
      // The previous board stays on screen. A momentary failure is not a
      // reason to blank out what the reader was looking at — the same
      // reasoning as showing a stale quota rather than nothing.
      error = e instanceof Error ? e.message : 'Failed to load agent sessions'
    } finally {
      loading = false
    }
  }

  function startPolling() {
    stopPolling()
    timer = setInterval(load, POLL_MS)
  }

  function stopPolling() {
    if (timer != null) clearInterval(timer)
    timer = null
  }

  /**
   * A board left open on a second monitor is the normal case, and polling a
   * hidden tab every five seconds buys nothing. Coming back asks immediately
   * rather than waiting out an interval, because the first thing a returning
   * reader wants is the current state, not the state from five seconds ago.
   */
  function onVisibilityChange() {
    if (document.hidden) {
      stopPolling()
    } else {
      void load()
      startPolling()
    }
  }

  onMount(() => {
    void load()
    startPolling()
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onDestroy(() => {
    stopPolling()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  })

  // Ticks so the "waiting for 3 minutes" figures advance between polls.
  let now = Date.now()
  const clock = setInterval(() => { now = Date.now() }, 1000)
  onDestroy(() => clearInterval(clock))

  $: locale = $lang === 'ja' ? 'ja-JP' : $lang === 'zh' ? 'zh-CN' : 'en-US'

  /** Shared with /quotas so the two pages measure time the same way. */
  const formatDuration = (/** @type {number} */ ms) => formatDurationWith(ms, $t)

  /** @param {number} n */
  function formatTokens(n) {
    if (!Number.isFinite(n) || n <= 0) return null
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
    return String(n)
  }

  /** @param {number} n */
  function formatCost(n) {
    if (!Number.isFinite(n) || n <= 0) return null
    return `$${n.toFixed(2)}`
  }

  $: visible = showAll ? sessions : sessions.filter((/** @type {any} */ s) => isRecent(s, now))
  $: truncated = Math.max(0, visible.length - MAX_ROWS)
  /** @type {Array<{ id: string, sessions: any[] }>} */
  $: groups = groupSessions(visible.slice(0, MAX_ROWS))
</script>

<svelte:head>
  <title>{$t('agents.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <div class="page-header-row">
    <div>
      <h1>{$t('agents.title')}</h1>
      <p>{$t('agents.desc')}</p>
    </div>
    <label class="show-all">
      <input type="checkbox" bind:checked={showAll} />
      {$t('agents.showAll')}
    </label>
  </div>
</div>

{#if error}
  <!-- Above the board, not instead of it: the rows below are the last good
       reading and are more use than an empty page. -->
  <div class="poll-error">{$t('agents.pollFailed')}</div>
{/if}

{#if loading && sessions.length === 0}
  <div class="state-msg"><p>{$t('common.loading')}</p></div>
{:else if sessions.length === 0}
  <div class="state-msg">
    <p>{$t('agents.empty')}</p>
    <p class="hint">{$t('agents.emptyHint')}</p>
  </div>
{:else}
  {#if summary?.statusCounts}
    <div class="counts">
      {#each Object.entries(summary.statusCounts) as [status, count] (status)}
        <div class="count">
          <span class="count-emoji">{statusEmoji(status, '')}</span>
          <span class="count-n">{count}</span>
          <span class="count-label">{$t(statusLabelKey(status, ''))}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#each groups as group (group.id)}
    <div class="group">
      <h2 class="group-title">
        {$t(`agents.group.${group.id}`)}
        <span class="group-count">{group.sessions.length}</span>
      </h2>

      {#each group.sessions as session (session.id)}
        {@const labelKey = statusLabelKey(session.status, session.lastEventKind)}
        {@const waited = formatDuration(now - session.statusSince)}
        {@const tokens = formatTokens(session.usage?.totalTokens)}
        {@const cost = formatCost(session.usage?.totalCost)}
        {@const linkable = (session.usage?.recordCount ?? 0) > 0}
        <div class="agent-row card" class:needs-action={group.id === 'needsAction'}>
          <div class="agent-head">
            <span class="agent-status">
              <span class="agent-emoji">{statusEmoji(session.status, session.lastEventKind)}</span>
              {$t(labelKey)}
            </span>
            {#if waited}
              <span class="agent-waited">{$t('agents.forDuration').replace('{time}', waited)}</span>
            {/if}
            {#if session.stale}
              <span class="agent-stale">{$t('agents.stale')}</span>
            {/if}
          </div>

          <div class="agent-meta">
            <span>{toolLabel(session.tool)}</span>
            <span class="sep">·</span>
            <span>{session.device || $t('agents.unknownDevice')}</span>
            {#if session.projectDisplayName}
              <span class="sep">·</span>
              <!-- Whatever the extractor produced, including the odd values
                   left in older rows. Rewriting them here would hide them. -->
              <span class="agent-project">{session.projectDisplayName}</span>
            {/if}
          </div>

          <dl class="agent-stats">
            <div><dt>{$t('agents.turns')}</dt><dd>{session.turnCount ?? 0}</dd></div>
            {#if formatDuration(session.durations?.runningMs)}
              <div><dt>{$t('agents.working')}</dt><dd>{formatDuration(session.durations?.runningMs)}</dd></div>
            {/if}
            {#if formatDuration(session.durations?.waitingForPermissionMs)}
              <div><dt>{$t('agents.waitingPermission')}</dt><dd>{formatDuration(session.durations?.waitingForPermissionMs)}</dd></div>
            {/if}
            {#if formatDuration(session.durations?.waitingForUserMs)}
              <div><dt>{$t('agents.waitingUser')}</dt><dd>{formatDuration(session.durations?.waitingForUserMs)}</dd></div>
            {/if}
            {#if tokens}
              <div><dt>{$t('agents.tokens')}</dt><dd>{tokens}</dd></div>
            {/if}
            {#if cost}
              <div><dt>{$t('agents.cost')}</dt><dd>{cost}</dd></div>
            {/if}
          </dl>

          <!-- No link without usage rows: /sessions/<id> is built from
               records, and a session with none of them 404s. -->
          {#if linkable}
            <a class="agent-link" href="/sessions/{session.agentSessionId}">
              {$t('agents.openSession')}
            </a>
          {/if}
        </div>
      {/each}
    </div>
  {/each}

  {#if truncated > 0}
    <div class="truncated">
      {$t('agents.truncated').replace('{n}', String(truncated))}
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

  .show-all {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8125rem;
    color: var(--text-secondary, var(--color-text-secondary));
    white-space: nowrap;
    cursor: pointer;
  }

  .poll-error {
    background: oklch(0.58 0.2 25 / 0.08);
    color: oklch(0.42 0.15 25);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.8125rem;
  }

  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin-bottom: 1.5rem;
  }

  .count {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    font-size: 0.8125rem;
  }

  .count-n {
    font-family: var(--font-mono, monospace);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .count-label {
    color: var(--text-muted, var(--color-text-muted));
  }

  .group {
    margin-bottom: 1.75rem;
  }

  .group-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted, var(--color-text-muted));
    margin: 0 0 0.6rem;
  }

  .group-count {
    font-family: var(--font-mono, monospace);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }

  .agent-row {
    padding: 0.75rem 0.875rem;
    margin-bottom: 0.5rem;
  }

  /* The one group that is blocked on a person. A left edge rather than a
     background: the row still has to read as the same kind of thing. */
  .agent-row.needs-action {
    border-left: 3px solid oklch(0.55 0.14 250);
    padding-left: 0.6rem;
  }

  .agent-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .agent-status {
    font-weight: 550;
    font-size: 0.875rem;
  }

  .agent-waited,
  .agent-stale {
    font-size: 0.75rem;
    color: var(--text-muted, var(--color-text-muted));
  }

  .agent-stale {
    color: oklch(0.48 0.2 25);
  }

  .agent-meta {
    margin-top: 0.2rem;
    font-size: 0.75rem;
    color: var(--text-secondary, var(--color-text-secondary));
  }

  .sep {
    margin: 0 0.35rem;
    color: var(--text-muted, var(--color-text-muted));
  }

  .agent-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.25rem;
    margin: 0.5rem 0 0;
  }

  .agent-stats > div {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    font-size: 0.75rem;
  }

  .agent-stats dt {
    color: var(--text-muted, var(--color-text-muted));
  }

  .agent-stats dd {
    margin: 0;
    font-family: var(--font-mono, monospace);
    font-variant-numeric: tabular-nums;
  }

  .agent-link {
    display: inline-block;
    margin-top: 0.5rem;
    font-size: 0.75rem;
    color: var(--accent, oklch(0.55 0.12 175));
    text-decoration: none;
  }

  .agent-link:hover {
    text-decoration: underline;
  }

  .truncated,
  .hint {
    font-size: 0.75rem;
    color: var(--text-muted, var(--color-text-muted));
  }
</style>
