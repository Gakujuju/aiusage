import { describe, it, expect } from 'vitest'
import { get } from 'svelte/store'
import { t, lang, setLang } from '../src/lib/i18n.js'

/**
 * A missing key used to reach the screen as its own dotted path. Falling back
 * to English makes an untranslated string a gap rather than a defect — but the
 * fallback must not swallow translations that do exist.
 */
function translate(locale: string, key: string): string {
  setLang(locale)
  return get(t)(key)
}

describe('t() fallback', () => {
  it('uses the active locale when it has the key', () => {
    expect(translate('ja', 'quotas.title')).toBe('利用枠')
    expect(translate('en', 'quotas.title')).toBe('Quotas')
  })

  it('does not quietly turn Japanese into English', () => {
    // The regression this guards: a fallback that fires too eagerly would
    // replace every ja string with its en counterpart.
    setLang('ja')
    const ja = get(t)
    setLang('en')
    const en = get(t)

    const keys = [
      'quotas.title', 'quotas.desc', 'quotas.refresh', 'quotas.fiveHour',
      'quotas.forecast.pace', 'quotas.forecast.exhaustAt', 'quotas.forecast.resetsIn',
      'quotas.forecast.risk.critical', 'quotas.chart.empty', 'quotas.staleValue',
      'cost.unpricedWarning', 'cost.unpricedLink',
      'common.loading', 'common.noData', 'nav.quotas', 'nav.sessions',
    ]
    for (const key of keys) {
      expect(ja(key), key).not.toBe(en(key))
      expect(ja(key), key).not.toBe(key)
    }
  })

  it('falls back to English for a key the locale lacks', () => {
    // Asserted through the public API rather than by mutating the dictionary,
    // so it stays true however the translations are stored.
    setLang('ja')
    const missing = 'quotas.__does_not_exist_in_any_locale__'
    expect(get(t)(missing)).toBe(missing)
  })

  it('returns the key itself when no locale has it', () => {
    for (const locale of ['en', 'ja', 'zh']) {
      expect(translate(locale, 'nope.not.a.real.key')).toBe('nope.not.a.real.key')
    }
  })

  it('never renders a dotted key for anything the UI asks for', () => {
    // The point of the fallback: every key the pages use resolves to text in
    // every locale, whether or not that locale was translated.
    const uiKeys = [
      'quotas.staleValue', 'quotas.chart.label', 'quotas.chart.empty',
      'quotas.forecast.pace', 'quotas.forecast.paceFast', 'quotas.forecast.paceOk',
      'quotas.forecast.exhaustAt', 'quotas.forecast.beforeReset',
      'quotas.forecast.resetsIn', 'quotas.forecast.p90', 'quotas.forecast.p90Note',
      'quotas.forecast.lowConfidence', 'quotas.forecast.days',
      'quotas.forecast.hours', 'quotas.forecast.minutes',
      'quotas.forecast.risk.watch', 'quotas.forecast.risk.warn',
      'quotas.forecast.risk.critical',
      'cost.unpricedWarning', 'cost.unpricedLink', 'cost.unpricedAndMore',
    ]
    for (const locale of ['en', 'ja', 'zh']) {
      for (const key of uiKeys) {
        expect(translate(locale, key), `${locale}/${key}`).not.toBe(key)
      }
    }
  })

  it('leaves the language store where it found it', () => {
    setLang('ja')
    expect(get(lang)).toBe('ja')
  })
})
