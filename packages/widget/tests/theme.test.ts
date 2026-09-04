import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { WIDGET_THEMES, polarityOf, resolveTheme, isWidgetTheme } from '../src/theme'

const require = createRequire(import.meta.url)
const { PALETTE, THEME_ORDER } = require('../../../scripts/theme/palette.cjs')

describe('theme resolution', () => {
  it('turns system into whatever the OS is in, and leaves the rest alone', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('kohaku', true)).toBe('kohaku')
    expect(resolveTheme('mono', true)).toBe('mono')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('tells the OS that paper themes are light', () => {
    expect(polarityOf('system')).toBe('system')
    expect(polarityOf('dark')).toBe('dark')
    expect(polarityOf('light')).toBe('light')
    expect(polarityOf('kohaku')).toBe('light')
    expect(polarityOf('mono')).toBe('light')
  })

  it('offers exactly the themes the stylesheet has blocks for, plus system', () => {
    const named = WIDGET_THEMES.filter((t) => t !== 'system')
    for (const t of named) expect(THEME_ORDER).toContain(t)
    expect(isWidgetTheme('terminal')).toBe(false) // web-only for now
    expect(isWidgetTheme('mono')).toBe(true)
  })
})

/*
 * The whole reason for the shared table: the widget's kohaku is the web's
 * kohaku, by value. Read the generated file rather than trusting the
 * generator, since the file is what the window loads.
 */
describe('generated widget stylesheet', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'renderer', 'themes.generated.css'), 'utf8')
  const block = (theme: string) => {
    const sel = theme === 'light' ? ':root {' : `:root[data-theme="${theme}"] {`
    const at = css.indexOf(sel)
    expect(at, `no block for ${theme}`).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('says GENERATED at the top', () => {
    expect(css.slice(0, 200)).toContain('GENERATED FILE - DO NOT EDIT')
  })

  it.each(['kohaku', 'mono', 'dark'])('%s carries the table\'s values under the widget\'s names', (theme) => {
    const b = block(theme)
    const p = PALETTE[theme]
    expect(b).toContain(`--bg: ${p['--bg']};`)
    expect(b).toContain(`--text-primary: ${p['--text']};`)
    expect(b).toContain(`--bg-hover: ${p['--hover']};`)
    expect(b).toContain(`--border: ${p['--border-subtle']};`)
    expect(b).toContain(`--danger: ${p['--danger-fg']};`)
    expect(b).toContain(`--mark-claude: ${p['--mark-claude']};`)
  })

  it('has every theme the table orders, and no other', () => {
    for (const theme of THEME_ORDER) block(theme)
    const blocks = css.match(/:root(\[data-theme="[a-z]+"\])? \{/g) ?? []
    expect(blocks.length).toBe(THEME_ORDER.length)
  })
})
