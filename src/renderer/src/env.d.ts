import type { LauncherLog, LauncherStatus } from '../../shared/types'

declare global {
  interface Window {
    xianyu: {
      launcher: {
        status: () => Promise<LauncherStatus | undefined>
        login: (email: string, password: string) => Promise<void>
        register: (email: string, password: string) => Promise<void>
        start: () => Promise<void>
        pause: () => Promise<void>
        openChrome: () => Promise<void>
        unbind: () => Promise<void>
        logout: () => Promise<void>
        logs: () => Promise<LauncherLog[]>
        onStatus: (listener: (status: LauncherStatus) => void) => () => void
      }
    }
  }
}

export {}
