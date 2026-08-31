<script>
  /**
   * Says so when the numbers on screen have stopped being updated.
   *
   * The scheduled parse writes a log line only when it found something, so a
   * quiet log means either "nothing to parse" or "not parsing" and there is
   * no telling which from outside. That ambiguity is the whole reason this
   * exists: the log carries events, /api/health carries the state, and the
   * state is put where someone is already looking rather than left in a
   * terminal nobody is tailing.
   *
   * The verdict is the server's. Nothing is recomputed here, so this band and
   * the notification cannot disagree about whether anything is wrong.
   *
   * Nothing renders while parsing is healthy, which is the normal case.
   */
  import { onMount, onDestroy } from 'svelte'
  import { t } from '$lib/i18n.js'
  import { fetchHealth } from '$lib/api.js'

  /** Often enough to clear within a minute of recovery, rarely enough to cost nothing. */
  const POLL_MS = 60_000

  /** @type {{ lastParseOkAt: number | null, intervalMs: number, stalled: boolean, stalledSince: number | null } | null} */
  let parse = null
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null

  async function load() {
    try {
      const health = await fetchHealth()
      parse = health?.parse ?? null
    } catch {
      // A failed request says nothing about parsing — it is far more likely
      // to be a lost network or an expired session, and claiming a stall on
      // that evidence would be the same guessing this endpoint replaces.
      parse = null
    }
  }

  onMount(() => {
    load()
    timer = setInterval(load, POLL_MS)
  })

  onDestroy(() => {
    if (timer != null) clearInterval(timer)
  })

  const minutes = (/** @type {number} */ ms) => String(Math.max(0, Math.round(ms / 60000)))

  $: stalledSince = parse?.stalled ? parse.stalledSince : null
  $: message = stalledSince == null ? '' : $t('health.stalledBody')
    .replace('{minutes}', minutes(Date.now() - stalledSince))
    .replace('{interval}', minutes(parse?.intervalMs ?? 0))
</script>

{#if stalledSince != null}
  <div class="stalled" role="status">
    <span class="stalled-icon" aria-hidden="true">⚠</span>
    <div>
      <div class="stalled-title">{$t('health.stalledTitle')}</div>
      <div class="stalled-text">{message}</div>
    </div>
  </div>
{/if}

<style>
  .stalled {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
    /* The error hue at low opacity, as DESIGN.md prescribes for badges.
       Loud enough to stop the eye, quiet enough not to look like a crash —
       the server is up, it is the data that is behind. */
    background: var(--danger-soft-bg);
    color: var(--danger-soft-fg);
    border-radius: var(--radius-card);
    padding: 0.6rem 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .stalled-icon {
    flex-shrink: 0;
    line-height: 1.5;
  }

  .stalled-title {
    font-weight: 600;
  }

  .stalled-text {
    color: inherit;
  }
</style>
