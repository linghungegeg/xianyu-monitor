import { app, safeStorage } from 'electron'
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright-core'
import type { LauncherStatus } from '../shared/types'
import { MonitorDatabase, type CachedMonitorTask, type CachedPublishedItemMonitorTask, type CachedSearchMonitorTask, type CachedSellerMonitorTask } from './database'
import {
  canonicalItemPayload,
  canonicalSellerItemPayload,
  mergeSearchDetail,
  matchesSearchRule,
  parseSearchCards,
  SearchPageError,
  type SearchCardSource,
  type SearchDetailSource,
  type SearchRule,
  type SearchSort,
  type SellerItemState,
  type SellerProfile,
  canonicalSellerProfilePayload,
  parseSellerProfile
} from './search'

const GOOFISH_HOME = process.env.XIANYU_LOGIN_URL ?? 'https://www.goofish.com/'
const GOOFISH_SEARCH = process.env.XIANYU_SEARCH_URL ?? 'https://www.goofish.com/search'
const GOOFISH_PUBLISH = process.env.XIANYU_PUBLISH_URL ?? 'https://www.goofish.com/'
const REQUEST_TIMEOUT_MS = 10_000
const PAGE_TIMEOUT_MS = 15_000
const TOKEN_RENEW_WINDOW_MS = 2 * 60_000
const SCHEDULER_INTERVAL_MS = positiveEnvironmentNumber('XIANYU_SCHEDULER_INTERVAL_MS', 60_000, 250)
const TASK_SYNC_INTERVAL_MS = positiveEnvironmentNumber('XIANYU_TASK_SYNC_INTERVAL_MS', 60_000, 250)
const SELLER_PAGE_LIMIT = positiveEnvironmentNumber('XIANYU_SELLER_PAGE_LIMIT', 4, 1)
const PHASE6_UPLOAD_ENABLED = process.env.XIANYU_PHASE6_UPLOAD_ENABLED !== 'false'
const STATE_REFRESH_TOKEN = 'collector.refresh-token'
const STATE_PRIVATE_KEY = 'collector.device-private-key'
const STATE_PUBLIC_KEY = 'collector.device-public-key'
const STATE_CLIENT_ID = 'collector.client-id'
const STATE_ACCOUNT_LABEL = 'collector.account-label'
const DEFAULT_SELLER_PROFILE_HOSTS = ['goofish.com', '*.goofish.com']

type TokenResponse = { accessToken?: string; refreshToken?: string; clientId?: string }
type EntitlementResponse = { allowed?: boolean }
type TaskResponse = { items?: unknown[]; snapshotAt?: string }
type SupplyPublishSnapshot = { title: string; description: string; price: number; mainImages: string[]; sku: unknown; attributes: Record<string, unknown>; address?: string }
type SupplyClaimResponse = { claimBatchId?: string; items?: Array<{ id?: string; status?: string; materialSnapshot?: unknown }> }
type SupplyMigrationClaimResponse = { items?: Array<{ id?: string; platformItemId?: string; itemUrl?: string }> }
type SupplySkuConfig = { groups: Array<{ name: string; values: string[] }>; combinations: Array<{ values: string[]; price: number; stock: number }> }
type DeviceKey = { publicKey: string; privateKey: ReturnType<typeof createPrivateKey> }

const XIANYU_PRESET_SKU_TYPES = new Set(['颜色', '尺码', '容量', '份数', '大小', '高度', '总量'])

class CloudRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function positiveEnvironmentNumber(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value >= minimum ? value : fallback
}

function apiBase(value: string, name: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} 必须是 HTTP(S) 地址`)
  return url.toString().replace(/\/$/, '')
}

function sellerProfileHostMatches(hostname: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase().replace(/\.$/, '')
  if (!normalized) return false
  if (normalized.startsWith('*.')) {
    const base = normalized.slice(2)
    return hostname === base || hostname.endsWith(`.${base}`)
  }
  return hostname === normalized
}

function sellerProfileUrlAllowed(value: string): boolean {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    return navigationUrlAllowed(url, hostname)
  } catch {
    return false
  }
}

function navigationUrlAllowed(value: string | URL, hostname = value instanceof URL ? value.hostname.toLowerCase().replace(/\.$/, '') : ''): boolean {
  try {
    const url = typeof value === 'string' ? new URL(value) : value
    const configuredHosts = [
      ...DEFAULT_SELLER_PROFILE_HOSTS,
      ...(process.env.XIANYU_PROFILE_ALLOWED_HOSTS ?? '').split(','),
      ...[GOOFISH_HOME, GOOFISH_SEARCH].flatMap((configured) => {
        try { return [new URL(configured).hostname] } catch { return [] }
      })
    ]
    const normalizedHost = hostname || url.hostname.toLowerCase().replace(/\.$/, '')
    const isDefaultHost = normalizedHost === 'goofish.com' || normalizedHost.endsWith('.goofish.com')
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username
      && !url.password
      && configuredHosts.some((pattern) => sellerProfileHostMatches(normalizedHost, pattern))
      && (!isDefaultHost || (url.protocol === 'https:' && !url.port))
  } catch {
    return false
  }
}

function responseMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const error = (payload as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return String((error as { message: string }).message)
  return fallback
}

function tokenExpiresSoon(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number }
    return !payload.exp || payload.exp * 1_000 - Date.now() <= TOKEN_RENEW_WINDOW_MS
  } catch {
    return true
  }
}

function tokenSubject(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string }
    if (payload.sub) return payload.sub
  } catch {
    // The cloud validates this token; parsing here only supplies the bind proof subject.
  }
  throw new Error('云端登录响应无效，请重新登录')
}

function compact(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function supplySnapshot(value: unknown): SupplyPublishSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('发布计划素材快照无效')
  const source = value as Record<string, unknown>
  const title = compact(typeof source.title === 'string' ? source.title : '')
  const description = compact(typeof source.description === 'string' ? source.description : '')
  const price = typeof source.price === 'number' ? source.price : Number(source.price)
  const images = Array.isArray(source.mainImages) ? source.mainImages.filter((item): item is string => typeof item === 'string') : []
  if (!title || title.length > 240 || !Number.isFinite(price) || price < 0 || price > 100_000_000 || !images.length || images.length > 10) throw new Error('发布计划素材快照无效')
  for (const image of images) {
    const url = new URL(image)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('发布计划包含非公开图片地址')
  }
  const attributes = source.attributes && typeof source.attributes === 'object' && !Array.isArray(source.attributes) ? source.attributes as Record<string, unknown> : {}
  const address = compact(typeof attributes.publishAddress === 'string' ? attributes.publishAddress : typeof attributes.address === 'string' ? attributes.address : '')
  return { title, description, price: Number(price.toFixed(2)), mainImages: images, sku: source.sku ?? null, attributes, ...(address ? { address } : {}) }
}

function supplySkuConfig(value: unknown): SupplySkuConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const rawGroups = Array.isArray(source.groups)
    ? source.groups
    : Array.isArray(source.specifications)
      ? source.specifications
      : Array.isArray(source.specs)
        ? source.specs
        : []
  const groups = rawGroups.slice(0, 2).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const row = entry as Record<string, unknown>
    const name = compact(typeof row.name === 'string' ? row.name : '').slice(0, 80)
    const values = Array.isArray(row.values)
      ? [...new Set(row.values.map((item) => compact(typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string' ? (item as Record<string, unknown>).name as string : '')).filter(Boolean))].slice(0, 30)
      : []
    return name && values.length ? [{ name, values }] : []
  })
  if (!groups.length) return null
  const rawCombinations = Array.isArray(source.combinations)
    ? source.combinations
    : Array.isArray(source.skus)
      ? source.skus
      : Array.isArray(source.variants)
        ? source.variants
        : []
  const combinations = rawCombinations.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const row = entry as Record<string, unknown>
    const values = Array.isArray(row.values)
      ? row.values.map((item) => compact(typeof item === 'string' ? item : '')).filter(Boolean)
      : Array.isArray(row.specs)
        ? row.specs.map((item) => compact(typeof item === 'string' ? item : '')).filter(Boolean)
        : []
    const price = Number(row.price)
    const stock = Number(row.stock)
    const valuesMatchGroups = values.length === groups.length && values.every((value, index) => groups[index]?.values.includes(value))
    return valuesMatchGroups && Number.isFinite(price) && price >= 0 && price <= 100_000_000 && Number.isInteger(stock) && stock >= 0
      ? [{ values, price: Number(price.toFixed(2)), stock }]
      : []
  })
  return { groups, combinations }
}

function escapedText(value: string): RegExp {
  return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
}

function taskLabel(rule: SearchRule): string {
  return compact(rule.keyword ?? rule.categoryPath?.join('/')).slice(0, 48) || '未命名搜索任务'
}

function parseTask(value: unknown): CachedMonitorTask {
  if (!value || typeof value !== 'object') throw new Error('云端任务快照无效')
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  const kind = row.kind === 'seller' ? 'seller' : row.kind === 'published_item' ? 'published_item' : 'search'
  const ruleVersion = typeof row.ruleVersion === 'number' ? row.ruleVersion : NaN
  const status = row.status === 'active' || row.status === 'paused' ? row.status : undefined
  const intervalSeconds = typeof row.intervalSeconds === 'number' ? row.intervalSeconds : NaN
  const nextRunAt = typeof row.nextRunAt === 'string' ? row.nextRunAt : ''
  const createdAt = typeof row.createdAt === 'string' ? row.createdAt : ''
  const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : ''
  if (!id || !Number.isInteger(ruleVersion) || ruleVersion < 1 || !status || !Number.isInteger(intervalSeconds) || intervalSeconds < 60 || !nextRunAt || !createdAt || !updatedAt) throw new Error('云端任务快照无效')
  if (kind === 'seller') {
    const platform = row.platform === undefined ? 'goofish' : row.platform
    const platformSellerId = typeof row.platformSellerId === 'string' ? row.platformSellerId.trim() : ''
    const profileUrl = typeof row.profileUrl === 'string' ? row.profileUrl.trim() : ''
    if (platform !== 'goofish' || !platformSellerId || platformSellerId.length > 128 || !profileUrl) throw new Error('云端卖家任务快照无效')
    if (!sellerProfileUrlAllowed(profileUrl)) throw new Error('云端卖家任务快照包含不允许的主页地址')
    return { id, kind: 'seller', platform: 'goofish', platformSellerId, profileUrl, ruleVersion, status, intervalSeconds, nextRunAt, createdAt, updatedAt }
  }
  if (row.kind === 'published_item') {
    const platform = row.platform === undefined ? 'goofish' : row.platform
    const platformItemId = typeof row.platformItemId === 'string' ? row.platformItemId.trim() : ''
    const itemUrl = typeof row.itemUrl === 'string' ? row.itemUrl.trim() : ''
    const publishPlanId = typeof row.publishPlanId === 'string' ? row.publishPlanId.trim() : undefined
    if (platform !== 'goofish' || !platformItemId || platformItemId.length > 128 || !itemUrl || !navigationUrlAllowed(itemUrl)) throw new Error('云端发布商品任务快照无效')
    return { id, kind: 'published_item', platform: 'goofish', platformItemId, itemUrl, publishPlanId, ruleVersion, status, intervalSeconds, nextRunAt, createdAt, updatedAt }
  }
  const rule = row.rule && typeof row.rule === 'object' && !Array.isArray(row.rule) ? row.rule as SearchRule : undefined
  if (!rule) throw new Error('云端任务规则无效')
  if (!rule.keyword && !rule.categoryPath?.length) throw new Error('云端任务规则无效')
  if (!['comprehensive', 'newly_reduced', 'newly_published', 'price_asc', 'price_desc'].includes(rule.sort)) throw new Error('云端任务规则无效')
  if (!Number.isInteger(rule.pageLimit) || rule.pageLimit < 1 || rule.pageLimit > 10) throw new Error('云端任务规则无效')
  return { id, kind: 'search', rule, ruleVersion, status, intervalSeconds, nextRunAt, createdAt, updatedAt }
}

export class XianyuMonitor {
  private readonly userApiBase = apiBase(process.env.COLLECTOR_USER_API_URL ?? 'https://user-api.placeholder.invalid', 'User API 地址')
  private readonly collectorApiBase = apiBase(process.env.COLLECTOR_API_URL ?? 'https://collector-api.placeholder.invalid', 'Collector API 地址')
  private context: BrowserContext | undefined
  private loginPage: Page | undefined
  private scannerPage: Page | undefined
  private sellerPage: Page | undefined
  private detailPage: Page | undefined
  private timer: NodeJS.Timeout | undefined
  private accessToken: string | undefined
  private running = false
  private ticking = false
  private lastTaskSyncAt = 0
  private readonly publishAddressQueues = new Map<string, string[]>()
  private lastPublishAddress: string | undefined
  private state: LauncherStatus = { session: 'signed-out', browser: 'idle', entitled: false, message: '请登录本系统账号并完成设备绑定' }

  constructor(private readonly db: MonitorDatabase, private readonly publish: (status: LauncherStatus) => void) {
    this.state = { ...this.state, account: this.db.getState(STATE_ACCOUNT_LABEL) ?? undefined }
  }

  status(): LauncherStatus {
    return this.state
  }

  async restore(): Promise<void> {
    if (!this.db.getState(STATE_REFRESH_TOKEN)) return
    this.updateStatus('checking', '正在恢复本机设备授权', false)
    try {
      await this.refreshCollectorSession()
      const allowed = await this.checkEntitlements()
      this.updateStatus(allowed ? 'ready' : 'paused', allowed ? '设备已绑定，等待启动采集' : '当前账号没有可用采集权益', allowed)
    } catch (error) {
      if (this.isNetworkError(error)) {
        this.updateStatus('offline', '无法连接云端，恢复网络后将重新校验授权', false)
        return
      }
      this.clearSession()
      this.updateStatus('signed-out', '本机授权已失效，请重新登录并绑定设备', false)
    }
  }

  async login(email: string, password: string): Promise<void> {
    if (!email.trim() || !password) throw new Error('请输入账号和密码')
    this.requireEncryption()
    this.updateStatus('checking', '正在验证账号并绑定本机设备', false)
    try {
      const userSession = await this.request<TokenResponse>(this.userApiBase, '/v1/auth/login', { method: 'POST', body: { email: email.trim(), password } })
      if (!userSession.accessToken) throw new Error('云端未返回登录授权')
      const deviceKey = this.getOrCreateDeviceKey()
      const bound = await this.request<TokenResponse>(this.collectorApiBase, '/v1/devices/bind', {
        method: 'POST',
        token: userSession.accessToken,
        body: {
          publicKey: deviceKey.publicKey,
          proof: sign(null, Buffer.from(tokenSubject(userSession.accessToken)), deviceKey.privateKey).toString('base64'),
          deviceName: app.getName()
        }
      })
      if (!bound.accessToken || !bound.refreshToken || !bound.clientId) throw new Error('云端未返回采集器授权')
      this.storeCollectorSession(bound)
      this.db.setState(STATE_ACCOUNT_LABEL, email.trim())
      const allowed = await this.checkEntitlements()
      this.db.addLog('success', '本机设备绑定完成')
      this.updateStatus(allowed ? 'ready' : 'paused', allowed ? '设备已绑定，等待启动采集' : '当前账号没有可用采集权益', allowed)
    } catch (error) {
      const message = this.safeMessage(error, '账号登录或设备绑定失败')
      this.updateStatus('error', message, false)
      throw new Error(message)
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    this.db.enqueueHeartbeat({ id: randomUUID(), observedAt: new Date().toISOString(), appVersion: app.getVersion() })
    try {
      await this.ensureAuthorized()
      this.running = true
      this.startTimer()
      this.updateStatus('running', '采集器正在运行', true)
      await this.tick(true)
      if (this.running) this.db.addLog('success', '采集器已启动')
    } catch (error) {
      this.stopTimer()
      const message = this.handleRuntimeError(error)
      throw new Error(message)
    }
  }

  pause(): void {
    if (!this.running) return
    this.running = false
    this.stopTimer()
    this.db.addLog('info', '采集器已暂停')
    this.updateStatus('paused', '采集器已暂停', this.state.entitled)
  }

  async openLogin(): Promise<void> {
    try {
      await this.ensureAuthorized()
      const page = await this.openLoginPage()
      await this.goto(page, GOOFISH_HOME, '无法打开闲鱼登录页，请检查网络后重试')
      await page.bringToFront()
      this.db.addLog('info', '已打开本机 Chrome，请完成闲鱼扫码登录')
      this.updateStatus(this.running ? 'running' : 'ready', '请在本机 Chrome 完成闲鱼扫码登录', true)
    } catch (error) {
      const message = error instanceof SearchPageError ? this.handleSearchError(error) : this.handleRuntimeError(error)
      throw new Error(message)
    }
  }

  async unbind(): Promise<void> {
    try {
      await this.ensureAccessToken()
      await this.request(this.collectorApiBase, '/v1/devices/unbind', { method: 'POST', token: this.accessToken })
      this.pause()
      this.clearSession()
      this.db.addLog('info', '本机设备已解绑')
      this.updateStatus('signed-out', '本机设备已解绑', false)
    } catch (error) {
      const message = this.safeMessage(error, '设备解绑失败')
      this.updateStatus('error', message, false)
      throw new Error(message)
    }
  }

  logout(): void {
    this.pause()
    this.clearSession()
    this.db.addLog('info', '已退出登录')
    this.updateStatus('signed-out', '已退出登录', false)
  }

  async shutdown(): Promise<void> {
    this.pause()
    if (this.context) await this.context.close().catch(() => undefined)
    this.context = undefined
    this.db.close()
  }

  private startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(() => void this.tick(), SCHEDULER_INTERVAL_MS)
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async tick(forceTaskSync = false): Promise<void> {
    if (!this.running || this.ticking) return
    this.ticking = true
    try {
      await this.ensureAuthorized()
      await this.syncTasks(forceTaskSync)
      this.db.enqueueHeartbeat({ id: randomUUID(), observedAt: new Date().toISOString(), appVersion: app.getVersion() })
      for (const task of this.db.listDueMonitorTasks()) {
        if (!this.running) return
        await this.scanTask(task)
      }
      await this.prepareDueSupplyPlans()
      await this.prepareSupplyMigrations()
      const clientId = PHASE6_UPLOAD_ENABLED ? this.db.getState(STATE_CLIENT_ID) : null
      if (clientId) this.db.enqueueMarketBatch(clientId)
      if (this.running) await this.flushOutbox()
    } catch (error) {
      this.stopTimer()
      this.running = false
      if (error instanceof SearchPageError) this.handleSearchError(error)
      else this.handleRuntimeError(error)
    } finally {
      this.ticking = false
    }
  }

  private async syncTasks(force = false): Promise<void> {
    if (!force && Date.now() - this.lastTaskSyncAt < TASK_SYNC_INTERVAL_MS) return
    const snapshot = await this.request<TaskResponse>(this.collectorApiBase, '/v1/tasks', { token: this.accessToken })
    if (!Array.isArray(snapshot.items)) throw new Error('云端任务快照无效')
    this.db.syncMonitorTasks(snapshot.items.map(parseTask))
    this.lastTaskSyncAt = Date.now()
  }

  private async prepareDueSupplyPlans(): Promise<void> {
    const clientId = this.db.getState(STATE_CLIENT_ID)
    if (!clientId) return
    const claimIdempotencyKey = `collector:${clientId}:${new Date().toISOString().slice(0, 16)}`
    const claim = await this.request<SupplyClaimResponse>(this.collectorApiBase, '/v1/supply/publish-plans/claim', {
      method: 'POST', token: this.accessToken, body: { schemaVersion: 1, deviceId: clientId, idempotencyKey: claimIdempotencyKey, limit: 20 }
    })
    if (!claim.claimBatchId || !Array.isArray(claim.items)) return
    for (const plan of claim.items) {
      if (!plan.id || plan.status !== 'claimed') continue
      const attemptId = randomUUID()
      this.db.recordSupplyPublishAttempt({ id: attemptId, planId: plan.id, claimBatchId: claim.claimBatchId, status: 'claimed', message: '已领取发布计划，等待本机发布页处理' })
      try {
        const material = supplySnapshot(plan.materialSnapshot)
        const page = await this.openPublishPage()
        await this.goto(page, GOOFISH_PUBLISH, '无法打开闲鱼发布页，请检查网络后重试')
        await this.assertPublishPageReady(page)
        const published = await this.fillAndSubmitSupplyPlan(page, material, attemptId)
        this.db.recordSupplyPublishAttempt({ id: attemptId, planId: plan.id, claimBatchId: claim.claimBatchId, status: 'succeeded', message: `已确认发布商品 ${published.itemId}` })
        this.db.enqueueSupplyPublishResult({ id: `supply-result:${attemptId}`, planId: plan.id, claimBatchId: claim.claimBatchId, attemptKey: `attempt:${attemptId}`, status: 'succeeded', xianyuItemId: published.itemId, xianyuUrl: published.url })
        this.db.addLog('success', `发布计划 ${plan.id} 已确认提交`)
      } catch (error) {
        const message = this.safeMessage(error, '发布页未能确认提交，请在本机 Chrome 检查后处理')
        this.db.recordSupplyPublishAttempt({ id: attemptId, planId: plan.id, claimBatchId: claim.claimBatchId, status: 'needs_attention', message })
        this.db.enqueueSupplyPublishResult({ id: `supply-result:${attemptId}`, planId: plan.id, claimBatchId: claim.claimBatchId, attemptKey: `attempt:${attemptId}`, status: 'needs_attention', errorMessage: message })
        const localReason = error instanceof Error ? compact(error.message).slice(0, 240) : '本机发布流程异常'
        this.db.addLog('error', `发布计划 ${plan.id} 未提交：${localReason}`)
      }
    }
  }

  private async openPublishPage(): Promise<Page> {
    return this.newProfilePage()
  }

  private async prepareSupplyMigrations(): Promise<void> {
    const clientId = this.db.getState(STATE_CLIENT_ID)
    if (!clientId) return
    const claim = await this.request<SupplyMigrationClaimResponse>(this.collectorApiBase, '/v1/supply/migrations/claim', {
      method: 'POST', token: this.accessToken, body: { schemaVersion: 1, deviceId: clientId, idempotencyKey: `migration:${clientId}:${new Date().toISOString().slice(0, 16)}`, limit: 1 }
    })
    if (!Array.isArray(claim.items)) return
    for (const migration of claim.items) {
      const requestId = typeof migration.id === 'string' ? migration.id : ''
      const platformItemId = typeof migration.platformItemId === 'string' ? migration.platformItemId : ''
      const itemUrl = typeof migration.itemUrl === 'string' ? migration.itemUrl : ''
      if (!requestId || !platformItemId || !itemUrl) continue
      const attemptKey = `migration:${requestId}:${randomUUID()}`
      try {
        const item = await this.readItemDetail({ platformItemId, url: itemUrl, title: platformItemId, price: null, region: null, publishedText: null, wantCount: null, imageUrls: [], tags: [] })
        if (item.price === null || !item.imageUrls.length) throw new SearchPageError('structure', '公开商品详情缺少价格或主图')
        const sku = await this.readSupplyMigrationSku()
        this.db.enqueueSupplyMigrationResult({
          requestId,
          attemptKey,
          status: 'succeeded',
          snapshot: {
            sourcePlatform: 'goofish', sourceItemId: item.platformItemId, sourceUrl: item.url, title: item.title, description: item.description,
            price: item.price, mainImages: item.imageUrls, detailImages: [], sku,
            attributes: { region: item.region, condition: item.conditionText, wantCount: item.wantCount, tags: item.tags, originalPrice: item.price }
          }
        })
        this.db.addLog('success', `搬家商品 ${platformItemId} 已读取，等待同步素材库`)
      } catch (error) {
        this.db.enqueueSupplyMigrationResult({ requestId, attemptKey, status: 'failed', errorMessage: this.safeMessage(error, '本机读取公开商品失败') })
        this.db.addLog('error', `搬家商品 ${platformItemId} 读取失败`)
      }
    }
  }

  private async assertPublishPageReady(page: Page): Promise<void> {
    const url = page.url()
    if (!navigationUrlAllowed(url)) throw new Error('发布页地址未通过本机校验')
    const text = compact(await page.locator('body').innerText().catch(() => ''))
    if (/登录|扫码|验证|安全校验|人机/.test(text)) throw new Error('需要在本机 Chrome 完成登录或安全校验')
  }

  private async firstVisible(page: Page, selectors: string[]): Promise<Locator | undefined> {
    for (const selector of selectors) {
      const candidate = page.locator(selector).first()
      if (await candidate.isVisible().catch(() => false)) return candidate
    }
    return undefined
  }

  private localPublishAddress(snapshot: SupplyPublishSnapshot): string | undefined {
    const pool = Array.isArray(snapshot.attributes.publishAddressPool)
      ? snapshot.attributes.publishAddressPool.map((entry) => compact(typeof entry === 'string' ? entry : '')).filter(Boolean)
      : []
    if (snapshot.attributes.publishAddressMode === 'random' && pool.length) return this.nextPublishAddress('material', pool)
    if (snapshot.address) return snapshot.address
    const configured = compact(process.env.XIANYU_PUBLISH_ADDRESSES ?? '')
    if (!configured) return undefined
    let addresses: unknown
    try { addresses = JSON.parse(configured) } catch { throw new Error('本机发布地址配置无效') }
    if (!Array.isArray(addresses)) throw new Error('本机发布地址配置无效')
    const values = addresses.map((entry) => compact(typeof entry === 'string' ? entry : entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).value === 'string' ? String((entry as Record<string, unknown>).value) : '')).filter(Boolean)
    if (!values.length) throw new Error('本机发布地址配置无有效地址')
    return this.nextPublishAddress('local-default', values)
  }

  private nextPublishAddress(scope: string, values: string[]): string {
    const unique = [...new Set(values)]
    const key = `${scope}:${unique.slice().sort().join('\u0000')}`
    let queue = this.publishAddressQueues.get(key) ?? []
    if (!queue.length) {
      queue = unique.slice().sort(() => Math.random() - 0.5)
      if (queue.length > 1 && queue[0] === this.lastPublishAddress) queue.push(queue.shift()!)
    }
    const address = queue.shift()!
    this.publishAddressQueues.set(key, queue)
    this.lastPublishAddress = address
    return address
  }

  private async downloadSupplyImages(images: string[], attemptId: string): Promise<{ directory: string; files: string[] }> {
    const directory = join(app.getPath('temp'), 'xianyu-monitor-publish', attemptId)
    mkdirSync(directory, { recursive: true })
    const files: string[] = []
    try {
      for (const [index, image] of images.entries()) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
          const response = await fetch(image, { signal: controller.signal })
          const type = response.headers.get('content-type')?.toLowerCase() ?? ''
          const bytes = Buffer.from(await response.arrayBuffer())
          if (!response.ok || !type.startsWith('image/') || !bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('公开图片下载失败')
          const extension = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'
          const file = join(directory, `${index + 1}.${extension}`)
          writeFileSync(file, bytes)
          files.push(file)
        } finally { clearTimeout(timeout) }
      }
      return { directory, files }
    } catch (error) {
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
  }

  private async fillAndSubmitSupplyPlan(page: Page, material: SupplyPublishSnapshot, attemptId: string): Promise<{ itemId: string; url: string }> {
    const imageFiles = await this.downloadSupplyImages(material.mainImages, attemptId)
    try {
      const title = await this.firstVisible(page, ['[data-xianyu-publish-title]', 'input[name="title"]', 'input[placeholder*="标题"]'])
      const description = await this.firstVisible(page, ['[data-xianyu-publish-description]', 'textarea[name="description"]', 'textarea[placeholder*="描述"]', '[contenteditable="true"]'])
      const price = await this.firstVisible(page, ['[data-xianyu-publish-price]', 'input[name="price"]', 'input[placeholder*="价格"]'])
      const imageInput = await this.firstVisible(page, ['input[data-xianyu-publish-images][type="file"]', 'input[name="images"][type="file"]'])
      if (!title || !description || !price || !imageInput) throw new Error('发布页缺少必要素材输入项')
      await title.fill(material.title)
      await description.fill(material.description)
      await price.fill(String(material.price))
      await imageInput.setInputFiles(imageFiles.files)

      // The publish page exposes these fields only after the image/category form has rendered.
      // They are optional for older page variants, but when present each value is verified.
      const fillOptional = async (selectors: string[], value: string): Promise<void> => {
        if (!value) return
        const control = await this.firstVisible(page, selectors)
        if (!control) return
        const tagName = await control.evaluate((node) => node.tagName.toLowerCase())
        if (tagName === 'select') {
          await control.selectOption({ label: value }).catch(() => control.selectOption(value)).catch(() => undefined)
        } else {
          await control.fill(value)
        }
        const written = tagName === 'select' ? await control.inputValue().catch(() => '') : await control.inputValue().catch(() => '')
        if (written && written !== value && !written.includes(value)) throw new Error(`发布页字段“${value}”写入未确认`)
      }
      const attributes = material.attributes
      await fillOptional(['[data-xianyu-publish-original-price]', 'input[name="originalPrice"]', 'input[name="original_price"]'], compact(String(attributes.originalPrice ?? '')))
      await fillOptional(['[data-xianyu-publish-category]', 'select[name="category"]', '[name="category"]'], compact(String(attributes.categoryPath ?? attributes.category ?? '')))
      await fillOptional(['[data-xianyu-publish-condition]', 'select[name="condition"]', '[name="condition"]'], compact(String(attributes.conditionText ?? attributes.condition ?? '')))
      await fillOptional(['[data-xianyu-publish-brand]', 'input[name="brand"]', '[name="brand"]'], compact(String(attributes.brand ?? '')))
      await fillOptional(['[data-xianyu-publish-delivery]', 'select[name="delivery"]', '[name="delivery"]'], compact(String(attributes.delivery ?? attributes.deliveryMethod ?? '')))
      await fillOptional(['[data-xianyu-publish-postage]', 'input[name="postage"]', '[name="postage"]'], compact(String(attributes.postage ?? '')))
      await fillOptional(['[data-xianyu-publish-region]', 'select[name="region"]', 'input[name="region"]', 'input[name="address"]'], compact(String(attributes.region ?? '')))
      await this.fillSupplySku(page, material.sku, material.price)
      const shipTime = await this.firstVisible(page, ['[data-xianyu-publish-ship-time]', '[data-xianyu-publish-delivery-time]', 'button:has-text("48小时")', 'button:has-text("24小时")'])
      if (shipTime) await shipTime.click()
      const freeShipping = await this.firstVisible(page, ['[data-xianyu-publish-free-shipping]', 'label:has-text("包邮") input', 'button:has-text("包邮")'])
      if (freeShipping) {
        const tagName = await freeShipping.evaluate((node) => node.tagName.toLowerCase())
        if (tagName === 'input') {
          const checked = await freeShipping.isChecked().catch(() => false)
          if (!checked) await freeShipping.check().catch(() => freeShipping.click())
        } else await freeShipping.click()
      }
      const address = this.localPublishAddress(material)
      if (address) {
        const addressInput = await this.firstVisible(page, ['[data-xianyu-publish-address]', 'select[name="address"]', 'input[name="address"]'])
        if (!addressInput) throw new Error('发布页缺少本机地址输入项')
        const tagName = await addressInput.evaluate((node) => node.tagName.toLowerCase())
        if (tagName === 'select') await addressInput.selectOption({ label: address }).catch(() => addressInput.selectOption(address))
        else await addressInput.fill(address)
      }
      const submit = await this.firstVisible(page, ['[data-xianyu-publish-submit]', 'button[type="submit"]'])
      if (!submit) throw new Error('发布页缺少提交按钮')
      await submit.click()
      let itemId = ''
      for (let attempt = 0; attempt < 40 && !itemId; attempt += 1) {
        const result = await this.firstVisible(page, ['[data-xianyu-publish-result-id]', '[data-xianyu-published-item-id]'])
        if (result) itemId = compact(await result.evaluate((node) => node.getAttribute('data-xianyu-publish-result-id') ?? node.getAttribute('data-xianyu-published-item-id') ?? node.textContent ?? ''))
        if (!itemId) {
          const url = page.url()
          const match = url.match(/\/item\/([A-Za-z0-9._-]{1,128})|[?&](?:itemId|id)=([A-Za-z0-9._-]{1,128})/i)
          if (match) itemId = match[1] ?? match[2] ?? ''
        }
        if (!itemId) {
          const text = compact(await page.locator('body').innerText().catch(() => ''))
          if (/发布成功|已发布|发布完成/.test(text) && !/发布失败|提交失败/.test(text)) {
            const bodyId = text.match(/商品(?:ID|编号)[：:]?\s*([A-Za-z0-9._-]{1,128})/i)
            if (bodyId) itemId = bodyId[1]
          }
        }
        if (!itemId) await page.waitForTimeout(250)
      }
      if (!itemId) throw new Error('发布后未确认商品 ID，已停止自动重试')
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(itemId)) throw new Error('发布后商品 ID 无效，已停止自动重试')
      const url = new URL(page.url())
      const itemUrl = url.searchParams.get('itemId') || url.searchParams.get('id') ? url.toString() : `https://www.goofish.com/item/${encodeURIComponent(itemId)}`
      return { itemId, url: itemUrl }
    } finally {
      rmSync(imageFiles.directory, { recursive: true, force: true })
    }
  }

  private async fillSupplySku(page: Page, rawSku: unknown, defaultPrice: number): Promise<void> {
    const sku = supplySkuConfig(rawSku)
    if (!sku) return

    const addType = await this.firstVisible(page, [
      '[data-xianyu-publish-add-sku-type]',
      'button:has-text("添加规格类型")'
    ])
    if (!addType) throw new Error('发布页缺少商品规格入口')
    for (const _group of sku.groups) await addType.click()

    for (const [groupIndex, group] of sku.groups.entries()) {
      const typeControl = await this.firstVisible(page, [
        `[data-xianyu-publish-sku-type="${groupIndex}"]`,
        `#itemProperties_${groupIndex}_propertyName`
      ])
      if (!typeControl) throw new Error(`发布页缺少第 ${groupIndex + 1} 组规格类型`)
      const tagName = await typeControl.evaluate((node) => node.tagName.toLowerCase())
      const selectedFromNativeControl = tagName === 'select'
        ? await typeControl.selectOption({ label: group.name }).then(() => true).catch(() => typeControl.selectOption(group.name).then(() => true).catch(() => false))
        : false
      if (!selectedFromNativeControl) {
        await typeControl.click()
        if (XIANYU_PRESET_SKU_TYPES.has(group.name)) {
          const option = page.locator('.ant-select-dropdown:visible .ant-select-item-option, .ant-select-dropdown:visible [role="option"], [data-xianyu-publish-sku-option]').filter({ hasText: escapedText(group.name) }).first()
          if (!(await option.isVisible().catch(() => false))) throw new Error(`发布页未提供规格类型「${group.name}」`)
          await option.click()
        } else {
          const customOption = page.locator('.ant-select-dropdown:visible .ant-select-item-option, .ant-select-dropdown:visible [role="option"], [data-xianyu-publish-sku-option]').filter({ hasText: /自定义类型|输入自定义/ }).first()
          if (!(await customOption.isVisible().catch(() => false))) throw new Error(`发布页未提供自定义规格类型入口，无法填写「${group.name}」`)
          await customOption.click()
          const customInput = await this.firstVisible(page, [
            `[data-xianyu-publish-sku-type="${groupIndex}"]`,
            `#itemProperties_${groupIndex}_propertyName`,
            `input[name="itemProperties_${groupIndex}_propertyName"]`
          ])
          if (!customInput) throw new Error(`发布页缺少自定义规格类型「${group.name}」输入项`)
          await customInput.fill(group.name)
          const writtenType = compact(await customInput.inputValue().catch(() => ''))
          if (writtenType !== group.name) throw new Error(`自定义规格类型「${group.name}」写入未确认`)
        }
      }

      for (const [valueIndex, value] of group.values.entries()) {
        const valueControl = await this.firstVisible(page, [
          `[data-xianyu-publish-sku-value="${groupIndex}:${valueIndex}"]`,
          `#itemProperties_${groupIndex}_propertyValues_${valueIndex}_propertyValue`
        ])
        if (!valueControl) throw new Error(`发布页缺少规格值「${value}」输入项`)
        await valueControl.fill(value)
      }
    }

    const rows = page.locator('tbody.ant-table-tbody tr.ant-table-row, [data-xianyu-publish-sku-row]')
    await rows.first().waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS }).catch(() => undefined)
    const rowCount = await rows.count()
    if (!rowCount) throw new Error('发布页未生成 SKU 价格库存表')
    for (const [rowIndex, combination] of sku.combinations.entries()) {
      const key = combination.values.join('-')
      let row: Locator | undefined
      for (let index = 0; index < rowCount; index += 1) {
        const candidate = rows.nth(index)
        const rowKey = await candidate.getAttribute('data-row-key').catch(() => null)
        const rowText = compact(await candidate.innerText().catch(() => ''))
        if (rowKey === key || rowKey === combination.values.join('') || combination.values.every((value) => rowText.includes(value))) {
          row = candidate
          break
        }
      }
      row ??= rows.nth(rowIndex)
      if (!row || !(await row.isVisible().catch(() => false))) throw new Error(`发布页缺少 SKU 组合「${key}」`)
      const priceControl = row.locator('input[placeholder="0.00"], [data-xianyu-publish-sku-price]').first()
      const stockControl = row.locator('input[placeholder="0"], [data-xianyu-publish-sku-stock]').first()
      if (!(await priceControl.isVisible().catch(() => false)) || !(await stockControl.isVisible().catch(() => false))) throw new Error(`发布页缺少 SKU 组合「${key}」的价格或库存`)
      const combinationPrice = combination.price > 0 ? combination.price : defaultPrice
      const combinationStock = combination.stock
      await priceControl.fill(String(combinationPrice))
      await stockControl.fill(String(combinationStock))
      const [writtenPrice, writtenStock] = await Promise.all([priceControl.inputValue(), stockControl.inputValue()])
      if (Number(writtenPrice) !== combinationPrice || Number(writtenStock) !== combinationStock) throw new Error(`SKU 组合「${key}」写入未确认`)
    }
  }

  private async scanTask(task: CachedMonitorTask): Promise<void> {
    if (task.kind === 'published_item') {
      await this.scanPublishedItemTask(task)
      return
    }
    if (task.kind === 'seller') {
      await this.scanSellerTask(task)
      return
    }
    await this.scanSearchTask(task)
  }

  private async scanPublishedItemTask(task: CachedPublishedItemMonitorTask): Promise<void> {
    const startedAt = new Date().toISOString()
    let scannedCount = 0
    let newItemCount = 0
    let newVersionCount = 0
    let eventCount = 0
    try {
      await this.ensureAuthorized()
      const page = await this.openDetailPage()
      await this.goto(page, task.itemUrl, '闲鱼发布商品详情加载失败，请检查网络后重试')
      const item = await this.readItemDetail({ platformItemId: task.platformItemId, url: task.itemUrl, title: '', price: null, region: null, publishedText: null, wantCount: null, imageUrls: [], tags: [] })
      if (item.platformItemId !== task.platformItemId) throw new SearchPageError('structure', '发布商品详情 ID 与监控目标不一致')
      const detailSellerId = await page.locator('[data-xianyu-seller-id], [data-seller-id]').first().evaluate((node) => node.getAttribute('data-xianyu-seller-id') ?? node.getAttribute('data-seller-id')).catch(() => null)
      if (!detailSellerId) throw new SearchPageError('structure', '发布商品详情缺少卖家 ID，已跳过以避免归属错误')
      const seller = parseSellerProfile({ platformSellerId: detailSellerId, profileUrl: `https://www.goofish.com/user/${encodeURIComponent(detailSellerId)}`, publicName: null, region: item.region, publicProfile: {} })
      if (!seller) throw new SearchPageError('structure', '发布商品详情卖家 ID 无效')
      const state = await this.readPublishedItemState(page)
      this.db.ensureSellerProfile(seller)
      const payload = canonicalSellerItemPayload(item)
      const saved = this.db.saveSellerItem({ taskId: task.id, scanId: randomUUID(), seller, state, item, contentHash: createHash('sha256').update(payload).digest('hex'), canonicalPayload: payload })
      scannedCount = 1
      newItemCount = saved.isNewItem ? 1 : 0
      newVersionCount = saved.isNewVersion ? 1 : 0
      eventCount = saved.eventCount
      if (!this.running) return
      this.db.markMonitorTaskRun(task.id)
      this.db.recordMonitorTaskRun({ id: randomUUID(), taskId: task.id, kind: 'published_item', ruleVersion: task.ruleVersion, status: 'completed', scannedCount, newItemCount, newVersionCount, eventCount, startedAt, finishedAt: new Date().toISOString() })
      this.db.addLog('success', `发布商品 ${task.platformItemId} 监控完成：${state}，新增事件 ${eventCount} 条`)
      this.updateStatus('running', '采集器正在运行', true)
    } catch (error) {
      this.db.recordMonitorTaskRun({ id: randomUUID(), taskId: task.id, kind: 'published_item', ruleVersion: task.ruleVersion, status: 'failed', scannedCount, newItemCount, newVersionCount, eventCount, startedAt, finishedAt: new Date().toISOString() })
      throw error
    }
  }

  private async readPublishedItemState(page: Page): Promise<Extract<SellerItemState, 'active' | 'sold' | 'offline'>> {
    const explicit = await page.locator('[data-xianyu-detail]').first().getAttribute('data-xianyu-published-state').catch(() => null)
    if (explicit === 'sold' || explicit === 'offline' || explicit === 'active') return explicit
    const text = compact(await page.locator('body').innerText().catch(() => ''))
    if (/已下架|已失效|不存在/.test(text)) return 'offline'
    if (/已售出|交易成功|卖掉了/.test(text)) return 'sold'
    return 'active'
  }

  private async scanSearchTask(task: CachedSearchMonitorTask): Promise<void> {
    const startedAt = new Date().toISOString()
    let scannedCount = 0
    let newItemCount = 0
    let newVersionCount = 0
    const label = taskLabel(task.rule)
    try {
      await this.ensureAuthorized()
      const page = await this.openScannerPage()
      await this.goto(page, this.searchUrl(task.rule), '闲鱼搜索页加载失败，请检查网络后重试')
      await this.assertSearchPageAvailable(page)
      await this.applySearchRule(page, task.rule)
      const seenItems = new Set<string>()
      const seenPages = new Set<string>()

      for (let pageIndex = 0; pageIndex < task.rule.pageLimit; pageIndex += 1) {
        if (!this.running) return
        await this.ensureAuthorized()
        const cards = await this.readSearchCards(page)
        const pageKey = `${page.url()}|${cards.map((card) => card.platformItemId).join(',')}`
        if (seenPages.has(pageKey)) throw new SearchPageError('structure', '闲鱼分页未前进，请检查页面结构后重试')
        seenPages.add(pageKey)
        await this.recordObservedCategories(page, task.rule)
        await this.recordObservedRegions(page)

        for (const card of cards) {
          if (!this.running || seenItems.has(card.platformItemId)) continue
          seenItems.add(card.platformItemId)
          await this.ensureAuthorized()
          const item = await this.readItemDetail(card)
          await this.ensureAuthorized()
          if (!matchesSearchRule(item, task.rule)) continue
          const payload = canonicalItemPayload(item)
          const saved = this.db.saveCollectedItem(task.id, item, createHash('sha256').update(payload).digest('hex'), payload)
          scannedCount += 1
          if (saved.isNewItem) newItemCount += 1
          if (saved.isNewVersion) newVersionCount += 1
        }

        if (pageIndex + 1 >= task.rule.pageLimit || !this.running) break
        if (!(await this.nextSearchPage(page))) break
      }

      if (!this.running) return
      this.db.markMonitorTaskRun(task.id)
      this.db.recordMonitorTaskRun({
        id: randomUUID(), taskId: task.id, kind: 'search', ruleVersion: task.ruleVersion, status: 'completed',
        scannedCount, newItemCount, newVersionCount, startedAt, finishedAt: new Date().toISOString()
      })
      this.db.addLog('success', `“${label}”采集完成：${scannedCount} 条，新增 ${newItemCount} 条`)
      this.updateStatus('running', '采集器正在运行', true)
    } catch (error) {
      this.db.recordMonitorTaskRun({
        id: randomUUID(), taskId: task.id, kind: 'search', ruleVersion: task.ruleVersion, status: 'failed',
        scannedCount, newItemCount, newVersionCount, startedAt, finishedAt: new Date().toISOString()
      })
      throw error
    }
  }

  private async scanSellerTask(task: CachedSellerMonitorTask): Promise<void> {
    const startedAt = new Date().toISOString()
    const scanId = randomUUID()
    let scannedCount = 0
    let newItemCount = 0
    let newVersionCount = 0
    let eventCount = 0
    let seller: SellerProfile | undefined
    try {
      await this.ensureAuthorized()
      const page = await this.openSellerPage()
      await this.goto(page, task.profileUrl, '闲鱼卖家主页加载失败，请检查网络后重试')
      await this.assertSellerPageAvailable(page)
      seller = await this.readSellerProfile(page, task)
      const sellerPayload = canonicalSellerProfilePayload(seller)
      this.db.saveSellerProfile(seller, createHash('sha256').update(sellerPayload).digest('hex'), sellerPayload)
      const seenItems = new Set<string>()
      const activeResult = await this.scanSellerListingState(page, task, seller, 'active', scanId, seenItems)
      const soldResult = await this.scanSellerListingState(page, task, seller, 'sold', scanId, seenItems)
      scannedCount = activeResult.scannedCount + soldResult.scannedCount
      newItemCount = activeResult.newItemCount + soldResult.newItemCount
      newVersionCount = activeResult.newVersionCount + soldResult.newVersionCount
      eventCount += activeResult.eventCount + soldResult.eventCount
      if (activeResult.complete && soldResult.complete) eventCount += this.db.markSellerActiveItemsOffline(seller.platformSellerId, scanId)
      if (!this.running) return
      this.db.markMonitorTaskRun(task.id)
      this.db.recordMonitorTaskRun({
        id: randomUUID(), taskId: task.id, kind: 'seller', ruleVersion: task.ruleVersion, status: 'completed',
        scannedCount, newItemCount, newVersionCount, eventCount, startedAt, finishedAt: new Date().toISOString()
      })
      this.db.addLog('success', `“${seller.publicName ?? seller.platformSellerId}”卖家采集完成：${scannedCount} 条，新增事件 ${eventCount} 条`)
      this.updateStatus('running', '采集器正在运行', true)
    } catch (error) {
      this.db.recordMonitorTaskRun({
        id: randomUUID(), taskId: task.id, kind: 'seller', ruleVersion: task.ruleVersion, status: 'failed',
        scannedCount, newItemCount, newVersionCount, eventCount, startedAt, finishedAt: new Date().toISOString()
      })
      throw error
    }
  }

  private async scanSellerListingState(
    page: Page,
    task: CachedSellerMonitorTask,
    seller: SellerProfile,
    state: Extract<SellerItemState, 'active' | 'sold'>,
    scanId: string,
    seenItems: Set<string>
  ): Promise<{ complete: boolean; scannedCount: number; newItemCount: number; newVersionCount: number; eventCount: number }> {
    await this.ensureAuthorized()
    await this.selectSellerState(page, state)
    const seenPages = new Set<string>()
    let scannedCount = 0
    let newItemCount = 0
    let newVersionCount = 0
    let eventCount = 0
    for (let pageIndex = 0; pageIndex < SELLER_PAGE_LIMIT; pageIndex += 1) {
      if (!this.running) return { complete: false, scannedCount, newItemCount, newVersionCount, eventCount }
      await this.ensureAuthorized()
      const cards = await this.readSellerCards(page, state)
      const pageKey = `${state}|${page.url()}|${cards.map((card) => card.platformItemId).join(',')}`
      if (seenPages.has(pageKey)) throw new SearchPageError('structure', '闲鱼卖家分页未前进，请检查页面结构后重试')
      seenPages.add(pageKey)
      for (const card of cards) {
        if (!this.running || seenItems.has(card.platformItemId)) continue
        seenItems.add(card.platformItemId)
        await this.ensureAuthorized()
        const item = await this.readSellerItemDetail(card, seller.platformSellerId)
        await this.ensureAuthorized()
        const payload = canonicalSellerItemPayload(item)
        const saved = this.db.saveSellerItem({
          taskId: task.id,
          scanId,
          seller,
          state,
          item,
          contentHash: createHash('sha256').update(payload).digest('hex'),
          canonicalPayload: payload
        })
        scannedCount += 1
        if (saved.isNewItem) newItemCount += 1
        if (saved.isNewVersion) newVersionCount += 1
        eventCount += saved.eventCount
      }
      if (pageIndex + 1 >= SELLER_PAGE_LIMIT) return { complete: !(await this.hasNextPage(page, true)), scannedCount, newItemCount, newVersionCount, eventCount }
      if (!(await this.clickNextPage(page, true))) return { complete: true, scannedCount, newItemCount, newVersionCount, eventCount }
    }
    return { complete: false, scannedCount, newItemCount, newVersionCount, eventCount }
  }

  private async readSellerProfile(page: Page, task: CachedSellerMonitorTask): Promise<SellerProfile> {
    const fixture = page.locator('[data-xianyu-seller-profile]').first()
    const source = await fixture.count()
      ? await fixture.evaluate((root): Record<string, unknown> => ({
          platformSellerId: root.getAttribute('data-xianyu-seller-id') ?? root.getAttribute('data-seller-id'),
          publicName: root.querySelector('[data-xianyu-seller-name], [data-seller-name]')?.textContent ?? null,
          region: root.querySelector('[data-xianyu-seller-region], [data-seller-region]')?.textContent ?? null,
          publicProfile: {
            followerText: root.querySelector('[data-xianyu-seller-followers]')?.textContent ?? null,
            ratingText: root.querySelector('[data-xianyu-seller-rating]')?.textContent ?? null,
            itemCountText: root.querySelector('[data-xianyu-seller-item-count]')?.textContent ?? null
          }
        }))
      : {
          platformSellerId: await page.locator('[data-xianyu-seller-id], [data-seller-id]').first().evaluate((node) => node.getAttribute('data-xianyu-seller-id') ?? node.getAttribute('data-seller-id')).catch(() => null),
          publicName: await page.locator('[data-xianyu-seller-name], [data-seller-name], h1').first().textContent().catch(() => null),
          region: await page.locator('[data-xianyu-seller-region], [data-seller-region], [class*="region"], [class*="location"]').first().textContent().catch(() => null),
          publicProfile: {}
        }
    const profile = parseSellerProfile({
      profileUrl: task.profileUrl,
      platformSellerId: typeof source.platformSellerId === 'string' && source.platformSellerId.trim() ? source.platformSellerId : task.platformSellerId,
      publicName: typeof source.publicName === 'string' ? source.publicName : null,
      region: typeof source.region === 'string' ? source.region : null,
      publicProfile: source.publicProfile && typeof source.publicProfile === 'object' ? source.publicProfile as Record<string, string | number | boolean | null> : {}
    })
    if (!profile || profile.platformSellerId !== task.platformSellerId) throw new SearchPageError('structure', '卖家公开资料缺少稳定卖家 ID')
    return profile
  }

  private async selectSellerState(page: Page, state: Extract<SellerItemState, 'active' | 'sold'>): Promise<void> {
    const label = state === 'active' ? '在售' : '已售'
    const fixture = page.locator(`[data-xianyu-seller-tab="${state}"]`).first()
    const generic = page.locator('button, a, [role="button"], [role="tab"]').filter({ hasText: escapedText(label) }).first()
    const control = await fixture.count() ? fixture : generic
    if (!(await control.count())) throw new SearchPageError('structure', `未找到卖家${label}商品入口`)
    await control.click()
    await page.waitForTimeout(120)
    const selected = await page.locator('body').getAttribute('data-xianyu-selected-seller-state')
    if (selected !== null && selected !== state) throw new SearchPageError('structure', `卖家${label}商品入口未生效`)
  }

  private async readSellerCards(page: Page, state: Extract<SellerItemState, 'active' | 'sold'>) {
    const fixture = page.locator('[data-xianyu-seller-item], [data-xianyu-item]')
    const fallback = page.locator('a[href*="/item?id="], a[href*="/item/"]')
    const cards = await fixture.count() ? fixture : fallback
    if (!(await cards.count())) {
      const text = await page.locator('body').innerText().catch(() => '')
      if (/非法访问|访问受限|操作太频繁|安全验证|扫码|登录/.test(compact(text))) this.throwPageState(text, `卖家${state === 'active' ? '在售' : '已售'}列表不可用`)
      return []
    }
    const sources = await cards.evaluateAll((nodes): SearchCardSource[] => nodes.map((node) => {
      const root = node.closest('[data-xianyu-seller-item], [data-xianyu-item]') ?? node
      const anchor = root instanceof HTMLAnchorElement ? root : root.querySelector<HTMLAnchorElement>('a[href]')
      return {
        href: anchor?.href ?? '',
        text: root.textContent ?? '',
        title: root.querySelector('[data-xianyu-title], h2, h3')?.textContent ?? null,
        imageUrls: Array.from(root.querySelectorAll('[data-xianyu-image], img')).map((image) => image instanceof HTMLImageElement ? image.currentSrc || image.src : '').filter((url) => /^https?:/i.test(url)),
        tags: Array.from(root.querySelectorAll('[data-xianyu-tag], [class*="tag"]')).map((tag) => tag.textContent ?? '')
      }
    }))
    return parseSearchCards(sources)
  }

  private async readSellerItemDetail(card: ReturnType<typeof parseSearchCards>[number], sellerId: string) {
    const item = await this.readItemDetail(card)
    const detailSellerId = await this.detailPage?.locator('[data-xianyu-seller-id], [data-seller-id]').first().evaluate((node) => node.getAttribute('data-xianyu-seller-id') ?? node.getAttribute('data-seller-id')).catch(() => null)
    if (!detailSellerId) throw new SearchPageError('structure', '商品详情缺少卖家 ID，已跳过以避免归属错误')
    if (detailSellerId !== sellerId) throw new SearchPageError('structure', '商品详情卖家与监控目标不一致')
    return item
  }

  private async assertSellerPageAvailable(page: Page): Promise<void> {
    const text = await page.locator('body').innerText().catch(() => '')
    if (/非法访问|访问受限|操作太频繁|安全验证|扫码|登录/.test(compact(text))) this.throwPageState(text, '卖家主页不可用')
  }

  private searchUrl(rule: SearchRule): string {
    const url = new URL(GOOFISH_SEARCH)
    if (rule.keyword) url.searchParams.set('q', rule.keyword)
    return url.toString()
  }

  private async applySearchRule(page: Page, rule: SearchRule): Promise<void> {
    if (rule.categoryPath?.length) {
      for (const category of rule.categoryPath) {
        await this.selectControl(page, 'category', category, `未找到类目“${category}”`)
        await this.assertSelected(page, 'category', category, `类目“${category}”未生效`)
      }
    }
    await this.selectSort(page, rule.sort)
    if (rule.minPrice !== undefined) await this.fillPrice(page, 'min', rule.minPrice)
    if (rule.maxPrice !== undefined) await this.fillPrice(page, 'max', rule.maxPrice)
    if (rule.region) {
      await this.selectControl(page, 'region', rule.region, `未找到地区“${rule.region}”`)
      await this.assertSelected(page, 'region', rule.region, `地区“${rule.region}”未生效`)
    }
    for (const [name, value] of Object.entries(rule.filters ?? {})) await this.selectPublicFilter(page, name, value)
  }

  private async selectSort(page: Page, sort: SearchSort): Promise<void> {
    const labels: Record<SearchSort, string> = {
      comprehensive: '综合', newly_reduced: '新降价', newly_published: '新发布', price_asc: '价格从低到高', price_desc: '价格从高到低'
    }
    const fixture = page.locator(`[data-xianyu-sort="${sort}"]`).first()
    if (await fixture.count()) await fixture.click()
    else await this.selectControl(page, 'sort', labels[sort], `未找到排序“${labels[sort]}”`)
    await this.assertSelected(page, 'sort', sort, `排序“${labels[sort]}”未生效`, labels[sort])
  }

  private async fillPrice(page: Page, kind: 'min' | 'max', value: number): Promise<void> {
    const fixture = page.locator(`[data-xianyu-price="${kind}"]`).first()
    const fallback = kind === 'min'
      ? page.locator('input[placeholder*="最低"], input[aria-label*="最低"]').first()
      : page.locator('input[placeholder*="最高"], input[aria-label*="最高"]').first()
    const input = await fixture.count() ? fixture : fallback
    if (!(await input.count())) throw new SearchPageError('structure', `未找到${kind === 'min' ? '最低' : '最高'}价格输入框`)
    await input.fill(String(value))
    await input.press('Enter').catch(() => undefined)
    if (await input.inputValue() !== String(value)) throw new SearchPageError('structure', `${kind === 'min' ? '最低' : '最高'}价格未生效`)
  }

  private async selectPublicFilter(page: Page, name: string, value: string): Promise<void> {
    const fixture = page.locator(`[data-xianyu-filter="${name}"][data-xianyu-value="${value}"]`).first()
    if (await fixture.count()) await fixture.click()
    else await this.selectControl(page, 'filter', value, `未找到公开筛选“${value}”`)
    await this.assertSelected(page, 'filter', value, `公开筛选“${value}”未生效`)
  }

  private async selectControl(page: Page, kind: 'category' | 'sort' | 'region' | 'filter', value: string, missingMessage: string): Promise<void> {
    const fixture = page.locator(`[data-xianyu-${kind}]`).filter({ hasText: escapedText(value) }).first()
    const generic = page.locator('button, a, [role="button"], [role="tab"]').filter({ hasText: escapedText(value) }).first()
    const control = await fixture.count() ? fixture : generic
    if (!(await control.count())) {
      const title = compact(await page.title().catch(() => '')).slice(0, 40)
      throw new SearchPageError('structure', title ? `${missingMessage}（页面：${title}）` : missingMessage)
    }
    await control.click()
    await page.waitForTimeout(120)
  }

  private async assertSelected(page: Page, kind: 'category' | 'sort' | 'region' | 'filter', expected: string, message: string, textFallback = expected): Promise<void> {
    const body = page.locator('body')
    const fixtureValue = await body.getAttribute(`data-xianyu-selected-${kind}`)
    if (fixtureValue !== null) {
      if (fixtureValue === expected) return
      throw new SearchPageError('structure', message)
    }
    const selectedText = await page.locator('[aria-selected="true"], [data-selected="true"], .selected, .active').allTextContents()
    if (selectedText.some((value) => compact(value) === textFallback)) return
    throw new SearchPageError('structure', message)
  }

  private async recordObservedCategories(page: Page, rule: SearchRule): Promise<void> {
    const paths = await page.locator('[data-xianyu-category-path], [data-category-path]').evaluateAll((nodes) => nodes.map((node) => {
      const raw = node.getAttribute('data-xianyu-category-path') ?? node.getAttribute('data-category-path') ?? ''
      return raw.split('/').map((part) => part.trim()).filter(Boolean)
    }).filter((path) => path.length > 0 && path.length <= 3))
    if (paths.length) {
      for (const path of paths) this.db.upsertLocalCategories(path)
      return
    }
    const options = await page.locator('[data-xianyu-category-option], [data-category-option], [data-xianyu-category]').evaluateAll((nodes) => nodes.map((node) => {
      const raw = node.getAttribute('data-xianyu-category-path') ?? node.getAttribute('data-category-path') ?? node.getAttribute('data-xianyu-category-option') ?? node.getAttribute('data-category-option') ?? node.textContent ?? ''
      return raw.split('/').map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean)
    }).filter((path) => path.length > 0 && path.length <= 3))
    if (options.length) {
      for (const path of options) this.db.upsertLocalCategories(path)
      return
    }
    if (rule.categoryPath?.length) {
      const selectedText = await page.locator('[aria-selected="true"], [data-selected="true"], .selected, .active').allTextContents()
      if (rule.categoryPath.every((part) => selectedText.some((value) => compact(value) === part))) {
        this.db.upsertLocalCategories(rule.categoryPath)
        return
      }
      throw new SearchPageError('structure', '页面未返回可解析的三级类目状态')
    }
  }

  private async recordObservedRegions(page: Page): Promise<void> {
    const values = await page.locator('[data-xianyu-region-option], [data-region-option], [data-xianyu-region], [data-seller-region], [data-xianyu-seller-region]')
      .evaluateAll((nodes) => nodes.map((node) => (node.getAttribute('data-xianyu-region-option') ?? node.getAttribute('data-region-option') ?? node.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))
    if (values.length) this.db.upsertLocalRegions([...new Set(values)])
  }

  private async readSearchCards(page: Page) {
    const fixture = page.locator('[data-xianyu-item]')
    const fallback = page.locator('a[href*="/item?id="], a[href*="/item/"]')
    const cards = await fixture.count() ? fixture : fallback
    if (!(await cards.count())) {
      const initialText = await page.locator('body').innerText().catch(() => '')
      if (/非法访问|访问受限|操作太频繁|安全验证|扫码|登录/.test(compact(initialText))) this.throwPageState(initialText, '页面未找到商品列表，请检查闲鱼页面结构')
    }
    await cards.first().waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS }).catch(() => undefined)
    const sources = await cards.evaluateAll((nodes): SearchCardSource[] => nodes.map((node) => {
      const root = node.closest('[data-xianyu-item]') ?? node
      const anchor = root instanceof HTMLAnchorElement ? root : root.querySelector<HTMLAnchorElement>('a[href]')
      const title = root.querySelector('[data-xianyu-title], h2, h3')?.textContent ?? null
      const imageUrls = Array.from(root.querySelectorAll('[data-xianyu-image], img')).map((image) => image instanceof HTMLImageElement ? image.currentSrc || image.src : '').filter((url) => /^https?:/i.test(url))
      const tags = Array.from(root.querySelectorAll('[data-xianyu-tag], [class*="tag"]')).map((tag) => tag.textContent ?? '')
      return { href: anchor?.href ?? '', text: root.textContent ?? '', title, imageUrls, tags }
    }))
    const parsed = parseSearchCards(sources)
    if (parsed.length) return parsed
    const text = await page.locator('body').innerText().catch(() => '')
    this.throwPageState(text, '页面未找到商品列表，请检查闲鱼页面结构')
  }

  private async assertSearchPageAvailable(page: Page): Promise<void> {
    const text = await page.locator('body').innerText().catch(() => '')
    if (/非法访问|访问受限|操作太频繁|安全验证|扫码|登录/.test(compact(text))) this.throwPageState(text, '页面未找到商品列表，请检查闲鱼页面结构')
  }

  private async readItemDetail(card: ReturnType<typeof parseSearchCards>[number]) {
    const page = await this.openDetailPage()
    await this.goto(page, card.url, '闲鱼商品详情加载失败，请检查网络后重试')
    const detail = page.locator('[data-xianyu-detail]').first()
    const title = page.locator('[data-xianyu-detail] [data-xianyu-title], h1, [data-xianyu-title]').first()
    if (!(await detail.count()) && !(await title.count())) {
      const text = await page.locator('body').innerText().catch(() => '')
      this.throwPageState(text, '页面未找到商品详情，请检查闲鱼页面结构')
    }
    const hasStructuredDetail = (await detail.count()) > 0
    const source: SearchDetailSource = hasStructuredDetail
      ? await detail.evaluate((root): SearchDetailSource => ({
          title: root.querySelector('[data-xianyu-title], h1')?.textContent ?? null,
          priceText: root.querySelector('[data-xianyu-price]')?.textContent ?? null,
          region: root.querySelector('[data-xianyu-region]')?.textContent ?? null,
          publishedText: root.querySelector('[data-xianyu-published]')?.textContent ?? null,
           wantText: root.querySelector('[data-xianyu-want]')?.textContent ?? null,
           description: root.querySelector('[data-xianyu-description], [class*="desc"]')?.textContent ?? null,
           conditionText: root.querySelector('[data-xianyu-condition], [data-condition], [class*="condition"]')?.textContent ?? null,
           imageUrls: Array.from(root.querySelectorAll('[data-xianyu-image], [class*="image"] img')).map((image) => image instanceof HTMLImageElement ? image.currentSrc || image.src : '').filter((url) => /^https?:/i.test(url)),
          tags: Array.from(root.querySelectorAll('[data-xianyu-tag], [class*="tag"]')).map((tag) => tag.textContent ?? '')
        }))
      : {
          title: await title.textContent(),
          priceText: await page.locator('[class*="price"]').first().textContent().catch(() => null),
          region: await page.locator('[class*="region"], [class*="location"]').first().textContent().catch(() => null),
          publishedText: await page.locator('[class*="publish"], [class*="time"]').first().textContent().catch(() => null),
           wantText: await page.locator('[class*="want"]').first().textContent().catch(() => null),
           description: await page.locator('[class*="desc"]').first().textContent().catch(() => null),
           conditionText: await page.locator('[data-xianyu-condition], [data-condition], [class*="condition"]').first().textContent().catch(() => null),
           imageUrls: await page.locator('[class*="image"] img').evaluateAll((images) => images.map((image) => image instanceof HTMLImageElement ? image.currentSrc || image.src : '').filter((url) => /^https?:/i.test(url))),
          tags: await page.locator('[class*="tag"]').allTextContents()
        }
    return mergeSearchDetail(card, source)
  }

  private async readSupplyMigrationSku(): Promise<SupplySkuConfig | null> {
    const detail = this.detailPage?.locator('[data-xianyu-detail]').first()
    if (!detail || !(await detail.count())) return null
    const raw = await detail.evaluate((root) => {
      const compactText = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
      const groups = Array.from(root.querySelectorAll('[data-xianyu-sku-group]')).map((group) => ({
        name: compactText(group.getAttribute('data-xianyu-sku-name') ?? group.querySelector('[data-xianyu-sku-name]')?.textContent),
        values: Array.from(group.querySelectorAll('[data-xianyu-sku-value]')).map((value) => compactText(value.getAttribute('data-xianyu-sku-value') ?? value.textContent)).filter(Boolean)
      }))
      const combinations = Array.from(root.querySelectorAll('[data-xianyu-sku-combination]')).map((combination) => {
        let values: unknown = []
        try { values = JSON.parse(combination.getAttribute('data-xianyu-sku-values') ?? '[]') } catch { values = [] }
        return {
          values,
          price: combination.getAttribute('data-xianyu-sku-price'),
          stock: combination.getAttribute('data-xianyu-sku-stock')
        }
      })
      return { groups, combinations }
    })
    return supplySkuConfig(raw)
  }

  private async nextSearchPage(page: Page): Promise<boolean> {
    return this.clickNextPage(page, false)
  }

  private async hasNextPage(page: Page, seller: boolean): Promise<boolean> {
    const next = await this.nextControl(page, seller)
    if (!(await next.count())) return false
    return !(await next.isDisabled().catch(() => false)) && await next.getAttribute('aria-disabled') !== 'true'
  }

  private async clickNextPage(page: Page, seller: boolean): Promise<boolean> {
    const next = await this.nextControl(page, seller)
    if (!(await next.count())) return false
    if (!(await this.hasNextPage(page, seller))) return false
    await next.click()
    await page.waitForTimeout(180)
    return true
  }

  private async nextControl(page: Page, seller: boolean): Promise<ReturnType<Page['locator']>> {
    const fixture = page.locator(seller ? '[data-xianyu-seller-next], [data-xianyu-next]' : '[data-xianyu-next]').first()
    const role = page.getByRole('button', { name: escapedText('下一页') }).first()
    const link = page.locator('a[rel="next"]').first()
    if (await fixture.count()) return fixture
    if (await role.count()) return role
    return link
  }

  private throwPageState(text: string, fallback: string): never {
    const normalized = compact(text).slice(0, 4_000)
    if (/非法访问|访问受限|操作太频繁|安全验证/.test(normalized)) throw new SearchPageError('access', '闲鱼页面拒绝访问，请在本机 Chrome 检查登录状态后稍后重试')
    if (/扫码|登录/.test(normalized)) throw new SearchPageError('login', '闲鱼登录状态已失效，请打开 Chrome 重新扫码登录')
    throw new SearchPageError('structure', fallback)
  }

  private async goto(page: Page, url: string, failureMessage: string): Promise<void> {
    if (!navigationUrlAllowed(url)) throw new SearchPageError('access', '页面地址不在允许的闲鱼域名范围内')
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS })
      await page.waitForTimeout(120)
      if (!navigationUrlAllowed(page.url())) throw new SearchPageError('access', '页面跳转到了不允许的域名')
    } catch (error) {
      if (error instanceof SearchPageError) throw error
      throw new SearchPageError('network', failureMessage)
    }
  }

  private async openLoginPage(): Promise<Page> {
    if (this.loginPage && !this.loginPage.isClosed()) return this.loginPage
    this.loginPage = await this.newProfilePage()
    return this.loginPage
  }

  private async openScannerPage(): Promise<Page> {
    if (this.scannerPage && !this.scannerPage.isClosed()) return this.scannerPage
    this.scannerPage = await this.newProfilePage()
    return this.scannerPage
  }

  private async openSellerPage(): Promise<Page> {
    if (this.sellerPage && !this.sellerPage.isClosed()) return this.sellerPage
    this.sellerPage = await this.newProfilePage()
    return this.sellerPage
  }

  private async openDetailPage(): Promise<Page> {
    if (this.detailPage && !this.detailPage.isClosed()) return this.detailPage
    this.detailPage = await this.newProfilePage()
    return this.detailPage
  }

  private async newProfilePage(): Promise<Page> {
    if (!this.context) {
      const profileDir = join(app.getPath('userData'), 'xianyu-chrome-profile')
      mkdirSync(profileDir, { recursive: true })
      try {
        this.context = await chromium.launchPersistentContext(profileDir, {
          channel: 'chrome', headless: false, viewport: { width: 1280, height: 900 }
        })
      } catch {
        this.updateBrowser('error')
        throw new Error('未找到可用的系统 Google Chrome。请安装官方 Chrome 后重试。')
      }
      this.context.on('close', () => {
        this.context = undefined
        this.loginPage = undefined
        this.scannerPage = undefined
        this.sellerPage = undefined
        this.detailPage = undefined
        this.updateBrowser('idle')
      })
      this.updateBrowser('open')
    }
    return this.context.newPage()
  }

  private async ensureAuthorized(): Promise<void> {
    await this.ensureAccessToken()
    const allowed = await this.checkEntitlements()
    if (!allowed) throw new Error('当前账号没有可用采集权益')
  }

  private async ensureAccessToken(): Promise<void> {
    if (!this.accessToken || tokenExpiresSoon(this.accessToken)) await this.refreshCollectorSession()
  }

  private async refreshCollectorSession(): Promise<void> {
    const refreshToken = this.readSecret(STATE_REFRESH_TOKEN)
    if (!refreshToken) throw new Error('本机没有可用的设备授权')
    const refreshed = await this.request<TokenResponse>(this.collectorApiBase, '/v1/auth/refresh', { method: 'POST', body: { refreshToken } })
    if (!refreshed.accessToken || !refreshed.refreshToken) throw new Error('云端未返回刷新授权')
    this.storeCollectorSession(refreshed)
  }

  private async checkEntitlements(): Promise<boolean> {
    if (!this.accessToken) throw new Error('本机没有可用的设备授权')
    const entitlements = await this.request<EntitlementResponse>(this.collectorApiBase, '/v1/entitlements', { token: this.accessToken })
    return entitlements.allowed === true
  }

  private async flushOutbox(): Promise<void> {
    for (const entry of this.db.listDueOutbox()) {
      try {
        const requestId = entry.kind === 'supply_migration_result' ? String(entry.payload.requestId ?? '') : ''
        const path = entry.kind === 'market_batch' ? '/v1/ingest' : entry.kind === 'supply_result' ? '/v1/supply/publish-results' : entry.kind === 'supply_migration_result' && requestId ? `/v1/supply/migrations/${encodeURIComponent(requestId)}/result` : '/v1/heartbeat'
        const payload = entry.kind === 'supply_migration_result' ? (() => { const { requestId: _requestId, ...result } = entry.payload; return result })() : entry.payload
        await this.request(this.collectorApiBase, path, { method: 'POST', token: this.accessToken, body: payload })
        this.db.completeOutbox(entry.id)
      } catch (error) {
        this.db.deferOutbox(entry.id, entry.attempts + 1)
        if (!this.isRetryableOutboxError(error)) throw error
        continue
      }
    }
  }

  private getOrCreateDeviceKey(): DeviceKey {
    const privatePem = this.readSecret(STATE_PRIVATE_KEY)
    const publicKey = this.db.getState(STATE_PUBLIC_KEY)
    if (privatePem && publicKey) return { privateKey: createPrivateKey(privatePem), publicKey }
    if (privatePem || publicKey) throw new Error('本机设备密钥不完整，请重新登录后绑定')
    const pair = generateKeyPairSync('ed25519')
    const generatedPublicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const generatedPrivateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    this.writeSecret(STATE_PRIVATE_KEY, generatedPrivateKey)
    this.db.setState(STATE_PUBLIC_KEY, generatedPublicKey)
    return { privateKey: createPrivateKey(generatedPrivateKey), publicKey: generatedPublicKey }
  }

  private storeCollectorSession(session: TokenResponse): void {
    if (!session.accessToken || !session.refreshToken) throw new Error('云端未返回采集器授权')
    this.accessToken = session.accessToken
    if (session.clientId) this.db.setState(STATE_CLIENT_ID, session.clientId)
    this.writeSecret(STATE_REFRESH_TOKEN, session.refreshToken)
  }

  private clearSession(): void {
    this.accessToken = undefined
    this.db.deleteState(STATE_REFRESH_TOKEN, STATE_CLIENT_ID, STATE_ACCOUNT_LABEL)
  }

  private requireEncryption(): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法安全保存设备授权')
  }

  private readSecret(key: string): string | null {
    const stored = this.db.getState(key)
    if (!stored) return null
    this.requireEncryption()
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      throw new Error('本机安全存储无法读取设备授权')
    }
  }

  private writeSecret(key: string, value: string): void {
    this.requireEncryption()
    this.db.setState(key, safeStorage.encryptString(value).toString('base64'))
  }

  private async request<T = Record<string, unknown>>(baseUrl: string, path: string, options: { method?: 'GET' | 'POST'; token?: string; body?: unknown } = {}): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new CloudRequestError(response.status, responseMessage(payload, '云端请求失败'))
      return payload as T
    } catch (error) {
      if (error instanceof CloudRequestError) throw error
      throw new CloudRequestError(0, '无法连接云端')
    } finally {
      clearTimeout(timeout)
    }
  }

  private handleSearchError(error: SearchPageError): string {
    this.running = false
    this.stopTimer()
    const message = error.kind === 'login'
      ? '闲鱼登录状态已失效，采集已暂停；请打开 Chrome 重新扫码登录'
      : error.kind === 'access'
        ? '闲鱼页面拒绝访问，采集已暂停；请在本机 Chrome 检查登录状态后稍后重试'
        : error.kind === 'network'
          ? '闲鱼页面网络不可用，采集已暂停；恢复网络后可重新启动'
          : `闲鱼页面结构异常，采集已暂停；${compact(error.message).slice(0, 120) || '请稍后重试'}`
    this.db.addLog('error', message)
    this.updateStatus('paused', message, this.state.entitled)
    return message
  }

  private handleRuntimeError(error: unknown): string {
    this.running = false
    if (this.isNetworkError(error)) {
      this.updateStatus('offline', '网络不可用，采集已暂停；恢复网络后可重新启动', false)
      this.db.addLog('error', '网络不可用，采集已暂停')
      return '网络不可用，采集已暂停；恢复网络后可重新启动'
    }
    const remoteMessage = error instanceof CloudRequestError ? error.message : ''
    if (remoteMessage.includes('撤销') || remoteMessage.includes('会话已失效') || remoteMessage.includes('刷新令牌重放')) {
      this.clearSession()
      this.updateStatus('revoked', '本机设备授权已失效，采集已停止', false)
      this.db.addLog('error', '本机设备授权已失效，采集已停止')
      return '本机设备授权已失效，请重新登录并绑定设备'
    }
    const message = this.safeMessage(error, '云端授权校验失败')
    if (message.startsWith('未找到可用的系统 Google Chrome') || message.startsWith('无法打开闲鱼登录页')) {
      this.updateStatus('error', message, this.state.entitled)
      this.db.addLog('error', message.startsWith('未找到') ? '系统 Google Chrome 不可用' : '闲鱼登录页无法打开')
      return message
    }
    if (message.includes('权益')) {
      this.updateStatus('paused', '当前账号没有可用采集权益', false)
      this.db.addLog('error', '当前账号没有可用采集权益')
      return '当前账号没有可用采集权益'
    }
    this.updateStatus('error', '云端授权校验失败，请稍后重试', false)
    this.db.addLog('error', '云端授权校验失败')
    return '云端授权校验失败，请稍后重试'
  }

  private safeMessage(error: unknown, fallback: string): string {
    if (error instanceof CloudRequestError) {
      if (error.status === 0) return '无法连接云端，请检查网络后重试'
      if (error.message === '账号或密码错误' || error.message === '设备数量已达上限' || error.message === '设备已被封禁') return error.message
    }
    if (error instanceof Error && (
      error.message === '当前账号没有可用采集权益' ||
      error.message === '本机没有可用的设备授权' ||
      error.message.startsWith('未找到可用的系统 Google Chrome') ||
      error.message.startsWith('无法打开闲鱼登录页') ||
      error.message.startsWith('本机设备密钥不完整')
    )) return error.message
    if (error instanceof Error && error.message.startsWith('Windows 安全存储')) return error.message
    return fallback
  }

  private isNetworkError(error: unknown): boolean {
    return error instanceof CloudRequestError && error.status === 0
  }

  private isRetryableOutboxError(error: unknown): boolean {
    return this.isNetworkError(error) || (error instanceof CloudRequestError && error.status >= 500)
  }

  private updateBrowser(browser: LauncherStatus['browser']): void {
    this.state = { ...this.state, browser }
    this.publish(this.state)
  }

  private updateStatus(session: LauncherStatus['session'], message: string, entitled: boolean): void {
    this.state = { session, browser: this.state.browser, entitled, message, account: this.db.getState(STATE_ACCOUNT_LABEL) ?? undefined }
    this.publish(this.state)
  }
}
