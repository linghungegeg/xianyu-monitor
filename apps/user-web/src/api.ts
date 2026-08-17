export type UserWebMode = 'demo' | 'api'

export type UserRuntimeConfig = {
  mode: UserWebMode
  baseUrl: string
}

export type UserTokens = {
  accessToken: string
  refreshToken: string
}

export type UserIdentity = {
  id: string
}

export type UserListResource = 'monitors' | 'sellers' | 'pool' | 'discoveries' | 'events' | 'logs' | 'ai'

export type UserListRequest = {
  limit: number
  cursor: string | null
  sort: string
  filters: Record<string, string>
}

export type UserPage<T> = {
  items: T[]
  total: number
  nextCursor: string | null
  hasMore: boolean
}

export class UserApiError extends Error {
  readonly status: number | null
  readonly code: string | null

  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message)
    this.name = 'UserApiError'
    this.status = status
    this.code = code
  }
}

const TOKEN_STORAGE_KEY = 'xianyu.user-web.session'

// These paths are the User API read boundary. Admin and collector URLs never enter this client.
export const USER_LIST_PATHS: Record<UserListResource, string> = {
  monitors: '/v1/monitors',
  sellers: '/v1/sellers',
  pool: '/v1/market/items',
  discoveries: '/v1/market/discoveries',
  events: '/v1/events',
  logs: '/v1/logs',
  ai: '/v1/ai/insights'
}

function readStoredTokens(): UserTokens | null {
  try {
    const raw = window.sessionStorage.getItem(TOKEN_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<UserTokens>
    if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') return null
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken }
  } catch {
    return null
  }
}

function storeTokens(tokens: UserTokens | null): void {
  try {
    if (tokens) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens))
    else window.sessionStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // A blocked session store should not prevent a user from seeing the API error.
  }
}

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function responseMessage(payload: unknown, fallback: string): string {
  const record = asRecord(payload)
  return typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : fallback
}

export class UserApiClient {
  private readonly baseUrl: string
  private tokens: UserTokens | null
  private refreshInFlight: Promise<void> | null = null

  constructor(baseUrl: string) {
    this.baseUrl = cleanBaseUrl(baseUrl)
    this.tokens = readStoredTokens()
  }

  get configured(): boolean {
    return this.baseUrl.length > 0
  }

  clearSession(): void {
    this.tokens = null
    storeTokens(null)
  }

  async restoreSession(): Promise<UserIdentity | null> {
    if (!this.tokens) return null
    try {
      return await this.me()
    } catch {
      this.clearSession()
      return null
    }
  }

  async login(email: string, password: string): Promise<UserIdentity> {
    const tokens = await this.publicRequest<UserTokens>('/v1/auth/login', { email, password })
    this.setTokens(tokens)
    return this.me()
  }

  async register(email: string, password: string): Promise<UserIdentity> {
    const tokens = await this.publicRequest<UserTokens>('/v1/auth/register', { email, password })
    this.setTokens(tokens)
    return this.me()
  }

  async me(): Promise<UserIdentity> {
    return this.request<UserIdentity>('/v1/me')
  }

  async list<T>(resource: UserListResource, input: UserListRequest, signal?: AbortSignal): Promise<UserPage<T>> {
    const params = new URLSearchParams()
    params.set('limit', String(Math.min(100, Math.max(1, Math.trunc(input.limit)))))
    if (input.cursor) params.set('cursor', input.cursor)
    params.set('sort', input.sort)
    params.set('filters', JSON.stringify(input.filters))
    const payload = await this.request<unknown>(`${USER_LIST_PATHS[resource]}?${params.toString()}`, { signal })
    const record = asRecord(payload)
    const items = Array.isArray(record.items) ? record.items as T[] : []
    const nextCursorValue = record.nextCursor ?? record.next_cursor
    const nextCursor = typeof nextCursorValue === 'string' && nextCursorValue.length > 0 ? nextCursorValue : null
    const hasMore = typeof record.hasMore === 'boolean' ? record.hasMore : Boolean(nextCursor)
    const total = typeof record.total === 'number' && Number.isFinite(record.total) ? record.total : items.length
    return { items, total, nextCursor, hasMore }
  }

  private setTokens(tokens: UserTokens): void {
    if (!tokens?.accessToken || !tokens?.refreshToken) throw new UserApiError('User API 返回的令牌无效')
    this.tokens = tokens
    storeTokens(tokens)
  }

  private async publicRequest<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) }, false, false)
  }

  private async refresh(): Promise<void> {
    const refreshToken = this.tokens?.refreshToken
    if (!refreshToken) throw new UserApiError('登录已过期，请重新登录', 401)
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = (async () => {
      try {
        const tokens = await this.request<UserTokens>('/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) }, false, false)
        this.setTokens(tokens)
      } catch (error) {
        this.clearSession()
        throw error
      } finally {
        this.refreshInFlight = null
      }
    })()
    return this.refreshInFlight
  }

  private async request<T>(path: string, init: RequestInit = {}, allowRefresh = true, attachAuth = true): Promise<T> {
    if (!this.configured) throw new UserApiError('未配置 User API 地址')
    const headers = new Headers(init.headers)
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    if (attachAuth && this.tokens?.accessToken) headers.set('Authorization', `Bearer ${this.tokens.accessToken}`)
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers })
    const payload = await response.json().catch(() => null)
    if (response.status === 401 && allowRefresh && this.tokens?.refreshToken) {
      await this.refresh()
      return this.request<T>(path, init, false, attachAuth)
    }
    if (!response.ok) throw new UserApiError(responseMessage(payload, `User API 请求失败（${response.status}）`), response.status, typeof asRecord(payload).code === 'string' ? asRecord(payload).code as string : null)
    return payload as T
  }
}

export function readUserRuntimeConfig(): UserRuntimeConfig {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {}
  const baseUrl = cleanBaseUrl(env.VITE_USER_API_BASE_URL ?? '')
  const explicitMode = env.VITE_USER_WEB_MODE
  const mode: UserWebMode = explicitMode === 'api' || (!explicitMode && baseUrl) ? 'api' : 'demo'
  return { mode, baseUrl }
}
