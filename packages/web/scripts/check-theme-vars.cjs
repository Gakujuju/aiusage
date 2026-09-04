/**
 * Fail the build when a theme forgets one of the properties the base defines.
 *
 * A theme is a block of custom properties that replaces the base palette. Miss
 * one and CSS does not complain: the property is inherited from :root instead,
 * so a dark theme quietly renders one value from the light palette. It is one
 * colour, on one control, on one screen, and the only way to find it is to
 * open every page in every theme and happen to notice.
 *
 * Same shape as the undefined-variable check next door, and the same argument.
 * The difference is that here the wrong value is a real value from a real
 * palette, so it looks even more deliberate than a missing one would.
 *
 * Inheriting is allowed where it is written down. SHARED and
 * INHERITED_ON_PURPOSE below are the whole of what is permitted, and each
 * entry says why; anything else is a hole.
 *
 * Run: node scripts/check-theme-vars.cjs   (also runs as web's pretest)
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
/*
 * The palettes live in scripts/theme/palette.cjs and are generated into this
 * file (2026-09-04). The layout keeps only geometry now, so this is where the
 * blocks are; generate.cjs --check separately holds the file to the table.
 */
const LAYOUT = path.join(ROOT, 'src', 'lib', 'themes.generated.css')
const THEME_JS = path.join(ROOT, 'src', 'lib', 'theme.js')
const I18N = path.join(ROOT, 'src', 'lib', 'i18n.js')

/**
 * The theme that is the base rather than a departure from it.
 *
 * :root is the light palette; light has no [data-theme] block because it does
 * not need one. Named here rather than special-cased quietly, so that moving
 * the base to some other theme is one edit and not a puzzle.
 */
const BASE_THEME = 'light'

/**
 * Properties every theme may inherit from the base, and why.
 *
 * Geometry and typefaces are not palette. A theme that wants different corners
 * or a different face says so; one that does not is agreeing with the base
 * rather than forgetting it. Keeping these out of the required set is what
 * stops each new theme from having to restate eleven numbers that have nothing
 * to do with colour - a list nobody would keep correct for long.
 */
const SHARED = new Set([
  '--font-sans',
  '--mono',
  '--sidebar-width',
  '--sidebar-collapsed',
  '--border-width',
  '--radius-xs',
  '--radius-badge',
  '--radius-input',
  '--radius-card',
  '--radius-panel',
  '--radius-pill',
])

/**
 * Where a theme may inherit a colour from the base, and why it is allowed.
 *
 * This began as a list of what the check found and was, for one commit, a
 * place to keep things while somebody looked at them. Somebody looked. Eight
 * of the seventeen turned out to be defects and were fixed in the theme; the
 * nine below stayed, each for a reason that is now written next to it.
 *
 * "Most of these are fine" is where the next one hides, so none of them is
 * covered by a summary. Every number here was measured in a browser against
 * this theme's own surface, not judged by eye. For scale: this theme's
 * --text is 16.03 against that surface and its --text-muted is 5.52.
 *
 * A theme added from now on gets no entries here. Adding one means saying,
 * on the line, why the base value is right on a ground the base never saw.
 */
const INHERITED_ON_PURPOSE = {
  dark: {
    // Tints, not colours: 12%, 8% and 12% alpha composite over whatever is
    // behind them, so one value is correct on paper and on a 0.13 ground.
    // Against this surface they measure 1.09, 1.05 and 1.11 - which is the
    // job. What has to be legible is the text on them, and that is this
    // theme's own now: 7.17 and 9.31 and 7.75.
    '--danger-bg': 'alpha tint, composites over this theme\'s surface (1.09)',
    '--danger-soft-bg': 'alpha tint, composites over this theme\'s surface (1.05)',
    '--info-bg': 'alpha tint, composites over this theme\'s surface (1.11)',

    // Fills and a border, not text. Their lightness is carried by the shape
    // rather than read through it, and all three clear 3:1 against the
    // surface, which is what a non-text element needs.
    '--warn-solid': 'progress-bar fill, nothing is drawn on it (6.67)',
    '--danger-solid': 'fill with its own white text (3.89 as a shape, 4.75 for the text)',
    '--danger-border': '3px border, read as a shape (6.55)',
    '--info-solid': 'left border on a card, read as a shape (3.79)',

    // Two light-palette values whose lightness happens to suit a dark ground
    // better than a white one. Both are already up where this theme puts its
    // own hued text.
    '--danger-plain': 'sRGB #f87171 is light enough to read here (6.68)',
    '--amber': 'sRGB #f59e0b is light enough to read here (8.60)',
  },
}

/**
 * The :root and [data-theme] blocks, and only those.
 *
 * Deliberately not every selector mentioning data-theme. The layout has plenty
 * of `:root[data-theme="terminal"] .card` rules; those style elements and are
 * none of this check's business. Only a block whose selector ends at the root
 * element itself is declaring a palette.
 */
function paletteBlocks(text) {
  const found = []
  const selector = /(?::global\(\s*)?(:root(?:\[data-theme="([a-zA-Z0-9_-]+)"\])?)\s*\)?\s*\{/g
  let match
  while ((match = selector.exec(text)) !== null) {
    const before = text.slice(0, match.index)
    // A selector list (", ") or a descendant means this block is not a palette.
    if (/[,>]\s*$/.test(before)) { continue }
    const open = text.indexOf('{', match.index)
    let depth = 0
    let end = open
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    found.push({
      theme: match[2] === undefined ? null : match[2],
      body: text.slice(open + 1, end),
      line: before.split(/\r?\n/).length,
    })
    selector.lastIndex = end
  }
  return found
}

function declaredIn(body) {
  return new Set([...body.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]))
}

const layout = fs.readFileSync(LAYOUT, 'utf8')
const blocks = paletteBlocks(layout)

const base = new Set()
for (const b of blocks) {
  if (b.theme === null) for (const name of declaredIn(b.body)) base.add(name)
}

if (base.size === 0) {
  console.error('theme vars: found no :root palette in src/lib/themes.generated.css')
  process.exit(1)
}

const themeBlocks = new Map()
for (const b of blocks) {
  if (b.theme === null) continue
  const seen = themeBlocks.get(b.theme) || new Set()
  for (const name of declaredIn(b.body)) seen.add(name)
  themeBlocks.set(b.theme, seen)
}

/* A theme lives in three places, and two of them agreeing is not enough. */
const themeJs = fs.readFileSync(THEME_JS, 'utf8')
const themesBlock = themeJs.match(/export const THEMES\s*=\s*\{([\s\S]*?)\n\}/)
const orderBlock = themeJs.match(/export const THEME_ORDER\s*=\s*\[([^\]]*)\]/)

const registered = new Map()
if (themesBlock) {
  for (const m of themesBlock[1].matchAll(/([a-zA-Z0-9_-]+)\s*:\s*\{([^}]*)\}/g)) {
    registered.set(m[1], /polarity\s*:\s*['"](light|dark)['"]/.test(m[2]))
  }
}
const ordered = orderBlock
  ? [...orderBlock[1].matchAll(/['"]([a-zA-Z0-9_-]+)['"]/g)].map((m) => m[1])
  : []

const problems = []

for (const [theme, names] of themeBlocks) {
  const allowed = new Set([...SHARED, ...Object.keys(INHERITED_ON_PURPOSE[theme] || {})])
  const missing = [...base].filter((n) => !names.has(n) && !allowed.has(n))
  if (missing.length) problems.push({ kind: 'missing', theme, names: missing })

  const stale = Object.keys(INHERITED_ON_PURPOSE[theme] || {}).filter((n) => names.has(n) || !base.has(n))
  if (stale.length) problems.push({ kind: 'stale', theme, names: stale })
}

for (const [theme, hasPolarity] of registered) {
  if (!themeBlocks.has(theme) && theme !== BASE_THEME) problems.push({ kind: 'no-css', theme })
  if (!hasPolarity) problems.push({ kind: 'no-polarity', theme })
  if (!ordered.includes(theme)) problems.push({ kind: 'unreachable', theme })
}
for (const theme of themeBlocks.keys()) {
  if (!registered.has(theme)) problems.push({ kind: 'unregistered', theme })
}
for (const name of ordered) {
  if (name !== 'system' && !registered.has(name)) problems.push({ kind: 'ordered-only', theme: name })
}

/*
 * And the fourth place: the name a person reads.
 *
 * A theme with no label falls through to whatever the lookup does with a
 * missing key, which is a blank or the key itself sitting in the toggle. Every
 * locale needs one - a theme that is named in English and blank in Japanese is
 * a theme half the users cannot identify.
 */
const i18n = fs.readFileSync(I18N, 'utf8')
const labelBlocks = [...i18n.matchAll(/\n    theme:\s*\{([^}]*)\}/g)]
if (labelBlocks.length === 0) problems.push({ kind: 'no-labels' })
labelBlocks.forEach((block, index) => {
  const named = new Set([...block[1].matchAll(/([a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]))
  const missing = [...registered.keys()].filter((t) => !named.has(t))
  if (missing.length) problems.push({ kind: 'no-label', names: missing, locale: index + 1 })
})

/* The base has to be a theme as well, or nothing ever points at :root. */
if (!registered.has(BASE_THEME)) problems.push({ kind: 'no-base', theme: BASE_THEME })
if (themeBlocks.has(BASE_THEME)) problems.push({ kind: 'base-has-block', theme: BASE_THEME })

if (problems.length === 0) {
  const holes = Object.values(INHERITED_ON_PURPOSE).reduce((n, m) => n + Object.keys(m).length, 0)
  console.log(
    `theme vars: ${base.size} in the base, ${themeBlocks.size + 1} theme(s) complete`
    + (holes ? `, ${holes} inherited by permission` : ''),
  )
  process.exit(0)
}

console.error('theme vars: a theme is not saying everything the base says\n')
for (const p of problems) {
  if (p.kind === 'missing') {
    console.error(`  [data-theme="${p.theme}"] leaves ${p.names.length} propert${p.names.length === 1 ? 'y' : 'ies'} to :root:`)
    for (const n of p.names) console.error(`      ${n}`)
    console.error('')
  }
  if (p.kind === 'stale') {
    console.error(`  [data-theme="${p.theme}"] defines these now; drop them from INHERITED_ON_PURPOSE: ${p.names.join(' ')}\n`)
  }
  if (p.kind === 'no-css') console.error(`  ${p.theme} is in THEMES with no [data-theme="${p.theme}"] palette\n`)
  if (p.kind === 'no-base') console.error(`  ${p.theme} is this file's BASE_THEME but is not in THEMES\n`)
  if (p.kind === 'no-labels') console.error('  found no theme: {} label block in src/lib/i18n.js\n')
  if (p.kind === 'no-label') console.error(`  locale ${p.locale} has no name for: ${p.names.join(' ')}\n`)
  if (p.kind === 'base-has-block') console.error(`  ${p.theme} is the base and also has a [data-theme] block of its own; one of the two is wrong\n`)
  if (p.kind === 'no-polarity') console.error(`  ${p.theme} declares no polarity, so scrollbars and form controls guess\n`)
  if (p.kind === 'unregistered') console.error(`  [data-theme="${p.theme}"] exists in CSS but is not in THEMES\n`)
  if (p.kind === 'ordered-only') console.error(`  ${p.theme} is in THEME_ORDER but not in THEMES\n`)
  if (p.kind === 'unreachable') console.error(`  ${p.theme} is in THEMES but not in THEME_ORDER; the toggle never reaches it\n`)
}
console.error('Define it in the theme, or add it to SHARED in this file with the reason.')
process.exit(1)
