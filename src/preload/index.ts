import { contextBridge, ipcRenderer } from 'electron'
import type { MonitorStatus, NewTask } from '../shared/types'

const api = {
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    create: (task: NewTask) => ipcRenderer.invoke('tasks:create', task),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('tasks:toggle', id, enabled),
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id)
  },
  items: {
    list: (taskId?: string) => ipcRenderer.invoke('items:list', taskId)
  },
  logs: {
    list: () => ipcRenderer.invoke('logs:list')
  },
  monitor: {
    status: () => ipcRenderer.invoke('monitor:status'),
    login: () => ipcRenderer.invoke('monitor:login'),
    scan: (taskId: string) => ipcRenderer.invoke('monitor:scan', taskId),
    openItem: (url: string) => ipcRenderer.invoke('monitor:open-item', url),
    onStatus: (listener: (status: MonitorStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: MonitorStatus): void => listener(status)
      ipcRenderer.on('monitor:status', handler)
      return () => ipcRenderer.removeListener('monitor:status', handler)
    }
  }
}

contextBridge.exposeInMainWorld('xianyu', api)
