import { contextBridge, ipcRenderer } from 'electron'
import type { PanelSize, WidgetUpdate } from './update'

/*
 * The channel name, written out rather than imported.
 *
 * A preload runs sandboxed - contextIsolation with no sandbox: false - and a
 * sandboxed preload cannot require a local module. Importing the constant
 * made this file throw on load, which took contextBridge with it: no
 * window.widget, so the renderer's first call threw, so nothing ever
 * measured or drew. The panel showed a header and nothing else.
 *
 * The type import above is erased at compile time and costs nothing at
 * runtime, so the contract still holds; only the string is repeated.
 */
const WIDGET_UPDATE_CHANNEL = 'widget:data-update'
import type { WidgetSettings } from './settings'
import type { ExchangeRateState } from './currency'

export interface InstallStatus {
  phase: 'installing' | 'launching' | 'done' | 'failed'
  error?: string
}

export interface WidgetAPI {
  getData: () => Promise<WidgetUpdate | null>
  openDashboard: () => Promise<void>
  hideWindow: () => void
  resizeWindow: (size: PanelSize) => void
  /**
   * Move the window by a screen-pixel delta.
   *
   * The strip has no header, so it has no -webkit-app-region: drag. That is
   * deliberate: a drag region swallows clicks, and the strip has to be both
   * the handle and the way back. See App.svelte.
   */
  moveWindowBy: (delta: { dx: number; dy: number }) => void
  onDataUpdate: (callback: (data: WidgetUpdate) => void) => void
  onInstallStatus: (callback: (status: InstallStatus) => void) => void
  onSetupStatus: (callback: (status: InstallStatus) => void) => void
  getSettings: () => Promise<WidgetSettings>
  saveSettings: (settings: WidgetSettings) => Promise<WidgetSettings>
  saveHubPassword: (password: string) => Promise<boolean>
  /** Whether a password is in place, and where it came from. Never the value. */
  getHubPasswordSource: () => Promise<'typed' | 'inherited' | 'none'>
  getExchangeRate: () => Promise<ExchangeRateState>
}

contextBridge.exposeInMainWorld('widget', {
  getData: () => ipcRenderer.invoke('widget:get-data'),
  openDashboard: () => ipcRenderer.invoke('widget:open-dashboard'),
  hideWindow: () => ipcRenderer.send('widget:hide-window'),
  resizeWindow: (size: PanelSize) => ipcRenderer.send('widget:resize-window', size),
  moveWindowBy: (delta: { dx: number; dy: number }) => ipcRenderer.send('widget:move-window-by', delta),
  onDataUpdate: (callback: (data: WidgetUpdate) => void) => {
    ipcRenderer.removeAllListeners(WIDGET_UPDATE_CHANNEL)
    ipcRenderer.on(WIDGET_UPDATE_CHANNEL, (_event, data) => callback(data))
  },
  onInstallStatus: (callback: (status: InstallStatus) => void) => {
    ipcRenderer.removeAllListeners('install:status')
    ipcRenderer.on('install:status', (_event, status) => callback(status))
  },
  onSetupStatus: (callback: (status: InstallStatus) => void) => {
    ipcRenderer.removeAllListeners('setup:status')
    ipcRenderer.on('setup:status', (_event, status) => callback(status))
  },
  getSettings: () => ipcRenderer.invoke('widget:get-settings'),
  saveSettings: (settings: WidgetSettings) => ipcRenderer.invoke('widget:save-settings', settings),
  saveHubPassword: (password: string) => ipcRenderer.invoke('widget:save-hub-password', password),
  getHubPasswordSource: () => ipcRenderer.invoke('widget:get-hub-password-source'),
  getExchangeRate: () => ipcRenderer.invoke('widget:get-exchange-rate'),
} satisfies WidgetAPI)
