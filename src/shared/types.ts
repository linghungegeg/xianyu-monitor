export type LauncherStatus = {
  session: 'signed-out' | 'checking' | 'ready' | 'running' | 'paused' | 'offline' | 'revoked' | 'error'
  browser: 'idle' | 'open' | 'error'
  entitled: boolean
  message: string
}

export type LauncherLog = {
  id: number
  level: 'info' | 'success' | 'error'
  message: string
  createdAt: string
}

export type OutboxEntry = {
  id: string
  kind: 'heartbeat'
  payload: Record<string, string>
  attempts: number
  nextAttemptAt: string
  createdAt: string
}
