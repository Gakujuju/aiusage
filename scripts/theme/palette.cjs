/**
 * The colours, in one table.
 *
 * Every theme of the web dashboard and of the widget is generated from this
 * file - see generate.cjs, which writes packages/web/src/lib/themes.generated.css
 * and packages/widget/src/renderer/themes.generated.css, and which fails the
 * build when either of those files stops matching what is written here.
 *
 * It began as the palette blocks of packages/web/src/routes/+layout.svelte,
 * moved here verbatim on 2026-09-04 - every value, and every comment that sat
 * beside one - so the move could be shown to change nothing. The widget used
 * to carry its own light and dark values; it now reads these, under its own
 * property names, by the map in generate.cjs. What has to agree between the
 * two is the colour, not the name.
 *
 * Geometry and typefaces are not here. They are shared by every theme and
 * live in the layout; see SHARED in packages/web/scripts/check-theme-vars.cjs.
 *
 * Values are CSS as written: oklch() mostly, the odd sRGB where a comment
 * says why. A key present in one theme must be present in all of them; the
 * checker holds that line, and the widget generator refuses a theme missing
 * one of its nineteen.
 */

/** The theme :root itself carries; every other theme is a [data-theme] block. */
const BASE_THEME = 'light'

/** Generation order, and the order the web toggle walks. system is not a theme. */
const THEME_ORDER = ['light', 'dark', 'kohaku', 'terminal']

const PALETTE = {
  light: {
    '--bg': 'oklch(0.985 0.004 175)',
    '--surface': 'oklch(0.995 0.003 175)',
    '--raised': 'oklch(0.97 0.006 175)',
    '--hover': 'oklch(0.955 0.008 175)',
    '--sidebar-bg': 'oklch(0.98 0.005 175)',
    '--border-subtle': 'oklch(0.92 0.008 175)',
    '--border-medium': 'oklch(0.87 0.01 175)',
    '--text': 'oklch(0.18 0.012 175)',
    '--text-secondary': 'oklch(0.42 0.015 175)',
    '--text-muted': 'oklch(0.6 0.012 175)',
    '--accent': 'oklch(0.55 0.12 175)',
    '--accent-dim': 'oklch(0.55 0.12 175 / 0.1)',
    '--accent-hover': 'oklch(0.50 0.13 175)',
    '--green': 'oklch(0.62 0.17 155)',
    '--green-dim': 'oklch(0.62 0.17 155 / 0.1)',
    '--blue': 'oklch(0.55 0.14 250)',
    '--blue-dim': 'oklch(0.55 0.14 250 / 0.1)',
    '--purple': 'oklch(0.58 0.16 300)',
    '--purple-dim': 'oklch(0.58 0.16 300 / 0.1)',
    '--rose': 'oklch(0.58 0.2 25)',
    '--rose-dim': 'oklch(0.58 0.2 25 / 0.1)',
    '--badge-override-bg': 'oklch(0.55 0.12 175 / 0.1)',
    '--badge-override-fg': 'oklch(0.55 0.12 175)',
    '--badge-matched-bg': 'oklch(0.62 0.17 155 / 0.1)',
    '--badge-matched-fg': 'oklch(0.62 0.17 155)',
    '--badge-noprice-bg': 'oklch(0.58 0.2 25 / 0.08)',
    '--badge-noprice-fg': 'oklch(0.58 0.2 25)',
    '--shadow-sm': '0 1px 2px oklch(0 0 0 / 0.05)',
    '--shadow-md': '0 1px 3px oklch(0 0 0 / 0.08), 0 4px 12px oklch(0 0 0 / 0.04)',
    '--shadow-lg': '0 4px 8px oklch(0 0 0 / 0.08), 0 12px 32px oklch(0 0 0 / 0.06)',
    '--overlay': 'oklch(0 0 0 / 0.25)',
    '--chart-input': 'oklch(0.65 0.14 175)',
    '--chart-output': 'oklch(0.6 0.15 250)',
    '--chart-cache-read': 'oklch(0.7 0.1 65)',
    '--chart-cache-write': 'oklch(0.65 0.12 310)',
    '--chart-thinking': 'oklch(0.62 0.18 20)',
    '--chart-total': 'oklch(0.55 0.12 175)',
    // Text drawn on top of an accent fill.
    '--on-accent': 'oklch(0.99 0.002 175)',
    // And on top of a danger fill, which is a different question: the two
    // fills do not move together from theme to theme. Three places had
    // `color: white` written over these instead of reading a name, which is
    // how terminal came to draw white on a 0.72 red at 2.87.
    '--on-danger': 'oklch(0.99 0.002 175)',
    // ── Status colours ──────────────────────────────────────────────────
    // These lived as literals in twelve page stylesheets, which is why a
    // new theme would have left every warning and error looking like the
    // old one. Each distinct rendered value gets its own name: two roles
    // that happen to share a colour today still need to be able to differ
    // in a theme that treats them differently.
    //
    // Where a page carried its own dark variant it is repeated in the dark
    // block below; where it did not, the light value stands in both — which
    // is what those pages already did.
    '--warn-solid': 'oklch(0.7 0.15 60)',
    '--warn-bg': 'oklch(0.96 0.02 80)',
    '--warn-fg': 'oklch(0.5 0.14 60)',
    '--notice-bg': 'oklch(0.97 0.03 60)',
    '--notice-border': 'oklch(0.87 0.08 60)',
    '--notice-fg': 'oklch(0.45 0.14 55)',
    '--danger-fg': 'oklch(0.48 0.2 25)',
    '--danger-bg': 'oklch(0.58 0.2 25 / 0.12)',
    '--danger-solid': 'oklch(0.58 0.2 25)',
    '--danger-border': 'oklch(0.7 0.12 25)',
    '--danger-soft-bg': 'oklch(0.58 0.2 25 / 0.08)',
    '--danger-soft-fg': 'oklch(0.42 0.15 25)',
    // The one status colour written as sRGB rather than OKLCH. Left at its
    // rendered value; converting it would be a visible change.
    '--danger-plain': '#f87171',
    '--info-bg': 'oklch(0.55 0.14 250 / 0.12)',
    '--info-fg': 'oklch(0.45 0.14 250)',
    '--info-solid': 'oklch(0.55 0.14 250)',
    '--success-fg': 'oklch(0.5 0.17 155)',
    // Referenced as var(--amber, #f59e0b) in three places while --amber did
    // not exist, so the fallback was what rendered. Defining it changes
    // nothing on screen and makes it reachable from a theme.
    '--amber': '#f59e0b',
    // Two shadows that were written out by hand rather than reused.
    '--shadow-dropdown': '0 1px 3px oklch(0 0 0 / 0.08), 0 4px 12px oklch(0 0 0 / 0.04)',
    '--shadow-modal': '0 4px 8px oklch(0 0 0 / 0.06), 0 12px 32px oklch(0 0 0 / 0.04)',
    '--overlay-strong': 'oklch(0 0 0 / 0.35)',
    // The widget's tool marks (Claude ● / Codex ■ / Copilot ◆). Widget-only:
    // the web has no marks, and carries these so one table holds every theme.
    '--mark-claude': 'oklch(0.66 0.12 65)',
    '--mark-codex': 'oklch(0.6 0.15 250)',
    '--mark-copilot': 'oklch(0.6 0.16 300)',
  },

  /*
   * ── Dark theme ─────────────────────────────────────────────────────────
   */
  dark: {
    '--bg': 'oklch(0.13 0.008 175)',
    '--surface': 'oklch(0.19 0.01 175)',
    '--raised': 'oklch(0.25 0.012 175)',
    '--hover': 'oklch(0.28 0.014 175)',
    '--sidebar-bg': 'oklch(0.11 0.006 175)',
    '--border-subtle': 'oklch(0.30 0.012 175)',
    '--border-medium': 'oklch(0.38 0.014 175)',
    '--text': 'oklch(0.95 0.005 175)',
    '--text-secondary': 'oklch(0.78 0.01 175)',
    '--text-muted': 'oklch(0.64 0.008 175)',
    '--accent': 'oklch(0.72 0.12 175)',
    '--accent-dim': 'oklch(0.72 0.12 175 / 0.15)',
    '--accent-hover': 'oklch(0.78 0.11 175)',
    '--green': 'oklch(0.74 0.16 155)',
    '--green-dim': 'oklch(0.74 0.16 155 / 0.15)',
    '--blue': 'oklch(0.72 0.14 250)',
    '--blue-dim': 'oklch(0.72 0.14 250 / 0.15)',
    '--purple': 'oklch(0.73 0.14 300)',
    '--purple-dim': 'oklch(0.73 0.14 300 / 0.15)',
    '--rose': 'oklch(0.72 0.18 25)',
    '--rose-dim': 'oklch(0.72 0.18 25 / 0.15)',
    '--badge-override-bg': 'oklch(0.72 0.12 175 / 0.18)',
    '--badge-override-fg': 'oklch(0.72 0.12 175)',
    '--badge-matched-bg': 'oklch(0.74 0.16 155 / 0.18)',
    '--badge-matched-fg': 'oklch(0.74 0.16 155)',
    '--badge-noprice-bg': 'oklch(0.72 0.18 25 / 0.15)',
    '--badge-noprice-fg': 'oklch(0.72 0.18 25)',
    '--shadow-sm': '0 1px 2px oklch(0 0 0 / 0.3)',
    '--shadow-md': '0 1px 3px oklch(0 0 0 / 0.4), 0 4px 12px oklch(0 0 0 / 0.2)',
    '--shadow-lg': '0 4px 8px oklch(0 0 0 / 0.4), 0 12px 32px oklch(0 0 0 / 0.25)',
    '--overlay': 'oklch(0 0 0 / 0.55)',
    '--chart-input': 'oklch(0.74 0.13 175)',
    '--chart-output': 'oklch(0.72 0.14 250)',
    '--chart-cache-read': 'oklch(0.78 0.09 65)',
    '--chart-cache-write': 'oklch(0.74 0.11 310)',
    '--chart-thinking': 'oklch(0.73 0.17 20)',
    '--chart-total': 'oklch(0.72 0.12 175)',
    // Only the two blocks that had a dark variant of their own. Everything
    // else in the status set inherits the light value, which is exactly what
    // those pages did before — including the error red, which is dark enough
    // to be hard to read on the dark theme. That is a real complaint, but
    // fixing it here would be a visible change, so it stays for now.
    '--warn-bg': 'oklch(0.22 0.04 60)',
    '--warn-fg': 'oklch(0.75 0.14 60)',
    '--notice-bg': 'oklch(0.2 0.04 55)',
    '--notice-border': 'oklch(0.35 0.1 55)',
    '--notice-fg': 'oklch(0.78 0.14 60)',
    // ── The eight this theme was taking from the light palette ───────────
    //
    // They were inherited, not chosen: nothing in CSS says a theme has to be
    // complete, so eight values from a palette built for white paper were
    // being drawn on a 0.13 ground. scripts/check-theme-vars.cjs is what
    // found them, and it now requires these eight to be here.
    //
    // The five foregrounds were measured rather than eyeballed. Their
    // contrast against what they actually sit on, before:
    //
    //   --danger-fg on --danger-bg            2.37
    //   --danger-soft-fg on --danger-soft-bg  1.92
    //   --info-fg on --info-bg                2.24
    //   --success-fg on --surface             3.50
    //   --on-accent on --accent               2.28
    //
    // against this theme's own --text-muted at 5.52 on the same ground.
    //
    // The values below follow this theme rather than terminal's, which had
    // already solved the same problem with its own numbers. Dark puts its
    // hued colours at 0.72-0.74 and its softer text at 0.75-0.78, so the
    // status foregrounds belong just above that: they are text, and they sit
    // on a tint rather than on the surface itself.
    '--danger-fg': 'oklch(0.76 0.16 25)',
    // Sits on the fainter tint, so it goes lighter still - the same relation
    // the light palette has, pointing the other way.
    '--danger-soft-fg': 'oklch(0.82 0.12 25)',
    '--info-fg': 'oklch(0.76 0.11 250)',
    '--success-fg': 'oklch(0.78 0.14 155)',
    // Ink, not paper. The light palette can put near-white on its accent
    // because its accent is dark (0.55); this theme's accent is light (0.72),
    // so the text on it has to flip. It is also the knob of the toggle
    // switch, which becomes a dark knob on a light track - visible for the
    // same reason the text is.
    '--on-accent': 'oklch(0.17 0.015 175)',
    // The danger fill here is still the light one at 0.58, which near-white
    // clears at 4.62, so this does not flip with --on-accent.
    '--on-danger': 'oklch(0.99 0.002 175)',
    // The remaining three were not a contrast problem but a contradiction:
    // this theme had already decided that its shadows are four to eight times
    // heavier than the light one's, and that its overlay is 0.55 rather than
    // 0.25 - and then inherited the light values for the two shadows and the
    // overlay that were named separately. --overlay-strong was the plain
    // inversion: at 0.35 it was weaker than the --overlay it is meant to be
    // the strong version of.
    '--shadow-dropdown': '0 1px 3px oklch(0 0 0 / 0.4), 0 4px 12px oklch(0 0 0 / 0.2)',
    '--shadow-modal': '0 4px 8px oklch(0 0 0 / 0.4), 0 12px 32px oklch(0 0 0 / 0.25)',
    '--overlay-strong': 'oklch(0 0 0 / 0.72)',
    // The widget's tool marks (Claude ● / Codex ■ / Copilot ◆). Widget-only:
    // the web has no marks, and carries these so one table holds every theme.
    '--mark-claude': 'oklch(0.7 0.1 65)',
    '--mark-codex': 'oklch(0.6 0.15 250)',
    '--mark-copilot': 'oklch(0.6 0.16 300)',
  },

  /*
   * ── 琥珀 (kohaku) ─────────────────────────────────────────────────────
   *
   * A warm, low-blue-light surface for reading at night without switching to
   * a dark page. Light polarity: it is paper, not ink.
   *
   * Every value here was chosen for this theme rather than sampled from
   * anywhere. The only thing borrowed is the idea - warm ground, warm text,
   * blues pulled down in chroma so they stop being the brightest thing on a
   * page full of numbers.
   *
   * Hue sits around 60-85 for everything structural. The status and chart
   * colours keep their hue separation, because a chart with six warm-brown
   * series is unreadable and the whole point of those names is that they can
   * be told apart; what changes is that their chroma comes down to sit inside
   * the same picture rather than on top of it.
   *
   * Geometry and typefaces are not restated - see SHARED in
   * scripts/check-theme-vars.cjs. Everything else is, and that script fails
   * the build if it is not.
   */
  kohaku: {
    '--bg': 'oklch(0.962 0.018 82)',
    '--surface': 'oklch(0.984 0.013 82)',
    '--raised': 'oklch(0.943 0.022 80)',
    '--hover': 'oklch(0.922 0.028 78)',
    '--sidebar-bg': 'oklch(0.951 0.021 82)',
    '--border-subtle': 'oklch(0.888 0.026 78)',
    '--border-medium': 'oklch(0.818 0.034 76)',
    // Dark brown rather than black: the contrast is still there, the glare
    // is not.
    '--text': 'oklch(0.27 0.032 62)',
    '--text-secondary': 'oklch(0.45 0.030 65)',
    '--text-muted': 'oklch(0.60 0.026 68)',
    // 0.56 rather than 0.58, which is where this started. The sign-in button
    // puts near-white text on this fill, and at 0.58 that measured 4.21 - the
    // same place the light palette sits (4.35). Two hundredths of lightness
    // buys 4.57 and changes nothing anyone would see, so there was no reason
    // to inherit the base's near miss along with its shape.
    '--accent': 'oklch(0.56 0.115 68)',
    '--accent-dim': 'oklch(0.56 0.115 68 / 0.12)',
    '--accent-hover': 'oklch(0.50 0.125 66)',
    '--green': 'oklch(0.55 0.110 130)',
    '--green-dim': 'oklch(0.55 0.110 130 / 0.12)',
    '--blue': 'oklch(0.52 0.080 235)',
    '--blue-dim': 'oklch(0.52 0.080 235 / 0.12)',
    '--purple': 'oklch(0.52 0.110 330)',
    '--purple-dim': 'oklch(0.52 0.110 330 / 0.12)',
    '--rose': 'oklch(0.53 0.150 30)',
    '--rose-dim': 'oklch(0.53 0.150 30 / 0.12)',
    '--badge-override-bg': 'oklch(0.56 0.115 68 / 0.14)',
    '--badge-override-fg': 'oklch(0.48 0.110 66)',
    '--badge-matched-bg': 'oklch(0.55 0.110 130 / 0.14)',
    '--badge-matched-fg': 'oklch(0.45 0.100 130)',
    '--badge-noprice-bg': 'oklch(0.55 0.170 28 / 0.12)',
    '--badge-noprice-fg': 'oklch(0.45 0.160 28)',
    // Warm shadows. Pure black on a warm ground reads as a grey smudge.
    '--shadow-sm': '0 1px 2px oklch(0.30 0.04 60 / 0.08)',
    '--shadow-md': '0 1px 3px oklch(0.30 0.04 60 / 0.10), 0 4px 12px oklch(0.30 0.04 60 / 0.06)',
    '--shadow-lg': '0 4px 8px oklch(0.30 0.04 60 / 0.10), 0 12px 32px oklch(0.30 0.04 60 / 0.08)',
    '--overlay': 'oklch(0.25 0.03 60 / 0.28)',
    '--chart-input': 'oklch(0.62 0.120 70)',
    '--chart-output': 'oklch(0.55 0.090 235)',
    '--chart-cache-read': 'oklch(0.60 0.100 130)',
    '--chart-cache-write': 'oklch(0.55 0.120 330)',
    '--chart-thinking': 'oklch(0.57 0.150 30)',
    '--chart-total': 'oklch(0.45 0.060 65)',
    '--on-accent': 'oklch(0.985 0.010 85)',
    // Its danger fill stays dark enough for near-white ink (5.12).
    '--on-danger': 'oklch(0.985 0.010 85)',
    '--warn-solid': 'oklch(0.68 0.140 62)',
    '--warn-bg': 'oklch(0.935 0.040 80)',
    '--warn-fg': 'oklch(0.45 0.120 58)',
    '--notice-bg': 'oklch(0.948 0.050 72)',
    '--notice-border': 'oklch(0.850 0.080 70)',
    '--notice-fg': 'oklch(0.42 0.120 60)',
    '--danger-fg': 'oklch(0.45 0.160 28)',
    '--danger-bg': 'oklch(0.55 0.170 28 / 0.14)',
    '--danger-solid': 'oklch(0.55 0.170 28)',
    '--danger-border': 'oklch(0.70 0.110 28)',
    '--danger-soft-bg': 'oklch(0.55 0.170 28 / 0.09)',
    '--danger-soft-fg': 'oklch(0.40 0.130 28)',
    // The base writes this one in sRGB for a reason that does not apply here:
    // nothing is being preserved, so it is stated like everything else.
    '--danger-plain': 'oklch(0.62 0.160 28)',
    '--info-bg': 'oklch(0.52 0.080 235 / 0.14)',
    '--info-fg': 'oklch(0.44 0.090 235)',
    '--info-solid': 'oklch(0.52 0.090 235)',
    '--success-fg': 'oklch(0.47 0.100 130)',
    '--amber': 'oklch(0.72 0.140 72)',
    '--shadow-dropdown': '0 1px 3px oklch(0.30 0.04 60 / 0.10), 0 4px 12px oklch(0.30 0.04 60 / 0.06)',
    '--shadow-modal': '0 4px 8px oklch(0.30 0.04 60 / 0.08), 0 12px 32px oklch(0.30 0.04 60 / 0.06)',
    '--overlay-strong': 'oklch(0.25 0.03 60 / 0.40)',
    // The widget's tool marks (Claude ● / Codex ■ / Copilot ◆). Widget-only:
    // the web has no marks, and carries these so one table holds every theme.
    '--mark-claude': 'oklch(0.58 0.130 55)',
    '--mark-codex': 'oklch(0.52 0.080 235)',
    '--mark-copilot': 'oklch(0.52 0.110 330)',
  },

  /*
   * ── Terminal ──────────────────────────────────────────────────────────
   *
   * A monitoring TUI, not a nostalgia filter: dark blue-green rather than
   * black, and colour used to sort information rather than to decorate.
   * Cyan carries headings, magenta the second level, amber a warning, olive
   * the middle ground and green what is healthy or remaining — the same job
   * those colours do in top or btop, which is where a reader of this page
   * has met them before.
   *
   * Everything is monospace here. That is the point of the theme, and it is
   * the one place the rule from DESIGN.md is deliberately set aside: the
   * grid is the aesthetic, so labels line up with the figures under them.
   *
   * Corners and shadows are zero. Structure is carried by lines: solid rules
   * for boxes, dotted ones for dividers, and bracketed corners on the panels.
   */
  terminal: {
    '--bg': 'oklch(0.21 0.028 195)',
    '--surface': 'oklch(0.25 0.032 195)',
    '--raised': 'oklch(0.29 0.036 195)',
    '--hover': 'oklch(0.33 0.04 195)',
    '--sidebar-bg': 'oklch(0.18 0.024 195)',
    '--border-subtle': 'oklch(0.40 0.045 195)',
    '--border-medium': 'oklch(0.55 0.07 195)',
    '--text': 'oklch(0.90 0.03 175)',
    '--text-secondary': 'oklch(0.78 0.04 175)',
    '--text-muted': 'oklch(0.62 0.04 190)',
    // Cyan is the interface's own colour: headings, links, the caret.
    '--accent': 'oklch(0.82 0.13 200)',
    '--accent-dim': 'oklch(0.82 0.13 200 / 0.16)',
    '--accent-hover': 'oklch(0.90 0.13 200)',
    // Green reads as "fine, and this much left".
    '--green': 'oklch(0.80 0.19 145)',
    '--green-dim': 'oklch(0.80 0.19 145 / 0.16)',
    // Magenta is the second heading level, not an alert.
    '--blue': 'oklch(0.74 0.19 330)',
    '--blue-dim': 'oklch(0.74 0.19 330 / 0.16)',
    '--purple': 'oklch(0.74 0.19 330)',
    '--purple-dim': 'oklch(0.74 0.19 330 / 0.16)',
    '--rose': 'oklch(0.72 0.20 25)',
    '--rose-dim': 'oklch(0.72 0.20 25 / 0.16)',
    '--badge-override-bg': 'oklch(0.82 0.13 200 / 0.16)',
    '--badge-override-fg': 'oklch(0.82 0.13 200)',
    '--badge-matched-bg': 'oklch(0.80 0.19 145 / 0.16)',
    '--badge-matched-fg': 'oklch(0.80 0.19 145)',
    '--badge-noprice-bg': 'oklch(0.80 0.15 75 / 0.16)',
    '--badge-noprice-fg': 'oklch(0.80 0.15 75)',
    // No shadows. Depth is a painted illusion and this surface has none.
    '--shadow-sm': 'none',
    '--shadow-md': 'none',
    '--shadow-lg': 'none',
    '--shadow-dropdown': 'none',
    '--shadow-modal': 'none',
    '--overlay': 'oklch(0.12 0.02 195 / 0.75)',
    '--overlay-strong': 'oklch(0.12 0.02 195 / 0.85)',
    // One face for everything.
    '--font-sans': 'var(--mono)',
    // Square.
    '--radius-xs': '0',
    '--radius-badge': '0',
    '--radius-input': '0',
    '--radius-card': '0',
    '--radius-panel': '0',
    '--radius-pill': '0',
    '--on-accent': 'oklch(0.16 0.02 195)',
    // Its danger fill is a light 0.72 red, so this is ink like --on-accent (6.75).
    '--on-danger': 'oklch(0.16 0.02 195)',
    // Amber warns; olive is the step before it.
    '--warn-solid': 'oklch(0.80 0.15 75)',
    '--warn-bg': 'oklch(0.80 0.15 75 / 0.14)',
    '--warn-fg': 'oklch(0.84 0.14 80)',
    '--notice-bg': 'oklch(0.74 0.12 110 / 0.14)',
    '--notice-border': 'oklch(0.74 0.12 110)',
    '--notice-fg': 'oklch(0.80 0.12 110)',
    '--danger-fg': 'oklch(0.76 0.20 25)',
    '--danger-bg': 'oklch(0.72 0.20 25 / 0.18)',
    '--danger-solid': 'oklch(0.72 0.20 25)',
    '--danger-border': 'oklch(0.72 0.20 25)',
    '--danger-soft-bg': 'oklch(0.72 0.20 25 / 0.12)',
    '--danger-soft-fg': 'oklch(0.80 0.18 25)',
    '--danger-plain': 'oklch(0.76 0.20 25)',
    '--info-bg': 'oklch(0.82 0.13 200 / 0.14)',
    '--info-fg': 'oklch(0.82 0.13 200)',
    '--info-solid': 'oklch(0.82 0.13 200)',
    '--success-fg': 'oklch(0.80 0.19 145)',
    '--amber': 'oklch(0.80 0.15 75)',
    // Chart series, ordered so neighbours stay distinguishable.
    '--chart-input': 'oklch(0.82 0.13 200)',
    '--chart-output': 'oklch(0.74 0.19 330)',
    '--chart-cache-read': 'oklch(0.80 0.15 75)',
    '--chart-cache-write': 'oklch(0.74 0.12 110)',
    '--chart-thinking': 'oklch(0.76 0.20 25)',
    '--chart-total': 'oklch(0.80 0.19 145)',
    // The widget's tool marks (Claude ● / Codex ■ / Copilot ◆). Widget-only:
    // the web has no marks, and carries these so one table holds every theme.
    '--mark-claude': 'oklch(0.75 0.130 65)',
    '--mark-codex': 'oklch(0.70 0.130 235)',
    '--mark-copilot': 'oklch(0.70 0.140 300)',
  },

}

module.exports = { PALETTE, BASE_THEME, THEME_ORDER }
