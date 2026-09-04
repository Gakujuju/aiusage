#!/usr/bin/env node
/**
 * Writes the theme CSS for the web dashboard and for the widget from one table.
 *
 *   node scripts/theme/generate.cjs          write both files
 *   node scripts/theme/generate.cjs --check  fail if either file differs from
 *                                            what the table would produce
 *
 * The table is scripts/theme/palette.cjs. The two outputs are committed, so a
 * checkout builds without running this - and so the --check mode has
 * something to hold them to. That mode runs in both packages' pretest and
 * build: a generated file that somebody edited by hand is the quiet kind of
 * drift, where nothing errors and one side simply has a different colour.
 * Making one table was the point; without the check that point lasts until
 * the first well-meant edit to the output.
 *
 * The web gets every key of every theme under the names the table uses. The
 * widget has its own, smaller vocabulary - nineteen properties against the
 * web's seventy-odd - so it gets the same colours under its own names, by the
 * map in WIDGET_VARS. What has to agree between the two is the colour, not
 * the name; the map is where that boundary is drawn.
 */
const fs = require('node:fs')
const path = require('node:path')
const { PALETTE, BASE_THEME, THEME_ORDER } = require('./palette.cjs')

const ROOT = path.join(__dirname, '..', '..')
const WEB_OUT = path.join(ROOT, 'packages', 'web', 'src', 'lib', 'themes.generated.css')
const WIDGET_OUT = path.join(ROOT, 'packages', 'widget', 'src', 'renderer', 'themes.generated.css')

const HEADER = (source) => [
  '/*',
  ' * GENERATED FILE - DO NOT EDIT.',
  ' *',
  ` * Source: scripts/theme/palette.cjs   (regenerate: node scripts/theme/generate.cjs)`,
  ' * The build and pretest fail if this file differs from what the table produces,',
  ' * so an edit made here is an edit that stops the build until it is made in the',
  ' * table instead. That is deliberate.',
  ` * Output: ${source}`,
  ' */',
  '',
].join('\n')

/**
 * Widget property <- table key.
 *
 * Text-bearing reds map to the text-safe danger colour, not the fill: the
 * widget paints words with --danger, and a fill colour is chosen for shapes.
 */
const WIDGET_VARS = {
  '--bg': '--bg',
  '--surface': '--surface',
  '--bg-hover': '--hover',
  '--border': '--border-subtle',
  '--border-medium': '--border-medium',
  '--text-primary': '--text',
  '--text-secondary': '--text-secondary',
  '--text-muted': '--text-muted',
  '--accent': '--accent',
  '--danger': '--danger-fg',
  '--chart-input': '--chart-input',
  '--chart-output': '--chart-output',
  '--chart-cache-read': '--chart-cache-read',
  '--chart-cache-write': '--chart-cache-write',
  '--chart-thinking': '--chart-thinking',
  '--mark-claude': '--mark-claude',
  '--mark-codex': '--mark-codex',
  '--mark-copilot': '--mark-copilot',
}

function selectorFor(theme) {
  return theme === BASE_THEME ? ':root' : `:root[data-theme="${theme}"]`
}

function block(selector, entries) {
  const lines = entries.map(([name, value]) => `  ${name}: ${value};`)
  return `${selector} {\n${lines.join('\n')}\n}\n`
}

function webCss() {
  let out = HEADER('web dashboard, every key of every theme')
  for (const theme of THEME_ORDER) {
    const table = PALETTE[theme]
    if (!table) throw new Error(`palette has no theme "${theme}" (THEME_ORDER names it)`)
    out += block(selectorFor(theme), Object.entries(table)) + '\n'
  }
  return out
}

function widgetCss() {
  let out = HEADER('widget, the nineteen properties it uses, mapped by WIDGET_VARS')
  for (const theme of THEME_ORDER) {
    const table = PALETTE[theme]
    const entries = Object.entries(WIDGET_VARS).map(([widgetName, key]) => {
      if (!(key in table)) throw new Error(`theme "${theme}" has no ${key} (needed for widget ${widgetName})`)
      return [widgetName, table[key]]
    })
    out += block(selectorFor(theme), entries) + '\n'
  }
  return out
}

function main() {
  const check = process.argv.includes('--check')
  const outputs = [[WEB_OUT, webCss()], [WIDGET_OUT, widgetCss()]]
  let stale = 0
  for (const [file, text] of outputs) {
    const rel = path.relative(ROOT, file)
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null
      if (current !== text) {
        stale++
        console.error(`theme css: ${rel} is not what scripts/theme/palette.cjs produces` +
          (current === null ? ' (missing)' : '') +
          '\n           edit the table and run: node scripts/theme/generate.cjs')
      }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
      console.log(`theme css: wrote ${rel}`)
    }
  }
  if (check) {
    if (stale) process.exit(1)
    console.log(`theme css: ${outputs.length} generated file(s) match the table`)
  }
}

main()
