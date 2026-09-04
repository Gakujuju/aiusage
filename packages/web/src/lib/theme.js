import { writable } from 'svelte/store'

const THEME_KEY = 'aiusage-theme'

/**
 * The themes, and whether each one is a light or a dark surface.
 *
 * The polarity is not decoration: it is what `system` resolves to, and it is
 * what the browser needs in order to draw form controls and scrollbars that
 * are legible against the page. A theme that forgets to declare it gets white
 * scrollbars on a dark background and no one can say why.
 *
 * `system` is not in here — it is a preference for one of these, not a theme.
 */
export const THEMES = {
  light: { polarity: 'light' },
  dark: { polarity: 'dark' },
  terminal: { polarity: 'dark' },
  /* Warm, low blue light, and still a light surface: paper, not ink. */
  kohaku: { polarity: 'light' },
  /* Greys only. Ink on paper, so light. */
  mono: { polarity: 'light' },
}

/** The order the toggle walks through. system first, so it stays the default. */
export const THEME_ORDER = ['system', 'dark', 'light', 'kohaku', 'terminal', 'mono']

/** @param {string} value */
function isKnown(value) {
  return value === 'system' || Object.hasOwn(THEMES, value)
}

function getStored() {
  if (typeof window === 'undefined') return 'system'
  const stored = localStorage.getItem(THEME_KEY)
  // A name from an older or newer build is not a reason to render nothing.
  return stored && isKnown(stored) ? stored : 'system'
}

function getSystemTheme() {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const userPref = writable(getStored())
export const resolvedTheme = writable(getSystemTheme())

/**
 * What `system` means right now, or the chosen theme itself.
 *
 * @param {string} pref
 */
export function resolveTheme(pref) {
  return pref === 'system' ? getSystemTheme() : pref
}

export function cycleTheme() {
  userPref.update(current => {
    const index = THEME_ORDER.indexOf(current)
    return THEME_ORDER[(index + 1) % THEME_ORDER.length]
  })
}

/** @param {string} next */
export function setTheme(next) {
  if (!isKnown(next)) return
  userPref.set(next)
}

export function initTheme() {
  if (typeof window === 'undefined') return

  const mq = window.matchMedia('(prefers-color-scheme: dark)')

  /** @param {string} pref */
  function apply(pref) {
    const theme = resolveTheme(pref)
    document.documentElement.setAttribute('data-theme', theme)
    // Tells the browser which way round its own furniture goes — scrollbars,
    // date pickers, the select popup. Set from the theme's declared polarity
    // rather than from the name, so a new dark theme does not have to be
    // spelled 'dark' to get dark scrollbars.
    const known = /** @type {Record<string, { polarity: string }>} */ (THEMES)
    document.documentElement.style.colorScheme = known[theme]?.polarity ?? 'light'
    resolvedTheme.set(theme)
  }

  apply(getStored())

  userPref.subscribe(pref => {
    localStorage.setItem(THEME_KEY, pref)
    apply(pref)
  })

  mq.addEventListener('change', () => {
    const pref = getStored()
    if (pref === 'system') {
      apply('system')
    }
  })
}
