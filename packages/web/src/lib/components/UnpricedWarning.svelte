<script>
  /**
   * Says so when the cost on screen is missing records.
   *
   * Without this, a price table that has fallen behind the models in use
   * shows a total that is simply too low — and the natural reading of a small
   * number is "I did not use it much", not "the price is missing". That
   * misreading went unnoticed here for a long time at a total of $0.
   *
   * Nothing renders when every record is priced, which is the normal case.
   */
  import { t } from '$lib/i18n.js'

  export let unpricedRecords = 0
  /** @type {string[]} */
  export let unpricedModels = []

  const MAX_NAMED = 3

  $: names = (unpricedModels ?? []).filter(Boolean)
  $: shown = names.slice(0, MAX_NAMED).join(', ')
  $: modelList = names.length > MAX_NAMED
    ? `${shown}, ${$t('cost.unpricedAndMore')}`
    : shown
  $: message = $t('cost.unpricedWarning')
    .replace('{n}', String(unpricedRecords))
    .replace('{models}', modelList)
</script>

{#if unpricedRecords > 0}
  <div class="unpriced" role="status">
    <span class="unpriced-icon" aria-hidden="true">⚠</span>
    <div>
      <div class="unpriced-text">{message}</div>
      <a class="unpriced-link" href="/pricing">{$t('cost.unpricedLink')}</a>
    </div>
  </div>
{/if}

<style>
  .unpriced {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
    /* The error hue at low opacity, as DESIGN.md prescribes for badges. Loud
       enough to stop the eye, quiet enough not to look like a failure. */
    background: var(--danger-soft-bg);
    color: var(--danger-soft-fg);
    border-radius: var(--radius-card);
    padding: 0.6rem 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .unpriced-icon {
    flex-shrink: 0;
    line-height: 1.5;
  }

  .unpriced-text {
    color: inherit;
  }

  .unpriced-link {
    display: inline-block;
    margin-top: 0.15rem;
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
