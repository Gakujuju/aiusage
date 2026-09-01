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
 * Inheriting is allowed where it is written down. SHARED and KNOWN_HOLES below
 * are the whole of what is permitted; anything else is a hole.
 *
 * Run: node scripts/check-theme-vars.cjs   (also runs as web's pretest)
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const LAYOUT = path.join(ROOT, 'src', 'routes', '+layout.svelte')
const THEME_JS = path.join(ROOT, 'src', 'lib', 'theme.js')
const I18N = path.join(ROOT, 'src', 'lib', 'i18n.js')

/**
 * Properties every theme may inherit from the base, and why.
 *
 * Geometry and typefaces are not palette. A theme that wants different corners
 * or a different face says so; one that does not is agreeing with the base
 * rather than forgetting it. Keeping these out of the required set is what
 * stops each new theme from having to restate eleven numbers that have nothing
 * to do with colour - a list nobody would keep correct for long.
 */
/**
 * The theme that is the base rather than a departure from it.
 *
 * :root is the light palette; light has no [data-theme] block because it does
 * not need one. Named here rather than special-cased quietly, so that moving
 * the base to some other theme is one edit and not a puzzle.
 */
const BASE_THEME = 'light'

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
 * What each existing theme was already inheriting when this check was written.
 *
 * Not a list of decisions - a list of what was found, written down so it stops
 * growing while someone looks at it. Most of these are defensible: alpha tints
 * sit on whatever is behind them, and solid badge fills carry their own
 * foreground. Four are not, and they are the reason this check exists:
 *
 *   --danger-fg       oklch(0.48 0.2 25)
 *   --danger-soft-fg  oklch(0.42 0.15 25)
 *   --info-fg         oklch(0.45 0.14 250)
 *   --success-fg      oklch(0.5 0.17 155)
 *
 * Those lightnesses were chosen against a white page. On the dark surface they
 * are dark text on dark ground - nobody has looked at them, and until this ran
 * there was nothing to look at them with.
 *
 * A theme added from now on gets no entries here.
 */
const KNOWN_HOLES = {
  dark: [
    '--on-accent',
    '--warn-solid',
    '--danger-fg',
    '--danger-bg',
    '--danger-solid',
    '--danger-border',
    '--danger-soft-bg',
    '--danger-soft-fg',
    '--danger-plain',
    '--info-bg',
    '--info-fg',
    '--info-solid',
    '--success-fg',
    '--amber',
    '--shadow-dropdown',
    '--shadow-modal',
    '--overlay-strong',
  ],
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
  console.error('theme vars: found no :root palette in src/routes/+layout.svelte')
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
  const allowed = new Set([...SHARED, ...(KNOWN_HOLES[theme] || [])])
  const missing = [...base].filter((n) => !names.has(n) && !allowed.has(n))
  if (missing.length) problems.push({ kind: 'missing', theme, names: missing })

  const stale = (KNOWN_HOLES[theme] || []).filter((n) => names.has(n) || !base.has(n))
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
  const holes = Object.values(KNOWN_HOLES).reduce((n, list) => n + list.length, 0)
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
    console.error(`  [data-theme="${p.theme}"] defines these now; drop them from KNOWN_HOLES: ${p.names.join(' ')}\n`)
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
