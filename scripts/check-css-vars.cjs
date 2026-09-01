/**
 * Fail the build when a stylesheet asks for a custom property nobody defines.
 *
 * CSS is quiet about this. `var(--nope, red)` renders red and nothing warns;
 * `var(--nope)` makes the declaration invalid and the element falls back to
 * whatever it inherited, which also looks like a design decision. Five of
 * these were living in this codebase — a chart drawing its axis in the
 * inherited colour, eight labels in the platform's default monospace instead
 * of the project's — and none of them was findable by looking.
 *
 * A fallback makes it worse, not better: the page looks deliberate, so the
 * only way the mistake surfaces is when someone changes the variable it was
 * supposed to be reading and nothing moves.
 *
 * Shared, not copied. It lived in the web package until the widget - which
 * had no such check - shipped exactly this bug: a panel written with the
 * web palette's variable names, on a package that names them differently,
 * so the empty cells of a bar rendered transparent and 3% looked like
 * nothing at all. The names differing is a separate question; a second copy
 * of the checker would have been a worse answer to it.
 *
 * Run: node ../../scripts/check-css-vars.cjs <package-dir>
 * (the pretest of both packages that have stylesheets)
 */
const fs = require('node:fs')
const path = require('node:path')

/**
 * The package to check, from the command line.
 *
 * Required rather than defaulted: a checker that silently examines the
 * wrong directory reports success, and success is the answer nobody
 * questions.
 */
const target = process.argv[2]
if (!target) {
  console.error('css vars: needs a package directory, e.g. node scripts/check-css-vars.cjs packages/web')
  process.exit(2)
}

const ROOT = path.resolve(target)
const SEARCH = [path.join(ROOT, 'src')]
if (!fs.existsSync(SEARCH[0])) {
  console.error(`css vars: no src directory under ${ROOT}`)
  process.exit(2)
}
const EXTENSIONS = new Set(['.svelte', '.css', '.html'])

/** Properties the browser defines for us. */
const BUILT_IN = new Set([])

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

const files = SEARCH.flatMap(walk)
const appHtml = path.join(ROOT, 'src', 'app.html')
if (fs.existsSync(appHtml) && !files.includes(appHtml)) files.push(appHtml)

/**
 * Every name anyone defines, anywhere.
 *
 * Deliberately not restricted to :root. A component may define a property on
 * its own element and use it in a child; that is legitimate and this check
 * has no business failing it. What it is looking for is names that exist
 * nowhere at all.
 */
const defined = new Set(BUILT_IN)
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  for (const match of text.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(match[1])
}

const problems = []
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    // Comments explain these mistakes; they should not be reported as them.
    if (/^\s*(\*|\/\/|<!--)/.test(line)) return
    for (const match of line.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(,)?/g)) {
      const [, name, comma] = match
      if (defined.has(name)) continue
      problems.push({
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line: index + 1,
        name,
        hadFallback: Boolean(comma),
      })
    }
  })
}

if (problems.length === 0) {
  console.log(`css vars: ${path.basename(ROOT)} — ${defined.size} defined, no undefined references`)
  process.exit(0)
}

console.error(`css vars: ${problems.length} reference(s) to properties nothing defines\n`)
for (const p of problems) {
  const note = p.hadFallback
    ? 'has a fallback, so it renders and hides the mistake'
    : 'no fallback — the declaration is dropped'
  console.error(`  ${p.file}:${p.line}  ${p.name}  (${note})`)
}
console.error('\nEither define it, or point it at the property that exists.')
process.exit(1)
