import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { CurrencyCode } from './currency'
import { isSizeName, nearestSize } from './size'
import type { WidgetTheme } from './theme'
import type { SizeName } from './size'

export interface WidgetSettings {
  theme: WidgetTheme
  refreshIntervalSec: number
  rangeDays: number
  /**
   * Show desktop notifications for what the hub already sent elsewhere.
   *
   * On by default and switchable, because the same event also reaches the
   * phone: two things going off for one event is worth being able to stop,
   * and which one to stop is not this program's call.
   */
  notifications: boolean
  /**
   * The newest event already shown on THIS machine, or null on a first run.
   *
   * Here rather than in the database because that is opened readonly, and
   * not shared between machines because "have I seen it" is a fact about a
   * screen, not about the event.
   */
  notificationsSeenAt: number | null
  /**
   * The hub to read from, when the obvious answer is wrong.
   *
   * Empty means: whatever hubForward.url says on a spoke, and this machine's
   * own serve port on the hub. Someone who types an address here means it,
   * so it wins over both.
   */
  hubUrl: string
  /**
   * Which of the four sizes the window is drawn at.
   *
   * Replaces a free zoom factor in 0.1 steps. One choice, in the words the
   * user used, each fixing a zoom and - for the smallest - a detail level;
   * see size.ts for the values and why they are what they are. A settings
   * file that still says zoomFactor is migrated once on load and never
   * written back with it.
   */
  size: SizeName
  /**
   * How much of each quota line to draw.
   *
   * One choice of three rather than a switch per element. Per-element
   * switches would be 2^n combinations of which three are worth having, and
   * a setting nobody uses is one nobody can safely remove later.
   */
  quotaDetail: 'meter' | 'percent' | 'full'
  /** Tools the user has switched off, by their id in quota_current. */
  hiddenTools: string[]
  /**
   * Folded down to a strip: tool names and meters, nothing else.
   *
   * Persisted rather than held in the window, because a fold that forgets
   * itself on every restart is a fold nobody keeps. The whole point is a
   * thing that stays on screen without taking any of it.
   */
  collapsed: boolean
  /**
   * Whether the window floats over everything else.
   *
   * On, because a resident readout that other windows cover is not resident.
   * Off is for the times that stops being true - it sits bottom-right, which
   * is where other things also want to be, and "get out of the way" needs an
   * answer that is not "close it".
   *
   * Not automatic. A window that decides for itself when to duck is a window
   * whose position nobody can predict; this is a switch, and it stays where
   * it was put.
   */
  alwaysOnTop: boolean
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
  notifications: true,
  notificationsSeenAt: null,
  hubUrl: '',
  size: 'normal',
  quotaDetail: 'full',
  hiddenTools: [],
  collapsed: false,
  /*
   * Off by default, since 2026-09-04: the person using it asked for the box
   * to start unticked. Note that this only reaches machines that have never
   * saved their settings - every save writes the whole object, defaults
   * included, so the three existing files carry true and keep it until it
   * is unticked by hand. There is no migration on purpose: a true written
   * as a default and a true someone chose look identical in the file.
   */
  alwaysOnTop: false,
  /*
   * Off, because the window's subject changed.
   *
   * These are tokens, cost and a trend chart - the whole of what this widget
   * used to be, and what its owner said they do not look at. They are kept
   * rather than deleted: not looked at is not the same as not wanted, and a
   * toggle already existed for most of them. Turning the defaults off
   * achieves the point, which was that the quota should not have to be found
   * among them.
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
      const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>
      const merged: WidgetSettings = { ...DEFAULT_SETTINGS, ...raw } as WidgetSettings
      /*
       * One-time migration from the zoom factor that sizes replaced. A file
       * with a size keeps it; one with only the old number lands on the
       * nearest tier; the old key is dropped either way so the next save
       * does not carry it forward.
       */
      if (!isSizeName(raw.size)) {
        merged.size = typeof raw.zoomFactor === 'number' ? nearestSize(raw.zoomFactor) : 'normal'
      }
      delete (merged as unknown as Record<string, unknown>).zoomFactor
      return merged
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
