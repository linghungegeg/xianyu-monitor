export type LauncherStatus = {
  session: 'signed-out' | 'checking' | 'ready' | 'running' | 'paused' | 'offline' | 'revoked' | 'error'
  browser: 'idle' | 'open' | 'error'
  entitled: boolean
  message: string
  account?: string
}

export type LauncherLog = {
  id: number
  level: 'info' | 'success' | 'error'
  message: string
  createdAt: string
}

export type OutboxEntry = {
  id: string
  kind: 'heartbeat' | 'market_batch' | 'supply_result' | 'supply_migration_result'
  payload: Record<string, unknown>
  attempts: number
  nextAttemptAt: string
  createdAt: string
}
