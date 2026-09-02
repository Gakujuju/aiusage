import { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog, screen, nativeTheme, Notification } from 'electron'
import { join } from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { EXCHANGE_RATE_SOURCE } from './currency'
import type { ExchangeRateState } from './currency'
import { queryWidgetData } from './data'
import { buildTooltip, queryQuota, quotaView, severity, shownRows } from './quota'
import type { Severity } from './quota'
import { SEVERITY_COLOURS, tintBitmap } from './tray-icon'
import { nextBatch, notificationsSince } from './notifications'
import { t } from './i18n'
import { loadSettings, saveSettings } from './settings'
import type { WidgetSettings } from './settings'
import {
  getTrayIconNativeImage,
  getWidgetNativeBindingPath,
  getWindowPosition,
  hasUsableTrayBounds,
  shouldHideWindowOnBlur,
  shouldHideWindowOnClose,
  shouldShowWindowOnLaunch,
} from './ui'

const nodeRequire = createRequire(__filename)
const Database = nodeRequire('better-sqlite3') as typeof import('better-sqlite3')

const DB_PATH = join(homedir(), '.aiusage', 'cache.db')
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
 * A floor against the panel measuring itself mid-render.
 *
 * The first height this receives on a cold start is 51 - the header alone,
 * before anything below it exists - and a 51-pixel window is a glitch
 * someone would report. 120 is above that and below anything real: the
 * quota-only panel measures 238.
 *
 * It was 320, chosen when the window held a trend chart and three stat rows.
 * That number outlived its contents and became a floor the panel could not
 * get under, which is most of why there was blank space below the text.
 */
const MIN_WINDOW_HEIGHT = 120

/*
 * How far the whole panel can be scaled, and in what steps.
 *
 * Zoom rather than a draggable edge. The window already sizes itself to its
 * contents, so widening it by hand would only add the margin that was just
 * taken out, and the next content change would undo it. Scaling moves the
 * text, the bars and the window together and leaves that behaviour intact.
 *
 * 0.7 to 1.5 was chosen by looking at both ends: below 0.7 the percentages
 * stop being readable at arm's length, and above 1.5 the countdown wraps
 * onto a second line, which is the one thing a glanceable panel cannot do.
 * 0.1 steps, because 0.05 needs two presses to see any difference.
 */
const ZOOM_MIN = 0.7
const ZOOM_MAX = 1.5
const ZOOM_STEP = 0.1
const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000

let tray: Tray | null = null
let win: BrowserWindow | null = null
let db: InstanceType<typeof Database> | null = null
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

let trayTimer: ReturnType<typeof setInterval> | null = null
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

// Prevent dock icon on macOS
if (process.platform === 'darwin' && app.dock) {
  app.dock.hide()
}

app.whenReady().then(async () => {
  settings = loadSettings(app.getLocale())
  const dbExists = existsSync(DB_PATH)

  if (dbExists) {
    db = new Database(DB_PATH, {
      readonly: true,
      nativeBinding: getWidgetNativeBindingPath(__dirname),
    })
  }

  /*
   * This is a quota display, and a spoke has no quota to display.
   *
   * Only the hub runs the snapshot (a spoke has quotaSnapshotInterval: 0),
   * so on any other machine quota_current is empty and always will be. An
   * icon that sits in the tray showing nothing is worse than no icon: it
   * occupies the place where a real reading would be, and the way you find
   * out is by hovering over it and seeing blanks.
   */
  if (!dbExists || quotaRowCount() === 0) {
    say('no quota data in this database. This build shows quota windows, and only the hub collects them. Not starting.')
    app.exit(0)
    return
  }

  applyTheme(settings.theme)
  createTray()
  createWindow()
  startAutoRefresh()
  startTrayRefresh()
  startNotificationWatch()
  void refreshExchangeRate()

  if (!dbExists) {
    await autoSetup()
  } else if (shouldShowWindowOnLaunch(app.isPackaged)) {
    showWindowWhenTrayReady()
  }
})

app.on('window-all-closed', () => {
  // Keep the app running in the tray — do not quit
})

app.on('before-quit', () => {
  db?.close()
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

/** Zero on any machine that does not collect quotas, including a broken read. */
function quotaRowCount(): number {
  try {
    return shownRows(queryQuota(db!)).length
  } catch {
    return 0
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
  updateTray()

  tray.on('click', () => toggleWindow())
  tray.on('right-click', () => {
    const i18n = t(settings.locale)
    const menu = Menu.buildFromTemplate([
      { label: i18n.showPanel, click: () => showWindow() },
      { label: i18n.openDashboard, click: () => openDashboardAction() },
      { label: i18n.refresh, click: () => pushDataUpdate() },
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

function createWindow(): void {
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
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
    win.on('blur', () => win?.hide())
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

function pushDataUpdate(): void {
  if (!win || !db) return
  try {
    const data = buildPayload()
    win.webContents.send('widget:data-update', data)
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
    say(`could not build the panel data: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * What the tray shows, from the database, now.
 *
 * Both the colour and the words come from the same read, so they cannot
 * disagree - an icon that has gone red beside a tooltip that has not caught
 * up would be worse than either alone.
 */
function updateTray(): void {
  if (!tray || !db) return
  let rows
  try {
    rows = queryQuota(db)
  } catch {
    /*
     * The database is there and the query failed, which is not the same as
     * having nothing to show. Saying so is the point of a resident display:
     * the one thing it must never do is keep presenting the last good
     * numbers as though they were current.
     */
    tray.setToolTip('AIUsage — cannot read the database')
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
function checkNotifications(): void {
  if (!db || !settings.notifications) return

  const now = Date.now()
  if (settings.notificationsSeenAt == null) {
    settings = { ...settings, notificationsSeenAt: now }
    saveSettings(settings)
    say('first run: notifications start from now, nothing replayed')
    return
  }

  let batch
  try {
    batch = nextBatch(notificationsSince(db, settings.notificationsSeenAt), settings.notificationsSeenAt)
  } catch (error) {
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

function startTrayRefresh(): void {
  if (trayTimer) clearInterval(trayTimer)
  trayTimer = setInterval(() => updateTray(), TRAY_REFRESH_MS)
}

function startAutoRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(() => pushDataUpdate(), settings.refreshIntervalSec * 1000)
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
  const { execFile } = nodeRequire('child_process') as typeof import('child_process')

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
  const { execFile } = nodeRequire('child_process') as typeof import('child_process')
  return new Promise((resolve) => {
    execFile('aiusage', ['--version'], { timeout: 10_000, shell: true }, (err) => {
      resolve(!err)
    })
  })
}

function runFirstParse(): Promise<{ success: boolean; error?: string }> {
  const { execFile } = nodeRequire('child_process') as typeof import('child_process')
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

  // Open database if it now exists
  if (existsSync(DB_PATH)) {
    db = new Database(DB_PATH, {
      readonly: true,
      nativeBinding: getWidgetNativeBindingPath(__dirname),
    })
  }

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
function buildPayload(): ReturnType<typeof queryWidgetData> & { quota: ReturnType<typeof quotaView> } {
  return { ...queryWidgetData(db!, settings.rangeDays), quota: quotaView(queryQuota(db!), Date.now()) }
}

ipcMain.handle('widget:get-data', () => {
  if (!db) return null
  return buildPayload()
})

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
let lastPanelSize: { width: number; height: number } | null = null

ipcMain.on('widget:resize-window', (_event, size: { width: number; height: number }) => {
  if (!win || !size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return
  lastPanelSize = size
  resizeToPanel(size)
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
function resizeToPanel(css: { width: number; height: number }): void {
  if (!win) return

  const zoom = clampZoom(settings.zoomFactor)
  const bounds = win.getBounds()
  const displayBounds = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea

  const nextWidth = Math.round(css.width * zoom)
  const nextHeight = Math.min(
    Math.max(Math.ceil(css.height * zoom), Math.round(MIN_WINDOW_HEIGHT * zoom)),
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
    const http = nodeRequire('http') as typeof import('http')
    const req = http.get(`http://localhost:${port}`, (res) => {
      res.destroy()
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(200, () => { req.destroy(); resolve(false) })
  })
}

async function launchDashboard(): Promise<{ success: boolean; error?: string }> {
  const { spawn } = nodeRequire('child_process') as typeof import('child_process')

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
