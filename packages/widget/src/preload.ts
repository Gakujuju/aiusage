import { contextBridge, ipcRenderer } from 'electron'
import type { WidgetData } from './data'
import type { WidgetSettings } from './settings'
import type { ExchangeRateState } from './currency'

export interface InstallStatus {
  phase: 'installing' | 'launching' | 'done' | 'failed'
  error?: string
}

export interface WidgetAPI {
  getData: () => Promise<WidgetData>
  openDashboard: () => Promise<void>
  hideWindow: () => void
  resizeWindow: (size: { width: number; height: number }) => void
  onDataUpdate: (callback: (data: WidgetData) => void) => void
  onInstallStatus: (callback: (status: InstallStatus) => void) => void
  onSetupStatus: (callback: (status: InstallStatus) => void) => void
  getSettings: () => Promise<WidgetSettings>
  saveSettings: (settings: WidgetSettings) => Promise<WidgetSettings>
  saveHubPassword: (password: string) => Promise<boolean>
  getExchangeRate: () => Promise<ExchangeRateState>
}

contextBridge.exposeInMainWorld('widget', {
  getData: () => ipcRenderer.invoke('widget:get-data'),
  openDashboard: () => ipcRenderer.invoke('widget:open-dashboard'),
  hideWindow: () => ipcRenderer.send('widget:hide-window'),
  resizeWindow: (size: { width: number; height: number }) => ipcRenderer.send('widget:resize-window', size),
  onDataUpdate: (callback: (data: WidgetData) => void) => {
    ipcRenderer.removeAllListeners('widget:data-update')
    ipcRenderer.on('widget:data-update', (_event, data) => callback(data))
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
  getExchangeRate: () => ipcRenderer.invoke('widget:get-exchange-rate'),
} satisfies WidgetAPI)
