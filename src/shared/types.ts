export type MonitorTask = {
  id: string
  keyword: string
  minPrice: number | null
  maxPrice: number | null
  region: string | null
  intervalMinutes: number
  enabled: boolean
  lastScannedAt: string | null
  createdAt: string
  updatedAt: string
}

export type NewTask = Omit<MonitorTask, 'id' | 'lastScannedAt' | 'createdAt' | 'updatedAt'>

export type SearchItem = {
  itemId: string
  taskId: string
  title: string
  price: number | null
  region: string | null
  publishedText: string | null
  wantCount: number | null
  url: string
  firstSeenAt: string
  lastSeenAt: string
  isNew: boolean
}

export type ScanLog = {
  id: number
  taskId: string | null
  level: 'info' | 'success' | 'error'
  message: string
  createdAt: string
}

export type MonitorStatus = {
  chrome: 'idle' | 'running' | 'login-required' | 'error'
  message: string
  nextScanAt: string | null
}

export type ScanSummary = {
  scanned: number
  newItems: number
}
