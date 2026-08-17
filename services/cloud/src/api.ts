import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { createHash, createHmac, randomUUID, timingSafeEqual, verify } from 'node:crypto'
import type { TokenDomain, SubjectKind } from './security.ts'
import { createRefreshToken, hashPassword, signAccessToken, verifyAccessToken, verifyPassword } from './security.ts'

export type Sql = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
export type Domains = Record<SubjectKind, TokenDomain>
export type ApiOptions = { allowedOrigins?: readonly string[] }

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
type ListPlan = { resource: string; page: (context: ListContext, subjectId: string) => ListQuerySpec; count: (context: ListContext, subjectId: string) => ListQuerySpec }
type ListPlanBuilder = (context: ListContext, subjectId: string) => ListPlan

class ListRequestError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function body<T>(value: unknown): T { return value as T }
function refreshHash(token: string): string { return createHash('sha256').update(token).digest('hex') }
function bearer(header: string | undefined): string { if (!header?.startsWith('Bearer ')) throw new Error('缺少访问令牌'); return header.slice(7) }
function fail(reply: { code: (value: number) => { send: (body: unknown) => unknown } }, code: number, message: string) { return reply.code(code).send({ error: message }) }
function listFail(reply: { code: (value: number) => { send: (body: unknown) => unknown } }, error: ListRequestError) { return reply.code(400).send({ error: { code: error.code, message: error.message } }) }

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
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS')
    reply.header('access-control-allow-headers', 'Authorization, Content-Type')
    reply.header('vary', 'Origin')
    if (request.method === 'OPTIONS') {
      const requestedMethod = request.headers['access-control-request-method']
      if (requestedMethod && !['GET', 'POST', 'OPTIONS'].includes(String(requestedMethod).toUpperCase())) return reply.code(405).send({ error: 'CORS 方法不允许' })
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
  return ['last_seen_at', 'first_seen_at', 'created_at', 'observed_at', 'occurred_at', 'started_at', 'received_at', 'collected_at', 'queued_at'].includes(sort) ? timestamp(value) : String(value)
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
  defaultSort: 'started_at',
  sortAliases: { started_at: 'started_at', updated_at: 'started_at', updated_at_desc: 'started_at', recent: 'started_at', priority_desc: 'status', title_asc: 'client_run_id', id: 'id' },
  filterAliases: { taskReference: 'task_reference' },
  allowedFilters: ['q', 'kind', 'status', 'task_reference']
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
  filterAliases: { clientId: 'client_id' },
  allowedFilters: ['q', 'status', 'client_id']
}

const adminAiJobsListConfig: ListConfig = {
  resource: 'admin.ai_jobs',
  defaultSort: 'created_at',
  sortAliases: { created_at: 'created_at', updated_at: 'created_at', updated_at_desc: 'created_at', recent: 'created_at', status: 'status', title: 'billing_reference', title_asc: 'billing_reference', id: 'id' },
  filterAliases: { userId: 'requesting_user_id', capabilityId: 'capability_id' },
  allowedFilters: ['q', 'status', 'requesting_user_id', 'capability_id']
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
  from: 'ops.collection_runs r JOIN identity.collector_clients c ON c.id = r.client_id',
  select: 'r.id, r.client_id AS "clientId", r.client_run_id AS "clientRunId", r.task_reference AS "taskReference", r.kind, r.status, r.result_counts AS "resultCounts", r.started_at AS "startedAt", r.finished_at AS "finishedAt"',
  idExpression: 'r.id::text',
  sortExpressions: { started_at: 'r.started_at', status: 'r.status', client_run_id: 'r.client_run_id', id: 'r.id::text' },
  conditions: (context, values, subjectId) => {
    values.push(subjectId)
    const conditions = ['r.started_at <= $1', 'c.user_id = $2']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`(LOWER(r.client_run_id) LIKE LOWER($${values.length}) OR LOWER(COALESCE(r.task_reference, '')) LIKE LOWER($${values.length}))`) }
    if (context.filters.kind) { values.push(context.filters.kind); conditions.push(`r.kind = $${values.length}`) }
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`r.status = $${values.length}`) }
    if (context.filters.task_reference) { values.push(context.filters.task_reference); conditions.push(`r.task_reference = $${values.length}`) }
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
  from: 'ops.ingest_batches b',
  select: 'b.id, b.client_id AS "clientId", b.idempotency_key AS "idempotencyKey", b.status, b.accepted_count AS "acceptedCount", b.rejected_count AS "rejectedCount", b.received_at AS "receivedAt"',
  idExpression: 'b.id::text',
  sortExpressions: { received_at: 'b.received_at', status: 'b.status', idempotency_key: 'b.idempotency_key', id: 'b.id::text' },
  conditions: (context, values) => {
    const conditions = ['b.received_at <= $1']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`LOWER(b.idempotency_key) LIKE LOWER($${values.length})`) }
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`b.status = $${values.length}`) }
    if (context.filters.client_id) { values.push(context.filters.client_id); conditions.push(`b.client_id = $${values.length}`) }
    return conditions
  }
})

const adminAiJobsPlan = tablePlan({
  resource: adminAiJobsListConfig.resource,
  from: 'ai.jobs j',
  select: 'j.id, j.requesting_user_id AS "requestingUserId", j.idempotency_key AS "idempotencyKey", j.capability_id AS "capabilityId", j.prompt_version_id AS "promptVersionId", j.input_object_key AS "inputObjectKey", j.status, j.queued_at AS "queuedAt", j.started_at AS "startedAt", j.finished_at AS "finishedAt", j.billing_reference AS "billingReference", j.created_at AS "createdAt"',
  idExpression: 'j.id::text',
  sortExpressions: { created_at: 'j.created_at', status: 'j.status', billing_reference: "COALESCE(j.billing_reference, '')", id: 'j.id::text' },
  conditions: (context, values) => {
    const conditions = ['j.created_at <= $1']
    if (context.filters.q) { values.push(`%${context.filters.q}%`); conditions.push(`LOWER(COALESCE(j.billing_reference, '')) LIKE LOWER($${values.length})`) }
    if (context.filters.status) { values.push(context.filters.status); conditions.push(`j.status = $${values.length}`) }
    if (context.filters.requesting_user_id) { values.push(context.filters.requesting_user_id); conditions.push(`j.requesting_user_id = $${values.length}`) }
    if (context.filters.capability_id) { values.push(context.filters.capability_id); conditions.push(`j.capability_id = $${values.length}`) }
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
        return { text: `SELECT i.id, i.platform, i.platform_item_id AS "platformItemId", i.lifecycle_state AS state, i.first_seen_at AS "firstSeenAt", i.last_seen_at AS "lastSeenAt", ${sortExpression} AS cursor_sort_value, i.id::text AS cursor_id FROM market.items i WHERE ${query.where} ORDER BY ${sortExpression} ${context.order.toUpperCase()}, i.id ${context.order.toUpperCase()} LIMIT ${context.limit + 1}`, values: query.values }
      },
      count: () => {
        const query = build(false)
        return { text: `SELECT COUNT(*)::int AS total FROM market.items i WHERE ${query.where}`, values: query.values }
      }
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
  const rows = await sql.query(`SELECT u.id, u.email_normalized AS email, u.status, u.created_at AS "createdAt", ${sortExpression} AS cursor_sort_value, u.id::text AS cursor_id
    FROM identity.users u WHERE ${pageWhere}
    ORDER BY ${sortExpression} ${context.order.toUpperCase()}, u.id ${context.order.toUpperCase()} LIMIT ${context.limit + 1}`, pageValues)
  const countValues: unknown[] = [context.snapshotAt]
  const countWhere = adminUsersConditions(context, countValues, false).join(' AND ')
  const total = Number((await sql.query(`SELECT COUNT(*)::int AS total FROM identity.users u WHERE ${countWhere}`, countValues)).rows[0]?.total ?? 0)
  return listResponse(context, rows.rows, total, secret, adminUsersListConfig.resource)
}

async function issue(sql: Sql, domain: TokenDomain, kind: SubjectKind, subjectId: string, clientId?: string) {
  const sessionId = randomUUID(); const familyId = randomUUID(); const refresh = createRefreshToken()
  await sql.query(`INSERT INTO identity.auth_refresh_sessions (id, subject_type, subject_id, token_hash, family_id, expires_at, created_at)
    VALUES ($1,$2,$3,$4,$5,now() + interval '30 days',now())`, [sessionId, kind, subjectId, refresh.hash, familyId])
  return { accessToken: await signAccessToken(domain, kind, subjectId, sessionId, clientId), refreshToken: refresh.token }
}

async function authenticateToken(sql: Sql, domain: TokenDomain, kind: SubjectKind, token: string) {
  const claims = await verifyAccessToken(domain, kind, token)
  const session = (await sql.query('SELECT id, subject_type, subject_id, revoked_at, expires_at FROM identity.auth_refresh_sessions WHERE id = $1', [claims.sessionId])).rows[0] as SessionRow | undefined
  if (!session || session.subject_type !== kind || session.subject_id !== claims.sub || session.revoked_at || new Date(String(session.expires_at)) <= new Date()) throw new Error('会话已失效')
  return claims
}

async function authenticate(sql: Sql, domain: TokenDomain, kind: SubjectKind, header: string | undefined) { return authenticateToken(sql, domain, kind, bearer(header)) }

async function refresh(sql: Sql, domain: TokenDomain, kind: SubjectKind, refreshToken: string, clientId?: string) {
  const result = await sql.query(`SELECT id, subject_id, family_id, revoked_at, expires_at FROM identity.auth_refresh_sessions
    WHERE subject_type = $1 AND token_hash = $2`, [kind, refreshHash(refreshToken)])
  const session = result.rows[0] as SessionRow | undefined
  if (!session || new Date(session.expires_at) <= new Date()) throw new Error('刷新令牌无效')
  if (session.revoked_at) {
    await sql.query('UPDATE identity.auth_refresh_sessions SET replay_detected_at = now(), revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [session.family_id])
    throw new Error('刷新令牌重放')
  }
  await sql.query('UPDATE identity.auth_refresh_sessions SET revoked_at = now(), last_used_at = now() WHERE id = $1', [session.id])
  return issue(sql, domain, kind, session.subject_id, clientId)
}

export function createUserApi(sql: Sql, domains: Domains, options: ApiOptions = {}) {
  const app = Fastify({ logger: false })
  installCors(app, options.allowedOrigins ?? [])
  app.get('/health', async () => ({ service: 'user-api', ok: true }))
  app.post('/v1/auth/register', async (request, reply) => {
    const input = body<{ email?: string; password?: string }>(request.body); const email = input.email?.trim().toLowerCase()
    if (!email || !input.password) return fail(reply, 400, '邮箱和密码必填')
    try { const id = randomUUID(); await sql.query('INSERT INTO identity.users (id,email_normalized,password_hash,status,created_at) VALUES ($1,$2,$3,\'active\',now())', [id, email, await hashPassword(input.password)]); return issue(sql, domains.user, 'user', id) } catch { return fail(reply, 409, '用户已存在') }
  })
  app.post('/v1/auth/login', async (request, reply) => {
    const input = body<{ email?: string; password?: string }>(request.body); const email = input.email?.trim().toLowerCase()
    const found = await sql.query('SELECT id,email_normalized,password_hash,status FROM identity.users WHERE email_normalized=$1', [email]); const user = found.rows[0] as UserRow | undefined
    if (!user || user.status !== 'active' || !input.password || !(await verifyPassword(input.password, user.password_hash))) return fail(reply, 401, '账号或密码错误')
    return issue(sql, domains.user, 'user', user.id)
  })
  app.post('/v1/auth/refresh', async (request, reply) => { try { return await refresh(sql, domains.user, 'user', body<{ refreshToken: string }>(request.body).refreshToken) } catch (error) { return fail(reply, 401, error instanceof Error ? error.message : '刷新失败') } })
  app.get('/v1/me', async (request, reply) => { try { const claims = await authenticate(sql, domains.user, 'user', request.headers.authorization); return { id: claims.sub } } catch { return fail(reply, 401, '未授权') } })
  app.get('/v1/me/entitlements', async (request, reply) => { try { const claims = await authenticate(sql, domains.user, 'user', request.headers.authorization); const rows = await sql.query('SELECT capability,limit_value,effective_to FROM billing.entitlement_grants WHERE user_id=$1 AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now())', [claims.sub]); return { items: rows.rows } } catch { return fail(reply, 401, '未授权') } })
  registerListEndpoint(app, ['/v1/market/items'], sql, domains.user, 'user', marketItemsListConfig, marketItemsPlan(marketItemsListConfig.resource, true), 401, '未授权')
  registerListEndpoint(app, ['/v1/monitors'], sql, domains.user, 'user', userMonitorsListConfig, userMonitorsPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/sellers', '/v1/market/sellers'], sql, domains.user, 'user', userSellersListConfig, userSellersPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/discoveries', '/v1/market/discoveries'], sql, domains.user, 'user', userDiscoveriesListConfig, userInsightPlan(userDiscoveriesListConfig.resource), 401, '未授权')
  registerListEndpoint(app, ['/v1/events', '/v1/market/events'], sql, domains.user, 'user', userEventsListConfig, userEventsPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/logs', '/v1/dynamic-logs'], sql, domains.user, 'user', userLogsListConfig, userLogsPlan, 401, '未授权')
  registerListEndpoint(app, ['/v1/ai', '/v1/ai/insights'], sql, domains.user, 'user', { ...userDiscoveriesListConfig, resource: 'user.ai' }, userInsightPlan('user.ai'), 401, '未授权')
  return app
}

export function createAdminApi(sql: Sql, domains: Domains, options: ApiOptions = {}) {
  const app = Fastify({ logger: false })
  installCors(app, options.allowedOrigins ?? [])
  app.get('/health', async () => ({ service: 'admin-api', ok: true }))
  app.post('/v1/auth/login', async (request, reply) => {
    const input = body<{ email?: string; password?: string }>(request.body); const found = await sql.query('SELECT id,email_normalized,password_hash,status,role,mfa_state FROM identity.admin_users WHERE email_normalized=$1', [input.email?.trim().toLowerCase()]); const admin = found.rows[0] as (UserRow & { role: string; mfa_state: string }) | undefined
    if (!admin || admin.status !== 'active' || admin.mfa_state !== 'enrolled' || !input.password || !(await verifyPassword(input.password, admin.password_hash))) return fail(reply, 401, '管理员认证失败')
    return issue(sql, domains.admin, 'admin', admin.id)
  })
  app.post('/v1/auth/refresh', async (request, reply) => {
    try {
      const input = body<{ refreshToken?: string; clientId?: string }>(request.body)
      return await refresh(sql, domains.admin, 'admin', input.refreshToken ?? '', input.clientId)
    } catch (error) { return fail(reply, 401, error instanceof Error ? error.message : '刷新失败') }
  })
  app.get('/v1/me', async (request, reply) => { try { const claims = await authenticate(sql, domains.admin, 'admin', request.headers.authorization); const rows = await sql.query('SELECT role FROM identity.admin_users WHERE id=$1', [claims.sub]); return { id: claims.sub, role: rows.rows[0]?.role } } catch { return fail(reply, 403, '管理员权限不足') } })
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
  registerListEndpoint(app, ['/v1/ai', '/v1/ai/jobs', '/v1/admin/ai'], sql, domains.admin, 'admin', adminAiJobsListConfig, adminAiJobsPlan, 403, '管理员权限不足')
  registerListEndpoint(app, ['/v1/capacity', '/v1/admin/capacity'], sql, domains.admin, 'admin', adminCapacityListConfig, adminCapacityPlan, 403, '管理员权限不足')
  registerListEndpoint(app, ['/v1/audit', '/v1/audit/logs', '/v1/admin/audit'], sql, domains.admin, 'admin', adminAuditListConfig, adminAuditPlan, 403, '管理员权限不足')
  return app
}

export function createCollectorApi(sql: Sql, domains: Domains) {
  const app = Fastify({ logger: false })
  app.get('/health', async () => ({ service: 'collector-api', ok: true }))
  app.post('/v1/devices/bind', async (request, reply) => {
    const input = body<{ userToken?: string; publicKey?: string; proof?: string; deviceName?: string }>(request.body)
    try {
      const user = await authenticateToken(sql, domains.user, 'user', input.userToken ?? ''); const key = Buffer.from(input.publicKey ?? '', 'base64'); const proof = Buffer.from(input.proof ?? '', 'base64')
      if (!key.length || !verify(null, Buffer.from(user.sub ?? ''), { key, format: 'der', type: 'spki' }, proof)) return fail(reply, 401, '设备签名无效')
      const fingerprint = createHash('sha256').update(key).digest('hex'); const active = await sql.query("SELECT COUNT(*)::int AS total FROM identity.collector_clients WHERE user_id=$1 AND status='active'", [user.sub])
      if (Number(active.rows[0]?.total) >= 2) return fail(reply, 403, '设备数量已达上限')
      const id = randomUUID(); await sql.query("INSERT INTO identity.collector_clients (id,user_id,device_public_key_fingerprint,device_public_key,key_algorithm,device_name,platform,app_version,status,created_at) VALUES ($1,$2,$3,$4,'ed25519',$5,'windows','phase1','active',now())", [id, user.sub, fingerprint, input.publicKey, input.deviceName ?? 'Collector'])
      return issue(sql, domains.collector, 'collector', id, id)
    } catch { return fail(reply, 401, '设备绑定失败') }
  })
  app.get('/v1/entitlements', async (request, reply) => { try { const claims = await authenticate(sql, domains.collector, 'collector', request.headers.authorization); const client = await sql.query("SELECT user_id FROM identity.collector_clients WHERE id=$1 AND status='active'", [claims.sub]); if (!client.rows[0]) return fail(reply, 403, '设备已撤销'); const grants = await sql.query('SELECT capability,limit_value FROM billing.entitlement_grants WHERE user_id=$1 AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now())', [client.rows[0].user_id]); return { items: grants.rows } } catch { return fail(reply, 403, '采集器权限不足') } })
  return app
}
