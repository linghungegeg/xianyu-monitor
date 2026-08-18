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

export type UserListResource = 'monitors' | 'sellerMonitors' | 'sellers' | 'pool' | 'discoveries' | 'events' | 'logs' | 'ai'

export type SupplySourceType = 'xianyu' | 'general'
export type SupplyMaterialStatus = 'draft' | 'ready' | 'archived'
export type SupplyMaterial = {
  id: string
  sourceType: SupplySourceType
  sourcePlatform: string
  sourceItemId: string
  sourceUrl: string
  title: string
  description?: string | null
  price: number
  mainImages: string[]
  detailImages: string[]
  sku?: unknown | null
  attributes: Record<string, unknown>
  currentVersion: number
  status: SupplyMaterialStatus
  importBatchId: string
  createdAt: string
  updatedAt: string
}

export type SupplyMaterialPatch = Partial<Pick<SupplyMaterial, 'title' | 'description' | 'price' | 'mainImages' | 'detailImages' | 'sku' | 'attributes' | 'status'>>

export type SupplyImportInput = {
  schemaVersion: 1
  sourceType: SupplySourceType
  sourceFormat: 'parsed_snapshot_json' | 'parsed_snapshot_jsonl'
  idempotencyKey: string
  snapshots: unknown[]
}

export type SupplyImportResult = {
  batchId: string
  receivedCount: number
  insertedCount: number
  deduplicatedCount: number
  failedCount: number
  rejections: Array<{ recordIndex: number; reasonCode: string }>
  duplicate: boolean
}

export type SupplyMigrationRequest = {
  id: string
  sourceKind: 'market_item' | 'published_item' | 'public_url'
  platform: 'goofish'
  platformItemId: string
  itemUrl: string
  status: 'queued' | 'claimed' | 'succeeded' | 'failed'
  materialId?: string | null
  lastError?: string | null
  createdAt: string
  updatedAt: string
  duplicate: boolean
}

export type SupplyPublishSchedule =
  | { mode: 'immediate' }
  | { mode: 'scheduled'; scheduledAt: string }
  | { mode: 'random_window'; windowStart: string; windowEnd: string }

export type SupplyPublishPlan = {
  id: string
  materialId: string
  materialVersionId: string
  materialVersion: number
  materialSnapshot: Record<string, unknown>
  scheduleMode: SupplyPublishSchedule['mode']
  scheduledAt: string
  windowStart?: string | null
  windowEnd?: string | null
  status: string
  materialTitle?: string
  sourcePlatform?: string
  createdAt: string
  updatedAt: string
  duplicate?: boolean
}

export type UserListRequest = {
  limit: number
  cursor: string | null
  sort: string
  filters: Record<string, string>
}

export type UserPage<T> = {
  items: T[]
  limit?: number
  total: number
  nextCursor: string | null
  hasMore: boolean
  snapshot?: string | null
}

export type MarketCategory = {
  id: string
  platform: string
  platformCategoryId: string
  parentId?: string | null
  name: string
  path: string
  depth: number
  active: boolean
  observedAt: string
}

export type MarketRegion = {
  name: string
  region: string
  platform: string
}

export type UserAiJobInput = {
  capabilityCode: string
  input: unknown
  idempotencyKey: string
  promptVersion?: number
  scope?: 'personal' | 'global'
}

export type UserAiJob = {
  id: string
  status: string
  duplicate?: boolean
}
export type UserAnnouncement = { id: string; title: string; body: string; startsAt: string; endsAt?: string | null }

export type MonitorTaskSort = 'comprehensive' | 'newly_reduced' | 'newly_published' | 'price_asc' | 'price_desc'
export type MonitorTaskStatus = 'active' | 'paused'

export type MonitorTaskRule = {
  keyword?: string
  categoryPath?: string[]
  sort: MonitorTaskSort
  minPrice?: number
  maxPrice?: number
  region?: string
  filters?: Record<string, string>
  includeWords?: string[]
  excludeWords?: string[]
  pageLimit: number
}

export type MonitorTask = {
  id: string
  rule: MonitorTaskRule
  ruleVersion: number
  intervalSeconds: number
  status: MonitorTaskStatus
  nextRunAt: string
  createdAt: string
  updatedAt: string
}

export type MonitorTaskInput = {
  rule: MonitorTaskRule
  intervalSeconds: number
  status?: MonitorTaskStatus
}

export type SellerMonitorStatus = 'active' | 'paused'

export type SellerMonitor = {
  id: string
  sellerId: string
  platform: 'goofish'
  platformSellerId: string
  profileUrl: string
  publicName?: string
  region?: string
  ruleVersion: number
  intervalSeconds: number
  status: SellerMonitorStatus
  nextRunAt: string
  createdAt: string
  updatedAt: string
}

export type SellerMonitorInput = {
  platform?: 'goofish'
  platformSellerId?: string
  profileUrl?: string
  intervalSeconds: number
  status?: SellerMonitorStatus
}

export type SellerProfile = {
  id: string
  platform: 'goofish'
  platformSellerId: string
  publicName?: string
  region?: string
  publicProfile?: unknown
  firstSeenAt: string
  lastSeenAt: string
}

export type SellerMonitorProfile = {
  task: SellerMonitor
  seller: SellerProfile
}

export type SellerItemState = 'active' | 'sold' | 'offline' | 'unknown'

export type SellerItem = {
  id: string
  platform: 'goofish'
  platformItemId: string
  state: SellerItemState
  title?: string
  price?: string
  previousPrice?: string
  currentPrice?: string
  region?: string
  conditionText?: string
  wantCount?: number
  images: string[]
  categoryPath?: string[]
  description?: string
  tags?: string[]
  sku?: unknown
  sourceUrl?: string
  firstSeenAt: string
  lastSeenAt: string
}

export type SellerEvent = {
  id: string
  itemId: string
  sellerId: string
  eventType: string
  beforeVersionId?: string
  afterVersionId?: string
  eventKey: string
  occurredAt: string
  detectedAt: string
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
  sellerMonitors: '/v1/seller-monitors',
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

function monitorTaskRule(value: unknown): MonitorTaskRule {
  const parsed = typeof value === 'string' ? (() => {
    try { return JSON.parse(value) } catch { return {} }
  })() : value
  const record = asRecord(parsed)
  const categoryPath = Array.isArray(record.categoryPath) ? record.categoryPath.filter((part): part is string => typeof part === 'string') : undefined
  const includeWords = Array.isArray(record.includeWords) ? record.includeWords.filter((word): word is string => typeof word === 'string') : undefined
  const excludeWords = Array.isArray(record.excludeWords) ? record.excludeWords.filter((word): word is string => typeof word === 'string') : undefined
  const filters = Object.fromEntries(Object.entries(asRecord(record.filters)).filter(([, entry]) => typeof entry === 'string')) as Record<string, string>
  const sort: MonitorTaskSort = record.sort === 'newly_reduced' || record.sort === 'newly_published' || record.sort === 'price_asc' || record.sort === 'price_desc' ? record.sort : 'comprehensive'
  return {
    ...(typeof record.keyword === 'string' ? { keyword: record.keyword } : {}),
    ...(categoryPath?.length ? { categoryPath } : {}),
    sort,
    ...(typeof record.minPrice === 'number' ? { minPrice: record.minPrice } : {}),
    ...(typeof record.maxPrice === 'number' ? { maxPrice: record.maxPrice } : {}),
    ...(typeof record.region === 'string' ? { region: record.region } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(includeWords?.length ? { includeWords } : {}),
    ...(excludeWords?.length ? { excludeWords } : {}),
    pageLimit: typeof record.pageLimit === 'number' ? record.pageLimit : 1
  }
}

function monitorTask(value: unknown): MonitorTask {
  const envelope = asRecord(value)
  const record = asRecord(envelope.task ?? envelope.item ?? value)
  const status: MonitorTaskStatus = record.status === 'paused' ? 'paused' : 'active'
  const stringValue = (key: string) => typeof record[key] === 'string' ? record[key] as string : ''
  const numberValue = (key: string, fallback: number) => typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : fallback
  return {
    id: stringValue('id'),
    rule: monitorTaskRule(record.rule ?? record.rule_json),
    ruleVersion: numberValue('ruleVersion', numberValue('rule_version', 1)),
    intervalSeconds: numberValue('intervalSeconds', numberValue('interval_seconds', 60)),
    status,
    nextRunAt: stringValue('nextRunAt') || stringValue('next_run_at'),
    createdAt: stringValue('createdAt') || stringValue('created_at'),
    updatedAt: stringValue('updatedAt') || stringValue('updated_at')
  }
}

function sellerMonitor(value: unknown): SellerMonitor {
  const envelope = asRecord(value)
  const record = asRecord(envelope.task ?? envelope.item ?? value)
  const stringValue = (key: string) => typeof record[key] === 'string' ? record[key] as string : ''
  const numberValue = (key: string, fallback: number) => typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : fallback
  return {
    id: stringValue('id'),
    sellerId: stringValue('sellerId') || stringValue('seller_id'),
    platform: 'goofish',
    platformSellerId: stringValue('platformSellerId') || stringValue('platform_seller_id'),
    profileUrl: stringValue('profileUrl') || stringValue('profile_url'),
    ...(stringValue('publicName') || stringValue('public_name') ? { publicName: stringValue('publicName') || stringValue('public_name') } : {}),
    ...(stringValue('region') ? { region: stringValue('region') } : {}),
    ruleVersion: numberValue('ruleVersion', numberValue('rule_version', 1)),
    intervalSeconds: numberValue('intervalSeconds', numberValue('interval_seconds', 60)),
    status: record.status === 'paused' ? 'paused' : 'active',
    nextRunAt: stringValue('nextRunAt') || stringValue('next_run_at'),
    createdAt: stringValue('createdAt') || stringValue('created_at'),
    updatedAt: stringValue('updatedAt') || stringValue('updated_at')
  }
}

function sellerProfile(value: unknown): SellerProfile {
  const record = asRecord(value)
  const stringValue = (key: string) => typeof record[key] === 'string' ? record[key] as string : ''
  return {
    id: stringValue('id'),
    platform: 'goofish',
    platformSellerId: stringValue('platformSellerId') || stringValue('platform_seller_id'),
    ...(stringValue('publicName') || stringValue('public_name') ? { publicName: stringValue('publicName') || stringValue('public_name') } : {}),
    ...(stringValue('region') ? { region: stringValue('region') } : {}),
    ...(record.publicProfile !== undefined ? { publicProfile: record.publicProfile } : record.public_profile !== undefined ? { publicProfile: record.public_profile } : {}),
    firstSeenAt: stringValue('firstSeenAt') || stringValue('first_seen_at'),
    lastSeenAt: stringValue('lastSeenAt') || stringValue('last_seen_at')
  }
}

function sellerItem(value: unknown): SellerItem {
  const record = asRecord(value)
  const stringValue = (key: string) => typeof record[key] === 'string' ? record[key] as string : ''
  const numberValue = (key: string) => typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] as number : undefined
  const stringArrayValue = (key: string) => Array.isArray(record[key]) ? record[key].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : []
  const stateValue = stringValue('state') || stringValue('lifecycleState') || stringValue('lifecycle_state')
  const state: SellerItemState = stateValue === 'active' || stateValue === 'sold' || stateValue === 'offline' ? stateValue : 'unknown'
  const wantCount = numberValue('wantCount') ?? numberValue('want_count')
  const images = stringArrayValue('images').length ? stringArrayValue('images') : stringArrayValue('imageUrls')
  const categoryPath = stringArrayValue('categoryPath').length ? stringArrayValue('categoryPath') : stringArrayValue('category_path')
  return {
    id: stringValue('id'),
    platform: 'goofish',
    platformItemId: stringValue('platformItemId') || stringValue('platform_item_id'),
    state,
    ...(stringValue('title') ? { title: stringValue('title') } : {}),
    ...(typeof record.price === 'number' || typeof record.price === 'string' ? { price: String(record.price) } : {}),
    ...(typeof record.previousPrice === 'number' || typeof record.previousPrice === 'string' ? { previousPrice: String(record.previousPrice) } : {}),
    ...(typeof record.currentPrice === 'number' || typeof record.currentPrice === 'string' ? { currentPrice: String(record.currentPrice) } : {}),
    ...(stringValue('region') ? { region: stringValue('region') } : {}),
    ...(stringValue('conditionText') || stringValue('condition_text') ? { conditionText: stringValue('conditionText') || stringValue('condition_text') } : {}),
    ...(wantCount === undefined ? {} : { wantCount }),
    images,
    ...(categoryPath.length ? { categoryPath } : {}),
    ...(typeof record.description === 'string' && record.description ? { description: record.description } : {}),
    ...(stringArrayValue('tags').length ? { tags: stringArrayValue('tags') } : {}),
    ...(record.sku !== undefined && record.sku !== null ? { sku: record.sku } : {}),
    ...(typeof record.sourceUrl === 'string' && record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
    firstSeenAt: stringValue('firstSeenAt') || stringValue('first_seen_at'),
    lastSeenAt: stringValue('lastSeenAt') || stringValue('last_seen_at')
  }
}

function sellerEvent(value: unknown): SellerEvent {
  const record = asRecord(value)
  const stringValue = (key: string) => typeof record[key] === 'string' ? record[key] as string : ''
  return {
    id: stringValue('id'),
    itemId: stringValue('itemId') || stringValue('item_id'),
    sellerId: stringValue('sellerId') || stringValue('seller_id'),
    eventType: stringValue('eventType') || stringValue('event_type'),
    ...(stringValue('beforeVersionId') || stringValue('before_version_id') ? { beforeVersionId: stringValue('beforeVersionId') || stringValue('before_version_id') } : {}),
    ...(stringValue('afterVersionId') || stringValue('after_version_id') ? { afterVersionId: stringValue('afterVersionId') || stringValue('after_version_id') } : {}),
    eventKey: stringValue('eventKey') || stringValue('event_key'),
    occurredAt: stringValue('occurredAt') || stringValue('occurred_at'),
    detectedAt: stringValue('detectedAt') || stringValue('detected_at')
  }
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

  async createAiJob(input: UserAiJobInput): Promise<UserAiJob> {
    return this.request<UserAiJob>('/v1/ai/jobs', { method: 'POST', body: JSON.stringify(input) })
  }

  async listAnnouncements(input: UserListRequest, signal?: AbortSignal): Promise<UserPage<UserAnnouncement>> {
    return this.listPath<UserAnnouncement>('/v1/announcements', input, signal)
  }

  async list<T>(resource: UserListResource, input: UserListRequest, signal?: AbortSignal): Promise<UserPage<T>> {
    return this.listPath<T>(USER_LIST_PATHS[resource], input, signal)
  }

  async listMarketCategories(input: UserListRequest, signal?: AbortSignal): Promise<UserPage<MarketCategory>> {
    return this.listPath<MarketCategory>('/v1/market/categories', input, signal)
  }

  async listMarketRegions(input: UserListRequest, signal?: AbortSignal): Promise<UserPage<MarketRegion>> {
    return this.listPath<MarketRegion>('/v1/market/regions', input, signal)
  }

  async importSupplySnapshots(input: SupplyImportInput): Promise<SupplyImportResult> {
    return this.request<SupplyImportResult>('/v1/supply/imports', { method: 'POST', body: JSON.stringify(input) })
  }

  async createSupplyMigration(input: { schemaVersion: 1; idempotencyKey: string; source: { kind: 'market_item' | 'published_item'; sourceId: string } | { kind: 'public_url'; itemUrl: string } }): Promise<SupplyMigrationRequest> {
    return this.request<SupplyMigrationRequest>('/v1/supply/migrations', { method: 'POST', body: JSON.stringify(input) })
  }

  async listSupplyMaterials(input: UserListRequest, signal?: AbortSignal): Promise<UserPage<SupplyMaterial>> {
    return this.listPath<SupplyMaterial>('/v1/supply/materials', input, signal)
  }

  async updateSupplyMaterial(id: string, input: SupplyMaterialPatch): Promise<SupplyMaterial> {
    return this.request<SupplyMaterial>(`/v1/supply/materials/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) })
  }

  async createSupplyPublishPlan(input: { schemaVersion: 1; materialId: string; idempotencyKey: string; schedule: SupplyPublishSchedule }): Promise<SupplyPublishPlan> {
    return this.request<SupplyPublishPlan>('/v1/supply/publish-plans', { method: 'POST', body: JSON.stringify(input) })
  }

  async listSupplyPublishPlans(input: UserListRequest, signal?: AbortSignal): Promise<UserPage<SupplyPublishPlan>> {
    return this.listPath<SupplyPublishPlan>('/v1/supply/publish-plans', input, signal)
  }

  async getSellerMonitorProfile(id: string, signal?: AbortSignal): Promise<SellerMonitorProfile> {
    const payload = asRecord(await this.request<unknown>(`/v1/seller-monitors/${encodeURIComponent(id)}/profile`, { signal }))
    return { task: sellerMonitor(payload.task), seller: sellerProfile(payload.seller) }
  }

  async listSellerMonitorItems(id: string, input: UserListRequest, signal?: AbortSignal): Promise<UserPage<SellerItem>> {
    const page = await this.listPath<unknown>(`/v1/seller-monitors/${encodeURIComponent(id)}/items`, input, signal)
    return { ...page, items: page.items.map(sellerItem) }
  }

  async listSellerMonitorEvents(id: string, input: UserListRequest, signal?: AbortSignal): Promise<UserPage<SellerEvent>> {
    const page = await this.listPath<unknown>(`/v1/seller-monitors/${encodeURIComponent(id)}/events`, input, signal)
    return { ...page, items: page.items.map(sellerEvent) }
  }

  private async listPath<T>(path: string, input: UserListRequest, signal?: AbortSignal): Promise<UserPage<T>> {
    const params = new URLSearchParams()
    params.set('limit', String(Math.min(100, Math.max(1, Math.trunc(input.limit)))))
    if (input.cursor) params.set('cursor', input.cursor)
    params.set('sort', input.sort)
    params.set('order', 'desc')
    params.set('filters', JSON.stringify(input.filters))
    const payload = await this.request<unknown>(`${path}?${params.toString()}`, { signal })
    const record = asRecord(payload)
    const page = asRecord(record.page)
    const items = Array.isArray(record.items) ? record.items as T[] : []
    const nextCursorValue = page.nextCursor ?? page.next_cursor
    const nextCursor = typeof nextCursorValue === 'string' && nextCursorValue.length > 0 ? nextCursorValue : null
    const hasMore = typeof page.hasMore === 'boolean' ? page.hasMore : Boolean(nextCursor)
    const total = typeof page.total === 'number' && Number.isFinite(page.total) ? page.total : items.length
    const limit = typeof page.limit === 'number' && Number.isFinite(page.limit) ? page.limit : undefined
    const snapshot = typeof page.snapshot === 'string' ? page.snapshot : null
    return { items, limit, total, nextCursor, hasMore, snapshot }
  }

  async listMonitorTasks(input: UserListRequest, signal?: AbortSignal): Promise<UserPage<MonitorTask>> {
    const page = await this.list<unknown>('monitors', input, signal)
    return { ...page, items: page.items.map(monitorTask) }
  }

  async listSellerMonitors(input: UserListRequest, signal?: AbortSignal): Promise<UserPage<SellerMonitor>> {
    const page = await this.list<unknown>('sellerMonitors', input, signal)
    return { ...page, items: page.items.map(sellerMonitor) }
  }

  async createMonitorTask(input: MonitorTaskInput): Promise<MonitorTask> {
    return monitorTask(await this.request<unknown>('/v1/monitors', { method: 'POST', body: JSON.stringify(input) }))
  }

  async updateMonitorTask(id: string, input: Partial<MonitorTaskInput>): Promise<MonitorTask> {
    return monitorTask(await this.request<unknown>(`/v1/monitors/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }))
  }

  async deleteMonitorTask(id: string): Promise<void> {
    await this.request<unknown>(`/v1/monitors/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async createSellerMonitor(input: SellerMonitorInput): Promise<SellerMonitor> {
    return sellerMonitor(await this.request<unknown>('/v1/seller-monitors', { method: 'POST', body: JSON.stringify(input) }))
  }

  async updateSellerMonitor(id: string, input: Partial<SellerMonitorInput>): Promise<SellerMonitor> {
    return sellerMonitor(await this.request<unknown>(`/v1/seller-monitors/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }))
  }

  async deleteSellerMonitor(id: string): Promise<void> {
    await this.request<unknown>(`/v1/seller-monitors/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  private setTokens(tokens: UserTokens): void {
    if (!tokens?.accessToken || !tokens?.refreshToken) throw new UserApiError('登录凭据无效')
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
    if (!this.configured) throw new UserApiError('当前无法连接，请稍后再试')
    const headers = new Headers(init.headers)
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    if (attachAuth && this.tokens?.accessToken) headers.set('Authorization', `Bearer ${this.tokens.accessToken}`)
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers })
    const payload = await response.json().catch(() => null)
    if (response.status === 401 && allowRefresh && this.tokens?.refreshToken) {
      await this.refresh()
      return this.request<T>(path, init, false, attachAuth)
    }
    if (!response.ok) throw new UserApiError(responseMessage(payload, `请求失败（${response.status}）`), response.status, typeof asRecord(payload).code === 'string' ? asRecord(payload).code as string : null)
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
