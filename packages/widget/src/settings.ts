import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { CurrencyCode } from './currency'

export interface WidgetSettings {
  theme: 'system' | 'light' | 'dark'
  refreshIntervalSec: number
  rangeDays: number
  /** The token/cost sections this widget used to be made of. */
  showUsage: boolean
  showCost: boolean
  showHeatmap: boolean
  showTokenBreakdown: boolean
  locale: 'en' | 'ja' | 'zh'
  currency: CurrencyCode
}

const SETTINGS_PATH = join(homedir(), '.aiusage', 'widget-settings.json')

const DEFAULT_SETTINGS: WidgetSettings = {
  theme: 'system',
  refreshIntervalSec: 60,
  rangeDays: 30,
  /*
   * Off, because the window's subject changed.
   *
   * These three are tokens, cost and a trend chart - the whole of what this
   * widget used to be, and what its owner said they do not look at. They are
   * kept rather than deleted: not looked at is not the same as not wanted,
   * and a toggle already existed for each. Turning the defaults off achieves
   * the point, which was that the quota should not have to be found among
   * them.
   */
  showUsage: false,
  showCost: false,
  showHeatmap: false,
  showTokenBreakdown: false,
  locale: 'en',
  currency: 'USD',
}

/**
 * What language to start in when nobody has said.
 *
 * Matched on the prefix, because the machine reports things like `ja-JP` and
 * `zh-Hans-CN` and the tables here are per language. Anything else falls to
 * English, which is the only one guaranteed to be complete.
 */
export function defaultLocale(osLocale: string | undefined): WidgetSettings['locale'] {
  const tag = (osLocale ?? '').toLowerCase()
  if (tag.startsWith('ja')) return 'ja'
  if (tag.startsWith('zh')) return 'zh'
  return 'en'
}

/**
 * @param osLocale What the operating system says, used only when there is no
 *   saved file. A choice already made is never overridden by the OS.
 */
export function loadSettings(osLocale?: string): WidgetSettings {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
      return { ...DEFAULT_SETTINGS, ...raw }
    }
  } catch {
    // Fall through to defaults
  }
  return { ...DEFAULT_SETTINGS, locale: defaultLocale(osLocale) }
}

export function saveSettings(settings: WidgetSettings): void {
  const dir = join(homedir(), '.aiusage')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8')
}

export function getDefaultSettings(): WidgetSettings {
  return { ...DEFAULT_SETTINGS }
}
