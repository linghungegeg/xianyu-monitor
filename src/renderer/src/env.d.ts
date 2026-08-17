import type { MonitorStatus, NewTask } from '../../shared/types'

declare global {
  interface Window {
    xianyu: {
      tasks: {
        list: () => Promise<import('../../shared/types').MonitorTask[]>
        create: (task: NewTask) => Promise<import('../../shared/types').MonitorTask>
        toggle: (id: string, enabled: boolean) => Promise<void>
        delete: (id: string) => Promise<void>
      }
      items: {
        list: (taskId?: string) => Promise<import('../../shared/types').SearchItem[]>
      }
      logs: {
        list: () => Promise<import('../../shared/types').ScanLog[]>
      }
      monitor: {
        status: () => Promise<MonitorStatus>
        login: () => Promise<void>
        scan: (taskId: string) => Promise<import('../../shared/types').ScanSummary>
        openItem: (url: string) => Promise<void>
        onStatus: (listener: (status: MonitorStatus) => void) => () => void
      }
    }
  }
}

export {}
