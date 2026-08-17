import Fastify from 'fastify'
import { createHash, randomUUID, verify } from 'node:crypto'
import type { TokenDomain, SubjectKind } from './security.ts'
import { createRefreshToken, hashPassword, signAccessToken, verifyAccessToken, verifyPassword } from './security.ts'

export type Sql = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
export type Domains = Record<SubjectKind, TokenDomain>

type UserRow = { id: string; email_normalized: string; password_hash: string; status: string }
type SessionRow = { id: string; subject_type: SubjectKind; subject_id: string; family_id: string | null; revoked_at: string | null; expires_at: string }

function body<T>(value: unknown): T { return value as T }
function refreshHash(token: string): string { return createHash('sha256').update(token).digest('hex') }
function bearer(header: string | undefined): string { if (!header?.startsWith('Bearer ')) throw new Error('缺少访问令牌'); return header.slice(7) }
function fail(reply: { code: (value: number) => { send: (body: unknown) => unknown } }, code: number, message: string) { return reply.code(code).send({ error: message }) }

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
