<script>
  /**
   * Says why the cost on screen is not the whole story.
   *
   * Two reasons, and they are kept apart because only one of them is the
   * reader's to fix.
   *
   * A missing price understates the total, and the natural reading of a small
   * number is "I did not use it much" rather than "the price is missing".
   * That misreading went unnoticed here for a long time at a total of $0. The
   * remedy is real: edit the price table.
   *
   * A missing breakdown has no remedy. Codex desktop sessions report a lump
   * total with no split, so there is nothing to multiply a price by, and the
   * rows are recorded at zero on purpose. These used to be counted as unpriced
   * — which named models that already had prices and sent the reader to a
   * price table that was not wrong, where no edit could ever silence the
   * warning. So this half says what is true and offers no link: there is
   * nowhere useful to send them.
   *
   * Nothing renders when neither applies, which is the normal case.
   */
  import { t } from '$lib/i18n.js'

  export let unpricedRecords = 0
  /** @type {string[]} */
  export let unpricedModels = []
  export let breakdownMissingRecords = 0
  export let acknowledgedUnpricedRecords = 0
  /**
   * Whether to render the two quiet lines here at all.
   *
   * They describe one number — the total cost — not the whole page. On a
   * screen where that number is the subject, they belong beside it rather
   * than in a full-width box above everything: put at the top they sit
   * higher and larger than the figure they qualify, and on a phone they
   * took a third of the screen to say something nobody can act on.
   *
   * The warning above them is a different matter and always renders. It can
   * be acted on and it goes away once it is.
   */
  export let showQuiet = true
  /** @type {string[]} */
  export let acknowledgedUnpricedModels = []

  const MAX_NAMED = 3

  $: names = (unpricedModels ?? []).filter(Boolean)
  $: shown = names.slice(0, MAX_NAMED).join(', ')
  $: modelList = names.length > MAX_NAMED
    ? `${shown}, ${$t('cost.unpricedAndMore')}`
    : shown
  $: unpricedMessage = $t('cost.unpricedWarning')
    .replace('{n}', String(unpricedRecords))
    .replace('{models}', modelList)
  $: breakdownMessage = $t('cost.breakdownMissingNote')
    .replace('{n}', String(breakdownMissingRecords))

  $: ackNames = (acknowledgedUnpricedModels ?? []).filter(Boolean)
  $: ackShown = ackNames.slice(0, MAX_NAMED).join(', ')
  $: ackList = ackNames.length > MAX_NAMED
    ? `${ackShown}, ${$t('cost.unpricedAndMore')}`
    : ackShown
  $: acknowledgedMessage = $t('cost.noPublishedRateNote')
    .replace('{n}', String(acknowledgedUnpricedRecords))
    .replace('{models}', ackList)
</script>

{#if unpricedRecords > 0}
  <div class="caveat" role="status">
    <span class="caveat-icon" aria-hidden="true">⚠</span>
    <div>
      <div class="caveat-text">{unpricedMessage}</div>
      <a class="caveat-link" href="/pricing">{$t('cost.unpricedLink')}</a>
    </div>
  </div>
{/if}

<!--
  A third line rather than folding into the second.

  "no split to price" and "no published rate" are different facts about
  different rows, and a reader who wants to know why a figure is low is owed
  the actual reason. Both are quiet, because neither can be acted on — which
  is exactly what separates them from the warning above.
-->
{#if showQuiet && acknowledgedUnpricedRecords > 0}
  <div class="caveat caveat-quiet" role="status">
    <span class="caveat-icon" aria-hidden="true">ⓘ</span>
    <div class="caveat-text">{acknowledgedMessage}</div>
  </div>
{/if}

{#if showQuiet && breakdownMissingRecords > 0}
  <!-- Quieter than the one above: nothing is broken and there is nothing to
       do, so it states a limit rather than asking for action. -->
  <div class="caveat caveat-quiet" role="status">
    <span class="caveat-icon" aria-hidden="true">ⓘ</span>
    <div class="caveat-text">{breakdownMessage}</div>
  </div>
{/if}

<style>
  .caveat {
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

  /* No warning colour: this is a statement of fact, not a fault to fix. */
  .caveat-quiet {
    background: var(--raised);
    color: var(--text-muted);
  }

  .caveat-icon {
    flex-shrink: 0;
    line-height: 1.5;
  }

  .caveat-text {
    color: inherit;
  }

  .caveat-link {
    display: inline-block;
    margin-top: 0.15rem;
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
