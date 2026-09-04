/**
 * Which theme the window draws, from what the setting says and what the OS
 * says. Pure, so it can be tested without Electron.
 *
 * The window used to switch on prefers-color-scheme, which followed the OS by
 * itself but could only ever say light or dark. Named themes need an
 * attribute the stylesheet can key on, and once the attribute exists somebody
 * has to keep it in step with the OS for 'system' - the media query did that
 * for free, and this is what does it now. main.ts calls resolveTheme at
 * startup and again on nativeTheme's 'updated' event.
 */
export type WidgetTheme = 'system' | 'light' | 'dark' | 'kohaku' | 'mono'
/** A theme the stylesheet actually has a block for. */
export type ResolvedTheme = Exclude<WidgetTheme, 'system'>

/** Settings-panel and tray order: system first, then light to dark, then the named ones. */
export const WIDGET_THEMES: readonly WidgetTheme[] = ['system', 'light', 'dark', 'kohaku', 'mono']

/**
 * What the OS should treat this window as - form controls, scrollbars,
 * the title in the taskbar. kohaku and mono are paper, so they are light.
 */
export function polarityOf(theme: WidgetTheme): 'system' | 'light' | 'dark' {
  switch (theme) {
    case 'system': return 'system'
    case 'dark': return 'dark'
    default: return 'light'
  }
}

/** The block to draw: 'system' becomes whichever of light/dark the OS is in now. */
export function resolveTheme(theme: WidgetTheme, osDark: boolean): ResolvedTheme {
  return theme === 'system' ? (osDark ? 'dark' : 'light') : theme
}

export function isWidgetTheme(value: unknown): value is WidgetTheme {
  return typeof value === 'string' && (WIDGET_THEMES as readonly string[]).includes(value)
}
