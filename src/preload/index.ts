import { contextBridge, ipcRenderer } from 'electron'
import type { LauncherStatus } from '../shared/types'

const api = {
  launcher: {
    status: () => ipcRenderer.invoke('launcher:status'),
    login: (email: string, password: string) => ipcRenderer.invoke('launcher:login', email, password),
    start: () => ipcRenderer.invoke('launcher:start'),
    pause: () => ipcRenderer.invoke('launcher:pause'),
    openChrome: () => ipcRenderer.invoke('launcher:open-chrome'),
    unbind: () => ipcRenderer.invoke('launcher:unbind'),
    logout: () => ipcRenderer.invoke('launcher:logout'),
    logs: () => ipcRenderer.invoke('launcher:logs'),
    onStatus: (listener: (status: LauncherStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: LauncherStatus): void => listener(status)
      ipcRenderer.on('launcher:status', handler)
      return () => ipcRenderer.removeListener('launcher:status', handler)
    }
  }
}

contextBridge.exposeInMainWorld('xianyu', api)
