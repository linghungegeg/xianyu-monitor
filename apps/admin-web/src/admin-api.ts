export type AdminResource = 'users' | 'billing' | 'market' | 'quality' | 'uploads' | 'ai' | 'capacity' | 'audit'
export type AdminProvider = { id: string; providerCode: string; modelReference: string; baseUrl: string; stream: boolean; reasoning: boolean; settings: unknown; status: string }
export type AdminAnnouncement = { id: string; title: string; body: string; scope: 'global' | 'personal'; userId?: string | null; enabled: boolean; startsAt: string; endsAt?: string | null }
export type AdminIdentity = { id: string; role?: string }
export type AdminSession = { accessToken: string; refreshToken: string; identity: AdminIdentity }
export type CursorListQuery = { limit: 20 | 50 | 100; cursor?: string; sort: string; order: 'asc' | 'desc'; filters?: Record<string, string | undefined> }
export type CursorPage<T> = { items: T[]; page: { limit: number; nextCursor: string | null; hasMore: boolean; total: number; snapshot?: string } }

const sessionKey = 'xianyu-admin-web.session.v1'
const resources: Record<AdminResource, string> = {
  users: '/v1/users',
  billing: '/v1/admin/billing',
  market: '/v1/admin/market',
  quality: '/v1/admin/quality',
  uploads: '/v1/admin/uploads',
  ai: '/v1/admin/ai',
  capacity: '/v1/admin/capacity',
  audit: '/v1/admin/audit'
}

export const adminWebConfig = {
  demoMode: import.meta.env.VITE_ADMIN_DEMO_MODE !== 'false',
  apiBaseUrl: (import.meta.env.VITE_ADMIN_API_BASE_URL ?? '').replace(/\/+$/, '')
}

export class AdminApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message)
    this.name = 'AdminApiError'
  }
}

type ApiError = { error?: string; code?: string }
type LoginResponse = { accessToken: string; refreshToken: string }
type MeResponse = { id: string; role?: string }

function readStoredSession(): Omit<AdminSession, 'identity'> | null {
  try {
    const value = sessionStorage.getItem(sessionKey)
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<LoginResponse>
    return typeof parsed.accessToken === 'string' && typeof parsed.refreshToken === 'string' ? { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken } : null
  } catch {
    sessionStorage.removeItem(sessionKey)
    return null
  }
}

function assertPage<T>(value: unknown): CursorPage<T> {
  const result = value as Partial<CursorPage<T>>
  if (!Array.isArray(result.items) || !result.page || typeof result.page.total !== 'number' || typeof result.page.hasMore !== 'boolean' || (result.page.nextCursor !== null && typeof result.page.nextCursor !== 'string')) throw new AdminApiError('Admin API 返回的分页合同无效')
  return result as CursorPage<T>
}

export class AdminApi {
  private session: AdminSession | null = null
  private restoreTask: Promise<AdminSession | null> | null = null

  constructor(private readonly baseUrl: string) {}

  async login(email: string, password: string): Promise<AdminSession> {
    const tokens = await this.request<LoginResponse>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
    this.session = { ...tokens, identity: await this.me(tokens.accessToken) }
    this.persist()
    return this.session
  }

  restore(): Promise<AdminSession | null> {
    if (this.restoreTask) return this.restoreTask
    this.restoreTask = this.restoreSession().finally(() => { this.restoreTask = null })
    return this.restoreTask
  }

  private async restoreSession(): Promise<AdminSession | null> {
    const stored = readStoredSession()
    if (!stored) return null
    this.session = { ...stored, identity: { id: '' } }
    try {
      this.session.identity = await this.me(stored.accessToken)
      return this.session
    } catch (error) {
      if (!(error instanceof AdminApiError) || (error.status !== 401 && error.status !== 403)) throw error
    }
    try {
      const tokens = await this.request<LoginResponse>('/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: stored.refreshToken }) })
      this.session = { ...tokens, identity: await this.me(tokens.accessToken) }
      this.persist()
      return this.session
    } catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) this.logout()
      throw error
    }
  }

  async list<T>(resource: AdminResource, query: CursorListQuery): Promise<CursorPage<T>> {
    const params = new URLSearchParams({ limit: String(query.limit), sort: query.sort, order: query.order })
    if (query.cursor) params.set('cursor', query.cursor)
    for (const [key, value] of Object.entries(query.filters ?? {})) if (value) params.set(key, value)
    return assertPage<T>(await this.request<unknown>(`${resources[resource]}?${params.toString()}`, { method: 'GET', authorized: true }))
  }

  async providers(): Promise<AdminProvider[]> { return (await this.request<{ items: AdminProvider[] }>('/v1/admin/ai/providers', { method: 'GET', authorized: true })).items }
  async createProvider(input: { providerCode: string; modelReference: string; baseUrl: string; apiKey?: string; apiKeyCiphertext?: string; stream: boolean; reasoning: boolean; settings?: unknown; status: string }): Promise<AdminProvider> {
    return this.request<AdminProvider>('/v1/admin/ai/providers', { method: 'POST', authorized: true, body: JSON.stringify(input) })
  }
  async fetchProviderModels(id: string): Promise<unknown[]> { return (await this.request<{ items: unknown[] }>(`/v1/admin/ai/providers/${encodeURIComponent(id)}/models`, { method: 'GET', authorized: true })).items }
  async updateProvider(id: string, input: { modelReference: string; baseUrl: string; apiKey?: string; stream: boolean; reasoning: boolean; settings?: unknown; status: string }): Promise<AdminProvider> {
    return this.request<AdminProvider>(`/v1/admin/ai/providers/${encodeURIComponent(id)}`, { method: 'PATCH', authorized: true, body: JSON.stringify(input) })
  }
  async createAnnouncement(input: { title: string; body: string; enabled: boolean }): Promise<AdminAnnouncement> {
    return this.request<AdminAnnouncement>('/v1/admin/announcements', { method: 'POST', authorized: true, body: JSON.stringify(input) })
  }
  async updateUserStatus(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean; status: string }> {
    return this.request<{ id: string; enabled: boolean; status: string }>(`/v1/admin/users/${encodeURIComponent(id)}/status`, { method: 'PATCH', authorized: true, body: JSON.stringify({ enabled }) })
  }
  async adjustUserPoints(id: string, delta: number): Promise<{ id: string; points: number; delta: number }> {
    return this.request<{ id: string; points: number; delta: number }>(`/v1/admin/users/${encodeURIComponent(id)}/points`, { method: 'PATCH', authorized: true, body: JSON.stringify({ delta }) })
  }

  logout(): void {
    this.session = null
    sessionStorage.removeItem(sessionKey)
  }

  private async me(accessToken?: string): Promise<AdminIdentity> {
    return this.request<MeResponse>('/v1/me', { method: 'GET', authorized: true, accessToken })
  }

  private persist(): void {
    if (this.session) sessionStorage.setItem(sessionKey, JSON.stringify({ accessToken: this.session.accessToken, refreshToken: this.session.refreshToken }))
  }

  private async request<T>(path: string, options: { method: 'GET' | 'POST' | 'PATCH'; body?: string; authorized?: boolean; accessToken?: string }): Promise<T> {
    if (!this.baseUrl) throw new AdminApiError('未配置 VITE_ADMIN_API_BASE_URL，无法连接独立 Admin API')
    const headers = new Headers({ Accept: 'application/json' })
    if (options.body) headers.set('Content-Type', 'application/json')
    if (options.authorized) {
      const accessToken = options.accessToken ?? this.session?.accessToken
      if (!accessToken) throw new AdminApiError('管理员会话不存在')
      headers.set('Authorization', `Bearer ${accessToken}`)
    }
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, { method: options.method, body: options.body, headers, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
    } catch {
      throw new AdminApiError('无法连接独立 Admin API')
    }
    const payload = await response.json().catch(() => null) as ApiError | T | null
    if (!response.ok) {
      const error = payload as ApiError | null
      throw new AdminApiError(error?.error ?? `Admin API 请求失败 (${response.status})`, response.status, error?.code)
    }
    return payload as T
  }
}

export const adminApi = new AdminApi(adminWebConfig.apiBaseUrl)
