import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { CurrencyCode } from './currency'

export interface WidgetSettings {
  theme: 'system' | 'light' | 'dark'
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
   * How big everything is drawn, as a webContents zoom factor.
   *
   * Zoom rather than a resizable window, because the window already follows
   * its contents: dragging an edge would only add margin, and the next
   * update would take it back. This scales the text, the bars and the window
   * together, and the existing follow-the-contents behaviour keeps working.
   */
  zoomFactor: number
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
  zoomFactor: 1,
  quotaDetail: 'full',
  hiddenTools: [],
  collapsed: false,
  alwaysOnTop: true,
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
