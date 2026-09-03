import { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog, screen, nativeTheme, Notification } from 'electron'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { EXCHANGE_RATE_SOURCE } from './currency'
import type { ExchangeRateState } from './currency'
import { emptyWidgetData, fetchWidgetData } from './data'
import { buildTooltip, quotaView, rowsFromApi, severity, shownRows } from './quota'
import type { QuotaRow, Severity } from './quota'
import { Hub, HubError } from './hub'
import type { HubFailure } from './hub'
import { DEFAULT_PORT, resolveHubUrl } from './hub-url'
import { HUB_PASSWORD_CREDENTIAL, hubPasswordSource, resolveHubPassword, saveCredential } from './credentials'
import { SEVERITY_COLOURS, tintBitmap } from './tray-icon'
import { eventsFromApi, nextBatch, notificationsPath } from './notifications'
import { WIDGET_UPDATE_CHANNEL } from './update'
import type { PanelSize, WidgetUpdate } from './update'
import { t } from './i18n'
import { loadSettings, saveSettings } from './settings'
import type { WidgetSettings } from './settings'
import {
  getTrayIconNativeImage,
  getWindowPosition,
  hasUsableTrayBounds,
  shouldHideWindowOnBlur,
  shouldHideWindowOnClose,
  shouldShowWindowOnLaunch,
} from './ui'

const PORT_FILE = join(homedir(), '.aiusage', '.serve-port')
const FX_CACHE_FILE = join(homedir(), '.aiusage', 'widget-exchange-rate.json')
const DASHBOARD_PORT = 3847
const WINDOW_WIDTH = 380
/*
 * Only what the panel is before it has measured itself.
 *
 * The renderer reports its real height within a frame or two of loading, so
 * this is visible for that long and never again. Kept roomy rather than
 * tight: too small for a moment reads as a broken window, too large as a
 * window still settling.
 */
const DEFAULT_WINDOW_HEIGHT = 320

/*
 * The range a panel-reported floor has to fall inside.
 *
 * The floor itself now arrives with each measurement - see PanelSize - since
 * an open panel and a folded strip have nothing like the same smallest
 * legitimate shape, and the renderer is the only thing that knows which it
 * just drew. These two are only a sanity range around that number, so a
 * garbage value cannot produce a window of zero height or one that fills the
 * screen. They are not the floor.
 *
 * The old single constant was 120, and before that 320 - a number chosen when
 * the window held a trend chart and three stat rows, which outlived its
 * contents and became a floor the panel could not get under. That is most of
 * why there used to be blank space below the text, and it is the argument
 * against having one of these at all.
 */
const MIN_REPORTED_FLOOR = 16
const MAX_REPORTED_FLOOR = 400

/*
 * The shortest a transparent window can be on Windows, in device pixels.
 *
 * Not a number anyone here chose. Asked for 33, the OS produced 64; asked for
 * 39 with transparency off, it produced 39 (2026-09-03, at 100% DPI). Width
 * has no such floor. It is written down because Electron does not know it:
 * getBounds() and getContentSize() report the height that was requested, so
 * the web contents are laid out 33 tall inside a 64-tall window, and the
 * bottom 31 pixels are neither drawn into nor clickable. Asking for 64 up
 * front makes the viewport the size the window actually is, which is what
 * lets the renderer centre a short strip and treat the whole window as the
 * target.
 *
 * If this is ever measured to be wrong - another Windows build, another DPI -
 * the symptom is a strip with dead space under it, and this is the number to
 * re-measure.
 */
const TRANSPARENT_MIN_HEIGHT_WIN = 64

/*
 * How far the whole panel can be scaled, and in what steps.
 *
 * Zoom rather than a draggable edge. The window already sizes itself to its
 * contents, so widening it by hand would only add the margin that was just
 * taken out, and the next content change would undo it. Scaling moves the
 * text, the bars and the window together and leaves that behaviour intact.
 *
 * The top, 1.5, is where the countdown wraps onto a second line, which is
 * the one thing a glanceable panel cannot do.
 *
 * The bottom was 0.7, on the grounds that below it the percentages stop
 * being readable at arm's length. The person using it then asked for
 * smaller and said the text could be small - which removes that reason,
 * and a limit whose reason is gone has no reason to stay. The floor is now
 * where the strip stops being usable as a thing to press and to grab. At
 * 0.5 it is 172 wide - and still 64 tall, because Windows will not make a
 * transparent window any shorter (see resizeToPanel). Below 0.5 the width
 * is what gets too small to hit reliably. Readable is the user's call;
 * grabbable is not.
 *
 * One number for both states, on purpose. A separate floor for the strip
 * would be a second value that has to agree with this one, and the next
 * change to either would be the next time only one of them is made.
 *
 * 0.1 steps, because 0.05 needs two presses to see any difference.
 */
const ZOOM_MIN = 0.5
const ZOOM_MAX = 1.5
const ZOOM_STEP = 0.1
const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000

let tray: Tray | null = null
let win: BrowserWindow | null = null
/**
 * The one connection everything goes through, including on the hub itself.
 *
 * Reading the database directly is what used to require a native binding
 * built for Electron's ABI, and rebuilding that took the CLI down on a
 * machine that was collecting data. There is no binding now, and no second
 * path for the hub to disagree with.
 */
let hub: Hub | null = null

/** Why the last attempt failed, or null while things are working. */
let hubProblem: HubFailure | null = null
/** @see WidgetUpdate.configProblem */
let configProblem: string | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let positionRetryTimers: Array<ReturnType<typeof setTimeout>> = []
/*
 * Loaded once here for the pieces that read it before the app is ready,
 * then re-read after whenReady so the OS language can be asked for. Electron
 * refuses app.getLocale() before that point, and the language a first-run
 * user sees is worth one extra read of a small JSON file.
 */
let settings: WidgetSettings = loadSettings()
let exchangeRate: ExchangeRateState = loadExchangeRateCache()
let exchangeRatePromise: Promise<ExchangeRateState> | null = null

/*
 * The tray refreshes on its own clock, not the window one.
 *
 * Five minutes because the numbers underneath it are fetched every five
 * minutes; reading the database more often than it is written just re-reads
 * the same row. The window keeps its own interval, which the user can set,
 * because that one is about how fresh a panel they are looking at feels.
 */
const TRAY_REFRESH_MS = 5 * 60_000

let baseTrayBitmap: { bitmap: Buffer; width: number; height: number; scaleFactor: number } | null = null
let trayLevel: Severity | null = null

/*
 * Notifications are checked more often than the tray is redrawn.
 *
 * The tray shows quota, which is refetched every five minutes, so reading it
 * faster would re-read the same row. A notification is about something that
 * just happened - a session finishing, a limit reached - and five minutes
 * late is late enough to have moved on. Thirty seconds of one indexed query
 * against a database this process already has open costs nothing.
 */
const NOTIFY_POLL_MS = 30_000

let notifyTimer: ReturnType<typeof setInterval> | null = null

app.setName('AIUsage Widget')

/*
 * The name Windows actually files this under.
 *
 * setName above is Electron's own idea of the name and Windows never asks
 * for it. The taskbar, the tray settings list and the notification centre
 * all key off the AppUserModelID, and with none set the process falls back
 * to its executable - which is why someone looking for "AIUsage Widget" in
 * Settings scrolled past `Electron` and nearly concluded it was not there.
 *
 * Set before any window exists, because Windows binds the ID to a window
 * when the window is created and will not revisit it afterwards.
 *
 * The same string as electron-builder's appId, so a packaged build and this
 * one are one identity rather than two.
 */
const AUMID = 'com.juliantanx.aiusage-widget'

if (process.platform === 'win32') {
  app.setAppUserModelId(AUMID)
}

/*
 * One widget per machine, enforced by the OS rather than by a file.
 *
 * There was a guard already, in the CLI: ~/.aiusage/widget.pid, written by
 * `aiusage widget` and checked before launching. It has two holes. It only
 * covers that one launch path - a shortcut, a startup entry, or electron run
 * directly walks straight past it - and if the file goes missing, which is
 * the ordinary outcome of a crash or a cleanup, nothing is being checked at
 * all. Two widgets then poll the hub forever and neither knows about the
 * other; on 2026-09-02 that had to be diagnosed by grouping Get-Process
 * output by StartTime, because Electron is several processes per app and the
 * count alone says nothing.
 *
 * This lock is held by the running process itself. It cannot go stale, and
 * it applies however the second copy was started.
 */
const isFirstInstance = app.requestSingleInstanceLock()
if (!isFirstInstance) {
  app.quit()
} else {
  // Someone tried to start a second one, which usually means they went
  // looking for the window. Show it rather than doing nothing visible.
  app.on('second-instance', () => {
    if (win) showWindow()
  })
}

// Prevent dock icon on macOS
if (process.platform === 'darwin' && app.dock) {
  app.dock.hide()
}

app.whenReady().then(async () => {
  settings = loadSettings(app.getLocale())

  /*
   * An unreadable config.json stops this here rather than quietly becoming a
   * different, working widget.
   *
   * resolveHubUrl used to swallow the parse failure and fall back to this
   * machine's own port. On 2026-09-02 a BOM on config.json did exactly that:
   * the spoke read itself as the hub, showed one tool instead of three, and
   * logged nothing, because nothing involved thought anything had gone wrong.
   * That took longer to find than the two failures that produced an empty
   * window, which is the argument for stopping loudly here.
   *
   * The window still opens. Someone can type a hub address into it, which is
   * the way out that does not involve editing the broken file.
   */
  let configFault: string | null = null
  let url: string
  try {
    url = resolveHubUrl(settings.hubUrl)
  } catch (error) {
    configFault = error instanceof Error ? error.message : String(error)
    configProblem = configFault
    say(configFault)
    url = `http://127.0.0.1:${DEFAULT_PORT}`
  }
  hub = new Hub({ url, password: configFault ? null : resolveHubPassword(url) })

  /*
   * The gate is now "can this reach a hub", not "does this machine collect
   * quotas".
   *
   * It used to look for rows in the local database, which only the hub ever
   * had - so the widget was a hub-only thing. Reading over HTTP makes it
   * useful on every machine, and the only question left is whether the hub
   * answers. One that does not is worth saying out loud rather than sitting
   * in the tray with nothing behind it.
   */
  let needsPassword = false
  try {
    await hub.get('/api/quotas')
  } catch (error) {
    const kind = error instanceof HubError ? error.kind : 'unexpected'
    if (kind === 'unauthorized') {
      /*
       * Started anyway, on purpose.
       *
       * This used to exit with a message saying to open the widget settings
       * and enter the password - and the widget settings are inside the
       * window this was about to refuse to open. The message was true and
       * there was no way to act on it.
       *
       * A 401 is the one failure here that is ours and fixable from this
       * side, so the thing that fixes it has to stay open. Unreachable is
       * different: nothing typed into this window changes whether another
       * machine is answering, so that one still declines to start.
       */
      needsPassword = true
      hubProblem = 'unauthorized'
      say(`the hub at ${url} refused the password - starting so it can be entered.`)
    } else {
      say(`cannot reach the hub at ${url} (${kind}). Not starting.`)
      app.exit(0)
      return
    }
  }

  applyTheme(settings.theme)
  createTray()
  createWindow()
  startAutoRefresh()
  startNotificationWatch()
  void refreshExchangeRate()

  // Shown regardless of the usual rule when a password is what is missing:
  // a tray icon alone gives nowhere to type it.
  if (needsPassword || configFault || shouldShowWindowOnLaunch(app.isPackaged)) {
    showWindowWhenTrayReady()
  }
})

app.on('window-all-closed', () => {
  // Keep the app running in the tray — do not quit
})

app.on('before-quit', () => {
  // Nothing to close: the only handle this holds is a cookie in memory.
})

/**
 * Says something where it can actually be read afterwards.
 *
 * A GUI Electron process on Windows has no console attached, so console.log
 * from the main process goes nowhere - which was measured, not assumed: this
 * exact line printed nothing at all when the app was launched from a shell
 * with its output piped. A program that declines to start has to leave the
 * reason somewhere, and next to the database it just read is where someone
 * would look.
 */
function say(message: string): void {
  const line = `[${new Date().toISOString()}] [widget] ${message}\n`
  console.log(line.trimEnd())
  try {
    appendFileSync(join(homedir(), '.aiusage', 'widget.log'), line)
  } catch {
    // If even that is not writable there is nowhere left to complain to.
  }
}

/**
 * Scales the panel, and the window with it.
 *
 * The renderer reports its height in CSS pixels, which do not change when
 * the zoom does, so the multiplication has to happen on this side - see the
 * resize handler. The width is scaled here because nothing else would.
 */
function applyZoom(): void {
  if (!win) return
  const zoom = clampZoom(settings.zoomFactor)
  win.webContents.setZoomFactor(zoom)
  if (lastPanelSize) resizeToPanel(lastPanelSize)
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100))
}

/**
 * @param delta Steps to move by; 0 means back to 1.
 */
function changeZoom(delta: number): void {
  const next = delta === 0 ? 1 : clampZoom(settings.zoomFactor + delta * ZOOM_STEP)
  if (next === settings.zoomFactor) return
  settings = { ...settings, zoomFactor: next }
  saveSettings(settings)
  applyZoom()
}

function applyTheme(theme: WidgetSettings['theme']): void {
  nativeTheme.themeSource = theme
}

function createTray(): void {
  const { buffer, scaleFactor } = getTrayIconNativeImage()
  const icon = nativeImage.createFromBuffer(buffer, scaleFactor ? { scaleFactor } : undefined)
  /*
   * Kept as pixels so the other two states can be made from it.
   *
   * Electron does the PNG decoding, which is why this lives here and the
   * recolouring lives in tray-icon.ts where it can be tested without
   * starting a browser process to look at an icon.
   */
  const size = icon.getSize()
  baseTrayBitmap = {
    bitmap: icon.toBitmap(),
    width: size.width,
    height: size.height,
    scaleFactor: scaleFactor ?? 1,
  }
  tray = new Tray(icon)
  void refreshAll()

  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => {
    const i18n = t(settings.locale)
    const menu = Menu.buildFromTemplate([
      { label: i18n.showPanel, click: () => showWindow() },
      { label: i18n.openDashboard, click: () => openDashboardAction() },
      { label: i18n.refresh, click: () => pushDataUpdate() },
      { type: 'separator' },
      {
        /*
         * Here as well as in the settings panel, and this is the copy that
         * matters: once the window is behind something, the settings panel
         * is behind it too. The tray icon is the one part of this that is
         * always reachable.
         */
        label: i18n.alwaysOnTop,
        type: 'checkbox',
        checked: settings.alwaysOnTop,
        click: () => setAlwaysOnTop(!settings.alwaysOnTop),
      },
      { type: 'separator' },
      { label: i18n.zoomIn, accelerator: 'CommandOrControl+Plus', click: () => changeZoom(1) },
      { label: i18n.zoomOut, accelerator: 'CommandOrControl+-', click: () => changeZoom(-1) },
      { label: i18n.zoomReset, accelerator: 'CommandOrControl+0', click: () => changeZoom(0) },
      { type: 'separator' },
      { label: i18n.quit, click: () => { app.exit(0) } },
    ])
    tray!.popUpContextMenu(menu)
  })
}

/**
   * Turns floating-over-everything on or off, and remembers which.
   *
   * Saved through the same path as every other setting so the window comes
   * back the way it was left. Showing it from the tray still raises it
   * either way - that is the way back when it is behind something and its
   * own controls are behind it too.
   */
function setAlwaysOnTop(next: boolean): void {
  settings = { ...settings, alwaysOnTop: next }
  saveSettings(settings)
  win?.setAlwaysOnTop(next)
  void pushDataUpdate()
}

function createWindow(): void {
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    transparent: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const rendererPath = join(__dirname, 'renderer', 'index.html')
  win.loadFile(rendererPath)

  /*
   * After the load, not before: a zoom factor set on an empty webContents is
   * discarded when the document arrives.
   */
  win.webContents.on('did-finish-load', () => applyZoom())

  if (shouldHideWindowOnBlur(app.isPackaged)) {
    // Never while folded. A strip exists to sit there being glanced at, and
    // one that vanishes the moment you click anything else is not resident -
    // it is a popup with extra steps. (Today this only fires in a packaged
    // build, so the three machines running from a checkout never hit it; the
    // guard is here because that is a property of how it was launched, not a
    // decision anybody made about folding.)
    win.on('blur', () => { if (!settings.collapsed) win?.hide() })
  }
}

function showWindow(): void {
  if (!win) return

  positionWindowNearTray()
  win.show()
  win.focus()
  pushDataUpdate()
  schedulePositionRetries()
}

function showWindowWhenTrayReady(attempt = 0): void {
  if (!tray) return

  const trayBounds = tray.getBounds()
  if (hasUsableTrayBounds({
    platform: process.platform,
    trayBounds,
    displayBounds: screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }).workArea,
  }) || attempt >= 12) {
    showWindow()
    return
  }

  setTimeout(() => showWindowWhenTrayReady(attempt + 1), 80)
}

function positionWindowNearTray(): boolean {
  if (!win || !tray) return false

  const trayBounds = tray!.getBounds()
  const displayBounds = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }).workArea
  const winBounds = win.getBounds()
  const { x, y } = getWindowPosition({
    platform: process.platform,
    trayBounds,
    windowBounds: winBounds,
    displayBounds,
  })

  win.setPosition(x, y, false)
  return hasUsableTrayBounds({ platform: process.platform, trayBounds, displayBounds })
}

function schedulePositionRetries(): void {
  for (const timer of positionRetryTimers) clearTimeout(timer)
  positionRetryTimers = [80, 200, 500, 1000].map((delay) => setTimeout(() => {
    if (!win?.isVisible()) return
    const positionedWithRealTrayBounds = positionWindowNearTray()
    if (positionedWithRealTrayBounds) {
      for (const timer of positionRetryTimers) clearTimeout(timer)
      positionRetryTimers = []
    }
  }, delay))
}

function toggleWindow(): void {
  if (win?.isVisible()) {
    win.hide()
  } else {
    showWindow()
  }
}

/**
 * The only way this process puts an update on that channel.
 *
 * webContents.send takes any, so nothing stopped a caller sending half of
 * one - and nothing did stop them, twice. The type is the fix; the panel
 * repainting again was only the symptom going away.
 */
function sendUpdate(update: WidgetUpdate): void {
  win?.webContents.send(WIDGET_UPDATE_CHANNEL, update)
}

/**
 * One update, whatever happened, and never a throw.
 *
 * There used to be two of these: this shape, built inside pushDataUpdate,
 * and the get-data handler, which returned null when anything failed. So
 * a widget that started with a bad password put a complete "the hub
 * refused us" update on the channel, while the panel's own first call -
 * the one that runs before any interval has elapsed - got null and drew
 * "nothing yet". The window said the wrong thing for a whole refresh
 * interval, and the settings panel that keys off hubProblem never opened.
 *
 * Same shape as the last two of these: a second path that reports failure
 * its own way. One function now, and both callers take what it returns.
 */
async function currentUpdate(rows?: QuotaRow[] | null): Promise<WidgetUpdate | null> {
  if (!hub) return null
  try {
    const data = await buildPayload(rows === undefined ? await fetchQuotaRows() : rows)
    hubProblem = null
    return { ...data, hubProblem: null, hubUrl: hub.url, configProblem }
  } catch (error) {
    /*
     * Said, not swallowed.
     *
     * This used to skip in silence on the theory that the database might not
     * be ready yet. What it actually produced, the first time anything in
     * here threw, was a window that drew its header and nothing else - and no
     * way at all to find out why, because a GUI Electron process has no
     * console. An empty panel is not a state this program has; it is a
     * failure wearing one.
     */
    hubProblem = error instanceof HubError ? error.kind : 'unexpected'
    if (hubProblem !== 'unreachable') {
      say(`could not build the panel data: ${error instanceof Error ? error.message : String(error)}`)
    }
    /*
     * A complete shape, with the quota deliberately absent.
     *
     * Sending only the problem left every other field undefined, and the
     * panel builds its strings from those the moment an update arrives -
     * before any {#if} decides whether to draw them. The reactive statement
     * threw, the panel never repainted, and the numbers from the last good
     * read stayed on screen with a stale timestamp beside them. Which is
     * precisely the thing this message exists to prevent.
     */
    return {
      ...emptyWidgetData(settings.rangeDays),
      quota: null,
      hubProblem,
      hubUrl: hub.url,
      configProblem,
    }
  }
}

/**
 * The one place that asks the hub what the quotas are.
 *
 * Separate so that a single answer can serve both displays. See refreshAll.
 */
async function fetchQuotaRows(): Promise<QuotaRow[]> {
  return rowsFromApi(await hub!.get('/api/quotas'))
}

async function pushDataUpdate(rows?: QuotaRow[] | null): Promise<void> {
  if (!win) return
  const update = await currentUpdate(rows)
  if (update) sendUpdate(update)
}

/**
 * One read of the quotas, shown in both places.
 *
 * The tray and the panel used to fetch on their own timers, so the same
 * numbers were pulled twice - and until today each pull ran a fresh round of
 * live upstream calls on the hub. That is what held claude-code at HTTP 429
 * on 2026-09-02: the hub's own collection runs twelve times an hour, and two
 * widgets reading on their own added far more than that, uncounted.
 *
 * The server side no longer calls upstream at all, so this is now about not
 * asking the same question twice rather than about rate limits. One timer,
 * one answer, both displays.
 *
 * The interval is the shorter of the two former ones. When the panel is set
 * to something longer than the tray's five minutes it now repaints more
 * often than asked, which costs one local HTTP call: the setting is there so
 * a panel can feel as fresh as its owner wants, not to ration reads.
 */
async function refreshAll(): Promise<void> {
  if (!hub) return
  let rows: QuotaRow[] | null = null
  try {
    rows = await fetchQuotaRows()
    hubProblem = null
  } catch (error) {
    hubProblem = error instanceof HubError ? error.kind : 'unexpected'
  }
  applyTray(rows)
  await pushDataUpdate(rows)
}

/**
 * What the tray shows, from the database, now.
 *
 * Both the colour and the words come from the same read, so they cannot
 * disagree - an icon that has gone red beside a tooltip that has not caught
 * up would be worse than either alone.
 */
/**
 * Paints the tray from rows somebody else already read.
 *
 * Takes null for "the hub did not answer" rather than fetching and finding
 * out itself, so that the panel and the icon can never disagree about
 * whether the hub is up - they are now looking at the same answer.
 */
function applyTray(rows: QuotaRow[] | null): void {
  if (!tray || !hub) return
  if (!rows) {
    /*
     * The hub did not answer, which is not the same as having nothing to
     * show. Saying so is the point of a resident display: the one thing it
     * must never do is keep the last good numbers on screen as though they
     * were current.
     *
     * The icon is left alone. Its colour means how much allowance is left,
     * and a second meaning would make the reason for a red icon ambiguous.
     */
    tray.setToolTip(hubProblem === 'unauthorized'
      ? `AIUsage — the hub rejected the password (${hub.url})`
      : `AIUsage — cannot reach the hub (${hub.url})`)
    return
  }

  tray.setToolTip(buildTooltip(rows, Date.now()))

  const level = severity(rows)
  if (level === trayLevel || !baseTrayBitmap) return
  trayLevel = level
  const { bitmap, width, height, scaleFactor } = baseTrayBitmap
  const pixels = level === 'ok' ? bitmap : tintBitmap(bitmap, SEVERITY_COLOURS[level])
  tray.setImage(nativeImage.createFromBitmap(pixels, { width, height, scaleFactor }))
}

/**
 * Shows what the hub sent since this machine last looked.
 *
 * On a first run it shows nothing and simply marks the present moment. The
 * table holds hundreds of past events and every one of them has already been
 * delivered somewhere else; replaying them on startup would be a wall of
 * notifications about things the reader dealt with days ago.
 */
async function checkNotifications(): Promise<void> {
  if (!hub || !settings.notifications) return

  const now = Date.now()
  if (settings.notificationsSeenAt == null) {
    settings = { ...settings, notificationsSeenAt: now }
    saveSettings(settings)
    say('first run: notifications start from now, nothing replayed')
    return
  }

  let batch
  try {
    const answer = await hub.get(notificationsPath(settings.notificationsSeenAt))
    batch = nextBatch(eventsFromApi(answer), settings.notificationsSeenAt)
  } catch (error) {
    /*
     * Quiet on an unreachable hub, because the tray is already saying so and
     * a line in the log every thirty seconds would bury everything else. A
     * refusal is different: that needs a person, and it is worth a line.
     */
    if (error instanceof HubError && error.kind === 'unreachable') return
    say(`could not read notifications: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  if (batch.show.length === 0) return

  /*
   * The marker moves first, and is written before anything is shown.
   *
   * If the process dies between the two, the cost is a notification nobody
   * saw. The other order costs the same event shown again on every restart,
   * for ever, which is the failure people notice.
   */
  settings = { ...settings, notificationsSeenAt: batch.seenAt }
  saveSettings(settings)

  if (batch.skipped > 0) {
    say(`${batch.skipped} notification(s) not shown: more arrived at once than fit on screen`)
  }

  for (const row of batch.show) {
    /* The hub's words, unchanged. The same event says the same thing here as
       it does on the phone, or they stop looking like one event. */
    new Notification({
      title: row.title,
      body: row.body,
      /*
       * Seen, not heard.
       *
       * There is no moment in a working day where a chime about a finished
       * task is worth the interruption, and the same event is already
       * making a sound on the phone. This silences Windows' default
       * notification sound; it does not affect whether the banner shows,
       * which is a separate setting the user owns.
       */
      silent: true,
    }).show()
  }
}

function startNotificationWatch(): void {
  if (notifyTimer) clearInterval(notifyTimer)
  checkNotifications()
  notifyTimer = setInterval(() => checkNotifications(), NOTIFY_POLL_MS)
}

function startAutoRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer)
  const every = Math.min(TRAY_REFRESH_MS, settings.refreshIntervalSec * 1000)
  refreshTimer = setInterval(() => refreshAll(), every)
}

async function openDashboardAction(): Promise<void> {
  const port = getDashboardPort()
  const reachable = await isDashboardReachable(port)
  if (!reachable) {
    // Show widget window so user can see install progress
    showWindow()
    notifyRenderer('install:status', { phase: 'installing' })
    const result = await launchDashboard()
    if (result.success) {
      notifyRenderer('install:status', { phase: 'done' })
    }
    if (!result.success) {
      // CLI not found; attempt auto-install
      const installResult = await installAiusageCli()
      if (!installResult.success) {
        notifyRenderer('install:status', { phase: 'failed', error: installResult.error })
        dialog.showErrorBox(
          'Installation Failed',
          `Could not install @juliantanx/aiusage automatically.\n\n${installResult.error ?? 'Unknown error'}\n\nTry manually:\n  npm install -g @juliantanx/aiusage`
        )
        return
      }
      notifyRenderer('install:status', { phase: 'launching' })
      const retryResult = await launchDashboard()
      if (!retryResult.success) {
        notifyRenderer('install:status', { phase: 'failed', error: retryResult.error })
        dialog.showErrorBox(
          'Launch Failed',
          'AIUsage was installed but the dashboard failed to start.\n\nTry running:\n  aiusage serve'
        )
        return
      }
      notifyRenderer('install:status', { phase: 'done' })
    }
  }
  shell.openExternal(`http://localhost:${getDashboardPort()}`)
}

function notifyRenderer(channel: string, payload: Record<string, unknown>): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

function loadExchangeRateCache(): ExchangeRateState {
  try {
    if (existsSync(FX_CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(FX_CACHE_FILE, 'utf-8')) as ExchangeRateState
      if (raw.base === 'USD' && raw.target === 'CNY' && typeof raw.rate === 'number') {
        return raw
      }
    }
  } catch {
    // Fall through to empty state
  }

  return {
    base: 'USD',
    target: 'CNY',
    rate: null,
    fetchedAt: null,
    source: EXCHANGE_RATE_SOURCE,
  }
}

function saveExchangeRateCache(rate: ExchangeRateState): void {
  const dir = join(homedir(), '.aiusage')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(FX_CACHE_FILE, JSON.stringify(rate, null, 2), 'utf-8')
}

async function refreshExchangeRate(force = false): Promise<ExchangeRateState> {
  const hasFreshRate = exchangeRate.rate !== null &&
    exchangeRate.fetchedAt !== null &&
    Date.now() - exchangeRate.fetchedAt < FX_CACHE_TTL_MS

  if (!force && hasFreshRate) return exchangeRate
  if (exchangeRatePromise) return exchangeRatePromise

  exchangeRatePromise = (async () => {
    try {
      const response = await fetch(EXCHANGE_RATE_SOURCE)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const payload = await response.json() as { date?: string; usd?: { cny?: number } }
      const rate = payload.usd?.cny
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
        throw new Error('USD/CNY rate missing')
      }

      exchangeRate = {
        base: 'USD',
        target: 'CNY',
        rate,
        fetchedAt: Date.now(),
        date: payload.date,
        source: EXCHANGE_RATE_SOURCE,
      }
      saveExchangeRateCache(exchangeRate)
    } catch (error) {
      exchangeRate = {
        ...exchangeRate,
        error: error instanceof Error ? error.message : 'Failed to fetch exchange rate',
        source: EXCHANGE_RATE_SOURCE,
      }
    } finally {
      exchangeRatePromise = null
    }

    return exchangeRate
  })()

  return exchangeRatePromise
}

async function installAiusageCli(): Promise<{ success: boolean; error?: string }> {
  const { execFile } = require('child_process') as typeof import('child_process')

  // Try npm first, fall back to pnpm, then yarn
  const managers = ['npm', 'pnpm', 'yarn']

  for (const pm of managers) {
    const args = pm === 'yarn'
      ? ['global', 'add', '@juliantanx/aiusage']
      : ['install', '-g', '@juliantanx/aiusage']

    const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      execFile(pm, args, { timeout: 120_000, shell: true }, (err, _stdout, stderr) => {
        if (err) {
          resolve({ success: false, error: stderr || err.message })
        } else {
          resolve({ success: true })
        }
      })
    })

    if (result.success) return result
    // If this package manager isn't installed, try the next one
  }

  return { success: false, error: 'No package manager (npm/pnpm/yarn) could install @juliantanx/aiusage.' }
}

function checkCliInstalled(): Promise<boolean> {
  const { execFile } = require('child_process') as typeof import('child_process')
  return new Promise((resolve) => {
    execFile('aiusage', ['--version'], { timeout: 10_000, shell: true }, (err) => {
      resolve(!err)
    })
  })
}

function runFirstParse(): Promise<{ success: boolean; error?: string }> {
  const { execFile } = require('child_process') as typeof import('child_process')
  return new Promise((resolve) => {
    execFile('aiusage', ['parse'], { timeout: 120_000, shell: true }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: stderr || err.message })
      } else {
        resolve({ success: true })
      }
    })
  })
}

async function autoSetup(): Promise<void> {
  // Show overlay
  notifyRenderer('setup:status', { phase: 'checking' })
  showWindow()

  // Check if CLI is installed
  const cliFound = await checkCliInstalled()

  if (!cliFound) {
    // Install CLI
    notifyRenderer('setup:status', { phase: 'installing' })
    const installResult = await installAiusageCli()
    if (!installResult.success) {
      notifyRenderer('setup:status', { phase: 'failed', error: installResult.error })
      return
    }
  }

  // Run first parse
  notifyRenderer('setup:status', { phase: 'parsing' })
  await runFirstParse()
  // Parse failure is not fatal — user may have no logs yet

  notifyRenderer('setup:status', { phase: 'done' })
  pushDataUpdate()
}

// IPC handlers
/**
 * Everything the window draws, from one place.
 *
 * There were two paths building this - the pull the renderer makes when it
 * mounts, and the push the main process sends afterwards - and they returned
 * different shapes. Adding the quota to the push alone produced a window
 * that drew its header and nothing else, because the pull is the one that
 * lands first and it had never heard of quotas.
 *
 * The quota rides along rather than taking its own channel, so the panel
 * cannot show a fresh quota above stale tokens or the other way round.
 */
async function buildPayload(rows: QuotaRow[] | null) {
  // null means the read failed; the caller turns that into the failure shape.
  if (!rows) throw new HubError(hubProblem ?? 'unexpected', 'the hub did not answer')
  const quota = quotaView(rows, Date.now())

  /*
   * The usage figures are only fetched when something is going to draw them.
   * They are three more requests, they are off by default, and the panel
   * they feed is the part its owner said they do not look at.
   */
  const usage = settings.showUsage
    ? await fetchWidgetData(hub!, settings.rangeDays)
    : emptyWidgetData(settings.rangeDays)
  return { ...usage, quota }
}

/**
 * Stores the hub's dashboard password and reconnects with it.
 *
 * Typed here rather than into a config file by hand: someone setting up a
 * second machine should not have to be told which JSON key to add. It goes
 * to the same place the CLI keeps its secrets - see credentials.ts, which
 * also records what this widens.
 */
ipcMain.on('widget:set-always-on-top', (_event, next: unknown) => {
  if (typeof next !== 'boolean') return
  setAlwaysOnTop(next)
})

ipcMain.handle('widget:get-hub-password-source', () =>
  hub ? hubPasswordSource(hub.url) : 'none')

ipcMain.handle('widget:save-hub-password', async (_event, password: unknown) => {
  if (typeof password !== 'string' || password.length === 0) return false
  saveCredential(HUB_PASSWORD_CREDENTIAL, password)
  hub = new Hub({ url: resolveHubUrl(settings.hubUrl), password })
  await refreshAll()
  return true
})

ipcMain.handle('widget:get-data', () => currentUpdate())

ipcMain.handle('widget:open-dashboard', async () => {
  await openDashboardAction()
})

ipcMain.handle('widget:get-settings', () => {
  return settings
})

ipcMain.handle('widget:get-exchange-rate', async () => {
  return refreshExchangeRate()
})

ipcMain.handle('widget:save-settings', (_event, newSettings: WidgetSettings) => {
  settings = newSettings
  saveSettings(settings)
  applyTheme(settings.theme)
  startAutoRefresh()
  return settings
})

ipcMain.on('widget:hide-window', () => {
  win?.hide()
})

/**
 * The last height the panel reported, in CSS pixels.
 *
 * Kept so that a zoom change can be re-applied to the same measurement
 * without waiting for the renderer to notice and measure again - otherwise
 * the window keeps its old size until something else in the panel moves.
 */
let lastPanelSize: PanelSize | null = null

ipcMain.on('widget:resize-window', (_event, size: PanelSize) => {
  if (!win || !size) return
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || !Number.isFinite(size.minHeight)) return
  lastPanelSize = size
  resizeToPanel(size)
})

/**
 * Moves the window by a delta the strip measured in screen pixels.
 *
 * The folded strip cannot use -webkit-app-region: drag, because a drag
 * region does not hand its clicks back and the strip has to be both the
 * handle and the way back out of folding. So it watches the pointer itself
 * and sends what it sees. Deltas rather than positions: the renderer knows
 * how far the pointer moved and nothing about where this window is, which is
 * main's business and stays there.
 */
ipcMain.on('widget:move-window-by', (_event, delta: { dx: number; dy: number }) => {
  if (!win || !delta || !Number.isFinite(delta.dx) || !Number.isFinite(delta.dy)) return
  if (delta.dx === 0 && delta.dy === 0) return
  const bounds = win.getBounds()
  const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea
  // Kept on a screen. A strip dragged off the edge is a strip nobody can
  // reach again, and there is no taskbar entry to get it back from.
  win.setPosition(
    Math.max(area.x, Math.min(bounds.x + Math.round(delta.dx), area.x + area.width - bounds.width)),
    Math.max(area.y, Math.min(bounds.y + Math.round(delta.dy), area.y + area.height - bounds.height)),
  )
})

/**
 * Fits the window to the panel, keeping the bottom-right corner still.
 *
 * The panel measures itself in CSS pixels, which do not change when the zoom
 * does; the window is in device pixels, which do. So both dimensions are
 * multiplied here, and this is the only place that knows about it.
 *
 * The corner matters because this window lives against the bottom-right of
 * the screen. Growing it from a fixed top-left would push it off the edge,
 * and re-centring it on the tray - which is right when it first appears -
 * makes it jump sideways every time the contents change.
 */
function resizeToPanel(css: PanelSize): void {
  if (!win) return

  const zoom = clampZoom(settings.zoomFactor)
  const bounds = win.getBounds()
  const displayBounds = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea

  const nextWidth = Math.round(css.width * zoom)
  const floor = Math.min(MAX_REPORTED_FLOOR, Math.max(MIN_REPORTED_FLOOR, css.minHeight))
  // The OS will not go lower than this on Windows; asking for less only
  // makes Electron's idea of the window disagree with the window.
  const osFloor = process.platform === 'win32' ? TRANSPARENT_MIN_HEIGHT_WIN : 0
  const nextHeight = Math.min(
    Math.max(Math.ceil(css.height * zoom), Math.round(floor * zoom), osFloor),
    displayBounds.height,
  )

  if (Math.abs(bounds.height - nextHeight) < 2 && Math.abs(bounds.width - nextWidth) < 2) return

  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height
  const x = Math.max(displayBounds.x, Math.min(right - nextWidth, displayBounds.x + displayBounds.width - nextWidth))
  const y = Math.max(displayBounds.y, Math.min(bottom - nextHeight, displayBounds.y + displayBounds.height - nextHeight))

  /*
   * Made resizable for the length of one call, because it is not.
   *
   * On Windows a window created with resizable: false refuses setSize as
   * well as the drag handles, silently. That is why this whole path did
   * nothing for so long: the renderer measured, the message arrived, the
   * height was computed, and the window ignored it.
   *
   * The flag goes straight back, so the user still cannot drag an edge.
   */
  win.setResizable(true)
  /*
   * What arrives here is not always what the OS gives back.
   *
   * On Windows a transparent (layered) window will not go under 64 device
   * pixels tall. Electron does not know: getBounds() and getContentSize()
   * both report the height that was asked for while GetWindowRect says 64.
   * Measured on 2026-09-03 at zoom 0.5 - asked for 172x33, got 172x64 - and
   * confirmed by flipping transparent to false, after which the same call
   * produced 172x39 and the two agreed. Width has no such floor; 100 wide
   * was honoured.
   *
   * The strip at zoom 1.0 is exactly 64 tall, which is why this was invisible
   * for as long as 1.0 was the smallest it ever drew. Below that, the panel
   * is shorter than its window and the renderer centres it - see App.svelte
   * - so the whole window stays something you can press and grab.
   */
  win.setBounds({ x, y, width: nextWidth, height: nextHeight }, false)
  win.setResizable(false)
}


function getDashboardPort(): number {
  try {
    if (existsSync(PORT_FILE)) {
      const port = parseInt(readFileSync(PORT_FILE, 'utf-8').trim(), 10)
      if (!isNaN(port) && port > 0) return port
    }
  } catch {}
  return DASHBOARD_PORT
}

async function isDashboardReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const http = require('http') as typeof import('http')
    const req = http.get(`http://localhost:${port}`, (res) => {
      res.destroy()
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(200, () => { req.destroy(); resolve(false) })
  })
}

async function launchDashboard(): Promise<{ success: boolean; error?: string }> {
  const { spawn } = require('child_process') as typeof import('child_process')

  return new Promise((resolve) => {
    const child = spawn('aiusage', ['serve'], {
      detached: true,
      stdio: 'ignore',
      shell: true,
    })

    let failed = false

    child.on('error', () => { failed = true })

    child.on('close', (code) => {
      if (code !== 0) failed = true
    })

    child.unref()

    let attempts = 0
    const check = async () => {
      if (failed) {
        resolve({ success: false, error: 'aiusage command not found' })
        return
      }
      if (await isDashboardReachable(getDashboardPort())) {
        resolve({ success: true })
        return
      }
      attempts++
      if (attempts >= 25) {
        resolve({ success: false, error: 'Server failed to start within 5 seconds' })
        return
      }
      setTimeout(check, 200)
    }
    check()
  })
}
