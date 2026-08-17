import Fastify from 'fastify'
import { createHash, createHmac, randomUUID, timingSafeEqual, verify } from 'node:crypto'
import type { TokenDomain, SubjectKind } from './security.ts'
import { createRefreshToken, hashPassword, signAccessToken, verifyAccessToken, verifyPassword } from './security.ts'

export type Sql = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
export type Domains = Record<SubjectKind, TokenDomain>

type UserRow = { id: string; email_normalized: string; password_hash: string; status: string }
type SessionRow = { id: string; subject_type: SubjectKind; subject_id: string; family_id: string | null; revoked_at: string | null; expires_at: string }

type ListOrder = 'asc' | 'desc'
type ListFilters = Record<string, string>
type ListConfig = { resource: string; defaultSort: string; sortAliases: Record<string, string>; filterAliases: Record<string, string>; allowedFilters: readonly string[] }
type ParsedListQuery = { limit: number; cursor?: string; sort: string; order: ListOrder; filters: ListFilters; filterHash: string }
type CursorPayload = { v: 1; resource: string; filterHash: string; sort: string; order: ListOrder; snapshot: string; key: [string, string] }
type SnapshotPayload = { v: 1; resource: string; at: string }
type ListContext = ParsedListQuery & { snapshot: string; snapshotAt: string; cursorKey?: [string, string] }

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
  return ['last_seen_at', 'first_seen_at', 'created_at'].includes(sort) ? timestamp(value) : String(value)
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

const marketItemsListConfig: ListConfig = {
  resource: 'user.market_items',
  defaultSort: 'last_seen_at',
  sortAliases: {
    last_seen_at: 'last_seen_at', updated_at: 'last_seen_at', recent: 'last_seen_at',
    first_seen_at: 'first_seen_at', platform_item_id: 'platform_item_id', name: 'platform_item_id', id: 'id'
  },
  filterAliases: { search: 'q', lifecycle_state: 'state', lifecycleState: 'state', sellerId: 'seller_id', categoryId: 'category_id' },
  allowedFilters: ['q', 'state', 'platform', 'seller_id', 'category_id']
}

const adminUsersListConfig: ListConfig = {
  resource: 'admin.users',
  defaultSort: 'created_at',
  sortAliases: { created_at: 'created_at', updated_at: 'created_at', recent: 'created_at', email: 'email', name: 'email', id: 'id' },
  filterAliases: { search: 'q' },
  allowedFilters: ['q', 'status']
}

function marketConditions(context: ListContext, values: unknown[], includeCursor: boolean): string[] {
  const conditions = ['i.first_seen_at <= $1']
  const filters = context.filters
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

async function listMarketItems(sql: Sql, context: ListContext, secret: string) {
  const sortExpression = ({ last_seen_at: 'i.last_seen_at', first_seen_at: 'i.first_seen_at', platform_item_id: 'i.platform_item_id', id: 'i.id::text' } as Record<string, string>)[context.sort]
  const pageValues: unknown[] = [context.snapshotAt]
  const pageWhere = marketConditions(context, pageValues, true).join(' AND ')
  const rows = await sql.query(`SELECT i.id, i.platform, i.platform_item_id AS "platformItemId", i.lifecycle_state AS state,
      i.first_seen_at AS "firstSeenAt", i.last_seen_at AS "lastSeenAt", ${sortExpression} AS cursor_sort_value, i.id::text AS cursor_id
    FROM market.items i WHERE ${pageWhere}
    ORDER BY ${sortExpression} ${context.order.toUpperCase()}, i.id ${context.order.toUpperCase()} LIMIT ${context.limit + 1}`, pageValues)
  const countValues: unknown[] = [context.snapshotAt]
  const countWhere = marketConditions(context, countValues, false).join(' AND ')
  const total = Number((await sql.query(`SELECT COUNT(*)::int AS total FROM market.items i WHERE ${countWhere}`, countValues)).rows[0]?.total ?? 0)
  return listResponse(context, rows.rows, total, secret, marketItemsListConfig.resource)
}

function adminUsersConditions(context: ListContext, values: unknown[], includeCursor: boolean): string[] {
  const conditions = ['u.created_at <= $1']
  const filters = context.filters
  if (filters.q) { values.push(`%${filters.q}%`); conditions.push(`LOWER(u.email_normalized) LIKE LOWER($${values.length})`) }
  if (filters.status) { values.push(filters.status); conditions.push(`u.status = $${values.length}`) }
  if (includeCursor && context.cursorKey) {
    const expression = ({ created_at: 'u.created_at', email: 'u.email_normalized', id: 'u.id::text' } as Record<string, string>)[context.sort]
    conditions.push(keyset(values, expression, 'u.id::text', context.order, context.cursorKey))
  }
  return conditions
}

async function listAdminUsers(sql: Sql, context: ListContext, secret: string) {
  const sortExpression = ({ created_at: 'u.created_at', email: 'u.email_normalized', id: 'u.id::text' } as Record<string, string>)[context.sort]
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

export function createUserApi(sql: Sql, domains: Domains) {
  const app = Fastify({ logger: false })
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
  app.get('/v1/market/items', async (request, reply) => {
    try { await authenticate(sql, domains.user, 'user', request.headers.authorization) } catch { return fail(reply, 401, '未授权') }
    try {
      const context = await prepareList(sql, request.query, marketItemsListConfig, domains.user.secret)
      return await listMarketItems(sql, context, domains.user.secret)
    } catch (error) {
      if (error instanceof ListRequestError) return listFail(reply, error)
      throw error
    }
  })
  return app
}

export function createAdminApi(sql: Sql, domains: Domains) {
  const app = Fastify({ logger: false })
  app.get('/health', async () => ({ service: 'admin-api', ok: true }))
  app.post('/v1/auth/login', async (request, reply) => {
    const input = body<{ email?: string; password?: string }>(request.body); const found = await sql.query('SELECT id,email_normalized,password_hash,status,role,mfa_state FROM identity.admin_users WHERE email_normalized=$1', [input.email?.trim().toLowerCase()]); const admin = found.rows[0] as (UserRow & { role: string; mfa_state: string }) | undefined
    if (!admin || admin.status !== 'active' || admin.mfa_state !== 'enrolled' || !input.password || !(await verifyPassword(input.password, admin.password_hash))) return fail(reply, 401, '管理员认证失败')
    return issue(sql, domains.admin, 'admin', admin.id)
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
