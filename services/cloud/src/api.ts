import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomUUID, timingSafeEqual, verify } from 'node:crypto'
import type { TokenDomain, SubjectKind } from './security.ts'
import { createRefreshToken, hashPassword, signAccessToken, verifyAccessToken, verifyPassword } from './security.ts'

export type Sql = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
export type Domains = Record<SubjectKind, TokenDomain>
export type ApiOptions = {
  allowedOrigins?: readonly string[]
  sellerProfileHosts?: readonly string[]
  publishedItemHosts?: readonly string[]
  modelListProxy?: (input: { baseUrl: string; modelReference: string; apiKeyCiphertext: string | null }) => Promise<unknown>
}

type UserRow = { id: string; email_normalized: string; password_hash: string; status: string }
type SessionRow = { id: string; subject_type: SubjectKind; subject_id: string; family_id: string | null; revoked_at: string | null; expires_at: string }

type ListOrder = 'asc' | 'desc'
type ListFilters = Record<string, string>
type ListConfig = { resource: string; defaultSort: string; sortAliases: Record<string, string>; filterAliases: Record<string, string>; allowedFilters: readonly string[] }
type ParsedListQuery = { limit: number; cursor?: string; sort: string; order: ListOrder; filters: ListFilters; filterHash: string }
type CursorPayload = { v: 1; resource: string; filterHash: string; sort: string; order: ListOrder; snapshot: string; key: [string, string] }
type SnapshotPayload = { v: 1; resource: string; at: string }
type ListContext = ParsedListQuery & { snapshot: string; snapshotAt: string; cursorKey?: [string, string] }
type ListQuerySpec = { text: string; values: unknown[] }

function providerSecret(secret: string): Buffer { return createHash('sha256').update(`${secret}:provider-config`).digest() }
function encryptProviderKey(value: string, secret: string): string {
  const iv = Buffer.from(randomUUID().replaceAll('-', ''), 'hex').subarray(0, 12)
  const cipher = createCipheriv('aes-256-gcm', providerSecret(secret), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}
function decryptProviderKey(value: string | null, secret: string): string | null {
  if (!value) return null
  try {
    const bytes = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', providerSecret(secret), bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
  } catch { return null }
}
function credentialValid(value: unknown): value is string { return typeof value === 'string' && value.length >= 6 && value.length <= 20 }
type ListPlan = { resource: string; page: (context: ListContext, subjectId: string) => ListQuerySpec; count: (context: ListContext, subjectId: string) => ListQuerySpec }
type ListPlanBuilder = (context: ListContext, subjectId: string) => ListPlan
type MonitorTaskStatus = 'active' | 'paused'
type MonitorTaskRule = {
  keyword?: string
  categoryPath?: string[]
  sort: 'comprehensive' | 'newly_reduced' | 'newly_published' | 'price_asc' | 'price_desc'
  minPrice?: number
  maxPrice?: number
  region?: string
  filters?: Record<string, string>
  includeWords?: string[]
  excludeWords?: string[]
  pageLimit: number
}
type MonitorTaskInput = { rule?: MonitorTaskRule; intervalSeconds?: number; status?: MonitorTaskStatus }
type SellerMonitorTaskStatus = 'active' | 'paused'
type SellerMonitorTaskInput = {
  platform?: 'goofish'
  platformSellerId?: string
  profileUrl?: string
  intervalSeconds?: number
  status?: SellerMonitorTaskStatus
}
type PublishedItemMonitorTaskStatus = 'active' | 'paused'
type PublishedItemMonitorTaskInput = {
  publishPlanId?: string
  platformItemId?: string
  itemUrl?: string
  intervalSeconds?: number
  status?: PublishedItemMonitorTaskStatus
}
type SupplySourceType = 'xianyu' | 'general'
type SupplyMaterial = {
  sourceType: SupplySourceType
  sourcePlatform: string
  sourceItemId: string
  sourceUrl: string
  title: string
  description?: string
  price: number
  mainImages: string[]
  detailImages: string[]
  sku?: unknown
  attributes: Record<string, unknown>
}
type SupplyMaterialPatch = {
  title?: string
  description?: string | null
  price?: number
  mainImages?: string[]
  detailImages?: string[]
  sku?: unknown | null
  attributes?: Record<string, unknown>
  status?: 'draft' | 'ready' | 'archived'
}
type SupplyPublishPlanInput = {
  materialId: string
  idempotencyKey: string
  schedule: { mode: 'immediate' | 'scheduled' | 'random_window'; scheduledAt: string; windowStart?: string; windowEnd?: string }
}
type SupplyPublishClaimInput = { deviceId: string; idempotencyKey: string; limit: number }

class ListRequestError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

class MonitorTaskRequestError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

class SupplyImportRequestError extends Error {}

const monitorTaskSorts = new Set<MonitorTaskRule['sort']>(['comprehensive', 'newly_reduced', 'newly_published', 'price_asc', 'price_desc'])
const monitorTaskFilterKeys = new Set(['condition', 'delivery', 'shipping', 'guarantee', 'newOnly'])
const monitorTaskRuleKeys = new Set(['keyword', 'categoryPath', 'sort', 'minPrice', 'maxPrice', 'region', 'filters', 'includeWords', 'excludeWords', 'pageLimit'])
const monitorTaskInputKeys = new Set(['rule', 'intervalSeconds', 'status'])
const MAX_ACTIVE_SEARCH_TASKS = 20
const MAX_ACTIVE_SELLER_TASKS = 5
const sellerMonitorTaskInputKeys = new Set(['platform', 'platformSellerId', 'profileUrl', 'intervalSeconds', 'status'])
const publishedItemMonitorTaskInputKeys = new Set(['publishPlanId', 'platformItemId', 'itemUrl', 'intervalSeconds', 'status'])
const DEFAULT_SELLER_PROFILE_HOSTS = ['goofish.com', '*.goofish.com'] as const
const supplyImportKeys = new Set(['schemaVersion', 'sourceType', 'sourceFormat', 'idempotencyKey', 'snapshots'])
const supplyMaterialPatchKeys = new Set(['title', 'description', 'price', 'mainImages', 'detailImages', 'sku', 'attributes', 'status'])
const supplyPublishPlanKeys = new Set(['schemaVersion', 'materialId', 'idempotencyKey', 'schedule'])
const supplyPublishScheduleKeys = new Set(['mode', 'scheduledAt', 'windowStart', 'windowEnd'])
const supplyPublishClaimKeys = new Set(['schemaVersion', 'deviceId', 'idempotencyKey', 'limit'])
const supplyMigrationRequestKeys = new Set(['schemaVersion', 'idempotencyKey', 'source'])
const supplyMigrationSourceKeys = new Set(['kind', 'sourceId', 'itemUrl'])
const supplyMigrationClaimKeys = new Set(['schemaVersion', 'deviceId', 'idempotencyKey', 'limit'])
const supplyMigrationResultKeys = new Set(['schemaVersion', 'deviceId', 'attemptKey', 'status', 'snapshot', 'errorMessage'])
const supplySensitiveKey = /(?:cookie|token|authorization|password|session|profile(?:path)?|chrome|qr(?:code)?|credential|secret)/i
const supplyCredentialQueryKey = /(?:cookie|token|authorization|password|session|profile|chrome|qr|credential|secret)/i
const supplyPlatforms = new Set(['goofish', 'pdd', 'taobao', 'tmall', '1688', 'douyin', 'jd', 'amazon'])

function body<T>(value: unknown): T { return value as T }
function refreshHash(token: string): string { return createHash('sha256').update(token).digest('hex') }
function bearer(header: string | undefined): string { if (!header?.startsWith('Bearer ')) throw new Error('缺少访问令牌'); return header.slice(7) }
function fail(reply: { code: (value: number) => { send: (body: unknown) => unknown } }, code: number, message: string) { return reply.code(code).send({ error: message }) }
function listFail(reply: { code: (value: number) => { send: (body: unknown) => unknown } }, error: ListRequestError) { return reply.code(400).send({ error: { code: error.code, message: error.message } }) }
function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === '23505') }

function monitorTaskRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new MonitorTaskRequestError(`${name} 必须是对象`)
  return value as Record<string, unknown>
}

function supplyRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new SupplyImportRequestError(`${name} 必须是对象`)
  return value as Record<string, unknown>
}

function supplyString(value: unknown, name: string, maxLength: number, required = true): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new SupplyImportRequestError(`${name} 必填`)
    return undefined
  }
  if (typeof value !== 'string') throw new SupplyImportRequestError(`${name} 必须是字符串`)
  const normalized = value.replace(/\s+/g, ' ').trim()
  if ((required && !normalized) || normalized.length > maxLength) throw new SupplyImportRequestError(`${name} 长度无效`)
  return normalized || undefined
}

function rejectSupplySensitive(value: unknown, depth = 0): void {
  if (depth > 12) throw new SupplyImportRequestError('快照嵌套层级过深')
  if (Array.isArray(value)) {
    if (value.length > 200) throw new SupplyImportRequestError('快照数组过长')
    value.forEach((entry) => rejectSupplySensitive(entry, depth + 1))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (supplySensitiveKey.test(key)) throw new SupplyImportRequestError('快照包含仅限本机的敏感字段')
    rejectSupplySensitive(entry, depth + 1)
  }
}

function supplyPublicUrl(value: unknown, name: string): string {
  const raw = supplyString(value, name, 2_048)!
  let url: URL
  try { url = new URL(raw) } catch { throw new SupplyImportRequestError(`${name} 必须是公开地址`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SupplyImportRequestError(`${name} 必须是公开地址`)
  for (const key of [...url.searchParams.keys()]) if (supplyCredentialQueryKey.test(key)) url.searchParams.delete(key)
  url.hash = ''
  return url.toString()
}

function supplyImages(value: unknown, name: string, max: number): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  if (values.length > max) throw new SupplyImportRequestError(`${name} 数量无效`)
  const result: string[] = []
  for (const entry of values) {
    const candidate = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? (entry as Record<string, unknown>).url ?? (entry as Record<string, unknown>).imageUrl : undefined
    const normalized = supplyPublicUrl(candidate, name)
    if (!result.includes(normalized)) result.push(normalized)
  }
  return result
}

function supplyPrice(value: unknown, name: string): number {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(numberValue) || numberValue < 0 || numberValue > 100_000_000) throw new SupplyImportRequestError(`${name} 必须是有效价格`)
  return Number(numberValue.toFixed(2))
}

function supplyPlatformFromUrl(url: string): string | undefined {
  const host = new URL(url).hostname.toLowerCase()
  if (host.includes('goofish.com')) return 'goofish'
  if (host.includes('yangkeduo.com') || host.includes('pinduoduo.com')) return 'pdd'
  if (host.includes('tmall.com')) return 'tmall'
  if (host.includes('taobao.com')) return 'taobao'
  if (host.includes('1688.com')) return '1688'
  if (host.includes('douyin.com') || host.includes('jinritemai.com')) return 'douyin'
  if (host.includes('jd.com')) return 'jd'
  if (host.includes('amazon.')) return 'amazon'
  return undefined
}

function parseSupplySnapshot(value: unknown): SupplyMaterial {
  const snapshot = supplyRecord(value, '快照')
  rejectSupplySensitive(snapshot)
  const pddGoods = (((snapshot.store as Record<string, unknown> | undefined)?.initDataObj as Record<string, unknown> | undefined)?.goods as Record<string, unknown> | undefined)
  if (pddGoods) {
    const sourceItemId = supplyString(pddGoods.goodsID ?? pddGoods.goodsId, 'PDD 商品 ID', 128)!
    const title = supplyString(pddGoods.goodsName ?? pddGoods.goods_name, 'PDD 标题', 240)!
    const mainImages = supplyImages(pddGoods.topGallery ?? [pddGoods.hdThumbUrl, pddGoods.thumbUrl].filter(Boolean), 'PDD 主图', 10)
    if (!mainImages.length) throw new SupplyImportRequestError('PDD 主图至少需要一张')
    const rawPrice = pddGoods.minOnSaleGroupPrice ?? pddGoods.minGroupPrice ?? pddGoods.groupPrice ?? pddGoods.price
    const price = supplyPrice(typeof rawPrice === 'number' && Number.isInteger(rawPrice) && rawPrice >= 100 ? rawPrice / 100 : rawPrice, 'PDD 价格')
    return { sourceType: 'general', sourcePlatform: 'pdd', sourceItemId, sourceUrl: `https://mobile.yangkeduo.com/goods.html?goods_id=${encodeURIComponent(sourceItemId)}`, title, price, mainImages, detailImages: supplyImages(pddGoods.detailGallery, 'PDD 详情图', 120), sku: pddGoods.skus, attributes: {} }
  }
  const data = supplyRecord(snapshot.data ?? snapshot.Data ?? snapshot, '快照')
  const itemInfo = supplyRecord(data.itemInfo ?? data.item ?? snapshot.itemInfo ?? {}, '快照 itemInfo')
  const sourceUrl = snapshot.sourceUrl ?? snapshot.url ? supplyPublicUrl(snapshot.sourceUrl ?? snapshot.url, 'sourceUrl') : undefined
  const sourcePlatform = supplyString(snapshot.sourcePlatform ?? snapshot.platform ?? (data.itemInfo ? 'taobao' : sourceUrl ? supplyPlatformFromUrl(sourceUrl) : undefined), '来源平台', 32, false)
  const sourceItemId = supplyString(snapshot.sourceItemId ?? snapshot.sourceGoodsId ?? snapshot.goodsId ?? snapshot.itemId ?? snapshot.platformItemId ?? itemInfo.itemId ?? itemInfo.item_id, '商品 ID', 128)!
  if (!sourcePlatform || !supplyPlatforms.has(sourcePlatform)) throw new SupplyImportRequestError('不支持的来源平台')
  const canonicalUrl = sourceUrl ?? (sourcePlatform === 'taobao' ? `https://item.taobao.com/item.htm?id=${encodeURIComponent(sourceItemId)}` : sourcePlatform === 'tmall' ? `https://detail.tmall.com/item.htm?id=${encodeURIComponent(sourceItemId)}` : undefined)
  if (!canonicalUrl) throw new SupplyImportRequestError('快照缺少 sourceUrl')
  const title = supplyString(snapshot.title ?? snapshot.goodsName ?? itemInfo.title ?? itemInfo.itemName, '商品标题', 240)!
  const mainImages = supplyImages(snapshot.mainImages ?? snapshot.images ?? snapshot.image ?? itemInfo.images ?? itemInfo.itemImages, '主图', 10)
  if (!mainImages.length) throw new SupplyImportRequestError('主图至少需要一张')
  const itemPrice = data.itemPrice && typeof data.itemPrice === 'object' ? data.itemPrice as Record<string, unknown> : {}
  const attributes = snapshot.attrs && !Array.isArray(snapshot.attrs) && typeof snapshot.attrs === 'object' ? snapshot.attrs as Record<string, unknown> : {}
  return { sourceType: sourcePlatform === 'goofish' ? 'xianyu' : 'general', sourcePlatform, sourceItemId, sourceUrl: canonicalUrl, title, description: supplyString(snapshot.description ?? snapshot.desc, '描述', 10_000, false), price: supplyPrice(snapshot.price ?? itemInfo.price ?? itemPrice.promotionPrice ?? itemPrice.originalPrice, '价格'), mainImages, detailImages: supplyImages(snapshot.detailImages, '详情图', 120), sku: snapshot.sku ?? snapshot.skuJson ?? data.skuCore ?? data.itemSkuDO, attributes }
}

function parseSupplyImport(value: unknown): { sourceType: SupplySourceType; sourceFormat: 'parsed_snapshot_json' | 'parsed_snapshot_jsonl'; idempotencyKey: string; snapshots: unknown[] } {
  const input = supplyRecord(value, '导入请求')
  for (const key of Object.keys(input)) if (!supplyImportKeys.has(key)) throw new SupplyImportRequestError(`不支持字段 ${key}`)
  if (input.schemaVersion !== 1) throw new SupplyImportRequestError('只支持 schemaVersion 1')
  if (input.sourceType !== 'xianyu' && input.sourceType !== 'general') throw new SupplyImportRequestError('sourceType 只允许 xianyu 或 general')
  if (input.sourceFormat !== 'parsed_snapshot_json' && input.sourceFormat !== 'parsed_snapshot_jsonl') throw new SupplyImportRequestError('只接受已解析 JSON 或 JSONL 快照，不接受链接文本')
  const idempotencyKey = supplyString(input.idempotencyKey, 'idempotencyKey', 256)!
  if (!Array.isArray(input.snapshots) || input.snapshots.length < 1 || input.snapshots.length > 100) throw new SupplyImportRequestError('snapshots 必须是 1 到 100 项的已解析快照数组')
  return { sourceType: input.sourceType, sourceFormat: input.sourceFormat, idempotencyKey, snapshots: input.snapshots }
}

function parseSupplyMigrationRequest(value: unknown, allowedHosts: readonly string[]) {
  const input = supplyRecord(value, '搬家请求')
  for (const key of Object.keys(input)) if (!supplyMigrationRequestKeys.has(key)) throw new SupplyImportRequestError(`不支持字段 ${key}`)
  if (input.schemaVersion !== 1) throw new SupplyImportRequestError('只支持 schemaVersion 1')
  const idempotencyKey = supplyString(input.idempotencyKey, 'idempotencyKey', 256)!
  const source = supplyRecord(input.source, 'source')
  for (const key of Object.keys(source)) if (!supplyMigrationSourceKeys.has(key)) throw new SupplyImportRequestError(`source 不支持字段 ${key}`)
  const kind = source.kind
  if (kind !== 'market_item' && kind !== 'published_item' && kind !== 'public_url') throw new SupplyImportRequestError('source.kind 无效')
  if (kind === 'public_url') {
    const itemUrl = publishedItemUrl(source.itemUrl, allowedHosts)
    const platformItemId = publishedItemIdFromUrl(itemUrl)
    if (!platformItemId) throw new SupplyImportRequestError('itemUrl 未包含可识别的闲鱼商品 ID')
    return { idempotencyKey, kind, sourceId: undefined, itemUrl, platformItemId }
  }
  const sourceId = supplyString(source.sourceId, 'source.sourceId', 64)!
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceId)) throw new SupplyImportRequestError('source.sourceId 格式无效')
  return { idempotencyKey, kind, sourceId, itemUrl: undefined, platformItemId: undefined }
}

function parseSupplyMigrationClaim(value: unknown) {
  const input = supplyRecord(value, '搬家领取请求')
  for (const key of Object.keys(input)) if (!supplyMigrationClaimKeys.has(key)) throw new SupplyImportRequestError(`不支持字段 ${key}`)
  if (input.schemaVersion !== 1) throw new SupplyImportRequestError('只支持 schemaVersion 1')
  const deviceId = supplyString(input.deviceId, 'deviceId', 64)!
  const idempotencyKey = supplyString(input.idempotencyKey, 'idempotencyKey', 256)!
  if (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 10) throw new SupplyImportRequestError('limit 必须是 1 到 10 的整数')
  return { deviceId, idempotencyKey, limit: Number(input.limit) }
}

function parseSupplyMigrationResult(value: unknown) {
  const input = supplyRecord(value, '搬家结果')
  for (const key of Object.keys(input)) if (!supplyMigrationResultKeys.has(key)) throw new SupplyImportRequestError(`不支持字段 ${key}`)
  if (input.schemaVersion !== 1) throw new SupplyImportRequestError('只支持 schemaVersion 1')
  const deviceId = supplyString(input.deviceId, 'deviceId', 64)!
  const attemptKey = supplyString(input.attemptKey, 'attemptKey', 256)!
  if (input.status !== 'succeeded' && input.status !== 'failed') throw new SupplyImportRequestError('status 只允许 succeeded 或 failed')
  if (input.status === 'succeeded') {
    if (input.errorMessage !== undefined) throw new SupplyImportRequestError('成功结果不接受 errorMessage')
    return { deviceId, attemptKey, status: 'succeeded' as const, snapshot: input.snapshot, errorMessage: undefined }
  }
  if (input.snapshot !== undefined) throw new SupplyImportRequestError('失败结果不接受 snapshot')
  return { deviceId, attemptKey, status: 'failed' as const, snapshot: undefined, errorMessage: supplyString(input.errorMessage, 'errorMessage', 1_000)! }
}

function parseSupplyMaterialPatch(value: unknown): SupplyMaterialPatch {
  const input = supplyRecord(value, '素材编辑请求')
  for (const key of Object.keys(input)) if (!supplyMaterialPatchKeys.has(key)) throw new SupplyImportRequestError(`不支持字段 ${key}`)
  if (!Object.keys(input).length) throw new SupplyImportRequestError('至少更新一个素材字段')
  rejectSupplySensitive(input)
  const patch: SupplyMaterialPatch = {}
  if (Object.hasOwn(input, 'title')) patch.title = supplyString(input.title, '标题', 240)!
  if (Object.hasOwn(input, 'description')) patch.description = input.description === null ? null : supplyString(input.description, '描述', 10_000)!
  if (Object.hasOwn(input, 'price')) patch.price = supplyPrice(input.price, '价格')
  if (Object.hasOwn(input, 'mainImages')) {
    const images = supplyImages(input.mainImages, '主图', 10)
    if (!images.length) throw new SupplyImportRequestError('主图至少需要一张')
    patch.mainImages = images
  }
  if (Object.hasOwn(input, 'detailImages')) patch.detailImages = supplyImages(input.detailImages, '详情图', 120)
  if (Object.hasOwn(input, 'sku')) patch.sku = input.sku === null ? null : input.sku
  if (Object.hasOwn(input, 'attributes')) {
    if (!input.attributes || Array.isArray(input.attributes) || typeof input.attributes !== 'object') throw new SupplyImportRequestError('属性必须是对象')
    patch.attributes = input.attributes as Record<string, unknown>
  }
  if (Object.hasOwn(input, 'status')) {
    if (input.status !== 'draft' && input.status !== 'ready' && input.status !== 'archived') throw new SupplyImportRequestError('素材状态无效')
    patch.status = input.status
  }
  return patch
}

function supplyTimestamp(value: unknown, name: string): string {
  const raw = supplyString(value, name, 64)!
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) throw new SupplyImportRequestError(`${name} 必须是有效时间`)
  return date.toISOString()
}

function parseSupplySchedule(value: unknown): SupplyPublishPlanInput['schedule'] {
  const scheduleInput = supplyRecord(value, 'schedule')
  for (const key of Object.keys(scheduleInput)) if (!supplyPublishScheduleKeys.has(key)) throw new SupplyImportRequestError(`schedule 不支持字段 ${key}`)
  if (scheduleInput.mode !== 'immediate' && scheduleInput.mode !== 'scheduled' && scheduleInput.mode !== 'random_window') throw new SupplyImportRequestError('schedule.mode 无效')
  if (scheduleInput.mode === 'immediate') {
    if (scheduleInput.scheduledAt !== undefined || scheduleInput.windowStart !== undefined || scheduleInput.windowEnd !== undefined) throw new SupplyImportRequestError('立即发布不接受计划时间窗口')
    return { mode: 'immediate', scheduledAt: new Date().toISOString() }
  }
  if (scheduleInput.mode === 'scheduled') {
    if (scheduleInput.windowStart !== undefined || scheduleInput.windowEnd !== undefined) throw new SupplyImportRequestError('定时发布不接受随机时间窗口')
    return { mode: 'scheduled', scheduledAt: supplyTimestamp(scheduleInput.scheduledAt, 'scheduledAt') }
  }
  if (scheduleInput.scheduledAt !== undefined) throw new SupplyImportRequestError('随机时间窗口不接受 scheduledAt')
  const windowStart = supplyTimestamp(scheduleInput.windowStart, 'windowStart')
  const windowEnd = supplyTimestamp(scheduleInput.windowEnd, 'windowEnd')
  const start = Date.parse(windowStart)
  const end = Date.parse(windowEnd)
  if (end <= start) throw new SupplyImportRequestError('随机时间窗口结束时间必须晚于开始时间')
  const scheduledAt = new Date(start + Math.floor(Math.random() * (end - start + 1))).toISOString()
  return { mode: 'random_window', scheduledAt, windowStart, windowEnd }
}

function parseSupplyPublishPlan(value: unknown): SupplyPublishPlanInput {
  const input = supplyRecord(value, '发布计划请求')
  for (const key of Object.keys(input)) if (!supplyPublishPlanKeys.has(key)) throw new SupplyImportRequestError(`不支持字段 ${key}`)
  if (input.schemaVersion !== 1) throw new SupplyImportRequestError('只支持 schemaVersion 1')
  return {
    materialId: supplyString(input.materialId, 'materialId', 64)!,
    idempotencyKey: supplyString(input.idempotencyKey, 'idempotencyKey', 256)!,
    schedule: parseSupplySchedule(input.schedule)
  }
}

function parseSupplyPublishPlanPatch(value: unknown): { schedule?: SupplyPublishPlanInput['schedule']; status?: 'cancelled' } {
  const input = supplyRecord(value, '发布计划编辑请求')
  for (const key of Object.keys(input)) if (key !== 'schedule' && key !== 'status') throw new SupplyImportRequestError(`不支持字段 ${key}`)
  if (!Object.keys(input).length) throw new SupplyImportRequestError('至少更新一个发布计划字段')
  if (input.status !== undefined && input.status !== 'cancelled') throw new SupplyImportRequestError('发布计划仅支持取消')
  return { schedule: input.schedule === undefined ? undefined : parseSupplySchedule(input.schedule), status: input.status as 'cancelled' | undefined }
}

function parseSupplyPublishClaim(value: unknown): SupplyPublishClaimInput {
  const input = supplyRecord(value, '发布计划领取请求')
  for (const key of Object.keys(input)) if (!supplyPublishClaimKeys.has(key)) throw new SupplyImportRequestError(`发布计划领取不支持字段 ${key}`)
  if (input.schemaVersion !== 1) throw new SupplyImportRequestError('发布计划领取只支持 schemaVersion 1')
  const limit = input.limit === undefined ? 10 : Number(input.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new SupplyImportRequestError('领取数量必须在 1 到 20 之间')
  return {
    deviceId: supplyString(input.deviceId, 'deviceId', 64)!,
    idempotencyKey: supplyString(input.idempotencyKey, 'idempotencyKey', 256)!,
    limit
  }
}

function supplyClaimSnapshot(value: unknown): Record<string, unknown> {
  const snapshot = supplyRecord(value, '冻结素材快照')
  rejectSupplySensitive(snapshot)
  return snapshot
}

function supplyStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(supplyStableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${supplyStableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function persistSupplyMigrationSnapshot(sql: Sql, userId: string, requestId: string, snapshotValue: unknown): Promise<{ materialId: string; duplicate: boolean }> {
  const material = parseSupplySnapshot(snapshotValue)
  if (material.sourceType !== 'xianyu' || material.sourcePlatform !== 'goofish') throw new SupplyImportRequestError('搬家结果必须是闲鱼公开商品快照')
  const request = (await sql.query(`SELECT platform_item_id,item_url FROM supply.migration_requests WHERE id=$1 AND user_id=$2`, [requestId, userId])).rows[0]
  if (!request || material.sourceItemId !== String(request.platform_item_id) || material.sourceUrl !== String(request.item_url)) throw new SupplyImportRequestError('搬家结果与请求商品不匹配')
  const canonicalSnapshot = { schemaVersion: 1, ...material, sku: material.sku ?? null }
  const contentHash = createHash('sha256').update(supplyStableJson(canonicalSnapshot)).digest('hex')
  const batchId = randomUUID()
  await sql.query(`INSERT INTO supply.import_batches (id,user_id,idempotency_key,source_type,source_format,payload_hash,received_count,inserted_count,deduplicated_count,failed_count,result,created_at,completed_at)
    VALUES ($1,$2,$3,'xianyu','parsed_snapshot_json',$4,1,0,0,0,'{}'::jsonb,now(),now())`, [batchId, userId, `migration:${requestId}:${contentHash}`, contentHash])
  const existing = (await sql.query('SELECT id,current_version FROM supply.materials WHERE user_id=$1 AND source_platform=$2 AND source_item_id=$3', [userId, material.sourcePlatform, material.sourceItemId])).rows[0]
  if (!existing) {
    const materialId = randomUUID()
    await sql.query(`INSERT INTO supply.materials (id,user_id,source_type,source_platform,source_item_id,source_url,title,description,price,main_images,detail_images,sku,attributes,import_batch_id,current_version,status,created_at,updated_at)
      VALUES ($1,$2,'xianyu',$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,1,'draft',now(),now())`, [materialId, userId, material.sourcePlatform, material.sourceItemId, material.sourceUrl, material.title, material.description ?? null, material.price, JSON.stringify(material.mainImages), JSON.stringify(material.detailImages), JSON.stringify(material.sku ?? null), JSON.stringify(material.attributes), batchId])
    await sql.query('INSERT INTO supply.material_versions (id,material_id,version,content_hash,canonical_snapshot,import_batch_id,created_at) VALUES ($1,$2,1,$3,$4::jsonb,$5,now())', [randomUUID(), materialId, contentHash, JSON.stringify(canonicalSnapshot), batchId])
    await sql.query("UPDATE supply.import_batches SET inserted_count=1,result=jsonb_build_object('receivedCount',1,'insertedCount',1,'deduplicatedCount',0,'failedCount',0,'duplicate',false) WHERE id=$1", [batchId])
    return { materialId, duplicate: false }
  }
  const materialId = String(existing.id)
  const known = await sql.query('SELECT 1 FROM supply.material_versions WHERE material_id=$1 AND content_hash=$2', [materialId, contentHash])
  if (known.rows[0]) {
    await sql.query("UPDATE supply.import_batches SET deduplicated_count=1,result=jsonb_build_object('receivedCount',1,'insertedCount',0,'deduplicatedCount',1,'failedCount',0,'duplicate',true) WHERE id=$1", [batchId])
    return { materialId, duplicate: true }
  }
  const nextVersion = Number(existing.current_version) + 1
  await sql.query(`UPDATE supply.materials SET source_url=$1,title=$2,description=$3,price=$4,main_images=$5::jsonb,detail_images=$6::jsonb,sku=$7::jsonb,attributes=$8::jsonb,import_batch_id=$9,current_version=$10,updated_at=now() WHERE id=$11 AND user_id=$12`, [material.sourceUrl, material.title, material.description ?? null, material.price, JSON.stringify(material.mainImages), JSON.stringify(material.detailImages), JSON.stringify(material.sku ?? null), JSON.stringify(material.attributes), batchId, nextVersion, materialId, userId])
  await sql.query('INSERT INTO supply.material_versions (id,material_id,version,content_hash,canonical_snapshot,import_batch_id,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,now())', [randomUUID(), materialId, nextVersion, contentHash, JSON.stringify(canonicalSnapshot), batchId])
  await sql.query("UPDATE supply.import_batches SET inserted_count=1,result=jsonb_build_object('receivedCount',1,'insertedCount',1,'deduplicatedCount',0,'failedCount',0,'duplicate',false) WHERE id=$1", [batchId])
  return { materialId, duplicate: false }
}

function supplyMigrationResponse(row: Record<string, unknown>) {
  return { id: String(row.id), sourceKind: String(row.source_kind ?? row.sourceKind), platform: String(row.platform), platformItemId: String(row.platform_item_id ?? row.platformItemId), itemUrl: String(row.item_url ?? row.itemUrl), status: String(row.status), materialId: row.material_id ?? row.materialId ?? null, lastError: row.last_error ?? row.lastError ?? null, createdAt: timestamp(row.created_at ?? row.createdAt), updatedAt: timestamp(row.updated_at ?? row.updatedAt) }
}

function safeSupplyMigrationError(value: string): string {
  return supplySensitiveKey.test(value) ? '本机读取失败，请检查公开商品页后重试' : value.slice(0, 1_000)
}

function monitorTaskString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new MonitorTaskRequestError(`${name} 必须是字符串`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) throw new MonitorTaskRequestError(`${name} 长度无效`)
  return normalized
}

function monitorTaskWords(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new MonitorTaskRequestError(`${name} 必须是最多 20 项的数组`)
  const words = value.map((entry) => monitorTaskString(entry, name, 48))
  if (new Set(words).size !== words.length) throw new MonitorTaskRequestError(`${name} 不能包含重复词`)
  return words
}

function monitorTaskPrice(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000_000) throw new MonitorTaskRequestError(`${name} 必须是有效价格`)
  return value
}

function parseMonitorTaskRule(value: unknown): MonitorTaskRule {
  const source = monitorTaskRecord(value, 'rule')
  for (const key of Object.keys(source)) if (!monitorTaskRuleKeys.has(key)) throw new MonitorTaskRequestError(`rule 不支持字段 ${key}`)

  const keyword = source.keyword === undefined ? undefined : monitorTaskString(source.keyword, 'keyword', 80)
  const categoryPath = source.categoryPath === undefined ? undefined : (() => {
    if (!Array.isArray(source.categoryPath) || source.categoryPath.length < 1 || source.categoryPath.length > 3) throw new MonitorTaskRequestError('categoryPath 必须是 1 到 3 级类目数组')
    const path = source.categoryPath.map((entry) => monitorTaskString(entry, 'categoryPath', 80))
    if (new Set(path).size !== path.length) throw new MonitorTaskRequestError('categoryPath 不能包含重复类目')
    return path
  })()
  if (!keyword && !categoryPath) throw new MonitorTaskRequestError('至少需要 keyword 或 categoryPath')

  const sort = source.sort === undefined ? 'comprehensive' : source.sort
  if (typeof sort !== 'string' || !monitorTaskSorts.has(sort as MonitorTaskRule['sort'])) throw new MonitorTaskRequestError('sort 无效')
  const minPrice = source.minPrice === undefined ? undefined : monitorTaskPrice(source.minPrice, 'minPrice')
  const maxPrice = source.maxPrice === undefined ? undefined : monitorTaskPrice(source.maxPrice, 'maxPrice')
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) throw new MonitorTaskRequestError('minPrice 不能大于 maxPrice')
  const region = source.region === undefined ? undefined : monitorTaskString(source.region, 'region', 64)
  const filters = source.filters === undefined ? undefined : (() => {
    const filterSource = monitorTaskRecord(source.filters, 'filters')
    if (Object.keys(filterSource).length > 5) throw new MonitorTaskRequestError('filters 最多 5 项')
    const result: Record<string, string> = {}
    for (const [key, rawValue] of Object.entries(filterSource)) {
      if (!monitorTaskFilterKeys.has(key)) throw new MonitorTaskRequestError(`filters 不支持字段 ${key}`)
      result[key] = monitorTaskString(rawValue, `filters.${key}`, 40)
    }
    return result
  })()
  const includeWords = source.includeWords === undefined ? undefined : monitorTaskWords(source.includeWords, 'includeWords')
  const excludeWords = source.excludeWords === undefined ? undefined : monitorTaskWords(source.excludeWords, 'excludeWords')
  if (includeWords && excludeWords && includeWords.some((word) => excludeWords.includes(word))) throw new MonitorTaskRequestError('包含词与排除词不能重复')
  const pageLimit = source.pageLimit === undefined ? 2 : source.pageLimit
  if (typeof pageLimit !== 'number' || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 10) throw new MonitorTaskRequestError('pageLimit 必须是 1 到 10 的整数')

  return {
    ...(keyword ? { keyword } : {}),
    ...(categoryPath ? { categoryPath } : {}),
    sort: sort as MonitorTaskRule['sort'],
    ...(minPrice === undefined ? {} : { minPrice }),
    ...(maxPrice === undefined ? {} : { maxPrice }),
    ...(region ? { region } : {}),
    ...(filters && Object.keys(filters).length ? { filters } : {}),
    ...(includeWords && includeWords.length ? { includeWords } : {}),
    ...(excludeWords && excludeWords.length ? { excludeWords } : {}),
    pageLimit
  }
}

function parseMonitorTaskInput(value: unknown, creating: boolean): MonitorTaskInput {
  const source = monitorTaskRecord(value, '请求体')
  for (const key of Object.keys(source)) if (!monitorTaskInputKeys.has(key)) throw new MonitorTaskRequestError(`不支持字段 ${key}`)
  if (creating && source.rule === undefined) throw new MonitorTaskRequestError('rule 必填')
  if (creating && source.intervalSeconds === undefined) throw new MonitorTaskRequestError('intervalSeconds 必填')
  const intervalSeconds = source.intervalSeconds === undefined ? undefined : source.intervalSeconds
  if (intervalSeconds !== undefined && (typeof intervalSeconds !== 'number' || !Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86_400)) throw new MonitorTaskRequestError('intervalSeconds 必须是 60 到 86400 的整数')
  const status = source.status === undefined ? undefined : source.status
  if (status !== undefined && status !== 'active' && status !== 'paused') throw new MonitorTaskRequestError('status 只允许 active 或 paused')
  return {
    ...(source.rule === undefined ? {} : { rule: parseMonitorTaskRule(source.rule) }),
    ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
    ...(status === undefined ? {} : { status: status as MonitorTaskStatus })
  }
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

function sellerMonitorTaskProfileUrl(value: unknown, allowedHosts: readonly string[]): string {
  const raw = monitorTaskString(value, 'profileUrl', 2_048)
  let url: URL
  try { url = new URL(raw) } catch { throw new MonitorTaskRequestError('profileUrl 必须是有效公开主页地址') }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  const isDefaultHost = hostname === 'goofish.com' || hostname.endsWith('.goofish.com')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !allowedHosts.some((pattern) => sellerProfileHostMatches(hostname, pattern)) || (isDefaultHost && (url.protocol !== 'https:' || url.port))) {
    throw new MonitorTaskRequestError('profileUrl 必须是允许的闲鱼公开主页地址')
  }
  return url.toString()
}

function sellerIdFromProfileUrl(profileUrl: string): string | undefined {
  const url = new URL(profileUrl)
  for (const key of ['userId', 'sellerId', 'seller_id', 'userid', 'id']) {
    const candidate = url.searchParams.get(key)?.trim()
    if (candidate && /^[A-Za-z0-9._-]+$/.test(candidate)) return candidate
  }
  const pathCandidate = /(?:user|seller|profile|personal)[\/_-]([A-Za-z0-9._-]+)/i.exec(url.pathname)?.[1]
  return pathCandidate
}

function sanitizeSellerProfileUrl(profileUrl: string, sellerId: string | undefined): string {
  const url = new URL(profileUrl)
  const sellerIdKeys = ['userId', 'sellerId', 'seller_id', 'userid', 'id']
  const key = sellerIdKeys.find((candidate) => url.searchParams.get(candidate)?.trim() === sellerId)
  url.search = ''
  if (key && sellerId) url.searchParams.set(key, sellerId)
  url.hash = ''
  return url.toString()
}

function canonicalSellerProfileUrl(platform: string, platformSellerId: string): string {
  if (platform === 'goofish') return `https://www.goofish.com/personal?userId=${encodeURIComponent(platformSellerId)}`
  throw new MonitorTaskRequestError('platform 只允许 goofish')
}

function parseSellerMonitorTaskInput(value: unknown, creating: boolean, allowedHosts: readonly string[]): SellerMonitorTaskInput {
  const source = monitorTaskRecord(value, '请求体')
  for (const key of Object.keys(source)) if (!sellerMonitorTaskInputKeys.has(key)) throw new MonitorTaskRequestError(`不支持字段 ${key}`)
  if (creating && source.platformSellerId === undefined && source.profileUrl === undefined) throw new MonitorTaskRequestError('platformSellerId 或 profileUrl 至少填写一个')
  if (creating && source.intervalSeconds === undefined) throw new MonitorTaskRequestError('intervalSeconds 必填')
  if (!creating && (source.platform !== undefined || source.platformSellerId !== undefined)) throw new MonitorTaskRequestError('卖家目标创建后不可修改')

  const platform = source.platform === undefined ? undefined : source.platform
  if (platform !== undefined && platform !== 'goofish') throw new MonitorTaskRequestError('platform 只允许 goofish')
  const explicitSellerId = source.platformSellerId === undefined ? undefined : monitorTaskString(source.platformSellerId, 'platformSellerId', 128)
  if (explicitSellerId !== undefined && !/^[A-Za-z0-9._-]+$/.test(explicitSellerId)) throw new MonitorTaskRequestError('platformSellerId 格式无效')
  const suppliedProfileUrl = source.profileUrl === undefined ? undefined : sellerMonitorTaskProfileUrl(source.profileUrl, allowedHosts)
  const profileSellerId = suppliedProfileUrl ? sellerIdFromProfileUrl(suppliedProfileUrl) : undefined
  if (explicitSellerId && profileSellerId && explicitSellerId !== profileSellerId) throw new MonitorTaskRequestError('platformSellerId 与 profileUrl 不匹配')
  const platformSellerId = explicitSellerId ?? profileSellerId
  if (creating && !platformSellerId) throw new MonitorTaskRequestError('profileUrl 未包含可识别的卖家 ID，请补充 platformSellerId')
  const profileUrl = suppliedProfileUrl
    ? sanitizeSellerProfileUrl(suppliedProfileUrl, profileSellerId)
    : (platformSellerId ? canonicalSellerProfileUrl(platform ?? 'goofish', platformSellerId) : undefined)
  const intervalSeconds = source.intervalSeconds === undefined ? undefined : source.intervalSeconds
  if (intervalSeconds !== undefined && (typeof intervalSeconds !== 'number' || !Number.isInteger(intervalSeconds) || intervalSeconds < 60 || intervalSeconds > 86_400)) throw new MonitorTaskRequestError('intervalSeconds 必须是 60 到 86400 的整数')
  const status = source.status === undefined ? undefined : source.status
  if (status !== undefined && status !== 'active' && status !== 'paused') throw new MonitorTaskRequestError('status 只允许 active 或 paused')

  return {
    ...(platform === undefined ? {} : { platform: 'goofish' as const }),
    ...(platformSellerId === undefined ? {} : { platformSellerId }),
    ...(profileUrl === undefined ? {} : { profileUrl }),
    ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
    ...(status === undefined ? {} : { status: status as SellerMonitorTaskStatus })
  }
}

function publishedItemIdFromUrl(itemUrl: string | URL): string | undefined {
  const url = typeof itemUrl === 'string' ? new URL(itemUrl) : itemUrl
  for (const key of ['id', 'itemId', 'item_id', 'goodsId', 'goods_id']) {
    const candidate = url.searchParams.get(key)?.trim()
    if (candidate && /^[A-Za-z0-9._-]+$/.test(candidate)) return candidate
  }
  return /(?:item|detail)[\/_-]([A-Za-z0-9._-]+)/i.exec(url.pathname)?.[1]
}

function publishedItemUrl(value: unknown, allowedHosts: readonly string[]): string {
  const raw = monitorTaskString(value, 'itemUrl', 2_048)
  let url: URL
  try { url = new URL(raw) } catch { throw new MonitorTaskRequestError('itemUrl 必须是有效公开商品地址') }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  const allowed = allowedHosts.some((pattern) => sellerProfileHostMatches(hostname, pattern))
  const official = hostname === 'goofish.com' || hostname.endsWith('.goofish.com')
  if (!allowed || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (official && (url.protocol !== 'https:' || url.port))) {
    throw new MonitorTaskRequestError('itemUrl 必须是允许的闲鱼公开商品地址')
  }
  const itemId = publishedItemIdFromUrl(url)
  if (!itemId) throw new MonitorTaskRequestError('itemUrl 未包含可识别的闲鱼商品 ID')
  if (official) return `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`
  const sanitized = new URL(url.origin)
  sanitized.pathname = url.pathname || '/item'
  sanitized.searchParams.set('id', itemId)
  return sanitized.toString()
}

function canonicalPublishedItemUrl(platformItemId: string): string {
  return `https://www.goofish.com/item?id=${encodeURIComponent(platformItemId)}`
}

function parsePublishedItemMonitorTaskInput(value: unknown, creating: boolean, allowedHosts: readonly string[]): PublishedItemMonitorTaskInput {
  const source = monitorTaskRecord(value, '请求体')
  for (const key of Object.keys(source)) if (!publishedItemMonitorTaskInputKeys.has(key)) throw new MonitorTaskRequestError(`不支持字段 ${key}`)
  if (creating && source.platformItemId === undefined && source.itemUrl === undefined) throw new MonitorTaskRequestError('platformItemId 或 itemUrl 至少填写一个')
  if (creating && source.intervalSeconds === undefined) throw new MonitorTaskRequestError('intervalSeconds 必填')
  if (!creating && (source.platformItemId !== undefined || source.publishPlanId !== undefined)) throw new MonitorTaskRequestError('发布商品目标创建后不可修改')
  const explicitItemId = source.platformItemId === undefined ? undefined : monitorTaskString(source.platformItemId, 'platformItemId', 128)
  if (explicitItemId !== undefined && !/^[A-Za-z0-9._-]+$/.test(explicitItemId)) throw new MonitorTaskRequestError('platformItemId 格式无效')
  const suppliedUrl = source.itemUrl === undefined ? undefined : publishedItemUrl(source.itemUrl, allowedHosts)
  const urlItemId = suppliedUrl ? publishedItemIdFromUrl(suppliedUrl) : undefined
  if (explicitItemId && urlItemId && explicitItemId !== urlItemId) throw new MonitorTaskRequestError('platformItemId 与 itemUrl 不匹配')
  const platformItemId = explicitItemId ?? urlItemId
  if (creating && !platformItemId) throw new MonitorTaskRequestError('itemUrl 未包含可识别的闲鱼商品 ID，请补充 platformItemId')
  const intervalSeconds = source.intervalSeconds === undefined ? undefined : source.intervalSeconds
  if (intervalSeconds !== undefined && (typeof intervalSeconds !== 'number' || !Number.isInteger(intervalSeconds) || intervalSeconds < 1_800 || intervalSeconds > 86_400)) throw new MonitorTaskRequestError('intervalSeconds 必须是 1800 到 86400 的整数')
  const status = source.status === undefined ? undefined : source.status
  if (status !== undefined && status !== 'active' && status !== 'paused') throw new MonitorTaskRequestError('status 只允许 active 或 paused')
  const publishPlanId = source.publishPlanId === undefined ? undefined : monitorTaskString(source.publishPlanId, 'publishPlanId', 64)
  if (publishPlanId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publishPlanId)) throw new MonitorTaskRequestError('publishPlanId 格式无效')
  return {
    ...(publishPlanId === undefined ? {} : { publishPlanId }),
    ...(platformItemId === undefined ? {} : { platformItemId }),
    ...(platformItemId === undefined ? {} : { itemUrl: suppliedUrl ?? canonicalPublishedItemUrl(platformItemId) }),
    ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
    ...(status === undefined ? {} : { status: status as PublishedItemMonitorTaskStatus })
  }
}

function monitorTaskResponse(row: Record<string, unknown>) {
  const rule = row.rule ?? row.rule_json
  const parsedRule = typeof rule === 'string' ? JSON.parse(rule) : rule
  return {
    id: String(row.id),
    rule: parseMonitorTaskRule(parsedRule),
    ruleVersion: Number(row.ruleVersion ?? row.rule_version),
    status: String(row.status) as MonitorTaskStatus,
    intervalSeconds: Number(row.intervalSeconds ?? row.interval_seconds),
    nextRunAt: timestamp(row.nextRunAt ?? row.next_run_at),
    createdAt: timestamp(row.createdAt ?? row.created_at),
    updatedAt: timestamp(row.updatedAt ?? row.updated_at)
  }
}

function sellerMonitorTaskResponse(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    kind: 'seller' as const,
    sellerId: String(row.sellerId ?? row.seller_id),
    platform: String(row.platform),
    platformSellerId: String(row.platformSellerId ?? row.platform_seller_id),
    profileUrl: String(row.profileUrl ?? row.profile_url),
    ruleVersion: Number(row.ruleVersion ?? row.rule_version),
    status: String(row.status) as SellerMonitorTaskStatus,
    intervalSeconds: Number(row.intervalSeconds ?? row.interval_seconds),
    nextRunAt: timestamp(row.nextRunAt ?? row.next_run_at),
    createdAt: timestamp(row.createdAt ?? row.created_at),
    updatedAt: timestamp(row.updatedAt ?? row.updated_at)
  }
}

function publishedItemMonitorTaskResponse(row: Record<string, unknown>) {
  const publishPlanId = row.publishPlanId ?? row.publish_plan_id
  return {
    id: String(row.id),
    kind: 'published_item' as const,
    publishPlanId: publishPlanId ? String(publishPlanId) : null,
    platform: String(row.platform),
    platformItemId: String(row.platformItemId ?? row.platform_item_id),
    itemUrl: String(row.itemUrl ?? row.item_url),
    ruleVersion: Number(row.ruleVersion ?? row.rule_version ?? 1),
    status: String(row.status) as PublishedItemMonitorTaskStatus,
    intervalSeconds: Number(row.intervalSeconds ?? row.interval_seconds),
    nextRunAt: timestamp(row.nextRunAt ?? row.next_run_at),
    createdAt: timestamp(row.createdAt ?? row.created_at),
    updatedAt: timestamp(row.updatedAt ?? row.updated_at)
  }
}

function installCors(app: FastifyInstance, allowedOrigins: readonly string[]) {
  const origins = new Set(allowedOrigins)
  if (origins.has('*')) throw new Error('CORS 不允许使用通配源')
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    if (!origin) {
      if (request.method === 'OPTIONS') return reply.code(204).send()
      return
    }
    if (!origins.has(origin)) return reply.code(403).send({ error: 'Origin 不在允许列表' })
    reply.header('access-control-allow-origin', origin)
    reply.header('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    reply.header('access-control-allow-headers', 'Authorization, Content-Type')
    reply.header('vary', 'Origin')
    if (request.method === 'OPTIONS') {
      const requestedMethod = request.headers['access-control-request-method']
      if (requestedMethod && !['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'].includes(String(requestedMethod).toUpperCase())) return reply.code(405).send({ error: 'CORS 方法不允许' })
      const requestedHeaders = String(request.headers['access-control-request-headers'] ?? '').split(',').map((header) => header.trim().toLowerCase()).filter(Boolean)
      if (requestedHeaders.some((header) => !['authorization', 'content-type'].includes(header))) return reply.code(400).send({ error: 'CORS 请求头不允许' })
      return reply.code(204).send()
    }
  })
}

function scalarQueryValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) throw new ListRequestError('INVALID_QUERY', `${name} 必须是单值`)
  const normalized = String(value).trim()
  return normalized || undefined
}

function canonicalFilters(filters: ListFilters): string {
  return JSON.stringify(Object.keys(filters).sort().reduce<Record<string, string>>((result, key) => {
    result[key] = filters[key]
    return result
  }, {}))
}

function parseFilterObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { throw new ListRequestError('INVALID_QUERY', 'filters 必须是有效 JSON') }
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new ListRequestError('INVALID_QUERY', 'filters 必须是对象')
  return value as Record<string, unknown>
}

function parseListQuery(raw: unknown, config: ListConfig): ParsedListQuery {
  const query = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const limitValue = scalarQueryValue(query.limit, 'limit')
  const limit = limitValue === undefined ? 50 : Number(limitValue)
  if (!Number.isInteger(limit) || ![20, 50, 100].includes(limit)) throw new ListRequestError('INVALID_QUERY', 'limit 只允许 20、50 或 100')

  const sortValue = scalarQueryValue(query.sort, 'sort') ?? config.defaultSort
  const sort = config.sortAliases[sortValue]
  if (!sort) throw new ListRequestError('INVALID_QUERY', `不支持排序字段 ${sortValue}`)
  const orderValue = (scalarQueryValue(query.order, 'order') ?? 'desc').toLowerCase()
  if (orderValue !== 'asc' && orderValue !== 'desc') throw new ListRequestError('INVALID_QUERY', 'order 只允许 asc 或 desc')

  const filters: ListFilters = {}
  const assignFilter = (rawName: string, rawValue: unknown) => {
    const name = config.filterAliases[rawName] ?? rawName
    if (!config.allowedFilters.includes(name)) throw new ListRequestError('INVALID_QUERY', `不支持筛选字段 ${rawName}`)
    const value = scalarQueryValue(rawValue, name)
    if (value === undefined) return
    const normalized = ['q', 'status', 'state', 'platform', 'role'].includes(name) ? value.toLowerCase() : value
    if (filters[name] !== undefined && filters[name] !== normalized) throw new ListRequestError('INVALID_QUERY', `筛选字段 ${name} 重复`)
    filters[name] = normalized
  }

  for (const [name, value] of Object.entries(parseFilterObject(query.filters))) assignFilter(name, value)
  for (const [name, value] of Object.entries(query)) {
    if (['limit', 'cursor', 'sort', 'order', 'filters'].includes(name)) continue
    const bracket = /^filters\[([^\]]+)\]$/.exec(name)
    assignFilter(bracket ? bracket[1] : name, value)
  }

  return {
    limit,
    cursor: scalarQueryValue(query.cursor, 'cursor'),
    sort,
    order: orderValue,
    filters,
    filterHash: createHash('sha256').update(canonicalFilters(filters)).digest('hex')
  }
}

function encodeOpaque(value: unknown, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function decodeOpaque<T>(value: string, secret: string): T {
  const parts = value.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ListRequestError('CURSOR_EXPIRED', '游标无效或已过期')
  const expected = createHmac('sha256', secret).update(parts[0]).digest()
  const actual = Buffer.from(parts[1], 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ListRequestError('CURSOR_EXPIRED', '游标无效或已过期')
  try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as T } catch { throw new ListRequestError('CURSOR_EXPIRED', '游标无效或已过期') }
}

function timestamp(value: unknown): string {
  const result = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(result.getTime())) throw new Error('数据库返回了无效时间')
  return result.toISOString()
}

async function prepareList(sql: Sql, rawQuery: unknown, config: ListConfig, secret: string): Promise<ListContext> {
  const parsed = parseListQuery(rawQuery, config)
  if (!parsed.cursor) {
    const result = await sql.query('SELECT clock_timestamp() AS snapshot')
    const snapshotAt = timestamp(result.rows[0]?.snapshot)
    return { ...parsed, snapshot: encodeOpaque({ v: 1, resource: config.resource, at: snapshotAt } satisfies SnapshotPayload, secret), snapshotAt }
  }

  const cursor = decodeOpaque<CursorPayload>(parsed.cursor, secret)
  if (!cursor || typeof cursor !== 'object' || cursor.v !== 1 || cursor.resource !== config.resource || cursor.filterHash !== parsed.filterHash || cursor.sort !== parsed.sort || cursor.order !== parsed.order || typeof cursor.snapshot !== 'string' || !Array.isArray(cursor.key) || cursor.key.length !== 2 || cursor.key.some((value) => typeof value !== 'string')) {
    throw new ListRequestError('CURSOR_EXPIRED', '游标与当前资源、筛选或排序不匹配')
  }
  const snapshot = decodeOpaque<SnapshotPayload>(cursor.snapshot, secret)
  if (snapshot.v !== 1 || snapshot.resource !== config.resource || !snapshot.at) throw new ListRequestError('CURSOR_EXPIRED', '读快照无效或已过期')
  return { ...parsed, snapshot: cursor.snapshot, snapshotAt: timestamp(snapshot.at), cursorKey: [String(cursor.key[0]), String(cursor.key[1])] }
}

function keyset(values: unknown[], expression: string, idExpression: string, order: ListOrder, key: [string, string]): string {
  const operator = order === 'desc' ? '<' : '>'
  values.push(key[0]); const sortParameter = `$${values.length}`
  values.push(key[1]); const idParameter = `$${values.length}`
  return `(${expression} ${operator} ${sortParameter} OR (${expression} = ${sortParameter} AND ${idExpression} ${operator} ${idParameter}))`
}

function cursorSortValue(sort: string, value: unknown): string {
  return ['last_seen_at', 'first_seen_at', 'created_at', 'updated_at', 'observed_at', 'occurred_at', 'started_at', 'received_at', 'collected_at', 'queued_at', 'next_run_at', 'scheduled_at', 'finished_at'].includes(sort) ? timestamp(value) : String(value)
}

function listResponse(context: ListContext, rows: Array<Record<string, unknown>>, total: number, secret: string, resource: string) {
  const hasMore = rows.length > context.limit
  const visibleRows = rows.slice(0, context.limit)
  const last = visibleRows[visibleRows.length - 1]
  const nextCursor = hasMore && last ? encodeOpaque({ v: 1, resource, filterHash: context.filterHash, sort: context.sort, order: context.order, snapshot: context.snapshot, key: [cursorSortValue(context.sort, last.cursor_sort_value), String(last.cursor_id)] } satisfies CursorPayload, secret) : null
  const items = visibleRows.map((row) => {
    const { cursor_sort_value: _sortValue, cursor_id: _id, ...item } = row
    return item
  })
  return { items, page: { limit: context.limit, nextCursor, hasMore, total, snapshot: context.snapshot } }
}

async function executeList(sql: Sql, context: ListContext, secret: string, plan: ListPlan, subjectId: string) {
  const pageSpec = plan.page(context, subjectId)
  const countSpec = plan.count(context, subjectId)
  const page = await sql.query(pageSpec.text, pageSpec.values)
  const count = await sql.query(countSpec.text, countSpec.values)
  const total = Number(count.rows[0]?.total ?? 0)
  return listResponse(context, page.rows, total, secret, plan.resource)
}

function registerListEndpoint(app: FastifyInstance, paths: readonly string[], sql: Sql, domain: TokenDomain, kind: SubjectKind, config: ListConfig, buildPlan: ListPlanBuilder, deniedCode: number, deniedMessage: string) {
  const handler = async (request: any, reply: any) => {
    let claims
    try { claims = await authenticate(sql, domain, kind, request.headers.authorization) } catch { return fail(reply, deniedCode, deniedMessage) }
    try {
      const context = await prepareList(sql, request.query, config, domain.secret)
      return await executeList(sql, context, domain.secret, buildPlan(context, claims.sub), claims.sub)
    } catch (error) {
      if (error instanceof ListRequestError) return listFail(reply, error)
      throw error
    }
  }
  for (const path of paths) app.get(path, handler)
}

const marketItemsListConfig: ListConfig = {
  resource: 'user.market_items',
  defaultSort: 'last_seen_at',
  sortAliases: {
    last_seen_at: 'last_seen_at', updated_at: 'last_seen_at', updated_at_desc: 'last_seen_at', priority_desc: 'last_seen_at', recent: 'last_seen_at',
    first_seen_at: 'first_seen_at', platform_item_id: 'platform_item_id', name: 'platform_item_id', title: 'platform_item_id', title_asc: 'platform_item_id', id: 'id'
  },
  filterAliases: { search: 'q', lifecycle_state: 'state', lifecycleState: 'state', sellerId: 'seller_id', categoryId: 'category_id' },
  allowedFilters: ['q', 'state', 'platform', 'seller_id', 'category_id']
}

const marketItemsAdminListConfig: ListConfig = { ...marketItemsListConfig, resource: 'admin.market_items' }

const adminUsersListConfig: ListConfig = {
  resource: 'admin.users',
  defaultSort: 'created_at',
  sortAliases: { created_at: 'created_at', updated_at: 'created_at', updated_at_desc: 'created_at', recent: 'created_at', email: 'email', name: 'email', title: 'email', title_asc: 'email', priority_desc: 'status', id: 'id' },
  filterAliases: { search: 'q' },
  allowedFilters: ['q', 'status']
}

const userSellersListConfig: ListConfig = {
  resource: 'user.sellers',
  defaultSort: 'last_seen_at',
  sortAliases: { last_seen_at: 'last_seen_at', updated_at: 'last_seen_at', updated_at_desc: 'last_seen_at', priority_desc: 'last_seen_at', recent: 'last_seen_at', first_seen_at: 'first_seen_at', name: 'public_name', title_asc: 'public_name', platform_seller_id: 'platform_seller_id', id: 'id' },
  filterAliases: { search: 'q', sellerId: 'platform_seller_id' },
  allowedFilters: ['q', 'platform', 'region', 'platform_seller_id']
}

const userDiscoveriesListConfig: ListConfig = {
  resource: 'user.discoveries',
  defaultSort: 'created_at',
  sortAliases: { created_at: 'created_at', updated_at: 'created_at', updated_at_desc: 'created_at', recent: 'created_at', confidence: 'confidence', priority_desc: 'confidence', type: 'insight_type', title_asc: 'insight_type', id: 'id' },
  filterAliases: { search: 'q', type: 'insight_type' },
  allowedFilters: ['q', 'insight_type', 'entity_reference']
}

const userEventsListConfig: ListConfig = {
  resource: 'user.events',
  defaultSort: 'occurred_at',
  sortAliases: { occurred_at: 'occurred_at', updated_at: 'occurred_at', updated_at_desc: 'occurred_at', priority_desc: 'occurred_at', recent: 'occurred_at', type: 'event_type', title_asc: 'event_type', id: 'id' },
  filterAliases: { eventType: 'event_type', itemId: 'item_id', sellerId: 'seller_id' },
  allowedFilters: ['event_type', 'item_id', 'seller_id']
}

const userLogsListConfig: ListConfig = {
  resource: 'user.logs',
  defaultSort: 'occurred_at',
  sortAliases: { occurred_at: 'occurred_at', updated_at: 'occurred_at', updated_at_desc: 'occurred_at', priority_desc: 'occurred_at', recent: 'occurred_at', title_asc: 'event_type', id: 'id' },
  filterAliases: { eventType: 'event_type', taskReference: 'task_reference' },
  allowedFilters: ['q', 'level', 'event_type', 'task_reference']
}

const userMonitorsListConfig: ListConfig = {
  resource: 'user.monitors',
  defaultSort: 'updated_at',
  sortAliases: { created_at: 'created_at', updated_at: 'updated_at', updated_at_desc: 'updated_at', recent: 'updated_at', priority_desc: 'next_run_at', title_asc: 'keyword', next_run_at: 'next_run_at', id: 'id' },
  filterAliases: { search: 'q' },
  allowedFilters: ['q', 'status']
}

const userSellerMonitorsListConfig: ListConfig = {
  resource: 'user.seller_monitors',
  defaultSort: 'updated_at',
  sortAliases: { created_at: 'created_at', updated_at: 'updated_at', updated_at_desc: 'updated_at', recent: 'updated_at', priority_desc: 'next_run_at', next_run_at: 'next_run_at', platform_seller_id: 'platform_seller_id', title_asc: 'platform_seller_id', id: 'id' },
  filterAliases: { search: 'q', sellerId: 'platform_seller_id' },
  allowedFilters: ['q', 'status', 'platform', 'platform_seller_id']
}

const userPublishedItemMonitorsListConfig: ListConfig = {
  resource: 'user.published_item_monitors',
  defaultSort: 'updated_at',
  sortAliases: { created_at: 'created_at', updated_at: 'updated_at', updated_at_desc: 'updated_at', recent: 'updated_at', next_run_at: 'next_run_at', platform_item_id: 'platform_item_id', title_asc: 'platform_item_id', id: 'id' },
  filterAliases: { search: 'q', itemId: 'platform_item_id', publishPlanId: 'publish_plan_id' },
  allowedFilters: ['q', 'status', 'platform_item_id', 'publish_plan_id']
}

const userSupplyMaterialsListConfig: ListConfig = {
  resource: 'user.supply_materials',
  defaultSort: 'updated_at',
  sortAliases: { created_at: 'created_at', updated_at: 'updated_at', updated_at_desc: 'updated_at', recent: 'updated_at', title: 'title', title_asc: 'title', price: 'price', id: 'id' },
  filterAliases: { search: 'q', sourceType: 'source_type', sourcePlatform: 'source_platform' },
  allowedFilters: ['q', 'source_type', 'source_platform', 'status']
}

const userSupplyPublishPlansListConfig: ListConfig = {
  resource: 'user.supply_publish_plans',
  defaultSort: 'created_at',
  sortAliases: { created_at: 'created_at', updated_at: 'updated_at', updated_at_desc: 'updated_at', scheduled_at: 'scheduled_at', status: 'status', title: 'title', id: 'id' },
  filterAliases: { search: 'q', materialId: 'material_id', scheduleMode: 'schedule_mode' },
  allowedFilters: ['q', 'material_id', 'schedule_mode', 'status']
}

const userAnnouncementsListConfig: ListConfig = {
  resource: 'user.announcements',
  defaultSort: 'starts_at',
  sortAliases: { starts_at: 'starts_at', updated_at: 'updated_at', recent: 'starts_at', id: 'id' },
  filterAliases: {},
  allowedFilters: []
}

const sellerItemsListConfig: ListConfig = { ...marketItemsListConfig, resource: 'user.seller_items' }

const sellerEventsListConfig: ListConfig = {
  resource: 'user.seller_events',
  defaultSort: 'occurred_at',
  sortAliases: { occurred_at: 'occurred_at', updated_at: 'occurred_at', updated_at_desc: 'occurred_at', recent: 'occurred_at', type: 'event_type', title_asc: 'event_type', id: 'id' },
  filterAliases: { eventType: 'event_type', itemId: 'item_id', sellerId: 'seller_id' },
  allowedFilters: ['event_type', 'item_id', 'seller_id']
}

const adminBillingListConfig: ListConfig = {
  resource: 'admin.billing_orders',
  defaultSort: 'created_at',
  sortAliases: { created_at: 'created_at', updated_at: 'created_at', updated_at_desc: 'created_at', recent: 'created_at', amount: 'amount', status: 'status', title: 'provider_order_id', title_asc: 'provider_order_id', id: 'id' },
  filterAliases: { providerOrderId: 'q', userId: 'user_id' },
  allowedFilters: ['q', 'status', 'provider', 'user_id']
}

const adminQualityListConfig: ListConfig = {
  resource: 'admin.quality_categories',
  defaultSort: 'observed_at',
  sortAliases: { observed_at: 'observed_at', updated_at: 'observed_at', updated_at_desc: 'observed_at', recent: 'observed_at', name: 'name', title: 'name', title_asc: 'name', status: 'name', id: 'id' },
  filterAliases: { category: 'q' },
  allowedFilters: ['q', 'platform', 'active']
}

const adminUploadsListConfig: ListConfig = {
  resource: 'admin.uploads',
  defaultSort: 'received_at',
  sortAliases: { received_at: 'received_at', updated_at: 'received_at', updated_at_desc: 'received_at', recent: 'received_at', status: 'status', title: 'idempotency_key', title_asc: 'idempotency_key', id: 'id' },
  filterAliases: { clientId: 'client_id', userId: 'user_id', deviceId: 'device_id', batchId: 'batch_id', itemId: 'item_id', sellerId: 'seller_id', eventKey: 'event_key', qualityStatus: 'quality_status', failureReason: 'failure_reason', from: 'from', to: 'to' },
  allowedFilters: ['q', 'status', 'client_id', 'user_id', 'device_id', 'batch_id', 'item_id', 'seller_id', 'event_key', 'quality_status', 'failure_reason', 'from', 'to']
}

const adminAiJobsListConfig: ListConfig = {
  resource: 'admin.ai_jobs',
  defaultSort: 'created_at',
  sortAliases: { created_at: 'created_at', updated_at: 'created_at', updated_at_desc: 'created_at', recent: 'created_at', status: 'status', title: 'billing_reference', title_asc: 'billing_reference', id: 'id' },
  filterAliases: { userId: 'requesting_user_id', capabilityId: 'capability_id', failureReason: 'failure_reason', from: 'from', to: 'to' },
  allowedFilters: ['q', 'status', 'requesting_user_id', 'capability_id', 'failure_reason', 'from', 'to']
}

const adminAnnouncementsListConfig: ListConfig = {
  resource: 'admin.announcements',
  defaultSort: 'updated_at',
  sortAliases: { updated_at: 'updated_at', created_at: 'created_at', recent: 'updated_at', status: 'enabled', title: 'title', id: 'id' },
  filterAliases: { userId: 'user_id' },
  allowedFilters: ['q', 'enabled', 'scope', 'user_id']
}

const adminProvidersListConfig: ListConfig = {
  resource: 'admin.ai_providers',
  defaultSort: 'updated_at',
  sortAliases: { created_at: 'created_at', updated_at: 'updated_at', recent: 'updated_at', status: 'status', provider_code: 'provider_code', id: 'id' },
  filterAliases: { providerCode: 'provider_code' },
  allowedFilters: ['status', 'provider_code']
}

const adminCapacityListConfig: ListConfig = {
  resource: 'admin.capacity',
  defaultSort: 'id',
  sortAliases: { id: 'id', name: 'id', title: 'id', title_asc: 'id', updated_at: 'id', updated_at_desc: 'id', status: 'id' },
  filterAliases: { search: 'q' },
  allowedFilters: ['q']
}

const adminAuditListConfig: ListConfig = {
  resource: 'admin.audit',
  defaultSort: 'occurred_at',
  sortAliases: { occurred_at: 'occurred_at', updated_at: 'occurred_at', updated_at_desc: 'occurred_at', recent: 'occurred_at', action: 'action', title: 'action', title_asc: 'action', status: 'action', id: 'id' },
  filterAliases: { actorType: 'actor_type', targetType: 'target_type' },
  allowedFilters: ['q', 'actor_type', 'action', 'target_type']
}

type TablePlanDefinition = {
  resource: string
  from: string
  select: string
  idExpression: string
  sortExpressions: Record<string, string>
  conditions: (context: ListContext, values: unknown[], subjectId: string) => string[]
}

function tablePlan(definition: TablePlanDefinition): ListPlanBuilder {
  return (context, subjectId) => {
    const sortExpression = definition.sortExpressions[context.sort]
    const build = (includeCursor: boolean): ListQuerySpec & { where: string } => {
      const values: unknown[] = [context.snapshotAt]
      const conditions = definition.conditions(context, values, subjectId)
      if (includeCursor && context.cursorKey) conditions.push(keyset(values, sortExpression, definition.idExpression, context.order, context.cursorKey))
      return { text: '', values, where: conditions.join(' AND ') }
    }
    return {
      resource: definition.resource,
      page: () => {
        const query = build(true)
        return { text: `SELECT ${definition.select}, ${sortExpression} AS cursor_sort_value, ${definition.idExpression} AS cursor_id FROM ${definition.from} WHERE ${query.where} ORDER BY ${sortExpression} ${context.order.toUpperCase()}, ${definition.idExpression} ${context.order.toUpperCase()} LIMIT ${context.limit + 1}`, values: query.values }
      },
      count: () => {
        const query = build(false)
        return { text: `SELECT COUNT(*)::int AS total FROM ${definition.from} WHERE ${query.where}`, values: query.values }
      }
    }
  }
}

const userSellersPlan = tablePlan({
  resource: userSellersListConfig.resource,
  from: 'market.seller_profiles s',
  select: 's.id, s.platform, s.platform_seller_id AS "platformSellerId", s.public_name AS "publicName", s.region, s.first_seen_at AS "firstSeenAt", s.last_seen_at AS "lastSeenAt"',
  idExpression: 's.id::text',
  sortExpressions: { last_seen_at: 's.last_seen_at', first_seen_at: 's.first_seen_at', public_name: "COALESCE(s.public_name, '')", platform_seller_id: 's.platform_seller_id', id: 's.id::text' },
  conditions: (context, values, subjectId) => {
    values.push(subjectId)
    const conditions = [
      's.first_seen_at <= $1',
      'EXISTS (SELECT 1 FROM market.items i JOIN market.observations o ON o.item_id = i.id JOIN ops.collection_runs r ON r.id = o.collection_run_id JOIN identity.collector_clients c ON c.id = r.client_id WHERE i.seller_id = s.id AND c.user_id = $2)'
    ]
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(COALESCE(s.public_name, '')) LIKE LOWER($${values.length}) OR LOWER(s.platform_seller_id) LIKE LOWER($${values.length}))`) }
    if (context.filters.platform) { values.push(context.filters.platform); conditions.push(`s.platform = $${values.length}`) }
    if (context.filters.region) { values.push(context.filters.region); conditions.push(`LOWER(COALESCE(s.region, '')) = LOWER($${values.length})`) }
    if (context.filters.platform_seller_id) { values.push(context.filters.platform_seller_id); conditions.push(`s.platform_seller_id = $${values.length}`) }
    return conditions
  }
})

function userInsightPlan(resource: string): ListPlanBuilder {
  return tablePlan({
    resource,
    from: 'ai.insights i JOIN ai.jobs j ON j.id = i.ai_job_id',
    select: 'i.id, i.ai_job_id AS "aiJobId", i.insight_type AS "insightType", i.entity_reference AS "entityReference", i.result, i.confidence, i.created_at AS "createdAt"',
    idExpression: 'i.id::text',
    sortExpressions: { created_at: 'i.created_at', confidence: 'COALESCE(i.confidence, -1)', insight_type: 'i.insight_type', id: 'i.id::text' },
    conditions: (context, values, subjectId) => {
      values.push(subjectId)
      const conditions = ['i.created_at <= $1', 'j.requesting_user_id = $2']
      if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(COALESCE(i.entity_reference, '')) LIKE LOWER($${values.length}) OR LOWER(i.insight_type) LIKE LOWER($${values.length}))`) }
      if (context.filters.insight_type) { values.push(context.filters.insight_type); conditions.push(`i.insight_type = $${values.length}`) }
      if (context.filters.entity_reference) { values.push(context.filters.entity_reference); conditions.push(`i.entity_reference = $${values.length}`) }
      return conditions
    }
  })
}

const userEventsPlan = tablePlan({
  resource: userEventsListConfig.resource,
  from: 'market.item_events e',
  select: 'e.id, e.item_id AS "itemId", e.seller_id AS "sellerId", e.event_type AS "eventType", e.before_version_id AS "beforeVersionId", e.after_version_id AS "afterVersionId", e.event_key AS "eventKey", e.occurred_at AS "occurredAt", e.detected_at AS "detectedAt"',
  idExpression: 'e.id::text',
  sortExpressions: { occurred_at: 'e.occurred_at', event_type: 'e.event_type', id: 'e.id::text' },
  conditions: (context, values, subjectId) => {
    values.push(subjectId)
    const conditions = [
      'e.occurred_at <= $1',
      `EXISTS (SELECT 1 FROM market.observations o JOIN ops.collection_runs r ON r.id = o.collection_run_id JOIN identity.collector_clients c ON c.id = r.client_id WHERE o.item_id = e.item_id AND c.user_id = $2)`
    ]
    if (context.filters.event_type) { values.push(context.filters.event_type); conditions.push(`e.event_type = $${values.length}`) }
    if (context.filters.item_id) { values.push(context.filters.item_id); conditions.push(`e.item_id = $${values.length}`) }
    if (context.filters.seller_id) { values.push(context.filters.seller_id); conditions.push(`e.seller_id = $${values.length}`) }
    return conditions
  }
})

const userLogsPlan = tablePlan({
  resource: userLogsListConfig.resource,
  from: 'ops.dynamic_logs l',
  select: 'l.id, l.actor_type AS "actorType", l.actor_id AS "actorId", l.client_id AS "clientId", l.task_reference AS "taskReference", l.item_id AS "itemId", l.seller_id AS "sellerId", l.level, l.event_type AS "eventType", l.safe_message AS "safeMessage", l.occurred_at AS "occurredAt"',
  idExpression: 'l.id::text',
  sortExpressions: { occurred_at: 'l.occurred_at', event_type: 'l.event_type', id: 'l.id::text' },
  conditions: (context, values, subjectId) => {
    values.push(subjectId)
    const conditions = [
      'l.occurred_at <= $1',
      `((l.actor_type = 'user' AND l.actor_id = $2) OR l.client_id IN (SELECT id FROM identity.collector_clients WHERE user_id = $2))`
    ]
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(l.safe_message) LIKE LOWER($${values.length}) OR LOWER(l.event_type) LIKE LOWER($${values.length}) OR LOWER(COALESCE(l.task_reference, '')) LIKE LOWER($${values.length}))`) }
    if (context.filters.level) { values.push(context.filters.level); conditions.push(`l.level = $${values.length}`) }
    if (context.filters.event_type) { values.push(context.filters.event_type); conditions.push(`l.event_type = $${values.length}`) }
    if (context.filters.task_reference) { values.push(context.filters.task_reference); conditions.push(`l.task_reference = $${values.length}`) }
    return conditions
  }
})

const userMonitorsPlan = tablePlan({
  resource: userMonitorsListConfig.resource,
  from: 'ops.monitor_tasks t',
  select: 't.id, t.rule_json AS rule, t.rule_version AS "ruleVersion", t.status, t.interval_seconds AS "intervalSeconds", t.next_run_at AS "nextRunAt", t.created_at AS "createdAt", t.updated_at AS "updatedAt"',
  idExpression: 't.id::text',
  sortExpressions: { created_at: 't.created_at', updated_at: 't.updated_at', next_run_at: 't.next_run_at', keyword: "COALESCE(t.rule_json->>'keyword', '')", id: 't.id::text' },
  conditions: (context, values, subjectId) => {
    values.push(subjectId)
    const conditions = ['t.created_at <= $1', 't.user_id = $2']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`LOWER(t.rule_json::text) LIKE LOWER($${values.length})`) }
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`t.status = $${values.length}`) }
    return conditions
  }
})

const userSupplyMaterialsPlan = tablePlan({
  resource: userSupplyMaterialsListConfig.resource,
  from: 'supply.materials m',
  select: 'm.id, m.source_type AS "sourceType", m.source_platform AS "sourcePlatform", m.source_item_id AS "sourceItemId", m.source_url AS "sourceUrl", m.title, m.description, m.price::float8 AS price, m.main_images AS "mainImages", m.detail_images AS "detailImages", m.sku, m.attributes, m.current_version AS "currentVersion", m.status, m.import_batch_id AS "importBatchId", m.created_at AS "createdAt", m.updated_at AS "updatedAt"',
  idExpression: 'm.id::text',
  sortExpressions: { created_at: 'm.created_at', updated_at: 'm.updated_at', title: 'm.title', price: 'm.price', id: 'm.id::text' },
  conditions: (context, values, subjectId) => {
    values.push(subjectId)
    const conditions = ['m.created_at <= $1', 'm.user_id = $2']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(m.title) LIKE LOWER($${values.length}) OR LOWER(m.source_item_id) LIKE LOWER($${values.length}))`) }
    if (context.filters.source_type) { values.push(context.filters.source_type); conditions.push(`m.source_type = $${values.length}`) }
    if (context.filters.source_platform) { values.push(context.filters.source_platform); conditions.push(`m.source_platform = $${values.length}`) }
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`m.status = $${values.length}`) }
    return conditions
  }
})

const userSupplyPublishPlansPlan = tablePlan({
  resource: userSupplyPublishPlansListConfig.resource,
  from: 'supply.publish_plans p JOIN supply.materials m ON m.id = p.material_id',
  select: 'p.id, p.material_id AS "materialId", p.material_version_id AS "materialVersionId", p.material_version AS "materialVersion", p.material_snapshot AS "materialSnapshot", p.idempotency_key AS "idempotencyKey", p.schedule_mode AS "scheduleMode", p.scheduled_at AS "scheduledAt", p.window_start AS "windowStart", p.window_end AS "windowEnd", p.status, m.title AS "materialTitle", m.source_platform AS "sourcePlatform", p.created_at AS "createdAt", p.updated_at AS "updatedAt"',
  idExpression: 'p.id::text',
  sortExpressions: { created_at: 'p.created_at', updated_at: 'p.updated_at', scheduled_at: 'p.scheduled_at', status: 'p.status', title: 'm.title', id: 'p.id::text' },
  conditions: (context, values, subjectId) => {
    values.push(subjectId)
    const conditions = ['p.created_at <= $1', 'p.user_id = $2']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(m.title) LIKE LOWER($${values.length}) OR LOWER(p.idempotency_key) LIKE LOWER($${values.length}))`) }
    if (context.filters.material_id) { values.push(context.filters.material_id); conditions.push(`p.material_id = $${values.length}`) }
    if (context.filters.schedule_mode) { values.push(context.filters.schedule_mode); conditions.push(`p.schedule_mode = $${values.length}`) }
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`p.status = $${values.length}`) }
    return conditions
  }
})

const userSellerMonitorsPlan = tablePlan({
  resource: userSellerMonitorsListConfig.resource,
  from: 'ops.seller_monitor_tasks t JOIN market.seller_profiles s ON s.id = t.seller_id',
  select: 't.id, t.seller_id AS "sellerId", s.platform, s.platform_seller_id AS "platformSellerId", s.public_name AS "publicName", s.region, t.profile_url AS "profileUrl", t.rule_version AS "ruleVersion", t.status, t.interval_seconds AS "intervalSeconds", t.next_run_at AS "nextRunAt", t.created_at AS "createdAt", t.updated_at AS "updatedAt"',
  idExpression: 't.id::text',
  sortExpressions: { created_at: 't.created_at', updated_at: 't.updated_at', next_run_at: 't.next_run_at', platform_seller_id: 's.platform_seller_id', id: 't.id::text' },
  conditions: (context, values, subjectId) => {
    values.push(subjectId)
    const conditions = ['t.created_at <= $1', 't.user_id = $2']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(s.platform_seller_id) LIKE LOWER($${values.length}) OR LOWER(COALESCE(s.public_name, '')) LIKE LOWER($${values.length}))`) }
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`t.status = $${values.length}`) }
    if (context.filters.platform) { values.push(context.filters.platform); conditions.push(`s.platform = $${values.length}`) }
    if (context.filters.platform_seller_id) { values.push(context.filters.platform_seller_id); conditions.push(`s.platform_seller_id = $${values.length}`) }
    return conditions
  }
})

const userPublishedItemMonitorsPlan = tablePlan({
  resource: userPublishedItemMonitorsListConfig.resource,
  from: 'ops.published_item_monitor_tasks t',
  select: 't.id, t.publish_plan_id AS "publishPlanId", t.platform, t.platform_item_id AS "platformItemId", t.item_url AS "itemUrl", t.rule_version AS "ruleVersion", t.status, t.interval_seconds AS "intervalSeconds", t.next_run_at AS "nextRunAt", t.created_at AS "createdAt", t.updated_at AS "updatedAt"',
  idExpression: 't.id::text',
  sortExpressions: { created_at: 't.created_at', updated_at: 't.updated_at', next_run_at: 't.next_run_at', platform_item_id: 't.platform_item_id', id: 't.id::text' },
  conditions: (context, values, subjectId) => {
    values.push(subjectId)
    const conditions = ['t.created_at <= $1', 't.user_id = $2']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`LOWER(t.platform_item_id) LIKE LOWER($${values.length})`) }
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`t.status = $${values.length}`) }
    if (context.filters.platform_item_id) { values.push(context.filters.platform_item_id); conditions.push(`t.platform_item_id = $${values.length}`) }
    if (context.filters.publish_plan_id) { values.push(context.filters.publish_plan_id); conditions.push(`t.publish_plan_id = $${values.length}`) }
    return conditions
  }
})

const userAnnouncementsPlan = tablePlan({
  resource: userAnnouncementsListConfig.resource,
  from: 'ops.announcements a',
  select: 'a.id,a.title,a.body,a.starts_at AS "startsAt",a.ends_at AS "endsAt",a.updated_at AS "updatedAt"',
  idExpression: 'a.id::text',
  sortExpressions: { starts_at: 'a.starts_at', updated_at: 'a.updated_at', id: 'a.id::text' },
  conditions: (_context, values, subjectId) => {
    values.push(subjectId)
    return ['a.starts_at <= $1', '(a.ends_at IS NULL OR a.ends_at > $1)', 'a.enabled=true', "(a.scope='global' OR a.user_id=$2)"]
  }
})

const sellerEventsPlan = tablePlan({
  resource: sellerEventsListConfig.resource,
  from: 'market.item_events e',
  select: 'e.id, e.item_id AS "itemId", e.seller_id AS "sellerId", e.event_type AS "eventType", e.before_version_id AS "beforeVersionId", e.after_version_id AS "afterVersionId", e.event_key AS "eventKey", e.occurred_at AS "occurredAt", e.detected_at AS "detectedAt"',
  idExpression: 'e.id::text',
  sortExpressions: { occurred_at: 'e.occurred_at', event_type: 'e.event_type', id: 'e.id::text' },
  conditions: (context, values, subjectId) => {
    values.push(subjectId)
    const conditions = [
      'e.occurred_at <= $1',
      `EXISTS (SELECT 1 FROM market.observations o JOIN ops.collection_runs r ON r.id = o.collection_run_id JOIN identity.collector_clients c ON c.id = r.client_id WHERE o.item_id = e.item_id AND c.user_id = $2)`
    ]
    if (context.filters.event_type) { values.push(context.filters.event_type); conditions.push(`e.event_type = $${values.length}`) }
    if (context.filters.item_id) { values.push(context.filters.item_id); conditions.push(`e.item_id = $${values.length}`) }
    if (context.filters.seller_id) { values.push(context.filters.seller_id); conditions.push(`e.seller_id = $${values.length}`) }
    return conditions
  }
})

const adminBillingPlan = tablePlan({
  resource: adminBillingListConfig.resource,
  from: 'billing.orders o',
  select: 'o.id, o.user_id AS "userId", o.provider, o.provider_order_id AS "providerOrderId", o.amount, o.currency, o.status, o.paid_at AS "paidAt", o.created_at AS "createdAt"',
  idExpression: 'o.id::text',
  sortExpressions: { created_at: 'o.created_at', amount: 'o.amount', status: 'o.status', provider_order_id: 'o.provider_order_id', id: 'o.id::text' },
  conditions: (context, values) => {
    const conditions = ['o.created_at <= $1']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`LOWER(o.provider_order_id) LIKE LOWER($${values.length})`) }
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`o.status = $${values.length}`) }
    if (context.filters.provider) { values.push(context.filters.provider); conditions.push(`o.provider = $${values.length}`) }
    if (context.filters.user_id) { values.push(context.filters.user_id); conditions.push(`o.user_id = $${values.length}`) }
    return conditions
  }
})

const adminQualityPlan = tablePlan({
  resource: adminQualityListConfig.resource,
  from: 'market.category_taxonomy c',
  select: 'c.id, c.platform, c.platform_category_id AS "platformCategoryId", c.parent_id AS "parentId", c.name, c.path, c.depth, c.active, c.observed_at AS "observedAt"',
  idExpression: 'c.id::text',
  sortExpressions: { observed_at: 'c.observed_at', name: 'c.name', id: 'c.id::text' },
  conditions: (context, values) => {
    const conditions = ['c.observed_at <= $1']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(c.name) LIKE LOWER($${values.length}) OR LOWER(c.path) LIKE LOWER($${values.length}) OR LOWER(c.platform_category_id) LIKE LOWER($${values.length}))`) }
    if (context.filters.platform) { values.push(context.filters.platform); conditions.push(`c.platform = $${values.length}`) }
    if (context.filters.active) { values.push(context.filters.active); conditions.push(`c.active = $${values.length}::boolean`) }
    return conditions
  }
})

const adminUploadsPlan = tablePlan({
  resource: adminUploadsListConfig.resource,
  select: 'b.id, b.client_id AS "clientId", c.user_id AS "userId", u.email_normalized AS "userAccount", b.idempotency_key AS "idempotencyKey", b.schema_version AS "schemaVersion", b.batch_sequence AS "batchSequence", b.cursor_start AS "cursorStart", b.cursor_end AS "cursorEnd", b.status, b.accepted_count AS "acceptedCount", b.rejected_count AS "rejectedCount", b.received_count AS "receivedCount", b.deduplicated_count AS "deduplicatedCount", b.inserted_count AS "insertedCount", b.failed_count AS "failedCount", b.retry_count AS "retryCount", b.quality_status AS "qualityStatus", b.quality_result AS "qualityResult", b.last_error AS "lastError", b.received_at AS "receivedAt", b.completed_at AS "completedAt"',
  from: 'ops.ingest_batches b JOIN identity.collector_clients c ON c.id = b.client_id JOIN identity.users u ON u.id = c.user_id',
  idExpression: 'b.id::text',
  sortExpressions: { received_at: 'b.received_at', status: 'b.status', idempotency_key: 'b.idempotency_key', batch_sequence: 'b.batch_sequence', quality_status: 'b.quality_status', id: 'b.id::text' },
  conditions: (context, values) => {
    const conditions = ['b.received_at <= $1']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`LOWER(b.idempotency_key) LIKE LOWER($${values.length})`) }
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`b.status = $${values.length}`) }
    if (context.filters.client_id) { values.push(context.filters.client_id); conditions.push(`b.client_id = $${values.length}`) }
    if (context.filters.user_id) { values.push(context.filters.user_id); conditions.push(`c.user_id = $${values.length}`) }
    if (context.filters.device_id) { values.push(context.filters.device_id); conditions.push(`b.client_id = $${values.length}`) }
    if (context.filters.batch_id) { values.push(context.filters.batch_id); conditions.push(`b.id = $${values.length}`) }
    if (context.filters.item_id) { values.push(context.filters.item_id); conditions.push(`EXISTS (SELECT 1 FROM ops.ingest_record_dedup d WHERE d.batch_id=b.id AND d.entity_type IN ('item','version','snapshot') AND d.entity_id=$${values.length})`) }
    if (context.filters.seller_id) { values.push(context.filters.seller_id); conditions.push(`EXISTS (SELECT 1 FROM ops.ingest_record_dedup d WHERE d.batch_id=b.id AND d.entity_type='seller' AND d.entity_id=$${values.length})`) }
    if (context.filters.event_key) { values.push(context.filters.event_key); conditions.push(`EXISTS (SELECT 1 FROM ops.ingest_record_dedup d WHERE d.batch_id=b.id AND d.entity_type='event' AND (d.idempotency_key=$${values.length} OR d.entity_id=$${values.length}))`) }
    if (context.filters.quality_status) { values.push(context.filters.quality_status); conditions.push(`b.quality_status = $${values.length}`) }
    if (context.filters.failure_reason) { values.push(`%${context.filters.failure_reason}%`); conditions.push(`EXISTS (SELECT 1 FROM ops.ingest_rejections r WHERE r.batch_id=b.id AND r.failure_reason ILIKE $${values.length})`) }
    if (context.filters.from) { values.push(context.filters.from); conditions.push(`b.received_at >= $${values.length}::timestamptz`) }
    if (context.filters.to) { values.push(context.filters.to); conditions.push(`b.received_at < $${values.length}::timestamptz`) }
    return conditions
  }
})

const adminAiJobsPlan = tablePlan({
  resource: adminAiJobsListConfig.resource,
  from: 'ai.jobs j JOIN identity.users u ON u.id = j.requesting_user_id JOIN ai.prompt_versions p ON p.id = j.prompt_version_id LEFT JOIN ai.provider_configs cfg ON cfg.provider_code = p.provider_reference',
  select: 'j.id, j.requesting_user_id AS "requestingUserId", u.email_normalized AS "requestingUserAccount", j.idempotency_key AS "idempotencyKey", j.capability_id AS "capabilityId", j.prompt_version_id AS "promptVersionId", j.scope, p.provider_reference AS "provider", COALESCE(cfg.model_reference, p.model_reference) AS "model", j.input_object_key AS "inputObjectKey", j.status, j.retry_count AS "retryCount", j.last_error AS "lastError", j.cost_quantity AS "costQuantity", j.queued_at AS "queuedAt", j.started_at AS "startedAt", j.finished_at AS "finishedAt", j.billing_reference AS "billingReference", j.created_at AS "createdAt"',
  idExpression: 'j.id::text',
  sortExpressions: { created_at: 'j.created_at', status: 'j.status', billing_reference: "COALESCE(j.billing_reference, '')", id: 'j.id::text' },
  conditions: (context, values) => {
    const conditions = ['j.created_at <= $1']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`LOWER(COALESCE(j.billing_reference, '')) LIKE LOWER($${values.length})`) }
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`j.status = $${values.length}`) }
    if (context.filters.requesting_user_id) { values.push(context.filters.requesting_user_id); conditions.push(`j.requesting_user_id = $${values.length}`) }
    if (context.filters.capability_id) { values.push(context.filters.capability_id); conditions.push(`j.capability_id = $${values.length}`) }
    if (context.filters.failure_reason) { values.push(`%${context.filters.failure_reason}%`); conditions.push(`j.last_error ILIKE $${values.length}`) }
    if (context.filters.from) { values.push(context.filters.from); conditions.push(`j.created_at >= $${values.length}::timestamptz`) }
    if (context.filters.to) { values.push(context.filters.to); conditions.push(`j.created_at < $${values.length}::timestamptz`) }
    return conditions
  }
})

const adminAnnouncementsPlan = tablePlan({
  resource: adminAnnouncementsListConfig.resource,
  from: 'ops.announcements a LEFT JOIN identity.users u ON u.id = a.user_id',
  select: 'a.id, a.title, a.body, a.scope, a.user_id AS "userId", u.email_normalized AS "userAccount", a.enabled, a.starts_at AS "startsAt", a.ends_at AS "endsAt", a.created_at AS "createdAt", a.updated_at AS "updatedAt"',
  idExpression: 'a.id::text',
  sortExpressions: { updated_at: 'a.updated_at', created_at: 'a.created_at', enabled: 'a.enabled::text', title: 'a.title', id: 'a.id::text' },
  conditions: (context, values) => {
    const conditions = ['a.updated_at <= $1']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(a.title) LIKE LOWER($${values.length}) OR LOWER(a.body) LIKE LOWER($${values.length}))`) }
    if (context.filters.enabled) { values.push(context.filters.enabled); conditions.push(`a.enabled = $${values.length}::boolean`) }
    if (context.filters.scope) { values.push(context.filters.scope); conditions.push(`a.scope = $${values.length}`) }
    if (context.filters.user_id) { values.push(context.filters.user_id); conditions.push(`a.user_id = $${values.length}`) }
    return conditions
  }
})

const adminProvidersPlan = tablePlan({
  resource: adminProvidersListConfig.resource,
  from: 'ai.provider_configs p',
  select: 'p.id,p.provider_code AS "providerCode",p.model_reference AS "modelReference",p.base_url AS "baseUrl",p.stream_enabled AS stream,p.reasoning_enabled AS reasoning,p.settings,p.status,p.created_at AS "createdAt",p.updated_at AS "updatedAt"',
  idExpression: 'p.id::text',
  sortExpressions: { created_at: 'p.created_at', updated_at: 'p.updated_at', status: 'p.status', provider_code: 'p.provider_code', id: 'p.id::text' },
  conditions: (context, values) => {
    const conditions = ['p.updated_at <= $1']
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`p.status=$${values.length}`) }
    if (context.filters.provider_code) { values.push(context.filters.provider_code); conditions.push(`p.provider_code=$${values.length}`) }
    return conditions
  }
})

const adminAuditPlan = tablePlan({
  resource: adminAuditListConfig.resource,
  from: 'ops.audit_logs a',
  select: 'a.id, a.actor_type AS "actorType", a.actor_id AS "actorId", a.action, a.target_type AS "targetType", a.target_id AS "targetId", a.request_id AS "requestId", a.safe_metadata AS "safeMetadata", a.occurred_at AS "occurredAt"',
  idExpression: 'a.id::text',
  sortExpressions: { occurred_at: 'a.occurred_at', action: 'a.action', id: 'a.id::text' },
  conditions: (context, values) => {
    const conditions = ['a.occurred_at <= $1']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(a.action) LIKE LOWER($${values.length}) OR LOWER(a.request_id) LIKE LOWER($${values.length}))`) }
    if (context.filters.actor_type) { values.push(context.filters.actor_type); conditions.push(`a.actor_type = $${values.length}`) }
    if (context.filters.action) { values.push(context.filters.action); conditions.push(`a.action = $${values.length}`) }
    if (context.filters.target_type) { values.push(context.filters.target_type); conditions.push(`a.target_type = $${values.length}`) }
    return conditions
  }
})

const capacitySourceSql = `
  SELECT 'database.tables'::text AS id, 'database'::text AS resource, COUNT(*)::text AS value, 'tables'::text AS unit, 'healthy'::text AS status
  FROM pg_class rel JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE rel.relkind IN ('r', 'p') AND ns.nspname IN ('identity', 'billing', 'market', 'ops', 'ai')
  UNION ALL
  SELECT 'ingest.pending'::text, 'queue', COUNT(*)::text, 'batches', 'healthy'
  FROM ops.ingest_batches WHERE status IN ('accepted', 'processing')
  UNION ALL
  SELECT 'ai.pending'::text, 'queue', COUNT(*)::text, 'jobs', 'healthy'
  FROM ai.jobs WHERE status IN ('queued', 'running')
  UNION ALL
  SELECT 'market.media_bytes'::text, 'storage', COALESCE(SUM(byte_size), 0)::text, 'bytes', 'healthy'
  FROM market.media_objects
  UNION ALL
  SELECT 'postgres.partitions'::text, 'database', COUNT(*)::text, 'partitions', 'healthy'
  FROM pg_inherits`

const adminCapacityPlan: ListPlanBuilder = (context) => {
  const build = (includeCursor: boolean): ListQuerySpec & { where: string } => {
    const values: unknown[] = [context.snapshotAt]
    const conditions = ['TRUE']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(h.id) LIKE LOWER($${values.length}) OR LOWER(h.resource) LIKE LOWER($${values.length}))`) }
    if (includeCursor && context.cursorKey) conditions.push(keyset(values, 'h.id', 'h.id', context.order, context.cursorKey))
    return { text: '', values, where: conditions.join(' AND ') }
  }
  return {
    resource: adminCapacityListConfig.resource,
    page: () => {
      const query = build(true)
      return { text: `SELECT h.id, h.resource, h.value, h.unit, h.status, $1::timestamptz AS "checkedAt", h.id AS cursor_sort_value, h.id AS cursor_id FROM (${capacitySourceSql}) h WHERE ${query.where} ORDER BY h.id ${context.order.toUpperCase()} LIMIT ${context.limit + 1}`, values: query.values }
    },
    count: () => {
      const values: unknown[] = []
      const conditions = ['TRUE']
      if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(h.id) LIKE LOWER($${values.length}) OR LOWER(h.resource) LIKE LOWER($${values.length}))`) }
      return { text: `SELECT COUNT(*)::int AS total FROM (${capacitySourceSql}) h WHERE ${conditions.join(' AND ')}`, values }
    }
  }
}

function marketConditions(context: ListContext, values: unknown[], includeCursor: boolean, subjectId?: string): string[] {
  const conditions = ['i.first_seen_at <= $1']
  const filters = context.filters
  if (subjectId) {
    values.push(subjectId)
    conditions.push('EXISTS (SELECT 1 FROM market.observations o JOIN ops.collection_runs r ON r.id = o.collection_run_id JOIN identity.collector_clients c ON c.id = r.client_id WHERE o.item_id = i.id AND c.user_id = $2)')
  }
  if (filters.q) { values.push(`%${filters.q}%`); conditions.push(`(LOWER(i.platform_item_id) LIKE LOWER($${values.length}) OR LOWER(i.platform) LIKE LOWER($${values.length}))`) }
  if (filters.state) { values.push(filters.state); conditions.push(`i.lifecycle_state = $${values.length}`) }
  if (filters.platform) { values.push(filters.platform); conditions.push(`i.platform = $${values.length}`) }
  if (filters.seller_id) { values.push(filters.seller_id); conditions.push(`i.seller_id = $${values.length}`) }
  if (filters.category_id) { values.push(filters.category_id); conditions.push(`i.category_id = $${values.length}`) }
  if (includeCursor && context.cursorKey) {
    const expression = ({ last_seen_at: 'i.last_seen_at', first_seen_at: 'i.first_seen_at', platform_item_id: 'i.platform_item_id', id: 'i.id::text' } as Record<string, string>)[context.sort]
    conditions.push(keyset(values, expression, 'i.id::text', context.order, context.cursorKey))
  }
  return conditions
}

function marketItemsPlan(resource: string, userScoped = false): ListPlanBuilder {
  return (context, subjectId) => {
    const sortExpression = ({ last_seen_at: 'i.last_seen_at', first_seen_at: 'i.first_seen_at', platform_item_id: 'i.platform_item_id', id: 'i.id::text' } as Record<string, string>)[context.sort]
    const build = (includeCursor: boolean): ListQuerySpec & { where: string } => {
      const values: unknown[] = [context.snapshotAt]
      const conditions = marketConditions(context, values, includeCursor, userScoped ? subjectId : undefined)
      return { text: '', values, where: conditions.join(' AND ') }
    }
    return {
      resource,
      page: () => {
        const query = build(true)
        return { text: `SELECT i.id, i.seller_id AS "sellerId", s.platform_seller_id AS "platformSellerId", i.platform, i.platform_item_id AS "platformItemId", i.lifecycle_state AS state, i.first_seen_at AS "firstSeenAt", i.last_seen_at AS "lastSeenAt", v.title, v.price, v.region, v.condition_text AS "conditionText", v.want_count AS "wantCount", v.canonical_payload->'imageUrls' AS images, ${sortExpression} AS cursor_sort_value, i.id::text AS cursor_id
          FROM market.items i
          LEFT JOIN market.seller_profiles s ON s.id = i.seller_id
          LEFT JOIN LATERAL (
            SELECT title,price,region,condition_text,want_count,canonical_payload
            FROM market.item_versions
            WHERE item_id=i.id
            ORDER BY observed_at DESC,id DESC
            LIMIT 1
          ) v ON TRUE
          WHERE ${query.where}
          ORDER BY ${sortExpression} ${context.order.toUpperCase()}, i.id ${context.order.toUpperCase()}
          LIMIT ${context.limit + 1}`, values: query.values }
      },
      count: () => {
        const query = build(false)
        return { text: `SELECT COUNT(*)::int AS total FROM market.items i WHERE ${query.where}`, values: query.values }
      }
    }
  }
}

function sellerItemsPlan(context: ListContext, subjectId: string): ListPlan {
  const sortExpression = ({ last_seen_at: 'i.last_seen_at', first_seen_at: 'i.first_seen_at', platform_item_id: 'i.platform_item_id', id: 'i.id::text' } as Record<string, string>)[context.sort]
  const build = (includeCursor: boolean): ListQuerySpec & { where: string } => {
    const values: unknown[] = [context.snapshotAt]
    const conditions = marketConditions(context, values, includeCursor, subjectId)
    return { text: '', values, where: conditions.join(' AND ') }
  }
  return {
    resource: sellerItemsListConfig.resource,
    page: () => {
      const query = build(true)
        return { text: `SELECT i.id, i.seller_id AS "sellerId", s.platform_seller_id AS "platformSellerId", i.platform, i.platform_item_id AS "platformItemId", i.lifecycle_state AS state, i.first_seen_at AS "firstSeenAt", i.last_seen_at AS "lastSeenAt", v.title, v.price, v.region, v.condition_text AS "conditionText", v.want_count AS "wantCount", ${sortExpression} AS cursor_sort_value, i.id::text AS cursor_id
        FROM market.items i
        LEFT JOIN market.seller_profiles s ON s.id = i.seller_id
        LEFT JOIN LATERAL (
          SELECT title,price,region,condition_text,want_count
          FROM market.item_versions
          WHERE item_id=i.id
          ORDER BY observed_at DESC,id DESC
          LIMIT 1
        ) v ON TRUE
        WHERE ${query.where}
        ORDER BY ${sortExpression} ${context.order.toUpperCase()}, i.id ${context.order.toUpperCase()}
        LIMIT ${context.limit + 1}`, values: query.values }
    },
    count: () => {
      const query = build(false)
      return { text: `SELECT COUNT(*)::int AS total FROM market.items i WHERE ${query.where}`, values: query.values }
    }
  }
}

function adminUsersConditions(context: ListContext, values: unknown[], includeCursor: boolean): string[] {
  const conditions = ['u.created_at <= $1']
  const filters = context.filters
  if (filters.q) { values.push(`%${filters.q}%`); conditions.push(`LOWER(u.email_normalized) LIKE LOWER($${values.length})`) }
  if (filters.status) { values.push(filters.status); conditions.push(`u.status = $${values.length}`) }
  if (includeCursor && context.cursorKey) {
    const expression = ({ created_at: 'u.created_at', email: 'u.email_normalized', status: 'u.status', id: 'u.id::text' } as Record<string, string>)[context.sort]
    conditions.push(keyset(values, expression, 'u.id::text', context.order, context.cursorKey))
  }
  return conditions
}

async function listAdminUsers(sql: Sql, context: ListContext, secret: string) {
  const sortExpression = ({ created_at: 'u.created_at', email: 'u.email_normalized', status: 'u.status', id: 'u.id::text' } as Record<string, string>)[context.sort]
  const pageValues: unknown[] = [context.snapshotAt]
  const pageWhere = adminUsersConditions(context, pageValues, true).join(' AND ')
  const rows = await sql.query(`SELECT u.id, u.email_normalized AS email, u.email_normalized AS account, u.status, (u.status = 'active') AS enabled,
    COALESCE(points.balance, 0) AS points,
    jsonb_build_object(
      'monitorCount', (SELECT COUNT(*)::int FROM ops.monitor_tasks t WHERE t.user_id = u.id),
      'sellerMonitorCount', (SELECT COUNT(*)::int FROM ops.seller_monitor_tasks t WHERE t.user_id = u.id),
      'deviceCount', (SELECT COUNT(*)::int FROM identity.collector_clients c WHERE c.user_id = u.id),
      'uploadBatchCount', (SELECT COUNT(*)::int FROM ops.ingest_batches b JOIN identity.collector_clients c ON c.id = b.client_id WHERE c.user_id = u.id)
    ) AS "userData", u.created_at AS "createdAt", ${sortExpression} AS cursor_sort_value, u.id::text AS cursor_id
    FROM identity.users u LEFT JOIN billing.user_points points ON points.user_id = u.id WHERE ${pageWhere}
    ORDER BY ${sortExpression} ${context.order.toUpperCase()}, u.id ${context.order.toUpperCase()} LIMIT ${context.limit + 1}`, pageValues)
  const countValues: unknown[] = [context.snapshotAt]
  const countWhere = adminUsersConditions(context, countValues, false).join(' AND ')
  const total = Number((await sql.query(`SELECT COUNT(*)::int AS total FROM identity.users u WHERE ${countWhere}`, countValues)).rows[0]?.total ?? 0)
  return listResponse(context, rows.rows, total, secret, adminUsersListConfig.resource)
}

async function issue(sql: Sql, domain: TokenDomain, kind: SubjectKind, subjectId: string, clientId?: string, familyId: string = randomUUID(), rotatedFromId?: string) {
  const sessionId = randomUUID(); const refresh = createRefreshToken()
  await sql.query(`INSERT INTO identity.auth_refresh_sessions (id, subject_type, subject_id, token_hash, family_id, expires_at, created_at)
    VALUES ($1,$2,$3,$4,$5,now() + interval '30 days',now())`, [sessionId, kind, subjectId, refresh.hash, familyId])
  if (rotatedFromId) await sql.query('UPDATE identity.auth_refresh_sessions SET rotated_from_id = $1 WHERE id = $2', [rotatedFromId, sessionId])
  return { accessToken: await signAccessToken(domain, kind, subjectId, sessionId, clientId), refreshToken: refresh.token }
}

async function rotateRefresh(sql: Sql, domain: TokenDomain, kind: SubjectKind, session: SessionRow, clientId?: string) {
  const sessionId = randomUUID(); const refresh = createRefreshToken()
  const rotated = await sql.query(`WITH old_session AS (
      UPDATE identity.auth_refresh_sessions
      SET revoked_at = now(), last_used_at = now()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING COALESCE(family_id, id) AS family_id
    )
    INSERT INTO identity.auth_refresh_sessions (id, subject_type, subject_id, token_hash, family_id, rotated_from_id, expires_at, created_at)
    SELECT $2,$3,$4,$5,old_session.family_id,$1,now() + interval '30 days',now()
    FROM old_session
    RETURNING id`, [session.id, sessionId, kind, session.subject_id, refresh.hash])
  if (!rotated.rows[0]) {
    const familyId = session.family_id ?? session.id
    await sql.query('UPDATE identity.auth_refresh_sessions SET replay_detected_at = now(), revoked_at = now() WHERE (family_id = $1 OR id = $1) AND revoked_at IS NULL', [familyId])
    throw new Error('刷新令牌重放')
  }
  return { accessToken: await signAccessToken(domain, kind, session.subject_id, sessionId, clientId), refreshToken: refresh.token }
}

async function activeCollector(sql: Sql, clientId: string): Promise<{ user_id: string }> {
  const client = (await sql.query(`SELECT c.user_id
    FROM identity.collector_clients c
    JOIN identity.users u ON u.id = c.user_id
    WHERE c.id = $1 AND c.status = 'active' AND u.status = 'active'`, [clientId])).rows[0] as { user_id: string } | undefined
  if (!client) throw new Error('设备已撤销或账号已禁用')
  return client
}

async function collectorEntitlements(sql: Sql, userId: string) {
  const grants = await sql.query('SELECT capability,limit_value,effective_to FROM billing.entitlement_grants WHERE user_id=$1 AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now())', [userId])
  const taskLimit = Math.min(MAX_ACTIVE_SEARCH_TASKS, Math.max(0, ...grants.rows.filter((grant) => String(grant.capability) === 'collector').map((grant) => Number(grant.limit_value))))
  return { items: grants.rows, allowed: taskLimit > 0, taskLimit }
}

async function requireCollectorEntitlement(sql: Sql, userId: string) {
  const entitlements = await collectorEntitlements(sql, userId)
  if (!entitlements.allowed) throw new Error('当前账号没有可用采集权益')
  return entitlements
}

async function authenticateToken(sql: Sql, domain: TokenDomain, kind: SubjectKind, token: string) {
  const claims = await verifyAccessToken(domain, kind, token)
  const session = (await sql.query('SELECT id, subject_type, subject_id, revoked_at, expires_at FROM identity.auth_refresh_sessions WHERE id = $1', [claims.sessionId])).rows[0] as SessionRow | undefined
  if (!session || session.subject_type !== kind || session.subject_id !== claims.sub || session.revoked_at || new Date(String(session.expires_at)) <= new Date()) throw new Error('会话已失效')
  if (kind === 'collector') {
    await activeCollector(sql, String(claims.sub))
  }
  if (kind === 'user') {
    const user = (await sql.query('SELECT status FROM identity.users WHERE id=$1', [claims.sub])).rows[0] as { status?: string } | undefined
    if (!user || user.status !== 'active') throw new Error('账号已禁用')
  }
  return claims
}

async function authenticate(sql: Sql, domain: TokenDomain, kind: SubjectKind, header: string | undefined) { return authenticateToken(sql, domain, kind, bearer(header)) }

async function refresh(sql: Sql, domain: TokenDomain, kind: SubjectKind, refreshToken: string, clientId?: string) {
  const result = await sql.query(`SELECT id, subject_id, family_id, revoked_at, expires_at FROM identity.auth_refresh_sessions
    WHERE subject_type = $1 AND token_hash = $2`, [kind, refreshHash(refreshToken)])
  const session = result.rows[0] as SessionRow | undefined
  if (!session || new Date(session.expires_at) <= new Date()) throw new Error('刷新令牌无效')
  if (session.revoked_at) {
    const familyId = session.family_id ?? session.id
    await sql.query('UPDATE identity.auth_refresh_sessions SET replay_detected_at = now(), revoked_at = now() WHERE (family_id = $1 OR id = $1) AND revoked_at IS NULL', [familyId])
    throw new Error('刷新令牌重放')
  }
  if (kind === 'collector') {
    const client = await activeCollector(sql, session.subject_id)
    await requireCollectorEntitlement(sql, client.user_id)
  }
  if (kind === 'user') {
    const user = (await sql.query('SELECT status FROM identity.users WHERE id=$1', [session.subject_id])).rows[0] as { status?: string } | undefined
    if (!user || user.status !== 'active') throw new Error('账号已禁用')
  }
  return rotateRefresh(sql, domain, kind, session, clientId ?? (kind === 'collector' ? session.subject_id : undefined))
}

async function revokeCollector(sql: Sql, clientId: string, userId?: string): Promise<boolean> {
  const updated = userId
    ? await sql.query("UPDATE identity.collector_clients SET status = 'revoked', active_slot = NULL, revoked_at = now() WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING id", [clientId, userId])
    : await sql.query("UPDATE identity.collector_clients SET status = 'revoked', active_slot = NULL, revoked_at = now() WHERE id = $1 AND status = 'active' RETURNING id", [clientId])
  if (!updated.rows[0]) return false
  await sql.query("UPDATE identity.auth_refresh_sessions SET revoked_at = now() WHERE subject_type = 'collector' AND subject_id = $1 AND revoked_at IS NULL", [clientId])
  return true
}

const monitorTaskColumns = `id, rule_json AS rule, rule_version AS "ruleVersion", status, interval_seconds AS "intervalSeconds", next_run_at AS "nextRunAt", created_at AS "createdAt", updated_at AS "updatedAt"`
const sellerMonitorTaskColumns = `t.id, t.seller_id AS "sellerId", s.platform, s.platform_seller_id AS "platformSellerId", s.public_name AS "publicName", s.region, t.profile_url AS "profileUrl", t.rule_version AS "ruleVersion", t.status, t.interval_seconds AS "intervalSeconds", t.next_run_at AS "nextRunAt", t.created_at AS "createdAt", t.updated_at AS "updatedAt"`
const publishedItemMonitorTaskColumns = `t.id, t.publish_plan_id AS "publishPlanId", t.platform, t.platform_item_id AS "platformItemId", t.item_url AS "itemUrl", t.rule_version AS "ruleVersion", t.status, t.interval_seconds AS "intervalSeconds", t.next_run_at AS "nextRunAt", t.created_at AS "createdAt", t.updated_at AS "updatedAt"`

async function ownedMonitorTask(sql: Sql, userId: string, taskId: string) {
  return (await sql.query(`SELECT ${monitorTaskColumns} FROM ops.monitor_tasks WHERE id=$1 AND user_id=$2`, [taskId, userId])).rows[0]
}

async function ownedSellerMonitorTask(sql: Sql, userId: string, taskId: string) {
  return (await sql.query(`SELECT ${sellerMonitorTaskColumns}
    FROM ops.seller_monitor_tasks t
    JOIN market.seller_profiles s ON s.id = t.seller_id
    WHERE t.id=$1 AND t.user_id=$2`, [taskId, userId])).rows[0]
}

async function ownedPublishedItemMonitorTask(sql: Sql, userId: string, taskId: string) {
  return (await sql.query(`SELECT ${publishedItemMonitorTaskColumns}
    FROM ops.published_item_monitor_tasks t
    WHERE t.id=$1 AND t.user_id=$2`, [taskId, userId])).rows[0]
}

async function createPublishedItemMonitor(sql: Sql, userId: string, input: { platformItemId: string; itemUrl: string; publishPlanId?: string; status?: PublishedItemMonitorTaskStatus; intervalSeconds?: number }, upsert = false) {
  if (input.publishPlanId) {
    const plan = await sql.query('SELECT id,xianyu_item_id FROM supply.publish_plans WHERE id=$1 AND user_id=$2', [input.publishPlanId, userId])
    if (!plan.rows[0]) throw new MonitorTaskRequestError('发布计划不存在', 400)
    if (plan.rows[0].xianyu_item_id && String(plan.rows[0].xianyu_item_id) !== input.platformItemId) throw new MonitorTaskRequestError('发布计划与闲鱼商品 ID 不匹配')
  }
  const values = [randomUUID(), userId, input.publishPlanId ?? null, 'goofish', input.platformItemId, input.itemUrl, input.status ?? 'active', input.intervalSeconds ?? 1800]
  const query = upsert
    ? `INSERT INTO ops.published_item_monitor_tasks (id,user_id,publish_plan_id,platform,platform_item_id,item_url,status,interval_seconds,next_run_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now(),now())
       ON CONFLICT (user_id,platform,platform_item_id) DO UPDATE SET publish_plan_id=COALESCE(ops.published_item_monitor_tasks.publish_plan_id,EXCLUDED.publish_plan_id), item_url=EXCLUDED.item_url, updated_at=now()
       RETURNING id`
    : `INSERT INTO ops.published_item_monitor_tasks (id,user_id,publish_plan_id,platform,platform_item_id,item_url,status,interval_seconds,next_run_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now(),now()) RETURNING id`
  const inserted = await sql.query(query, values)
  return ownedPublishedItemMonitorTask(sql, userId, String(inserted.rows[0]?.id ?? ''))
}

async function findOrCreateSellerProfile(sql: Sql, platform: string, platformSellerId: string): Promise<string> {
  const seller = await sql.query(`INSERT INTO market.seller_profiles (id,platform,platform_seller_id,public_profile,first_seen_at,last_seen_at)
    VALUES ($1,$2,$3,'{}'::jsonb,now(),now())
    ON CONFLICT (platform,platform_seller_id) DO UPDATE SET platform = EXCLUDED.platform
    RETURNING id`, [randomUUID(), platform, platformSellerId])
  return String(seller.rows[0]?.id ?? '')
}

async function allocateActiveTaskSlot(sql: Sql, userId: string, excludedTaskId?: string): Promise<number> {
  const entitlements = await collectorEntitlements(sql, userId)
  if (!entitlements.allowed) throw new MonitorTaskRequestError('当前账号没有可用采集权益', 403)
  const values: unknown[] = [userId]
  const excluded = excludedTaskId ? (() => { values.push(excludedTaskId); return ` AND id <> $${values.length}` })() : ''
  const active = await sql.query(`SELECT active_slot FROM ops.monitor_tasks WHERE user_id=$1 AND status='active'${excluded}`, values)
  const occupied = new Set(active.rows.map((task) => Number(task.active_slot)))
  for (let slot = 1; slot <= entitlements.taskLimit; slot += 1) if (!occupied.has(slot)) return slot
  throw new MonitorTaskRequestError(`当前采集权益最多启用 ${entitlements.taskLimit} 条搜索任务`, 403)
}

async function withActiveTaskSlotRetry<T>(sql: Sql, userId: string, excludedTaskId: string | undefined, operation: (activeSlot: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_ACTIVE_SEARCH_TASKS; attempt += 1) {
    const activeSlot = await allocateActiveTaskSlot(sql, userId, excludedTaskId)
    try {
      return await operation(activeSlot)
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === MAX_ACTIVE_SEARCH_TASKS - 1) throw error
    }
  }
  throw new Error('采集任务槽位分配失败')
}

async function allocateActiveSellerTaskSlot(sql: Sql, userId: string, excludedTaskId?: string): Promise<number> {
  const entitlements = await collectorEntitlements(sql, userId)
  if (!entitlements.allowed) throw new MonitorTaskRequestError('当前账号没有可用采集权益', 403)
  const values: unknown[] = [userId]
  const excluded = excludedTaskId ? (() => { values.push(excludedTaskId); return ` AND id <> $${values.length}` })() : ''
  const active = await sql.query(`SELECT active_slot FROM ops.seller_monitor_tasks WHERE user_id=$1 AND status='active'${excluded}`, values)
  const occupied = new Set(active.rows.map((task) => Number(task.active_slot)))
  for (let slot = 1; slot <= MAX_ACTIVE_SELLER_TASKS; slot += 1) if (!occupied.has(slot)) return slot
  throw new MonitorTaskRequestError(`当前账号最多启用 ${MAX_ACTIVE_SELLER_TASKS} 个竞品商家`, 403)
}

async function withActiveSellerTaskSlotRetry<T>(sql: Sql, userId: string, excludedTaskId: string | undefined, operation: (activeSlot: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_ACTIVE_SELLER_TASKS; attempt += 1) {
    const activeSlot = await allocateActiveSellerTaskSlot(sql, userId, excludedTaskId)
    try {
      return await operation(activeSlot)
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === MAX_ACTIVE_SELLER_TASKS - 1) throw error
    }
  }
  throw new Error('竞品商家任务槽位分配失败')
}

export function createUserApi(sql: Sql, domains: Domains, options: ApiOptions = {}) {
  const app = Fastify({ logger: false })
  installCors(app, options.allowedOrigins ?? [])
  const sellerProfileHosts = [...DEFAULT_SELLER_PROFILE_HOSTS, ...(options.sellerProfileHosts ?? [])]
  const publishedItemHosts = [...DEFAULT_SELLER_PROFILE_HOSTS, ...(options.publishedItemHosts ?? [])]
  app.get('/health', async () => ({ service: 'user-api', ok: true }))
  app.post('/v1/auth/register', async (request, reply) => {
    const input = body<{ email?: string; password?: string }>(request.body); const email = input.email?.trim().toLowerCase()
    if (!email || !credentialValid(input.password)) return fail(reply, 400, '账号必填，密码需要 6 到 20 个字符')
    try { const id = randomUUID(); await sql.query('INSERT INTO identity.users (id,email_normalized,password_hash,status,created_at) VALUES ($1,$2,$3,\'active\',now())', [id, email, await hashPassword(input.password)]); return issue(sql, domains.user, 'user', id) } catch { return fail(reply, 409, '用户已存在') }
  })
  app.post('/v1/auth/login', async (request, reply) => {
    const input = body<{ email?: string; password?: string }>(request.body); const email = input.email?.trim().toLowerCase()
    const found = await sql.query('SELECT id,email_normalized,password_hash,status FROM identity.users WHERE email_normalized=$1', [email]); const user = found.rows[0] as UserRow | undefined
    if (!user || user.status !== 'active' || !credentialValid(input.password) || !(await verifyPassword(input.password, user.password_hash))) return fail(reply, 401, '账号或密码错误')
    return issue(sql, domains.user, 'user', user.id)
  })
  app.post('/v1/auth/refresh', async (request, reply) => { try { return await refresh(sql, domains.user, 'user', body<{ refreshToken: string }>(request.body).refreshToken) } catch (error) { return fail(reply, 401, error instanceof Error ? error.message : '刷新失败') } })
  app.get('/v1/me', async (request, reply) => { try { const claims = await authenticate(sql, domains.user, 'user', request.headers.authorization); return { id: claims.sub } } catch { return fail(reply, 401, '未授权') } })
  app.get('/v1/me/entitlements', async (request, reply) => { try { const claims = await authenticate(sql, domains.user, 'user', request.headers.authorization); const rows = await sql.query('SELECT capability,limit_value,effective_to FROM billing.entitlement_grants WHERE user_id=$1 AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now())', [claims.sub]); return { items: rows.rows } } catch { return fail(reply, 401, '未授权') } })
  app.post('/v1/ai/jobs', async (request, reply) => {
    let claims: Awaited<ReturnType<typeof authenticate>>
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    try {
      const input = body<{ capabilityCode?: string; input?: unknown; idempotencyKey?: string; promptVersion?: number; scope?: string }>(request.body)
      const code = input.capabilityCode?.trim(); const key = input.idempotencyKey?.trim()
      if (!code || !key || key.length > 256) return fail(reply, 400, 'AI 任务参数无效')
      const scope = input.scope ?? 'personal'
      if (scope !== 'personal' && scope !== 'global') return fail(reply, 400, 'AI 任务范围无效')
      const capability = (await sql.query(`SELECT id, published_version, entitlement FROM ai.capabilities WHERE code=$1 AND published_version IS NOT NULL`, [code])).rows[0]
      if (!capability) return fail(reply, 404, 'AI 能力未发布')
      const entitlement = await sql.query(`SELECT 1 FROM billing.entitlement_grants WHERE user_id=$1 AND capability=$2 AND limit_value > 0 AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now()) LIMIT 1`, [claims.sub, capability.entitlement])
      if (!entitlement.rows[0]) return fail(reply, 403, '当前账号没有可用 AI 权益')
      const prompt = (await sql.query(`SELECT id FROM ai.prompt_versions WHERE capability_id=$1 AND version=$2 AND status='published'`, [capability.id, input.promptVersion ?? capability.published_version])).rows[0]
      if (!prompt) return fail(reply, 409, 'AI 提示版本未发布')
      const id = randomUUID()
      const claimed = await sql.query(`WITH claim AS (
          INSERT INTO ai.job_idempotency (requesting_user_id,idempotency_key,job_id,created_at)
          VALUES ($1,$2,$3,now()) ON CONFLICT DO NOTHING RETURNING job_id
        ), created AS (
          INSERT INTO ai.jobs (id,created_at,requesting_user_id,idempotency_key,capability_id,prompt_version_id,input_payload,scope,status,queued_at)
          SELECT job_id,now(),$1,$2,$4,$5,$6::jsonb,$7,'queued',now() FROM claim RETURNING id
        )
        SELECT id,false AS duplicate FROM created
        UNION ALL
        SELECT job_id,true AS duplicate FROM ai.job_idempotency WHERE requesting_user_id=$1 AND idempotency_key=$2 AND NOT EXISTS (SELECT 1 FROM claim)
        LIMIT 1`, [claims.sub, key, id, capability.id, prompt.id, JSON.stringify(input.input ?? {}), scope])
      const job = claimed.rows[0]
      if (!job) throw new Error('AI 任务幂等声明失败')
      const canonicalScope = (await sql.query('SELECT scope FROM ai.jobs WHERE id=$1', [job.id])).rows[0]?.scope ?? scope
      return reply.code(202).send({ id: job.id, status: 'queued', scope: canonicalScope, duplicate: Boolean(job.duplicate) })
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : 'AI 任务创建失败') }
  })
  app.post('/v1/collector-devices/:clientId/revoke', async (request, reply) => {
    try {
      const claims = await authenticate(sql, domains.user, 'user', request.headers.authorization)
      const clientId = String((request.params as { clientId?: string }).clientId ?? '')
      if (!clientId || !(await revokeCollector(sql, clientId, String(claims.sub)))) return fail(reply, 404, '设备不存在或已解绑')
      return { revoked: true }
    } catch {
      return fail(reply, 401, '未授权')
    }
  })
  app.post('/v1/supply/migrations', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    try {
      const input = parseSupplyMigrationRequest(request.body, publishedItemHosts)
      const existing = (await sql.query('SELECT * FROM supply.migration_requests WHERE user_id=$1 AND idempotency_key=$2', [claims.sub, input.idempotencyKey])).rows[0]
      if (existing) return { ...supplyMigrationResponse(existing), duplicate: true }
      let platformItemId = input.platformItemId
      let itemUrl = input.itemUrl
      if (input.kind === 'market_item') {
        const item = (await sql.query(`SELECT i.platform,i.platform_item_id
          FROM market.items i
          WHERE i.id=$1 AND i.platform='goofish' AND EXISTS (
            SELECT 1 FROM market.observations o JOIN ops.collection_runs r ON r.id=o.collection_run_id
            JOIN identity.collector_clients c ON c.id=r.client_id WHERE o.item_id=i.id AND c.user_id=$2
          )`, [input.sourceId, claims.sub])).rows[0]
        if (!item) return fail(reply, 404, '当前账户未找到该市场商品')
        platformItemId = String(item.platform_item_id)
        itemUrl = canonicalPublishedItemUrl(platformItemId)
      }
      if (input.kind === 'published_item') {
        const item = (await sql.query(`SELECT platform_item_id,item_url FROM ops.published_item_monitor_tasks
          WHERE id=$1 AND user_id=$2 AND platform='goofish'`, [input.sourceId, claims.sub])).rows[0]
        if (!item) return fail(reply, 404, '当前账户未找到该已发布商品')
        platformItemId = String(item.platform_item_id)
        itemUrl = String(item.item_url)
      }
      if (!platformItemId || !itemUrl) throw new SupplyImportRequestError('搬家来源无效')
      const id = randomUUID()
      await sql.query(`INSERT INTO supply.migration_requests (id,user_id,idempotency_key,source_kind,source_reference,platform,platform_item_id,item_url,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,'goofish',$6,$7,'queued',now(),now())`, [id, claims.sub, input.idempotencyKey, input.kind, input.sourceId ?? null, platformItemId, itemUrl])
      const created = (await sql.query('SELECT * FROM supply.migration_requests WHERE id=$1 AND user_id=$2', [id, claims.sub])).rows[0]
      return { ...supplyMigrationResponse(created), duplicate: false }
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : '创建搬家请求失败') }
  })
  app.post('/v1/supply/imports', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    try {
      const input = parseSupplyImport(request.body)
      const existing = (await sql.query('SELECT id,result FROM supply.import_batches WHERE user_id=$1 AND idempotency_key=$2', [claims.sub, input.idempotencyKey])).rows[0]
      if (existing) return { ...(existing.result as Record<string, unknown>), batchId: existing.id, duplicate: true }

      const parsed = input.snapshots.map((snapshot, recordIndex) => {
        try {
          const material = parseSupplySnapshot(snapshot)
          if (material.sourceType !== input.sourceType) throw new SupplyImportRequestError('sourceType 与快照来源平台不一致')
          return { material, recordIndex }
        } catch (error) {
          const safeDetail = error instanceof SupplyImportRequestError ? error.message : '快照解析失败'
          return { recordIndex, safeDetail }
        }
      })
      const payloadHash = createHash('sha256').update(JSON.stringify(parsed.map((entry) => entry.material ?? { recordIndex: entry.recordIndex, rejected: true }))).digest('hex')
      const batchId = randomUUID()
      await sql.query(`INSERT INTO supply.import_batches (id,user_id,idempotency_key,source_type,source_format,payload_hash,received_count,inserted_count,deduplicated_count,failed_count,result,created_at,completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,0,'{}'::jsonb,now(),now())`, [batchId, claims.sub, input.idempotencyKey, input.sourceType, input.sourceFormat, payloadHash, input.snapshots.length])
      let insertedCount = 0
      let deduplicatedCount = 0
      const rejections: Array<{ recordIndex: number; reasonCode: string }> = []
      for (const entry of parsed) {
        if (!entry.material) {
          await sql.query('INSERT INTO supply.import_rejections (id,batch_id,record_index,reason_code,safe_detail,created_at) VALUES ($1,$2,$3,$4,$5,now())', [randomUUID(), batchId, entry.recordIndex, 'INVALID_SNAPSHOT', entry.safeDetail ?? '快照解析失败'])
          rejections.push({ recordIndex: entry.recordIndex, reasonCode: 'INVALID_SNAPSHOT' })
          continue
        }
        const material = entry.material
        const snapshot = { schemaVersion: 1, ...material, sku: material.sku ?? null }
        const contentHash = createHash('sha256').update(supplyStableJson(snapshot)).digest('hex')
        const existingMaterial = (await sql.query('SELECT id,current_version FROM supply.materials WHERE user_id=$1 AND source_platform=$2 AND source_item_id=$3', [claims.sub, material.sourcePlatform, material.sourceItemId])).rows[0]
        if (!existingMaterial) {
          const materialId = randomUUID()
          await sql.query(`INSERT INTO supply.materials (id,user_id,source_type,source_platform,source_item_id,source_url,title,description,price,main_images,detail_images,sku,attributes,import_batch_id,current_version,status,created_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,1,'draft',now(),now())`, [materialId, claims.sub, material.sourceType, material.sourcePlatform, material.sourceItemId, material.sourceUrl, material.title, material.description ?? null, material.price, JSON.stringify(material.mainImages), JSON.stringify(material.detailImages), JSON.stringify(material.sku ?? null), JSON.stringify(material.attributes), batchId])
          await sql.query('INSERT INTO supply.material_versions (id,material_id,version,content_hash,canonical_snapshot,import_batch_id,created_at) VALUES ($1,$2,1,$3,$4::jsonb,$5,now())', [randomUUID(), materialId, contentHash, JSON.stringify(snapshot), batchId])
          insertedCount += 1
          continue
        }
        const materialId = String(existingMaterial.id)
        const knownVersion = await sql.query('SELECT 1 FROM supply.material_versions WHERE material_id=$1 AND content_hash=$2', [materialId, contentHash])
        if (knownVersion.rows[0]) { deduplicatedCount += 1; continue }
        const nextVersion = Number(existingMaterial.current_version) + 1
        await sql.query(`UPDATE supply.materials SET source_type=$1,source_url=$2,title=$3,description=$4,price=$5,main_images=$6::jsonb,detail_images=$7::jsonb,sku=$8::jsonb,attributes=$9::jsonb,import_batch_id=$10,current_version=$11,updated_at=now() WHERE id=$12 AND user_id=$13`, [material.sourceType, material.sourceUrl, material.title, material.description ?? null, material.price, JSON.stringify(material.mainImages), JSON.stringify(material.detailImages), JSON.stringify(material.sku ?? null), JSON.stringify(material.attributes), batchId, nextVersion, materialId, claims.sub])
        await sql.query('INSERT INTO supply.material_versions (id,material_id,version,content_hash,canonical_snapshot,import_batch_id,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,now())', [randomUUID(), materialId, nextVersion, contentHash, JSON.stringify(snapshot), batchId])
        insertedCount += 1
      }
      const result = { receivedCount: input.snapshots.length, insertedCount, deduplicatedCount, failedCount: rejections.length, rejections, duplicate: false }
      await sql.query('UPDATE supply.import_batches SET inserted_count=$1,deduplicated_count=$2,failed_count=$3,result=$4::jsonb,completed_at=now() WHERE id=$5', [insertedCount, deduplicatedCount, rejections.length, JSON.stringify(result), batchId])
      return { batchId, ...result }
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : '素材导入失败') }
  })
  app.get('/v1/supply/materials/:materialId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const materialId = String((request.params as { materialId?: string }).materialId ?? '')
    const result = await sql.query(`SELECT id,source_type AS "sourceType",source_platform AS "sourcePlatform",source_item_id AS "sourceItemId",source_url AS "sourceUrl",title,description,price::float8 AS price,main_images AS "mainImages",detail_images AS "detailImages",sku,attributes,current_version AS "currentVersion",status,import_batch_id AS "importBatchId",created_at AS "createdAt",updated_at AS "updatedAt"
      FROM supply.materials WHERE id=$1 AND user_id=$2`, [materialId, claims.sub])
    if (!result.rows[0]) return fail(reply, 404, '素材不存在')
    return result.rows[0]
  })
  app.patch('/v1/supply/materials/:materialId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const materialId = String((request.params as { materialId?: string }).materialId ?? '')
    try {
      const patch = parseSupplyMaterialPatch(request.body)
      const found = await sql.query(`SELECT m.id,m.user_id,m.source_type,m.source_platform,m.source_item_id,m.source_url,m.import_batch_id,m.current_version,m.status,
        v.id AS material_version_id,v.canonical_snapshot
        FROM supply.materials m JOIN supply.material_versions v ON v.material_id=m.id AND v.version=m.current_version
        WHERE m.id=$1 AND m.user_id=$2`, [materialId, claims.sub])
      const current = found.rows[0]
      if (!current) return fail(reply, 404, '素材不存在')
      const source = supplyRecord(current.canonical_snapshot, '当前素材版本')
      const nextSnapshot = {
        ...source,
        title: patch.title ?? source.title,
        description: Object.hasOwn(patch, 'description') ? patch.description : source.description ?? null,
        price: patch.price ?? source.price,
        mainImages: patch.mainImages ?? source.mainImages,
        detailImages: patch.detailImages ?? source.detailImages ?? [],
        sku: Object.hasOwn(patch, 'sku') ? patch.sku : source.sku ?? null,
        attributes: patch.attributes ?? source.attributes ?? {}
      }
      const contentChanged = supplyStableJson(source) !== supplyStableJson(nextSnapshot)
      const nextStatus = patch.status ?? String(current.status)
      let currentVersion = Number(current.current_version)
      if (contentChanged) {
        const contentHash = createHash('sha256').update(supplyStableJson(nextSnapshot)).digest('hex')
        const known = await sql.query('SELECT id,version FROM supply.material_versions WHERE material_id=$1 AND content_hash=$2', [materialId, contentHash])
        if (known.rows[0]) {
          currentVersion = Number(known.rows[0].version)
        } else {
          currentVersion += 1
          await sql.query(`INSERT INTO supply.material_versions (id,material_id,version,content_hash,canonical_snapshot,import_batch_id,created_at)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6,now())`, [randomUUID(), materialId, currentVersion, contentHash, JSON.stringify(nextSnapshot), current.import_batch_id])
        }
      }
      if (contentChanged || nextStatus !== current.status) {
        await sql.query(`UPDATE supply.materials SET title=$1,description=$2,price=$3,main_images=$4::jsonb,detail_images=$5::jsonb,sku=$6::jsonb,attributes=$7::jsonb,current_version=$8,status=$9,updated_at=now()
          WHERE id=$10 AND user_id=$11`, [nextSnapshot.title, nextSnapshot.description, nextSnapshot.price, JSON.stringify(nextSnapshot.mainImages), JSON.stringify(nextSnapshot.detailImages), JSON.stringify(nextSnapshot.sku), JSON.stringify(nextSnapshot.attributes), currentVersion, nextStatus, materialId, claims.sub])
      }
      const updated = await sql.query(`SELECT id,source_type AS "sourceType",source_platform AS "sourcePlatform",source_item_id AS "sourceItemId",source_url AS "sourceUrl",title,description,price::float8 AS price,main_images AS "mainImages",detail_images AS "detailImages",sku,attributes,current_version AS "currentVersion",status,updated_at AS "updatedAt"
        FROM supply.materials WHERE id=$1 AND user_id=$2`, [materialId, claims.sub])
      return { ...updated.rows[0], changed: contentChanged || nextStatus !== current.status }
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : '素材编辑失败') }
  })
  app.delete('/v1/supply/materials/:materialId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const materialId = String((request.params as { materialId?: string }).materialId ?? '')
    const result = await sql.query(`UPDATE supply.materials SET status='archived',updated_at=now()
      WHERE id=$1 AND user_id=$2 AND status <> 'archived' RETURNING id,status,updated_at AS "updatedAt"`, [materialId, claims.sub])
    if (!result.rows[0]) {
      const exists = await sql.query('SELECT 1 FROM supply.materials WHERE id=$1 AND user_id=$2', [materialId, claims.sub])
      return exists.rows[0] ? { id: materialId, status: 'archived', archived: true, duplicate: true } : fail(reply, 404, '素材不存在')
    }
    return { ...result.rows[0], archived: true, duplicate: false }
  })
  app.post('/v1/supply/publish-plans', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    try {
      const input = parseSupplyPublishPlan(request.body)
      const existing = await sql.query(`SELECT p.id,p.material_id AS "materialId",p.material_version_id AS "materialVersionId",p.material_version AS "materialVersion",p.material_snapshot AS "materialSnapshot",p.idempotency_key AS "idempotencyKey",p.schedule_mode AS "scheduleMode",p.scheduled_at AS "scheduledAt",p.window_start AS "windowStart",p.window_end AS "windowEnd",p.status,p.created_at AS "createdAt",p.updated_at AS "updatedAt"
        FROM supply.publish_plans p WHERE p.user_id=$1 AND p.idempotency_key=$2`, [claims.sub, input.idempotencyKey])
      if (existing.rows[0]) return { ...existing.rows[0], duplicate: true }
      const material = await sql.query(`SELECT m.id,m.status,m.current_version,v.id AS material_version_id,v.canonical_snapshot
        FROM supply.materials m JOIN supply.material_versions v ON v.material_id=m.id AND v.version=m.current_version
        WHERE m.id=$1 AND m.user_id=$2`, [input.materialId, claims.sub])
      const current = material.rows[0]
      if (!current) return fail(reply, 404, '素材不存在')
      if (current.status === 'archived') return fail(reply, 409, '已归档素材不能创建发布计划')
      const planId = randomUUID()
      const created = await sql.query(`INSERT INTO supply.publish_plans (id,user_id,material_id,material_version_id,material_version,material_snapshot,idempotency_key,schedule_mode,scheduled_at,window_start,window_end,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,'planned',now(),now())
        ON CONFLICT (user_id,idempotency_key) DO NOTHING RETURNING id`, [planId, claims.sub, current.id, current.material_version_id, current.current_version, JSON.stringify(current.canonical_snapshot), input.idempotencyKey, input.schedule.mode, input.schedule.scheduledAt, input.schedule.windowStart ?? null, input.schedule.windowEnd ?? null])
      const id = String(created.rows[0]?.id ?? '')
      const result = await sql.query(`SELECT p.id,p.material_id AS "materialId",p.material_version_id AS "materialVersionId",p.material_version AS "materialVersion",p.material_snapshot AS "materialSnapshot",p.idempotency_key AS "idempotencyKey",p.schedule_mode AS "scheduleMode",p.scheduled_at AS "scheduledAt",p.window_start AS "windowStart",p.window_end AS "windowEnd",p.status,p.created_at AS "createdAt",p.updated_at AS "updatedAt"
        FROM supply.publish_plans p WHERE p.user_id=$1 AND p.idempotency_key=$2`, [claims.sub, input.idempotencyKey])
      if (!result.rows[0]) throw new Error('发布计划幂等声明失败')
      return { ...result.rows[0], duplicate: !id }
    } catch (error) {
      if (error && typeof error === 'object' && 'statusCode' in error) throw error
      return fail(reply, 400, error instanceof Error ? error.message : '发布计划创建失败')
    }
  })
  app.get('/v1/supply/publish-plans/:planId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const planId = String((request.params as { planId?: string }).planId ?? '')
    const result = await sql.query(`SELECT p.id,p.material_id AS "materialId",p.material_version_id AS "materialVersionId",p.material_version AS "materialVersion",p.material_snapshot AS "materialSnapshot",p.idempotency_key AS "idempotencyKey",p.schedule_mode AS "scheduleMode",p.scheduled_at AS "scheduledAt",p.window_start AS "windowStart",p.window_end AS "windowEnd",p.status,p.created_at AS "createdAt",p.updated_at AS "updatedAt"
      FROM supply.publish_plans p WHERE p.id=$1 AND p.user_id=$2`, [planId, claims.sub])
    if (!result.rows[0]) return fail(reply, 404, '发布计划不存在')
    return result.rows[0]
  })
  app.patch('/v1/supply/publish-plans/:planId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const planId = String((request.params as { planId?: string }).planId ?? '')
    try {
      const patch = parseSupplyPublishPlanPatch(request.body)
      const existing = await sql.query('SELECT id,status,schedule_mode,scheduled_at,window_start,window_end FROM supply.publish_plans WHERE id=$1 AND user_id=$2', [planId, claims.sub])
      if (!existing.rows[0]) return fail(reply, 404, '发布计划不存在')
      if (existing.rows[0].status !== 'planned') return fail(reply, 409, '只有待发布计划可以编辑')
      const schedule = patch.schedule ?? {
        mode: existing.rows[0].schedule_mode as SupplyPublishPlanInput['schedule']['mode'],
        scheduledAt: timestamp(existing.rows[0].scheduled_at),
        windowStart: existing.rows[0].window_start ? timestamp(existing.rows[0].window_start) : undefined,
        windowEnd: existing.rows[0].window_end ? timestamp(existing.rows[0].window_end) : undefined
      }
      const status = patch.status ?? 'planned'
      const updated = await sql.query(`UPDATE supply.publish_plans SET schedule_mode=$1,scheduled_at=$2,window_start=$3,window_end=$4,status=$5,updated_at=now()
        WHERE id=$6 AND user_id=$7
        RETURNING id,material_id AS "materialId",material_version_id AS "materialVersionId",material_version AS "materialVersion",material_snapshot AS "materialSnapshot",idempotency_key AS "idempotencyKey",schedule_mode AS "scheduleMode",scheduled_at AS "scheduledAt",window_start AS "windowStart",window_end AS "windowEnd",status,created_at AS "createdAt",updated_at AS "updatedAt"`, [schedule.mode, schedule.scheduledAt, schedule.windowStart ?? null, schedule.windowEnd ?? null, status, planId, claims.sub])
      return updated.rows[0]
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : '发布计划编辑失败') }
  })
  app.post('/v1/monitors', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    try {
      const input = parseMonitorTaskInput(request.body, true)
      const status = input.status ?? 'active'
      const insertTask = (activeSlot: number | null) => sql.query(`INSERT INTO ops.monitor_tasks (id,user_id,kind,rule_json,rule_version,status,active_slot,interval_seconds,next_run_at,created_at,updated_at)
        VALUES ($1,$2,'search',$3::jsonb,1,$4,$5,$6,now(),now(),now())
        RETURNING ${monitorTaskColumns}`, [randomUUID(), claims.sub, JSON.stringify(input.rule), status, activeSlot, input.intervalSeconds])
      const task = status === 'active'
        ? await withActiveTaskSlotRetry(sql, String(claims.sub), undefined, (activeSlot) => insertTask(activeSlot))
        : await insertTask(null)
      return monitorTaskResponse(task.rows[0])
    } catch (error) {
      if (error instanceof MonitorTaskRequestError) return fail(reply, error.status, error.message)
      if (isUniqueViolation(error)) return fail(reply, 403, '当前采集权益最多启用搜索任务')
      throw error
    }
  })
  app.get('/v1/monitors/:taskId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const task = taskId ? await ownedMonitorTask(sql, String(claims.sub), taskId) : undefined
    if (!task) return fail(reply, 404, '监控任务不存在')
    return monitorTaskResponse(task)
  })
  app.patch('/v1/monitors/:taskId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const existing = taskId ? await ownedMonitorTask(sql, String(claims.sub), taskId) : undefined
    if (!existing) return fail(reply, 404, '监控任务不存在')
    try {
      const input = parseMonitorTaskInput(request.body, false)
      if (!input.rule && input.intervalSeconds === undefined && input.status === undefined) throw new MonitorTaskRequestError('至少更新一个任务字段')
      const current = monitorTaskResponse(existing)
      const status = input.status ?? current.status
      const updateTask = (activeSlot: number | null) => sql.query(`UPDATE ops.monitor_tasks
        SET rule_json=$1::jsonb, interval_seconds=$2, status=$3, active_slot=$4, rule_version=rule_version+1, next_run_at=now(), updated_at=now()
        WHERE id=$5 AND user_id=$6
        RETURNING ${monitorTaskColumns}`, [JSON.stringify(input.rule ?? current.rule), input.intervalSeconds ?? current.intervalSeconds, status, activeSlot, taskId, claims.sub])
      const task = status === 'active'
        ? await withActiveTaskSlotRetry(sql, String(claims.sub), taskId, (activeSlot) => updateTask(activeSlot))
        : await updateTask(null)
      if (!task.rows[0]) return fail(reply, 404, '监控任务不存在')
      return monitorTaskResponse(task.rows[0])
    } catch (error) {
      if (error instanceof MonitorTaskRequestError) return fail(reply, error.status, error.message)
      if (isUniqueViolation(error)) return fail(reply, 403, '当前采集权益最多启用搜索任务')
      throw error
    }
  })
  app.delete('/v1/monitors/:taskId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const deleted = taskId ? await sql.query('DELETE FROM ops.monitor_tasks WHERE id=$1 AND user_id=$2 RETURNING id', [taskId, claims.sub]) : { rows: [] }
    if (!deleted.rows[0]) return fail(reply, 404, '监控任务不存在')
    return { deleted: true }
  })
  app.post('/v1/seller-monitors', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    try {
      const input = parseSellerMonitorTaskInput(request.body, true, sellerProfileHosts)
      if (!input.platformSellerId) throw new MonitorTaskRequestError('卖家目标无效')
      const platform = input.platform ?? 'goofish'
      const profileUrl = input.profileUrl ?? canonicalSellerProfileUrl(platform, input.platformSellerId)
      const sellerId = await findOrCreateSellerProfile(sql, platform, input.platformSellerId)
      if (!sellerId) throw new Error('卖家目标创建失败')
      const status = input.status ?? 'active'
      const insertTask = (activeSlot: number | null) => sql.query(`INSERT INTO ops.seller_monitor_tasks (id,user_id,seller_id,profile_url,rule_version,status,active_slot,interval_seconds,next_run_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,1,$5,$6,$7,now(),now(),now())
        RETURNING id`, [randomUUID(), claims.sub, sellerId, profileUrl, status, activeSlot, input.intervalSeconds])
      const inserted = status === 'active'
        ? await withActiveSellerTaskSlotRetry(sql, String(claims.sub), undefined, (activeSlot) => insertTask(activeSlot))
        : await insertTask(null)
      const task = await ownedSellerMonitorTask(sql, String(claims.sub), String(inserted.rows[0]?.id ?? ''))
      if (!task) throw new Error('卖家任务创建失败')
      return sellerMonitorTaskResponse(task)
    } catch (error) {
      if (error instanceof MonitorTaskRequestError) return fail(reply, error.status, error.message)
      if (isUniqueViolation(error)) return fail(reply, 409, '该卖家已在监控列表中')
      throw error
    }
  })
  app.get('/v1/seller-monitors/:taskId/profile', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const task = taskId ? await ownedSellerMonitorTask(sql, String(claims.sub), taskId) : undefined
    if (!task) return fail(reply, 404, '竞品商家任务不存在')
    const seller = await sql.query(`SELECT id,platform,platform_seller_id AS "platformSellerId",public_name AS "publicName",region,public_profile AS "publicProfile",first_seen_at AS "firstSeenAt",last_seen_at AS "lastSeenAt"
      FROM market.seller_profiles WHERE id=$1`, [task.sellerId])
    if (!seller.rows[0]) return fail(reply, 404, '竞品商家不存在')
    return { task: sellerMonitorTaskResponse(task), seller: seller.rows[0] }
  })
  app.get('/v1/seller-monitors/:taskId/items', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const task = taskId ? await ownedSellerMonitorTask(sql, String(claims.sub), taskId) : undefined
    if (!task) return fail(reply, 404, '竞品商家任务不存在')
    try {
      const context = await prepareList(sql, { ...(request.query as Record<string, unknown>), sellerId: String(task.sellerId) }, sellerItemsListConfig, domains.user.secret)
      return await executeList(sql, context, domains.user.secret, sellerItemsPlan(context, String(claims.sub)), String(claims.sub))
    } catch (error) {
      if (error instanceof ListRequestError) return listFail(reply, error)
      throw error
    }
  })
  app.get('/v1/seller-monitors/:taskId/events', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const task = taskId ? await ownedSellerMonitorTask(sql, String(claims.sub), taskId) : undefined
    if (!task) return fail(reply, 404, '竞品商家任务不存在')
    try {
      const context = await prepareList(sql, { ...(request.query as Record<string, unknown>), sellerId: String(task.sellerId) }, sellerEventsListConfig, domains.user.secret)
      return await executeList(sql, context, domains.user.secret, sellerEventsPlan(context, String(claims.sub)), String(claims.sub))
    } catch (error) {
      if (error instanceof ListRequestError) return listFail(reply, error)
      throw error
    }
  })
  app.get('/v1/seller-monitors/:taskId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const task = taskId ? await ownedSellerMonitorTask(sql, String(claims.sub), taskId) : undefined
    if (!task) return fail(reply, 404, '竞品商家任务不存在')
    return sellerMonitorTaskResponse(task)
  })
  app.patch('/v1/seller-monitors/:taskId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const existing = taskId ? await ownedSellerMonitorTask(sql, String(claims.sub), taskId) : undefined
    if (!existing) return fail(reply, 404, '竞品商家任务不存在')
    try {
      const input = parseSellerMonitorTaskInput(request.body, false, sellerProfileHosts)
      if (input.profileUrl === undefined && input.intervalSeconds === undefined && input.status === undefined) throw new MonitorTaskRequestError('至少更新一个任务字段')
      const current = sellerMonitorTaskResponse(existing)
      if (input.profileUrl !== undefined) {
        const profileSellerId = sellerIdFromProfileUrl(input.profileUrl)
        if (!profileSellerId || profileSellerId !== current.platformSellerId) throw new MonitorTaskRequestError('profileUrl 必须包含与当前卖家一致的稳定 ID')
      }
      const status = input.status ?? current.status
      const updateTask = (activeSlot: number | null) => sql.query(`UPDATE ops.seller_monitor_tasks
        SET profile_url=$1, interval_seconds=$2, status=$3, active_slot=$4, rule_version=rule_version+1, next_run_at=now(), updated_at=now()
        WHERE id=$5 AND user_id=$6
        RETURNING id`, [input.profileUrl ?? current.profileUrl, input.intervalSeconds ?? current.intervalSeconds, status, activeSlot, taskId, claims.sub])
      const updated = status === 'active'
        ? await withActiveSellerTaskSlotRetry(sql, String(claims.sub), taskId, (activeSlot) => updateTask(activeSlot))
        : await updateTask(null)
      if (!updated.rows[0]) return fail(reply, 404, '竞品商家任务不存在')
      const task = await ownedSellerMonitorTask(sql, String(claims.sub), taskId)
      if (!task) return fail(reply, 404, '竞品商家任务不存在')
      return sellerMonitorTaskResponse(task)
    } catch (error) {
      if (error instanceof MonitorTaskRequestError) return fail(reply, error.status, error.message)
      if (isUniqueViolation(error)) return fail(reply, 403, `当前账号最多启用 ${MAX_ACTIVE_SELLER_TASKS} 个竞品商家`)
      throw error
    }
  })
  app.delete('/v1/seller-monitors/:taskId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const deleted = taskId ? await sql.query('DELETE FROM ops.seller_monitor_tasks WHERE id=$1 AND user_id=$2 RETURNING id', [taskId, claims.sub]) : { rows: [] }
    if (!deleted.rows[0]) return fail(reply, 404, '竞品商家任务不存在')
    return { deleted: true }
  })
  app.post('/v1/published-item-monitors', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    try {
      const input = parsePublishedItemMonitorTaskInput(request.body, true, publishedItemHosts)
      if (!input.platformItemId || !input.itemUrl) throw new MonitorTaskRequestError('发布商品目标无效')
      const task = await createPublishedItemMonitor(sql, String(claims.sub), { platformItemId: input.platformItemId, itemUrl: input.itemUrl, publishPlanId: input.publishPlanId, status: input.status, intervalSeconds: input.intervalSeconds })
      if (!task) throw new Error('发布商品任务创建失败')
      return publishedItemMonitorTaskResponse(task)
    } catch (error) {
      if (error instanceof MonitorTaskRequestError) return fail(reply, error.status, error.message)
      if (isUniqueViolation(error)) return fail(reply, 409, '该闲鱼商品已在发布监控列表中')
      throw error
    }
  })
  app.get('/v1/published-item-monitors/:taskId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const task = taskId ? await ownedPublishedItemMonitorTask(sql, String(claims.sub), taskId) : undefined
    if (!task) return fail(reply, 404, '发布商品任务不存在')
    return publishedItemMonitorTaskResponse(task)
  })
  app.patch('/v1/published-item-monitors/:taskId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const existing = taskId ? await ownedPublishedItemMonitorTask(sql, String(claims.sub), taskId) : undefined
    if (!existing) return fail(reply, 404, '发布商品任务不存在')
    try {
      const input = parsePublishedItemMonitorTaskInput(request.body, false, publishedItemHosts)
      if (input.intervalSeconds === undefined && input.status === undefined) throw new MonitorTaskRequestError('至少更新一个任务字段')
      const status = input.status ?? String(existing.status) as PublishedItemMonitorTaskStatus
      const updated = await sql.query(`UPDATE ops.published_item_monitor_tasks
        SET interval_seconds=$1,status=$2,rule_version=rule_version+1,next_run_at=now(),updated_at=now()
        WHERE id=$3 AND user_id=$4 RETURNING id`, [input.intervalSeconds ?? Number(existing.intervalSeconds), status, taskId, claims.sub])
      if (!updated.rows[0]) return fail(reply, 404, '发布商品任务不存在')
      const task = await ownedPublishedItemMonitorTask(sql, String(claims.sub), taskId)
      return publishedItemMonitorTaskResponse(task as Record<string, unknown>)
    } catch (error) {
      if (error instanceof MonitorTaskRequestError) return fail(reply, error.status, error.message)
      throw error
    }
  })
  app.delete('/v1/published-item-monitors/:taskId', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    const taskId = String((request.params as { taskId?: string }).taskId ?? '')
    const deleted = taskId ? await sql.query('DELETE FROM ops.published_item_monitor_tasks WHERE id=$1 AND user_id=$2 RETURNING id', [taskId, claims.sub]) : { rows: [] }
    if (!deleted.rows[0]) return fail(reply, 404, '发布商品任务不存在')
    return { deleted: true }
  })
  registerListEndpoint(app, ['/v1/market/items'], sql, domains.user, 'user', marketItemsListConfig, marketItemsPlan(marketItemsListConfig.resource, true), 401, '未授权')
  registerListEndpoint(app, ['/v1/supply/materials'], sql, domains.user, 'user', userSupplyMaterialsListConfig, userSupplyMaterialsPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/supply/publish-plans'], sql, domains.user, 'user', userSupplyPublishPlansListConfig, userSupplyPublishPlansPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/monitors'], sql, domains.user, 'user', userMonitorsListConfig, userMonitorsPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/seller-monitors'], sql, domains.user, 'user', userSellerMonitorsListConfig, userSellerMonitorsPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/published-item-monitors'], sql, domains.user, 'user', userPublishedItemMonitorsListConfig, userPublishedItemMonitorsPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/sellers', '/v1/market/sellers'], sql, domains.user, 'user', userSellersListConfig, userSellersPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/discoveries', '/v1/market/discoveries'], sql, domains.user, 'user', userDiscoveriesListConfig, userInsightPlan(userDiscoveriesListConfig.resource), 401, '未授权')
  registerListEndpoint(app, ['/v1/events', '/v1/market/events'], sql, domains.user, 'user', userEventsListConfig, userEventsPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/logs', '/v1/dynamic-logs'], sql, domains.user, 'user', userLogsListConfig, userLogsPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/ai', '/v1/ai/insights'], sql, domains.user, 'user', { ...userDiscoveriesListConfig, resource: 'user.ai' }, userInsightPlan('user.ai'), 401, '未授权')
  registerListEndpoint(app, ['/v1/announcements'], sql, domains.user, 'user', userAnnouncementsListConfig, userAnnouncementsPlan, 401, '未授权')
  return app
}

export function createAdminApi(sql: Sql, domains: Domains, options: ApiOptions = {}) {
  const app = Fastify({ logger: false })
  installCors(app, options.allowedOrigins ?? [])
  app.get('/health', async () => ({ service: 'admin-api', ok: true }))
  app.post('/v1/auth/login', async (request, reply) => {
    const input = body<{ email?: string; password?: string }>(request.body); const found = await sql.query('SELECT id,email_normalized,password_hash,status,role,mfa_state FROM identity.admin_users WHERE email_normalized=$1', [input.email?.trim().toLowerCase()]); const admin = found.rows[0] as (UserRow & { role: string; mfa_state: string }) | undefined
    if (!admin || admin.status !== 'active' || admin.mfa_state !== 'enrolled' || !credentialValid(input.password) || !(await verifyPassword(input.password, admin.password_hash))) return fail(reply, 401, '管理员认证失败')
    return issue(sql, domains.admin, 'admin', admin.id)
  })
  app.post('/v1/auth/refresh', async (request, reply) => {
    try {
      const input = body<{ refreshToken?: string; clientId?: string }>(request.body)
      return await refresh(sql, domains.admin, 'admin', input.refreshToken ?? '', input.clientId)
    } catch (error) { return fail(reply, 401, error instanceof Error ? error.message : '刷新失败') }
  })
  app.get('/v1/me', async (request, reply) => { try { const claims = await authenticate(sql, domains.admin, 'admin', request.headers.authorization); const rows = await sql.query('SELECT role FROM identity.admin_users WHERE id=$1', [claims.sub]); return { id: claims.sub, role: rows.rows[0]?.role } } catch { return fail(reply, 403, '管理员权限不足') } })
  app.patch('/v1/admin/users/:id/status', async (request, reply) => {
    try { await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    const input = body<{ enabled?: boolean }>(request.body)
    if (typeof input.enabled !== 'boolean') return fail(reply, 400, '用户状态参数无效')
    const status = input.enabled ? 'active' : 'disabled'
    const userId = String((request.params as { id?: string }).id ?? '')
    const result = await sql.query(`UPDATE identity.users SET status=$2,disabled_at=CASE WHEN $2='disabled' THEN now() ELSE NULL END
      WHERE id=$1 RETURNING id,email_normalized AS account,status,(status='active') AS enabled,disabled_at AS "disabledAt"`, [userId, status])
    if (result.rows[0] && status === 'disabled') await sql.query("UPDATE identity.auth_refresh_sessions SET revoked_at=now() WHERE subject_type='user' AND subject_id=$1 AND revoked_at IS NULL", [userId])
    return result.rows[0] ?? fail(reply, 404, '用户不存在')
  })
  app.patch('/v1/admin/users/:id/points', async (request, reply) => {
    try { await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    const input = body<{ delta?: number }>(request.body)
    if (!Number.isInteger(input.delta) || input.delta === 0 || Math.abs(Number(input.delta)) > 1_000_000) return fail(reply, 400, '积分调整值无效')
    const userId = String((request.params as { id?: string }).id ?? '')
    const current = await sql.query(`SELECT u.id,COALESCE(points.balance,0)::int AS balance
      FROM identity.users u LEFT JOIN billing.user_points points ON points.user_id=u.id WHERE u.id=$1`, [userId])
    if (!current.rows[0]) return fail(reply, 404, '用户不存在')
    const next = Number(current.rows[0].balance) + Number(input.delta)
    if (next < 0) return fail(reply, 400, '积分余额不能小于 0')
    const result = await sql.query(`INSERT INTO billing.user_points (user_id,balance,updated_at)
      VALUES ($1,$2,now()) ON CONFLICT (user_id) DO UPDATE SET balance=$2,updated_at=now()
      RETURNING user_id AS id,balance AS points,$3::int AS delta`, [userId, next, input.delta])
    return result.rows[0]
  })
  app.post('/v1/admin/announcements', async (request, reply) => {
    let claims
    try { claims = await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    try {
      const input = body<{ title?: string; body?: string; scope?: string; userId?: string; enabled?: boolean; startsAt?: string; endsAt?: string }>(request.body)
      const title = input.title?.trim(); const message = input.body?.trim(); const scope = input.scope ?? 'global'
      if (!title || !message || title.length > 160 || message.length > 8_000 || (scope !== 'global' && scope !== 'personal') || (scope === 'personal' && !input.userId) || (scope === 'global' && input.userId)) return fail(reply, 400, '公告参数无效')
      const result = await sql.query(`INSERT INTO ops.announcements (id,title,body,scope,user_id,enabled,starts_at,ends_at,created_by,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()),$8::timestamptz,$9,now(),now())
        RETURNING id,title,body,scope,user_id AS "userId",enabled,starts_at AS "startsAt",ends_at AS "endsAt",created_at AS "createdAt",updated_at AS "updatedAt"`, [randomUUID(), title, message, scope, input.userId ?? null, input.enabled === true, input.startsAt ?? null, input.endsAt ?? null, claims.sub])
      return result.rows[0]
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : '公告创建失败') }
  })
  app.patch('/v1/admin/announcements/:id', async (request, reply) => {
    try { await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    try {
      const input = body<{ title?: string; body?: string; enabled?: boolean; startsAt?: string | null; endsAt?: string | null }>(request.body)
      const values: unknown[] = [String((request.params as { id?: string }).id ?? '')]
      const updates = ['updated_at=now()']
      if (input.title !== undefined) { if (!input.title.trim() || input.title.length > 160) return fail(reply, 400, '公告标题无效'); values.push(input.title.trim()); updates.push(`title=$${values.length}`) }
      if (input.body !== undefined) { if (!input.body.trim() || input.body.length > 8_000) return fail(reply, 400, '公告内容无效'); values.push(input.body.trim()); updates.push(`body=$${values.length}`) }
      if (input.enabled !== undefined) { values.push(input.enabled); updates.push(`enabled=$${values.length}`) }
      if (input.startsAt !== undefined) { values.push(input.startsAt); updates.push(`starts_at=$${values.length}::timestamptz`) }
      if (input.endsAt !== undefined) { values.push(input.endsAt); updates.push(`ends_at=$${values.length}::timestamptz`) }
      const result = await sql.query(`UPDATE ops.announcements SET ${updates.join(',')} WHERE id=$1 RETURNING id,title,body,scope,user_id AS "userId",enabled,starts_at AS "startsAt",ends_at AS "endsAt",updated_at AS "updatedAt"`, values)
      return result.rows[0] ?? fail(reply, 404, '公告不存在')
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : '公告更新失败') }
  })
  app.post('/v1/admin/ai/providers', async (request, reply) => {
    try { await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    try {
      const input = body<{ providerCode?: string; modelReference?: string; baseUrl?: string; apiKeyCiphertext?: string; apiKey?: string; stream?: boolean; reasoning?: boolean; settings?: unknown; status?: string }>(request.body)
      if (!input.providerCode?.trim() || !input.modelReference?.trim() || !input.baseUrl?.trim() || (input.apiKey !== undefined && typeof input.apiKey !== 'string')) return fail(reply, 400, 'AI 提供方参数无效')
      let baseUrl: string
      try { const parsed = new URL(input.baseUrl.trim()); if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(); baseUrl = parsed.toString().replace(/\/$/, '') } catch { return fail(reply, 400, 'AI 提供方地址无效') }
      const settings = input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? input.settings : {}
      const apiKeyCiphertext = input.apiKey ? encryptProviderKey(input.apiKey, domains.admin.secret) : input.apiKeyCiphertext ?? null
      const result = await sql.query(`INSERT INTO ai.provider_configs (id,provider_code,model_reference,base_url,api_key_ciphertext,stream_enabled,reasoning_enabled,settings,status,api_key_updated_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5::text,$6,$7,$8::jsonb,$9,CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,now(),now())
        RETURNING id,provider_code AS "providerCode",model_reference AS "modelReference",base_url AS "baseUrl",stream_enabled AS stream,reasoning_enabled AS reasoning,settings,status,created_at AS "createdAt",updated_at AS "updatedAt"`, [randomUUID(), input.providerCode.trim(), input.modelReference.trim(), baseUrl, apiKeyCiphertext, input.stream === true, input.reasoning === true, JSON.stringify(settings), input.status === 'active' ? 'active' : 'draft'])
      return result.rows[0]
    } catch (error) { return fail(reply, isUniqueViolation(error) ? 409 : 400, isUniqueViolation(error) ? 'AI 提供方已存在' : (error instanceof Error ? error.message : 'AI 提供方创建失败')) }
  })
  app.get('/v1/admin/ai/providers/:id/models', async (request, reply) => {
    try { await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    const id = String((request.params as { id?: string }).id ?? '')
    const found = (await sql.query('SELECT base_url AS "baseUrl",model_reference AS "modelReference",api_key_ciphertext AS "apiKeyCiphertext" FROM ai.provider_configs WHERE id=$1 AND status=\'active\'', [id])).rows[0] as { baseUrl?: string; modelReference?: string; apiKeyCiphertext?: string | null } | undefined
    if (!found?.baseUrl) return fail(reply, 404, 'AI 提供方不存在或未启用')
    try {
      const proxy = options.modelListProxy ?? (async (input: { baseUrl: string; apiKeyCiphertext: string | null }) => {
        const key = decryptProviderKey(input.apiKeyCiphertext, domains.admin.secret)
        const response = await fetch(`${input.baseUrl.replace(/\/$/, '')}/models`, { headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, redirect: 'error' })
        if (!response.ok) throw new Error(`模型列表请求失败 (${response.status})`)
        return response.json()
      })
      const payload = await proxy({ baseUrl: String(found.baseUrl), modelReference: String(found.modelReference ?? ''), apiKeyCiphertext: found.apiKeyCiphertext ?? null })
      return { items: Array.isArray(payload) ? payload : (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : []) }
    } catch (error) { return fail(reply, 502, error instanceof Error ? error.message : '模型列表请求失败') }
  })
  app.patch('/v1/admin/ai/providers/:id', async (request, reply) => {
    try { await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    try {
      const input = body<{ modelReference?: string; baseUrl?: string; apiKeyCiphertext?: string; apiKey?: string; stream?: boolean; reasoning?: boolean; settings?: unknown; status?: string }>(request.body)
      if (input.apiKey !== undefined && typeof input.apiKey !== 'string') return fail(reply, 400, 'AI 提供方参数无效')
      const values: unknown[] = [String((request.params as { id?: string }).id ?? '')]
      const updates: string[] = ['updated_at=now()']
      if (input.modelReference !== undefined) { if (!input.modelReference.trim()) return fail(reply, 400, '模型不能为空'); values.push(input.modelReference.trim()); updates.push(`model_reference=$${values.length}`) }
      if (input.baseUrl !== undefined) { let parsed: URL; try { parsed = new URL(input.baseUrl.trim()); if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error() } catch { return fail(reply, 400, 'AI 提供方地址无效') }; values.push(parsed.toString().replace(/\/$/, '')); updates.push(`base_url=$${values.length}`) }
      if (input.apiKey !== undefined) { values.push(encryptProviderKey(input.apiKey, domains.admin.secret)); updates.push(`api_key_ciphertext=$${values.length},api_key_updated_at=now()`) }
      else if (input.apiKeyCiphertext !== undefined) { values.push(input.apiKeyCiphertext); updates.push(`api_key_ciphertext=$${values.length},api_key_updated_at=now()`) }
      if (input.stream !== undefined) { values.push(input.stream === true); updates.push(`stream_enabled=$${values.length}`) }
      if (input.reasoning !== undefined) { values.push(input.reasoning === true); updates.push(`reasoning_enabled=$${values.length}`) }
      if (input.settings !== undefined) { values.push(JSON.stringify(input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? input.settings : {})); updates.push(`settings=$${values.length}::jsonb`) }
      if (input.status !== undefined) { if (!['draft', 'active', 'retired'].includes(input.status)) return fail(reply, 400, 'AI 提供方状态无效'); values.push(input.status); updates.push(`status=$${values.length}`) }
      const result = await sql.query(`UPDATE ai.provider_configs SET ${updates.join(',')} WHERE id=$1 RETURNING id,provider_code AS "providerCode",model_reference AS "modelReference",base_url AS "baseUrl",stream_enabled AS stream,reasoning_enabled AS reasoning,settings,status,created_at AS "createdAt",updated_at AS "updatedAt"`, values)
      return result.rows[0] ?? fail(reply, 404, 'AI 提供方不存在')
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : 'AI 提供方更新失败') }
  })
  app.post('/v1/admin/ai/capabilities', async (request, reply) => {
    try { await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    try {
      const input = body<{ code?: string; inputSchema?: unknown; outputSchema?: unknown; entitlement?: string }>(request.body)
      if (!input.code?.trim() || !input.entitlement?.trim()) return fail(reply, 400, 'AI 能力参数无效')
      const id = randomUUID()
      const result = await sql.query(`INSERT INTO ai.capabilities (id,code,input_schema,output_schema,entitlement,created_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,now()) RETURNING id,code,published_version AS "publishedVersion",input_schema AS "inputSchema",output_schema AS "outputSchema",entitlement`, [id, input.code.trim(), JSON.stringify(input.inputSchema ?? {}), JSON.stringify(input.outputSchema ?? {}), input.entitlement.trim()])
      return result.rows[0]
    } catch (error) { return fail(reply, isUniqueViolation(error) ? 409 : 400, isUniqueViolation(error) ? 'AI 能力已存在' : (error instanceof Error ? error.message : 'AI 能力创建失败')) }
  })
  app.post('/v1/admin/ai/prompts', async (request, reply) => {
    try { await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    try {
      const input = body<{ capabilityId?: string; version?: number; providerReference?: string; modelReference?: string; promptBody?: string; status?: string }>(request.body)
      if (!input.capabilityId || !Number.isInteger(input.version) || !input.providerReference || !input.modelReference || !input.promptBody) return fail(reply, 400, 'AI 提示版本参数无效')
      const result = await sql.query(`INSERT INTO ai.prompt_versions (id,capability_id,version,provider_reference,model_reference,prompt_body,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now()) RETURNING id,capability_id AS "capabilityId",version,status,created_at AS "createdAt"`, [randomUUID(), input.capabilityId, input.version, input.providerReference, input.modelReference, input.promptBody, input.status === 'published' ? 'published' : 'draft'])
      return result.rows[0]
    } catch (error) { return fail(reply, isUniqueViolation(error) ? 409 : 400, isUniqueViolation(error) ? '提示版本已存在' : (error instanceof Error ? error.message : '提示版本创建失败')) }
  })
  app.post('/v1/admin/ai/prompts/:id/publish', async (request, reply) => {
    try { await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    const result = await sql.query(`UPDATE ai.prompt_versions SET status='published',published_at=now() WHERE id=$1 RETURNING id,capability_id AS "capabilityId",version,status`, [(request.params as { id?: string }).id])
    return result.rows[0] ?? fail(reply, 404, '提示版本不存在')
  })
  app.post('/v1/admin/ai/capabilities/:id/publish', async (request, reply) => {
    try { await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    const input = body<{ promptVersionId?: string }>(request.body)
    const prompt = await sql.query('SELECT version FROM ai.prompt_versions WHERE id=$1 AND capability_id=$2 AND status=\'published\'', [input.promptVersionId, (request.params as { id?: string }).id])
    if (!prompt.rows[0]) return fail(reply, 409, '提示版本未发布')
    const result = await sql.query(`UPDATE ai.capabilities SET published_version=$2 WHERE id=$1 RETURNING id,code,published_version AS "publishedVersion",entitlement`, [(request.params as { id?: string }).id, prompt.rows[0].version])
    return result.rows[0] ?? fail(reply, 404, 'AI 能力不存在')
  })
  app.get('/v1/users', async (request, reply) => {
    try { await authenticate(sql, domains.admin, 'admin', request.headers.authorization) } catch { return fail(reply, 403, '管理员权限不足') }
    try {
      const context = await prepareList(sql, request.query, adminUsersListConfig, domains.admin.secret)
      return await listAdminUsers(sql, context, domains.admin.secret)
    } catch (error) {
      if (error instanceof ListRequestError) return listFail(reply, error)
      throw error
    }
  })
  registerListEndpoint(app, ['/v1/market', '/v1/market/items', '/v1/admin/market'], sql, domains.admin, 'admin', marketItemsAdminListConfig, marketItemsPlan(marketItemsAdminListConfig.resource), 403, '管理员权限不足')
  registerListEndpoint(app, ['/v1/billing', '/v1/billing/orders', '/v1/admin/billing'], sql, domains.admin, 'admin', adminBillingListConfig, adminBillingPlan, 403, '管理员权限不足')
  registerListEndpoint(app, ['/v1/quality', '/v1/quality/categories', '/v1/admin/quality'], sql, domains.admin, 'admin', adminQualityListConfig, adminQualityPlan, 403, '管理员权限不足')
  registerListEndpoint(app, ['/v1/uploads', '/v1/ingest/batches', '/v1/admin/uploads'], sql, domains.admin, 'admin', adminUploadsListConfig, adminUploadsPlan, 403, '管理员权限不足')
  registerListEndpoint(app, ['/v1/ai', '/v1/ai/jobs', '/v1/admin/ai', '/v1/admin/ai/jobs'], sql, domains.admin, 'admin', adminAiJobsListConfig, adminAiJobsPlan, 403, '管理员权限不足')
  registerListEndpoint(app, ['/v1/admin/announcements'], sql, domains.admin, 'admin', adminAnnouncementsListConfig, adminAnnouncementsPlan, 403, '管理员权限不足')
  registerListEndpoint(app, ['/v1/admin/ai/providers'], sql, domains.admin, 'admin', adminProvidersListConfig, adminProvidersPlan, 403, '管理员权限不足')
  registerListEndpoint(app, ['/v1/capacity', '/v1/admin/capacity'], sql, domains.admin, 'admin', adminCapacityListConfig, adminCapacityPlan, 403, '管理员权限不足')
  registerListEndpoint(app, ['/v1/audit', '/v1/audit/logs', '/v1/admin/audit'], sql, domains.admin, 'admin', adminAuditListConfig, adminAuditPlan, 403, '管理员权限不足')
  return app
}

const phase6SensitiveKeys = ['cookie', 'token', 'authorization', 'password', 'session', 'credential', 'secret', 'qr', 'profile', 'loginstate', 'accountstate']

function phase6ContainsSensitive(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(phase6ContainsSensitive)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
    const profileState = normalized !== 'publicprofile' && (normalized === 'profile' || normalized.endsWith('profilepath') || normalized.includes('chromeprofile') || normalized.includes('browserprofile') || normalized.includes('profiledir'))
    return phase6SensitiveKeys.some((sensitive) => normalized.includes(sensitive) && sensitive !== 'profile') || profileState || phase6ContainsSensitive(child)
  })
}

function phase6Record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`)
  const record = value as Record<string, unknown>
  if (phase6ContainsSensitive(record)) throw new Error('上传数据包含本机敏感状态')
  return record
}

function phase6Text(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 无效`)
  return value.trim()
}

function phase6OptionalText(value: unknown, max = 2_048): string | null {
  if (value === undefined || value === null) return null
  return phase6Text(value, '字段', max)
}

function phase6Json(value: unknown): string {
  if (phase6ContainsSensitive(value)) throw new Error('上传数据包含本机敏感状态')
  return JSON.stringify(value && typeof value === 'object' ? value : {})
}

type Phase6IngestRecord = Record<string, unknown> & { type: string; idempotencyKey: string }

function parsePhase6Batch(value: unknown): { schemaVersion: number; deviceId: string; batchId: string; idempotencyKey: string; batchSequence: number; cursorStart: string | null; cursorEnd: string | null; records: Phase6IngestRecord[] } {
  const source = phase6Record(value, '上传请求')
  const schemaVersion = source.schemaVersion
  if (schemaVersion !== 1) throw new Error('schemaVersion 只支持 1')
  const deviceId = phase6Text(source.deviceId, 'deviceId', 128)
  const batchId = phase6Text(source.batchId, 'batchId', 128)
  const idempotencyKey = phase6Text(source.idempotencyKey, 'idempotencyKey', 256)
  const batchSequence = source.batchSequence
  if (!Number.isSafeInteger(batchSequence) || Number(batchSequence) < 0) throw new Error('batchSequence 无效')
  const cursor = source.cursor && typeof source.cursor === 'object' && !Array.isArray(source.cursor) ? source.cursor as Record<string, unknown> : {}
  const cursorStart = phase6OptionalText(cursor.start, 256)
  const cursorEnd = phase6OptionalText(cursor.end, 256)
  if (!Array.isArray(source.records) || source.records.length < 1 || source.records.length > 250) throw new Error('records 必须是 1 到 250 条')
  const records = source.records.map((entry, index) => {
    const record = phase6Record(entry, `records[${index}]`)
    const type = record.type ?? record.kind
    const key = record.idempotencyKey ?? record.eventKey ?? record.contentHash ?? record.platformItemId ?? record.platformSellerId
    if (typeof type !== 'string' || !['seller', 'version', 'item', 'snapshot', 'event'].includes(type)) throw new Error(`records[${index}].type 无效`)
    return { ...record, type, idempotencyKey: phase6Text(key, `records[${index}].idempotencyKey`, 256) }
  })
  return { schemaVersion, deviceId, batchId, idempotencyKey, batchSequence: Number(batchSequence), cursorStart, cursorEnd, records }
}

async function phase6IngestRecord(sql: Sql, record: Phase6IngestRecord, runId: string, batchId: string, recordIndex: number): Promise<'inserted' | 'deduplicated'> {
  const now = new Date().toISOString()
  const type = record.type
  if (type === 'seller') {
    const platform = phase6Text(record.platform ?? 'goofish', 'platform', 32)
    const sellerKey = phase6Text(record.platformSellerId, 'platformSellerId', 256)
    const profile = record.publicProfile && typeof record.publicProfile === 'object' ? record.publicProfile : {}
    const seller = await sql.query(`INSERT INTO market.seller_profiles (id,platform,platform_seller_id,public_name,region,public_profile,first_seen_at,last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7) ON CONFLICT (platform,platform_seller_id) DO UPDATE SET public_name=COALESCE(EXCLUDED.public_name,market.seller_profiles.public_name), region=COALESCE(EXCLUDED.region,market.seller_profiles.region), public_profile=EXCLUDED.public_profile, last_seen_at=EXCLUDED.last_seen_at RETURNING id`,
      [randomUUID(), platform, sellerKey, phase6OptionalText(record.publicName, 256), phase6OptionalText(record.region, 128), phase6Json(profile), now])
    const sellerId = String(seller.rows[0]?.id)
    const hash = phase6Text(record.contentHash ?? createHash('sha256').update(phase6Json(profile)).digest('hex'), 'contentHash', 128)
    const version = await sql.query(`INSERT INTO market.seller_profile_versions (id,seller_id,canonical_payload,content_hash,observed_at)
      VALUES ($1,$2,$3::jsonb,$4,$5) ON CONFLICT (seller_id,content_hash) DO NOTHING RETURNING id`, [randomUUID(), sellerId, phase6Json(profile), hash, now])
    await sql.query('INSERT INTO ops.ingest_record_dedup (batch_id,record_index,idempotency_key,entity_type,entity_id,payload_hash,accepted_at,status,inserted,processed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7) ON CONFLICT (batch_id,record_index) DO NOTHING', [batchId, recordIndex, record.idempotencyKey, 'seller', sellerKey, hash, now, 'accepted', Boolean(version.rows[0])])
    return version.rows[0] ? 'inserted' : 'deduplicated'
  }
  const platform = phase6Text(record.platform ?? 'goofish', 'platform', 32)
  const itemKey = phase6Text(record.platformItemId, 'platformItemId', 256)
  let sellerId: string | null = null
  if (record.platformSellerId) {
    const seller = await sql.query(`INSERT INTO market.seller_profiles (id,platform,platform_seller_id,public_profile,first_seen_at,last_seen_at) VALUES ($1,$2,$3,'{}'::jsonb,$4,$4) ON CONFLICT (platform,platform_seller_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at RETURNING id`, [randomUUID(), platform, phase6Text(record.platformSellerId, 'platformSellerId', 256), now])
    sellerId = String(seller.rows[0]?.id)
  }
  const item = await sql.query(`INSERT INTO market.items (id,platform,platform_item_id,seller_id,lifecycle_state,first_seen_at,last_seen_at)
    VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (platform,platform_item_id) DO UPDATE SET seller_id=COALESCE(EXCLUDED.seller_id,market.items.seller_id), lifecycle_state=EXCLUDED.lifecycle_state, last_seen_at=EXCLUDED.last_seen_at RETURNING id`, [randomUUID(), platform, itemKey, sellerId, record.state ?? 'unknown', now])
  const itemId = String(item.rows[0]?.id)
  if (sellerId) await sql.query(`INSERT INTO market.seller_item_relations (seller_id,item_id,first_seen_at,last_seen_at,state) VALUES ($1,$2,$3,$3,$4) ON CONFLICT (seller_id,item_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,state=EXCLUDED.state`, [sellerId, itemId, now, record.state ?? 'unknown'])
  if (type === 'item' || type === 'version') {
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : record
    const hash = phase6Text(record.contentHash ?? createHash('sha256').update(phase6Json(payload)).digest('hex'), 'contentHash', 128)
    const version = await sql.query(`INSERT INTO market.item_versions (id,item_id,title,price,region,condition_text,want_count,canonical_payload,content_hash,observed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT (item_id,content_hash) DO NOTHING RETURNING id`, [randomUUID(), itemId, phase6OptionalText(record.title, 512), record.price ?? null, phase6OptionalText(record.region, 128), phase6OptionalText(record.conditionText, 128), record.wantCount ?? null, phase6Json(payload), hash, record.observedAt ?? now])
    return version.rows[0] ? 'inserted' : 'deduplicated'
  }
  if (type === 'snapshot') {
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : record
    const hash = phase6Text(record.payloadHash ?? createHash('sha256').update(phase6Json(payload)).digest('hex'), 'payloadHash', 128)
    const existing = await sql.query('SELECT 1 FROM market.observations WHERE item_id=$1 AND payload_hash=$2 LIMIT 1', [itemId, hash])
    if (existing.rows[0]) return 'deduplicated'
    await sql.query(`INSERT INTO market.observations (id,collected_at,received_at,collection_run_id,item_id,platform_item_id,platform_seller_id,payload_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), record.observedAt ?? now, now, runId, itemId, itemKey, record.platformSellerId ?? null, hash])
    return 'inserted'
  }
  const eventKey = phase6Text(record.eventKey ?? record.idempotencyKey, 'eventKey', 256)
  const occurredAt = record.occurredAt ?? now
  const eventId = randomUUID()
  const claimed = await sql.query('INSERT INTO market.item_event_dedup (event_key,event_id,occurred_at) VALUES ($1,$2,$3) ON CONFLICT (event_key) DO NOTHING RETURNING event_id', [eventKey, eventId, occurredAt])
  if (!claimed.rows[0]) return 'deduplicated'
  await sql.query(`INSERT INTO market.item_events (id,occurred_at,detected_at,item_id,seller_id,event_type,event_key) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [eventId, occurredAt, now, itemId, sellerId, phase6Text(record.eventType, 'eventType', 64), eventKey])
  return 'inserted'
}

export function createCollectorApi(sql: Sql, domains: Domains) {
  const app = Fastify({ logger: false })
  app.get('/health', async () => ({ service: 'collector-api', ok: true }))
  app.post('/v1/devices/bind', async (request, reply) => {
    const input = body<{ publicKey?: string; proof?: string; deviceName?: string }>(request.body)
    try {
      const user = await authenticate(sql, domains.user, 'user', request.headers.authorization); const key = Buffer.from(input.publicKey ?? '', 'base64'); const proof = Buffer.from(input.proof ?? '', 'base64')
      if (!key.length || !verify(null, Buffer.from(user.sub ?? ''), { key, format: 'der', type: 'spki' }, proof)) return fail(reply, 401, '设备签名无效')
      const fingerprint = createHash('sha256').update(key).digest('hex')
      const existing = (await sql.query('SELECT id,status FROM identity.collector_clients WHERE user_id=$1 AND device_public_key_fingerprint=$2', [user.sub, fingerprint])).rows[0] as { id: string; status: string } | undefined
      if (existing?.status === 'active') return { clientId: existing.id, ...(await issue(sql, domains.collector, 'collector', existing.id, existing.id)) }
      if (existing?.status === 'blocked') return fail(reply, 403, '设备已被封禁')
      if (existing?.status === 'revoked') {
        const rebound = await sql.query(`WITH available_slot AS (
            SELECT CASE
              WHEN NOT EXISTS (SELECT 1 FROM identity.collector_clients WHERE user_id = $1 AND status = 'active' AND active_slot = 1) THEN 1::smallint
              WHEN NOT EXISTS (SELECT 1 FROM identity.collector_clients WHERE user_id = $1 AND status = 'active' AND active_slot = 2) THEN 2::smallint
            END AS active_slot
          )
          UPDATE identity.collector_clients
          SET status='active', active_slot=available_slot.active_slot, revoked_at=NULL, device_name=$2, platform='windows', app_version='phase3', last_seen_at=now()
          FROM available_slot
          WHERE id=$3 AND status='revoked' AND available_slot.active_slot IS NOT NULL
          RETURNING id`, [user.sub, input.deviceName ?? 'Collector', existing.id])
        if (!rebound.rows[0]) return fail(reply, 403, '设备数量已达上限')
        return { clientId: existing.id, ...(await issue(sql, domains.collector, 'collector', existing.id, existing.id)) }
      }
      const id = randomUUID()
      const bound = await sql.query(`WITH available_slot AS (
          SELECT CASE
            WHEN NOT EXISTS (SELECT 1 FROM identity.collector_clients WHERE user_id = $1 AND status = 'active' AND active_slot = 1) THEN 1::smallint
            WHEN NOT EXISTS (SELECT 1 FROM identity.collector_clients WHERE user_id = $1 AND status = 'active' AND active_slot = 2) THEN 2::smallint
          END AS active_slot
        )
        INSERT INTO identity.collector_clients (id,user_id,device_public_key_fingerprint,active_slot,device_name,platform,app_version,status,last_seen_at,created_at)
        SELECT $2,$1,$3,available_slot.active_slot,$4,'windows','phase3','active',now(),now()
        FROM available_slot
        WHERE available_slot.active_slot IS NOT NULL
        RETURNING id`, [user.sub, id, fingerprint, input.deviceName ?? 'Collector'])
      if (!bound.rows[0]) return fail(reply, 403, '设备数量已达上限')
      return { clientId: id, ...(await issue(sql, domains.collector, 'collector', id, id)) }
    } catch (error) { return fail(reply, isUniqueViolation(error) ? 403 : 401, isUniqueViolation(error) ? '设备数量已达上限' : '设备绑定失败') }
  })
  app.post('/v1/auth/refresh', async (request, reply) => {
    try { return await refresh(sql, domains.collector, 'collector', body<{ refreshToken?: string }>(request.body).refreshToken ?? '') } catch (error) { return fail(reply, 401, error instanceof Error ? error.message : '刷新失败') }
  })
  app.get('/v1/entitlements', async (request, reply) => {
    try {
      const claims = await authenticate(sql, domains.collector, 'collector', request.headers.authorization)
      const client = await activeCollector(sql, String(claims.sub))
      return await collectorEntitlements(sql, client.user_id)
    } catch (error) {
      return fail(reply, 403, error instanceof Error ? error.message : '采集器权限不足')
    }
  })
  app.post('/v1/supply/publish-plans/claim', async (request, reply) => {
    let claims: Awaited<ReturnType<typeof authenticate>>
    let client: { user_id: string }
    try {
      claims = await authenticate(sql, domains.collector, 'collector', request.headers.authorization)
      client = await activeCollector(sql, String(claims.sub))
      await requireCollectorEntitlement(sql, client.user_id)
    } catch (error) {
      return fail(reply, 403, error instanceof Error ? error.message : '采集器权限不足')
    }
    try {
      const input = parseSupplyPublishClaim(request.body)
      if (input.deviceId !== String(claims.sub)) return fail(reply, 403, 'deviceId 与授权设备不匹配')
      const existing = await sql.query(`SELECT b.id,b.status,b.requested_limit
        FROM supply.publish_claim_batches b
        WHERE b.client_id=$1 AND b.idempotency_key=$2`, [claims.sub, input.idempotencyKey])
      let claimBatchId = String(existing.rows[0]?.id ?? '')
      let duplicate = Boolean(claimBatchId)
      let claimLimit = Number(existing.rows[0]?.requested_limit ?? input.limit)
      if (!claimBatchId) {
        const inserted = await sql.query(`INSERT INTO supply.publish_claim_batches (id,user_id,client_id,idempotency_key,requested_limit,created_at)
          VALUES ($1,$2,$3,$4,$5,now())
          ON CONFLICT (client_id,idempotency_key) DO NOTHING
          RETURNING id`, [randomUUID(), client.user_id, claims.sub, input.idempotencyKey, input.limit])
        claimBatchId = String(inserted.rows[0]?.id ?? '')
        duplicate = !claimBatchId
        if (!claimBatchId) {
          const raced = await sql.query('SELECT id,status,requested_limit FROM supply.publish_claim_batches WHERE client_id=$1 AND idempotency_key=$2', [claims.sub, input.idempotencyKey])
          claimBatchId = String(raced.rows[0]?.id ?? '')
          claimLimit = Number(raced.rows[0]?.requested_limit ?? input.limit)
        }
        if (!claimBatchId) throw new Error('发布计划领取幂等声明失败')
      }
      const batchState = await sql.query('SELECT status FROM supply.publish_claim_batches WHERE id=$1 AND client_id=$2 AND user_id=$3', [claimBatchId, claims.sub, client.user_id])
      if (!batchState.rows[0]) throw new Error('发布计划领取批次不存在')
      if (String(batchState.rows[0].status) !== 'completed') {
        const due = await sql.query(`WITH candidates AS (
              SELECT p.id
              FROM supply.publish_plans p
              WHERE p.user_id=$1 AND p.status='planned' AND p.scheduled_at <= now()
              ORDER BY p.scheduled_at ASC,p.id ASC
              LIMIT $2
            ), claimed AS (
              UPDATE supply.publish_plans p
              SET status='claimed',claimed_by_client_id=$3,claimed_at=now(),updated_at=now()
              FROM candidates c
              WHERE p.id=c.id AND p.status='planned'
              RETURNING p.id
            )
              SELECT id FROM claimed`, [client.user_id, claimLimit, claims.sub])
          for (const row of due.rows) {
            await sql.query(`INSERT INTO supply.publish_plan_claims (id,claim_batch_id,plan_id,user_id,client_id,claimed_at)
              VALUES ($1,$2,$3,$4,$5,now())
              ON CONFLICT (plan_id) DO NOTHING
              RETURNING plan_id`, [randomUUID(), claimBatchId, row.id, client.user_id, claims.sub])
          }
        if (due.rows.length) {
          const updatedIds = due.rows.map((row) => String(row.id))
          await sql.query(`UPDATE supply.publish_plans
            SET claimed_by_client_id=NULL,claimed_at=NULL,status='planned',updated_at=now()
            WHERE user_id=$1 AND id = ANY($2::uuid[]) AND id NOT IN (
              SELECT plan_id FROM supply.publish_plan_claims WHERE claim_batch_id=$3
            )`, [client.user_id, updatedIds, claimBatchId])
        }
        await sql.query("UPDATE supply.publish_claim_batches SET status='completed' WHERE id=$1 AND client_id=$2 AND status='processing'", [claimBatchId, claims.sub])
      }
      const delivered = await sql.query(`SELECT p.id,p.material_id AS "materialId",p.material_version_id AS "materialVersionId",p.material_version AS "materialVersion",p.material_snapshot AS "materialSnapshot",p.schedule_mode AS "scheduleMode",p.scheduled_at AS "scheduledAt",p.window_start AS "windowStart",p.window_end AS "windowEnd",c.claimed_at AS "claimedAt"
        FROM supply.publish_plan_claims c
        JOIN supply.publish_plans p ON p.id=c.plan_id
        WHERE c.claim_batch_id=$1 AND c.client_id=$2 AND c.user_id=$3
        ORDER BY p.scheduled_at ASC,p.id ASC`, [claimBatchId, claims.sub, client.user_id])
      const items = delivered.rows.map((row) => ({ ...row, materialSnapshot: supplyClaimSnapshot(row.materialSnapshot) }))
      return { schemaVersion: 1, claimBatchId, deviceId: String(claims.sub), duplicate, items }
    } catch (error) {
      return fail(reply, 400, error instanceof Error ? error.message : '发布计划领取失败')
    }
  })
  app.post('/v1/supply/publish-results', async (request, reply) => {
    let claims: Awaited<ReturnType<typeof authenticate>>
    try { claims = await authenticate(sql, domains.collector, 'collector', request.headers.authorization) } catch { return fail(reply, 403, '采集器权限不足') }
    try {
      const client = await activeCollector(sql, String(claims.sub))
      await requireCollectorEntitlement(sql, client.user_id)
      const input = supplyRecord(request.body, '发布结果请求')
      if (input.schemaVersion !== 1 || input.deviceId !== String(claims.sub) || !Array.isArray(input.results) || input.results.length > 20) throw new SupplyImportRequestError('发布结果请求无效')
      const accepted: Array<Record<string, unknown>> = []
      for (const raw of input.results) {
        const result = supplyRecord(raw, '发布结果')
        const planId = supplyString(result.planId, 'planId', 64)!
        const claimBatchId = supplyString(result.claimBatchId, 'claimBatchId', 64)!
        const attemptKey = supplyString(result.attemptKey, 'attemptKey', 256)!
        const status = result.status
        if (status !== 'succeeded' && status !== 'failed' && status !== 'needs_attention') throw new SupplyImportRequestError('发布结果状态无效')
        rejectSupplySensitive(result)
        const existingAttempt = await sql.query('SELECT id FROM supply.publish_attempts WHERE client_id=$1 AND attempt_key=$2', [claims.sub, attemptKey])
        if (existingAttempt.rows[0]) {
          accepted.push({ planId, attemptKey, duplicate: true })
          continue
        }
        const plan = (await sql.query(`SELECT id,status,user_id FROM supply.publish_plans WHERE id=$1 AND user_id=$2 AND claimed_by_client_id=$3`, [planId, client.user_id, claims.sub])).rows[0]
        if (!plan) throw new SupplyImportRequestError('发布计划不属于当前设备')
        const attemptNo = Number((await sql.query('SELECT COALESCE(MAX(attempt_no),0)+1 AS next FROM supply.publish_attempts WHERE plan_id=$1', [planId])).rows[0].next)
        const inserted = await sql.query(`INSERT INTO supply.publish_attempts (id,plan_id,user_id,client_id,claim_batch_id,attempt_key,attempt_no,status,error_code,error_message,xianyu_item_id,xianyu_url,created_at,completed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now()) ON CONFLICT (client_id,attempt_key) DO NOTHING RETURNING id`, [randomUUID(), planId, client.user_id, claims.sub, claimBatchId, attemptKey, attemptNo, status, typeof result.errorCode === 'string' ? result.errorCode.slice(0,128) : null, typeof result.errorMessage === 'string' ? result.errorMessage.slice(0,1000) : null, typeof result.xianyuItemId === 'string' ? result.xianyuItemId.slice(0,128) : null, typeof result.xianyuUrl === 'string' ? result.xianyuUrl.slice(0,2048) : null])
        if (inserted.rows[0]) {
          const nextPlanStatus = status === 'succeeded' ? 'published' : status === 'failed' ? 'planned' : 'failed'
          await sql.query(`UPDATE supply.publish_plans SET status=$1,retry_count=retry_count+$2,last_error_code=$3,last_error_message=$4,xianyu_item_id=$5,xianyu_url=$6,claimed_by_client_id=NULL,claimed_at=NULL,updated_at=now() WHERE id=$7 AND user_id=$8`, [nextPlanStatus, status === 'failed' ? 1 : 0, result.errorCode ?? null, result.errorMessage ?? null, result.xianyuItemId ?? null, result.xianyuUrl ?? null, planId, client.user_id])
          const publishedItemId = typeof result.xianyuItemId === 'string' ? result.xianyuItemId.trim().slice(0, 128) : ''
          if (status === 'succeeded' && /^[A-Za-z0-9._-]+$/.test(publishedItemId)) {
            await createPublishedItemMonitor(sql, client.user_id, {
              platformItemId: publishedItemId,
              itemUrl: canonicalPublishedItemUrl(publishedItemId),
              publishPlanId: planId,
              status: 'active',
              intervalSeconds: 1_800
            }, true)
          }
        }
        accepted.push({ planId, attemptKey, duplicate: !inserted.rows[0] })
      }
      return { schemaVersion: 1, deviceId: String(claims.sub), accepted }
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : '发布结果接收失败') }
  })
  app.post('/v1/supply/migrations/claim', async (request, reply) => {
    let claims: Awaited<ReturnType<typeof authenticate>>
    let client: { user_id: string }
    try {
      claims = await authenticate(sql, domains.collector, 'collector', request.headers.authorization)
      client = await activeCollector(sql, String(claims.sub))
      await requireCollectorEntitlement(sql, client.user_id)
    } catch (error) { return fail(reply, 403, error instanceof Error ? error.message : '采集器权限不足') }
    try {
      const input = parseSupplyMigrationClaim(request.body)
      if (input.deviceId !== String(claims.sub)) return fail(reply, 403, 'deviceId 与授权设备不匹配')
      const claimed = await sql.query(`WITH candidates AS (
          SELECT id FROM supply.migration_requests
          WHERE user_id=$1 AND status='queued'
          ORDER BY created_at ASC,id ASC LIMIT $2
        )
        UPDATE supply.migration_requests r SET status='claimed',claimed_by_client_id=$3,claimed_at=now(),attempt_count=attempt_count+1,updated_at=now()
        FROM candidates c WHERE r.id=c.id AND r.status='queued'
        RETURNING r.id,r.platform_item_id AS "platformItemId",r.item_url AS "itemUrl"`, [client.user_id, input.limit, claims.sub])
      return { schemaVersion: 1, deviceId: String(claims.sub), idempotencyKey: input.idempotencyKey, items: claimed.rows }
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : '搬家请求领取失败') }
  })
  app.post('/v1/supply/migrations/:requestId/result', async (request, reply) => {
    let claims: Awaited<ReturnType<typeof authenticate>>
    let client: { user_id: string }
    try {
      claims = await authenticate(sql, domains.collector, 'collector', request.headers.authorization)
      client = await activeCollector(sql, String(claims.sub))
      await requireCollectorEntitlement(sql, client.user_id)
    } catch (error) { return fail(reply, 403, error instanceof Error ? error.message : '采集器权限不足') }
    try {
      const requestId = String((request.params as { requestId?: string }).requestId ?? '')
      const input = parseSupplyMigrationResult(request.body)
      if (input.deviceId !== String(claims.sub)) return fail(reply, 403, 'deviceId 与授权设备不匹配')
      const requestRow = (await sql.query(`SELECT * FROM supply.migration_requests
        WHERE id=$1 AND user_id=$2 AND claimed_by_client_id=$3`, [requestId, client.user_id, claims.sub])).rows[0]
      if (!requestRow) return fail(reply, 404, '搬家请求不存在或不属于当前设备')
      const existing = (await sql.query('SELECT id FROM supply.migration_attempts WHERE client_id=$1 AND attempt_key=$2', [claims.sub, input.attemptKey])).rows[0]
      if (existing) {
        const current = (await sql.query('SELECT * FROM supply.migration_requests WHERE id=$1 AND user_id=$2', [requestId, client.user_id])).rows[0]
        return { ...supplyMigrationResponse(current), attemptKey: input.attemptKey, duplicate: true }
      }
      if (String(requestRow.status) !== 'claimed') return fail(reply, 409, '搬家请求不是待处理状态')
      let status: 'succeeded' | 'failed' = input.status
      let materialId: string | null = null
      let safeError: string | null = null
      if (status === 'succeeded') {
        try { materialId = (await persistSupplyMigrationSnapshot(sql, client.user_id, requestId, input.snapshot)).materialId }
        catch (error) { status = 'failed'; safeError = error instanceof Error ? safeSupplyMigrationError(error.message) : '本机快照校验失败' }
      } else safeError = safeSupplyMigrationError(input.errorMessage ?? '本机读取失败')
      await sql.query(`INSERT INTO supply.migration_attempts (id,request_id,user_id,client_id,attempt_key,status,safe_error,created_at,completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())`, [randomUUID(), requestId, client.user_id, claims.sub, input.attemptKey, status, safeError])
      await sql.query(`UPDATE supply.migration_requests SET status=$1,material_id=$2,last_error=$3,completed_at=now(),updated_at=now()
        WHERE id=$4 AND user_id=$5 AND claimed_by_client_id=$6`, [status, materialId, safeError, requestId, client.user_id, claims.sub])
      const current = (await sql.query('SELECT * FROM supply.migration_requests WHERE id=$1 AND user_id=$2', [requestId, client.user_id])).rows[0]
      return { ...supplyMigrationResponse(current), attemptKey: input.attemptKey, duplicate: false }
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : '搬家结果接收失败') }
  })
  app.get('/v1/tasks', async (request, reply) => {
    try {
      const claims = await authenticate(sql, domains.collector, 'collector', request.headers.authorization)
      const client = await activeCollector(sql, String(claims.sub))
      const entitlements = await collectorEntitlements(sql, client.user_id)
      if (!entitlements.allowed) return fail(reply, 403, '当前账号没有可用采集权益')
      const snapshotAt = timestamp((await sql.query('SELECT clock_timestamp() AS snapshot')).rows[0]?.snapshot)
      const searchTasks = await sql.query(`SELECT id, 'search' AS kind, rule_json AS rule, rule_version AS "ruleVersion", status, interval_seconds AS "intervalSeconds", next_run_at AS "nextRunAt", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM ops.monitor_tasks
        WHERE user_id=$1 AND kind='search' AND updated_at <= $2::timestamptz
          AND (status = 'paused' OR active_slot <= $3)
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END ASC, next_run_at ASC, id ASC`, [client.user_id, snapshotAt, entitlements.taskLimit])
      const sellerTasks = await sql.query(`SELECT t.id, 'seller' AS kind, s.platform, s.platform_seller_id AS "platformSellerId", t.profile_url AS "profileUrl", t.rule_version AS "ruleVersion", t.status, t.interval_seconds AS "intervalSeconds", t.next_run_at AS "nextRunAt", t.created_at AS "createdAt", t.updated_at AS "updatedAt"
        FROM ops.seller_monitor_tasks t
        JOIN market.seller_profiles s ON s.id = t.seller_id
        WHERE t.user_id=$1 AND t.updated_at <= $2::timestamptz
          AND (t.status = 'paused' OR t.active_slot <= ${MAX_ACTIVE_SELLER_TASKS})
        ORDER BY CASE t.status WHEN 'active' THEN 0 ELSE 1 END ASC, t.next_run_at ASC, t.id ASC`, [client.user_id, snapshotAt])
      const publishedItemTasks = await sql.query(`SELECT t.id, 'published_item' AS kind, t.publish_plan_id AS "publishPlanId", t.platform, t.platform_item_id AS "platformItemId", t.item_url AS "itemUrl", t.rule_version AS "ruleVersion", t.status, t.interval_seconds AS "intervalSeconds", t.next_run_at AS "nextRunAt", t.created_at AS "createdAt", t.updated_at AS "updatedAt"
        FROM ops.published_item_monitor_tasks t
        WHERE t.user_id=$1 AND t.updated_at <= $2::timestamptz
        ORDER BY CASE t.status WHEN 'active' THEN 0 ELSE 1 END ASC, t.next_run_at ASC, t.id ASC`, [client.user_id, snapshotAt])
      return { items: [...searchTasks.rows, ...sellerTasks.rows, ...publishedItemTasks.rows], snapshotAt, taskLimit: entitlements.taskLimit, sellerTaskLimit: MAX_ACTIVE_SELLER_TASKS }
    } catch (error) {
      return fail(reply, 403, error instanceof Error ? error.message : '采集器权限不足')
    }
  })
  app.post('/v1/ingest', async (request, reply) => {
    let claims: Awaited<ReturnType<typeof authenticate>>
    try { claims = await authenticate(sql, domains.collector, 'collector', request.headers.authorization) } catch (error) { return fail(reply, 403, error instanceof Error ? error.message : '采集器权限不足') }
    let client: { user_id: string }
    try {
      client = await activeCollector(sql, String(claims.sub))
      await requireCollectorEntitlement(sql, client.user_id)
    } catch (error) {
      return fail(reply, 403, error instanceof Error ? error.message : '当前账号没有可用采集权益')
    }
    try {
      const input = parsePhase6Batch(request.body)
      if (input.deviceId !== String(claims.sub)) throw new Error('deviceId 与授权设备不匹配')
      const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
      const existing = (await sql.query('SELECT id,status,accepted_count,rejected_count,received_count,deduplicated_count,inserted_count,failed_count,retry_count,cursor_end FROM ops.ingest_batches WHERE client_id=$1 AND idempotency_key=$2', [claims.sub, input.idempotencyKey])).rows[0] as Record<string, unknown> | undefined
      if (existing) {
        const retry = await sql.query('UPDATE ops.ingest_batches SET retry_count=retry_count+1 WHERE id=$1 RETURNING retry_count', [existing.id])
        return { schemaVersion: 1, batchId: String(existing.id), status: existing.status, acceptedCount: Number(existing.accepted_count ?? 0), rejectedCount: Number(existing.rejected_count ?? 0), receivedCount: Number(existing.received_count ?? 0), deduplicatedCount: Number(existing.deduplicated_count ?? 0), insertedCount: Number(existing.inserted_count ?? 0), failedCount: Number(existing.failed_count ?? 0), retryCount: Number(retry.rows[0]?.retry_count ?? 0), cursor: { end: existing.cursor_end ?? input.cursorEnd }, duplicate: true }
      }
      const batchId = input.batchId
      const runId = randomUUID()
      const created = await sql.query(`INSERT INTO ops.ingest_batches (id,client_id,idempotency_key,payload_hash,status,schema_version,device_id,batch_sequence,cursor_start,cursor_end,received_count,received_at)
        VALUES ($1,$2,$3,$4,'processing',$5,$2,$6,$7,$8,$9,now()) ON CONFLICT (client_id,idempotency_key) DO NOTHING RETURNING id`, [batchId, claims.sub, input.idempotencyKey, payloadHash, input.schemaVersion, input.batchSequence, input.cursorStart, input.cursorEnd, input.records.length])
      if (!created.rows[0]) {
        const duplicate = (await sql.query('SELECT id,status,accepted_count,rejected_count,received_count,deduplicated_count,inserted_count,failed_count,retry_count,cursor_end FROM ops.ingest_batches WHERE client_id=$1 AND idempotency_key=$2', [claims.sub, input.idempotencyKey])).rows[0] as Record<string, unknown> | undefined
        if (!duplicate) throw new Error('上传批次并发状态异常')
        const retry = await sql.query('UPDATE ops.ingest_batches SET retry_count=retry_count+1 WHERE id=$1 RETURNING retry_count', [duplicate.id])
        return { schemaVersion: 1, batchId: String(duplicate.id), status: duplicate.status, acceptedCount: Number(duplicate.accepted_count ?? 0), rejectedCount: Number(duplicate.rejected_count ?? 0), receivedCount: Number(duplicate.received_count ?? 0), deduplicatedCount: Number(duplicate.deduplicated_count ?? 0), insertedCount: Number(duplicate.inserted_count ?? 0), failedCount: Number(duplicate.failed_count ?? 0), retryCount: Number(retry.rows[0]?.retry_count ?? 0), cursor: { end: duplicate.cursor_end ?? input.cursorEnd }, duplicate: true }
      }
      await sql.query(`INSERT INTO ops.collection_runs (id,client_id,client_run_id,task_reference,kind,status,started_at,result_counts) VALUES ($1,$2,$3,$4,'detail','started',now(),'{}'::jsonb) ON CONFLICT (client_id,client_run_id) DO NOTHING`, [runId, claims.sub, `ingest-${batchId}`, batchId])
      let insertedCount = 0; let deduplicatedCount = 0; let failedCount = 0
      for (const [index, record] of input.records.entries()) {
        try {
          const recordHash = createHash('sha256').update(phase6Json(record)).digest('hex')
          const entityClaim = await sql.query(`INSERT INTO ops.ingest_entity_dedup (idempotency_key,entity_type,payload_hash,first_batch_id,accepted_at)
            VALUES ($1,$2,$3,$4,now()) ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`, [record.idempotencyKey, record.type, recordHash, batchId])
          if (!entityClaim.rows[0]) {
            deduplicatedCount += 1
            await sql.query(`INSERT INTO ops.ingest_record_dedup (batch_id,record_index,idempotency_key,entity_type,entity_id,payload_hash,accepted_at,status,inserted,processed_at)
              VALUES ($1,$2,$3,$4,$5,$6,now(),'accepted',false,now()) ON CONFLICT (batch_id,record_index) DO NOTHING`, [batchId, index, record.idempotencyKey, record.type, String(record.type === 'event' ? (record.eventKey ?? record.idempotencyKey) : (record.platformItemId ?? record.platformSellerId ?? '')), recordHash])
            continue
          }
          const result = await phase6IngestRecord(sql, record, runId, batchId, index)
          await sql.query(`INSERT INTO ops.ingest_record_dedup (batch_id,record_index,idempotency_key,entity_type,entity_id,payload_hash,accepted_at,status,inserted,processed_at)
            VALUES ($1,$2,$3,$4,$5,$6,now(),'accepted',$7,now()) ON CONFLICT (batch_id,record_index) DO NOTHING`, [batchId, index, record.idempotencyKey, record.type, String(record.type === 'event' ? (record.eventKey ?? record.idempotencyKey) : (record.platformItemId ?? record.platformSellerId ?? '')), recordHash, result === 'inserted'])
          if (result === 'inserted') insertedCount += 1
          else deduplicatedCount += 1
        } catch (error) {
          failedCount += 1
          await sql.query('DELETE FROM ops.ingest_entity_dedup WHERE first_batch_id=$1 AND idempotency_key=$2', [batchId, record.idempotencyKey])
          const reason = error instanceof Error ? error.message.slice(0, 256) : '记录处理失败'
          await sql.query(`INSERT INTO ops.ingest_rejections (id,batch_id,record_index,idempotency_key,entity_type,failure_reason,safe_details,created_at) VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,now()) ON CONFLICT (batch_id,record_index) DO NOTHING`, [randomUUID(), batchId, index, record.idempotencyKey, record.type, reason])
        }
      }
      const acceptedCount = insertedCount + deduplicatedCount
      const qualityStatus = failedCount ? (acceptedCount ? 'warning' : 'failed') : 'passed'
      await sql.query(`UPDATE ops.ingest_batches SET status='completed',accepted_count=$2,rejected_count=$3,received_count=$4,deduplicated_count=$5,inserted_count=$6,failed_count=$3,quality_status=$7,quality_result=$8::jsonb,completed_at=now()
        WHERE id=$1`, [batchId, acceptedCount, failedCount, input.records.length, deduplicatedCount, insertedCount, qualityStatus, JSON.stringify({ schemaVersion: 1, deviceId: String(claims.sub), clientUserId: client.user_id, recordTypes: input.records.reduce<Record<string, number>>((counts, record) => { counts[record.type] = (counts[record.type] ?? 0) + 1; return counts }, {}) })])
      await sql.query(`UPDATE ops.collection_runs SET status='completed',finished_at=now(),result_counts=$2::jsonb WHERE id=$1`, [runId, JSON.stringify({ received: input.records.length, inserted: insertedCount, deduplicated: deduplicatedCount, failed: failedCount })])
      return { schemaVersion: 1, batchId, status: 'completed', acceptedCount, rejectedCount: failedCount, receivedCount: input.records.length, deduplicatedCount, insertedCount, failedCount, retryCount: 0, cursor: { start: input.cursorStart, end: input.cursorEnd }, qualityStatus }
    } catch (error) {
      return fail(reply, 400, error instanceof Error ? error.message : '上传批次无效')
    }
  })
  app.post('/v1/ingest/media', async (request, reply) => {
    let claims: Awaited<ReturnType<typeof authenticate>>
    try {
      claims = await authenticate(sql, domains.collector, 'collector', request.headers.authorization)
      const client = await activeCollector(sql, String(claims.sub))
      await requireCollectorEntitlement(sql, client.user_id)
    } catch (error) {
      return fail(reply, 403, error instanceof Error ? error.message : '当前账号没有可用采集权益')
    }
    try {
      const input = phase6Record(request.body, '媒体请求')
      const batchId = phase6Text(input.batchId, 'batchId', 128)
      const batch = (await sql.query('SELECT id FROM ops.ingest_batches WHERE id=$1 AND client_id=$2', [batchId, claims.sub])).rows[0]
      if (!batch) return fail(reply, 404, '批次不存在')
      const sha256 = phase6Text(input.sha256, 'sha256', 128)
      const objectKey = phase6Text(input.objectKey ?? `public/${sha256}`, 'objectKey', 512)
      const mimeType = phase6Text(input.mimeType, 'mimeType', 128)
      const byteSize = input.byteSize
      if (!Number.isSafeInteger(byteSize) || Number(byteSize) < 0) throw new Error('byteSize 无效')
      const media = await sql.query(`INSERT INTO market.media_objects (id,object_key,mime_type,byte_size,sha256,visibility,created_at) VALUES ($1,$2,$3,$4,$5,'market_public',now()) ON CONFLICT (sha256) DO UPDATE SET object_key=EXCLUDED.object_key RETURNING id,object_key`, [randomUUID(), objectKey, mimeType, byteSize, sha256])
      const mediaId = String(media.rows[0]?.id)
      await sql.query(`INSERT INTO ops.ingest_media_uploads (id,batch_id,media_id,object_key,mime_type,byte_size,sha256,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'accepted',now()) ON CONFLICT (batch_id,sha256) DO UPDATE SET status='deduplicated'`, [randomUUID(), batchId, mediaId, objectKey, mimeType, byteSize, sha256])
      return { accepted: true, mediaId, objectKey, storage: 'metadata-only' }
    } catch (error) { return fail(reply, 400, error instanceof Error ? error.message : '媒体请求无效') }
  })
  app.post('/v1/devices/unbind', async (request, reply) => {
    try {
      const claims = await authenticate(sql, domains.collector, 'collector', request.headers.authorization)
      await revokeCollector(sql, String(claims.sub))
      return { revoked: true }
    } catch (error) {
      return fail(reply, 403, error instanceof Error ? error.message : '设备解绑失败')
    }
  })
  app.post('/v1/heartbeat', async (request, reply) => {
    try {
      const claims = await authenticate(sql, domains.collector, 'collector', request.headers.authorization)
      const input = body<{ id?: string }>(request.body)
      if (!input.id || input.id.length > 128) return fail(reply, 400, '心跳请求无效')
      await sql.query('UPDATE identity.collector_clients SET last_seen_at=now() WHERE id=$1', [claims.sub])
      return { accepted: true }
    } catch (error) {
      return fail(reply, 403, error instanceof Error ? error.message : '采集器权限不足')
    }
  })
  return app
}
