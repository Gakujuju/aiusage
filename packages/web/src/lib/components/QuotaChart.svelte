<script>
  /**
   * Utilization over the life of one quota window.
   *
   * Hand-drawn SVG rather than a charting library: the only dependency this
   * package has is lucide-svelte, a library would be most of the bundle for
   * one line each, and DESIGN.md's motion rules are easier to honour than to
   * configure away.
   *
   * Sized entirely in viewBox units and stretched by CSS, so it is already
   * fluid — 8-B can make it properly responsive without unpicking anything.
   */
  /** @type {Array<{ ts: number, utilization: number }>} */
  export let points = []
  /** @type {number | null} */
  export let resetsAt = null
  export let color = 'var(--accent)'
  export let ariaLabel = ''

  // viewBox space. Not pixels: the element is width:100% and scales.
  const W = 600
  const H = 140
  const PAD_L = 34
  const PAD_R = 12
  const PAD_T = 10
  const PAD_B = 22

  const GRID = [0, 25, 50, 75, 100]

  $: sorted = [...(points ?? [])]
    .filter((p) => p && Number.isFinite(p.ts) && Number.isFinite(p.utilization))
    .sort((a, b) => a.ts - b.ts)

  // The reset line only earns its place inside the drawn range; a marker
  // pinned to the right edge would claim a precision the axis does not have.
  $: resetTs = Number.isFinite(resetsAt) ? resetsAt : null

  $: minTs = sorted.length ? sorted[0].ts : 0
  $: maxTs = sorted.length
    ? Math.max(sorted[sorted.length - 1].ts, resetTs ?? 0)
    : 0
  // A window observed once, or twice within the same second, has no width.
  // Give it one so every point lands mid-plot instead of dividing by zero.
  $: span = maxTs - minTs > 0 ? maxTs - minTs : 1

  $: x = (/** @type {number} */ ts) => PAD_L + ((ts - minTs) / span) * (W - PAD_L - PAD_R)
  $: y = (/** @type {number} */ pct) => PAD_T + (1 - Math.min(Math.max(pct, 0), 100) / 100) * (H - PAD_T - PAD_B)

  $: line = sorted.map((p) => `${x(p.ts).toFixed(1)},${y(p.utilization).toFixed(1)}`).join(' ')

  // Closing the polyline along the baseline gives the fill; the line itself
  // stays a separate element so it keeps full opacity.
  $: area = sorted.length > 1
    ? `${PAD_L},${y(0)} ${line} ${x(sorted[sorted.length - 1].ts).toFixed(1)},${y(0)}`
    : ''

  $: resetX = resetTs != null && resetTs >= minTs && resetTs <= maxTs ? x(resetTs) : null

  /** @param {number} ts */
  function clockLabel(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
</script>

{#if sorted.length > 0}
  <svg
    class="quota-chart"
    viewBox="0 0 {W} {H}"
    preserveAspectRatio="none"
    role="img"
    aria-label={ariaLabel}
  >
    {#each GRID as pct}
      <line class="grid" x1={PAD_L} y1={y(pct)} x2={W - PAD_R} y2={y(pct)} />
      <text class="axis" x={PAD_L - 6} y={y(pct) + 3} text-anchor="end">{pct}</text>
    {/each}

    {#if resetX != null}
      <line class="reset" x1={resetX} y1={PAD_T} x2={resetX} y2={H - PAD_B} />
      <text class="axis reset-label" x={resetX} y={H - PAD_B + 14} text-anchor="middle">
        {clockLabel(resetTs ?? 0)}
      </text>
    {/if}

    {#if sorted.length > 1}
      <polygon class="area" points={area} style="fill: {color}" />
      <polyline class="line" points={line} style="stroke: {color}" />
    {/if}

    <!-- A single observation is a dot: two points would imply a trend we did
         not watch, and one point drawn as a line is not a line. -->
    {#each sorted as p (p.ts)}
      <circle
        class="dot"
        class:only={sorted.length === 1}
        cx={x(p.ts)}
        cy={y(p.utilization)}
        r={sorted.length === 1 ? 4 : 2.5}
        style="fill: {color}"
      />
    {/each}

    <text class="axis" x={PAD_L} y={H - PAD_B + 14} text-anchor="start">{clockLabel(minTs)}</text>
    <!-- One label on the right, not two. When a reset is in range it sits at
         the far edge and the last sample's own label lands on top of it; the
         reset is the more useful of the two, and the line visibly ends where
         the samples do. -->
    {#if resetX == null && sorted.length > 1}
      <text class="axis" x={W - PAD_R} y={H - PAD_B + 14} text-anchor="end">
        {clockLabel(sorted[sorted.length - 1].ts)}
      </text>
    {/if}
  </svg>
{/if}

<style>
  .quota-chart {
    width: 100%;
    height: 140px;
    display: block;
    overflow: visible;
  }

  .grid {
    stroke: var(--color-border-subtle);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }

  .reset {
    stroke: var(--color-text-muted);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    vector-effect: non-scaling-stroke;
  }

  .axis {
    fill: var(--color-text-muted);
    font-size: 10px;
    font-family: var(--font-mono);
  }

  .reset-label {
    fill: var(--color-text-muted);
  }

  .line {
    fill: none;
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }

  .area {
    opacity: 0.12;
    stroke: none;
  }

  .dot {
    /* Only the endpoints of a many-point series need to read as data; the
       middle ones would turn the line into a dotted mess. */
    opacity: 0;
  }

  .dot.only {
    opacity: 1;
  }

  .line,
  .area {
    animation: quota-chart-in 400ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  @keyframes quota-chart-in {
    from { opacity: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    .line,
    .area {
      animation: none;
    }
  }
</style>
