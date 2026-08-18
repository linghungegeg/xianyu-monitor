import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createAdminApi, createUserApi } from '../../services/cloud/src/api.ts'
import { hashPassword } from '../../services/cloud/src/security.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase2-cloud-${process.pid}-${Date.now()}`)
const domains = {
  user: { issuer: 'https://user.test', audience: 'user-api', secret: 'user-phase2-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.test', audience: 'admin-api', secret: 'admin-phase2-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.test', audience: 'collector-api', secret: 'collector-phase2-secret-012345678901234567890' }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function json(response) {
  return JSON.parse(response.body)
}

function auth(token) {
  return { authorization: `Bearer ${token}` }
}

function assertPage(response, label) {
  assert(response.statusCode !== 404, `${label} 不应返回 404`)
  assert(response.statusCode === 200, `${label} 失败：${response.statusCode} ${response.body}`)
  const page = json(response)
  assert(Array.isArray(page.items), `${label} 缺少 items 数组`)
  assert(page.page && Number.isInteger(page.page.limit), `${label} 缺少 page.limit`)
  for (const field of ['nextCursor', 'hasMore', 'total', 'snapshot']) assert(Object.hasOwn(page.page, field), `${label} 缺少 page.${field}`)
  assert(typeof page.page.snapshot === 'string' && page.page.snapshot.length > 20, `${label} snapshot 无效`)
  return page
}

function marketId(index) {
  return `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`
}

function userId(index) {
  return `10000000-0000-0000-0000-${String(index).padStart(12, '0')}`
}

async function applyMigrations(db) {
  const migrations = readdirSync(migrationDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  return migrations
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains, { allowedOrigins: ['http://localhost:5174'] })
  const adminApi = createAdminApi(sql, domains, { allowedOrigins: ['http://localhost:5175'] })
  const passwordHash = await hashPassword('p2-test-123456')
  const baseTime = new Date(Date.now() - 120_000).toISOString()
  const migrations = await applyMigrations(db)

  try {
    await db.query(`INSERT INTO identity.admin_users (id,email_normalized,password_hash,role,status,mfa_state,created_at)
      VALUES ($1,'admin@example.test',$2,'owner','active','enrolled',$3)`, [userId(900), passwordHash, baseTime])
    for (let index = 1; index <= 22; index += 1) {
      const createdAt = new Date(Date.parse(baseTime) + index * 1000).toISOString()
      await db.query(`INSERT INTO identity.users (id,email_normalized,password_hash,status,created_at)
        VALUES ($1,$2,$3,'active',$4)`, [userId(index), `seed-${String(index).padStart(2, '0')}@example.test`, passwordHash, createdAt])
      await db.query(`INSERT INTO market.items (id,platform,platform_item_id,lifecycle_state,first_seen_at,last_seen_at)
        VALUES ($1,'goofish',$2,'active',$3,$4)`, [marketId(index), `seed-item-${String(index).padStart(2, '0')}`, createdAt, new Date(Date.parse(createdAt) + index * 100).toISOString()])
    }

  const registered = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'reader@example.test', password: 'p2-reader-123456' } })
    assert(registered.statusCode === 200, `用户注册失败：${registered.statusCode} ${registered.body}`)
    const userToken = json(registered).accessToken
    const readerId = String((await db.query("SELECT id FROM identity.users WHERE email_normalized='reader@example.test'")).rows[0].id)
    const ownClientId = userId(700)
    const otherClientId = userId(701)
    const ownRunId = marketId(700)
    const otherRunId = marketId(701)
    await db.query(`INSERT INTO identity.collector_clients (id,user_id,device_public_key_fingerprint,active_slot,device_name,platform,app_version,status,last_seen_at,created_at)
      VALUES ($1,$2,$3,1,'reader-device','windows','phase2','active',$4,$4),($5,$6,$7,1,'other-device','windows','phase2','active',$4,$4)`, [ownClientId, readerId, 'reader-fingerprint', baseTime, otherClientId, userId(1), 'other-fingerprint'])
    await db.query(`INSERT INTO ops.collection_runs (id,client_id,client_run_id,task_reference,kind,status,started_at,finished_at,result_counts)
      VALUES ($1,$2,'reader-run','reader monitor','search','completed',$3,$3,'{}'),($4,$5,'other-run','other monitor','search','completed',$3,$3,'{}')`, [ownRunId, ownClientId, baseTime, otherRunId, otherClientId])
    for (let index = 1; index <= 22; index += 1) {
      const collectedAt = new Date(Date.parse(baseTime) + index * 1000).toISOString()
      await db.query(`INSERT INTO market.observations (id,collected_at,received_at,collection_run_id,item_id,platform_item_id,payload_hash)
        VALUES ($1,$2,$2,$3,$4,$5,$6)`, [marketId(1000 + index), collectedAt, ownRunId, marketId(index), `seed-item-${String(index).padStart(2, '0')}`, `payload-${index}`])
    }
    await db.query(`INSERT INTO market.items (id,platform,platform_item_id,lifecycle_state,first_seen_at,last_seen_at)
      VALUES ($1,'goofish','other-user-item','active',$2,$2)`, [marketId(88), baseTime])
    await db.query(`INSERT INTO market.observations (id,collected_at,received_at,collection_run_id,item_id,platform_item_id,payload_hash)
      VALUES ($1,$2,$2,$3,$4,'other-user-item','other-payload')`, [marketId(1088), baseTime, otherRunId, marketId(88)])

  const adminLogin = await adminApi.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@example.test', password: 'p2-test-123456' } })
    assert(adminLogin.statusCode === 200, `Admin 登录失败：${adminLogin.statusCode} ${adminLogin.body}`)
    let adminToken = json(adminLogin).accessToken

    const userPreflight = await userApi.inject({ method: 'OPTIONS', url: '/v1/market/items', headers: {
      origin: 'http://localhost:5174',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'Authorization, Content-Type'
    } })
    assert(userPreflight.statusCode === 204, `User CORS 预检失败：${userPreflight.statusCode} ${userPreflight.body}`)
    assert(userPreflight.headers['access-control-allow-origin'] === 'http://localhost:5174', 'User CORS 未回显白名单源')
    assert(userPreflight.headers['access-control-allow-headers'] === 'Authorization, Content-Type', 'User CORS 请求头合同错误')
    assert(!userPreflight.headers['access-control-allow-credentials'], 'User CORS 不应允许 credentials')
    const adminPreflight = await adminApi.inject({ method: 'OPTIONS', url: '/v1/auth/refresh', headers: {
      origin: 'http://localhost:5175',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'Authorization, Content-Type'
    } })
    assert(adminPreflight.statusCode === 204 && adminPreflight.headers['access-control-allow-origin'] === 'http://localhost:5175', 'Admin CORS 预检失败')
    const wrongOrigin = await userApi.inject({ method: 'OPTIONS', url: '/v1/market/items', headers: { origin: 'http://localhost:5175', 'access-control-request-method': 'GET' } })
    assert(wrongOrigin.statusCode === 403, '未白名单源不应通过 CORS')
    const wrongHeader = await userApi.inject({ method: 'OPTIONS', url: '/v1/market/items', headers: { origin: 'http://localhost:5174', 'access-control-request-method': 'GET', 'access-control-request-headers': 'X-Not-Allowed' } })
    assert(wrongHeader.statusCode === 400, 'CORS 不应允许未声明请求头')

    const userOnAdmin = await adminApi.inject({ method: 'GET', url: '/v1/users', headers: auth(userToken) })
    assert(userOnAdmin.statusCode === 403, `User token 不应访问 Admin 列表：${userOnAdmin.statusCode}`)
    const adminOnUser = await userApi.inject({ method: 'GET', url: '/v1/market/items', headers: auth(adminToken) })
    assert(adminOnUser.statusCode === 401, `Admin token 不应访问 User 列表：${adminOnUser.statusCode}`)

    const adminRefreshToken = json(adminLogin).refreshToken
    const refreshedAdmin = await adminApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: adminRefreshToken } })
    assert(refreshedAdmin.statusCode === 200, `Admin refresh 失败：${refreshedAdmin.statusCode} ${refreshedAdmin.body}`)
    adminToken = json(refreshedAdmin).accessToken
    const refreshedMe = await adminApi.inject({ method: 'GET', url: '/v1/me', headers: auth(adminToken) })
    assert(refreshedMe.statusCode === 200, `Admin refresh 后身份失败：${refreshedMe.statusCode}`)
    const replayedAdminRefresh = await adminApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: adminRefreshToken } })
    assert(replayedAdminRefresh.statusCode === 401, 'Admin refresh token 重放未拒绝')
    const revokedDescendantRefresh = await adminApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: json(refreshedAdmin).refreshToken } })
    assert(revokedDescendantRefresh.statusCode === 401, 'Admin refresh token 重放后后代令牌未撤销')
  const reauthenticatedAdmin = await adminApi.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@example.test', password: 'p2-test-123456' } })
    assert(reauthenticatedAdmin.statusCode === 200, `Admin 重登失败：${reauthenticatedAdmin.statusCode} ${reauthenticatedAdmin.body}`)
    adminToken = json(reauthenticatedAdmin).accessToken

    const firstUserPage = await userApi.inject({ method: 'GET', url: '/v1/market/items?limit=20&sort=last_seen_at&order=desc', headers: auth(userToken) })
    assert(firstUserPage.statusCode === 200, `User 首页失败：${firstUserPage.statusCode} ${firstUserPage.body}`)
    const firstUser = json(firstUserPage)
    assert(firstUser.items.length === 20 && firstUser.page.total === 22, 'User 首页数量或 total 错误')
    assert(firstUser.page.hasMore === true && typeof firstUser.page.nextCursor === 'string', 'User 首页没有 nextCursor')
    assert(typeof firstUser.page.snapshot === 'string' && firstUser.page.snapshot.length > 20, 'User 首页没有 opaque snapshot')
    const firstIds = new Set(firstUser.items.map((item) => item.id))

    await db.query(`INSERT INTO market.items (id,platform,platform_item_id,lifecycle_state,first_seen_at,last_seen_at)
      VALUES ($1,'goofish','inserted-after-snapshot','active',clock_timestamp(),clock_timestamp())`, [marketId(99)])
    const secondUrl = `/v1/market/items?limit=20&sort=last_seen_at&order=desc&cursor=${encodeURIComponent(firstUser.page.nextCursor)}`
    const secondUserPage = await userApi.inject({ method: 'GET', url: secondUrl, headers: auth(userToken) })
    assert(secondUserPage.statusCode === 200, `User 第二页失败：${secondUserPage.statusCode} ${secondUserPage.body}`)
    const secondUser = json(secondUserPage)
    assert(secondUser.page.snapshot === firstUser.page.snapshot, 'User 翻页没有复用 snapshot')
    assert(secondUser.page.total === 22 && secondUser.page.hasMore === false && secondUser.page.nextCursor === null, 'User 第二页 page 合同错误')
    assert(secondUser.items.length === 2, `User 第二页条数错误：${secondUser.items.length}`)
    assert(secondUser.items.every((item) => !firstIds.has(item.id) && item.id !== marketId(99)), 'User cursor 出现重复或混入快照后的新数据')

    const [cursorPayload, cursorSignature] = firstUser.page.nextCursor.split('.')
    const tamperedCursor = `${cursorPayload}.${cursorSignature.startsWith('a') ? 'b' : 'a'}${cursorSignature.slice(1)}`
    const tampered = await userApi.inject({ method: 'GET', url: `/v1/market/items?cursor=${encodeURIComponent(tamperedCursor)}`, headers: auth(userToken) })
    assert(tampered.statusCode === 400 && json(tampered).error.code === 'CURSOR_EXPIRED', `篡改 cursor 未返回明确错误：${tampered.statusCode} ${tampered.body}`)
    const mismatched = await userApi.inject({ method: 'GET', url: `/v1/market/items?state=sold&cursor=${encodeURIComponent(firstUser.page.nextCursor)}`, headers: auth(userToken) })
    assert(mismatched.statusCode === 400 && json(mismatched).error.code === 'CURSOR_EXPIRED', '筛选变化未拒绝旧 cursor')
    const invalidLimit = await userApi.inject({ method: 'GET', url: '/v1/market/items?limit=21', headers: auth(userToken) })
    assert(invalidLimit.statusCode === 400 && json(invalidLimit).error.code === 'INVALID_QUERY', '非法 limit 未被拒绝')

    const firstAdminPage = await adminApi.inject({ method: 'GET', url: '/v1/users?limit=20&sort=created_at&order=asc&status=active', headers: auth(adminToken) })
    assert(firstAdminPage.statusCode === 200, `Admin 首页失败：${firstAdminPage.statusCode} ${firstAdminPage.body}`)
    const firstAdmin = json(firstAdminPage)
    assert(firstAdmin.items.length === 20 && firstAdmin.page.total === 23, 'Admin 首页数量或 total 错误')
    assert(firstAdmin.page.hasMore === true && typeof firstAdmin.page.nextCursor === 'string', 'Admin 首页没有 nextCursor')
    assert(firstAdmin.items.every((item) => !('password_hash' in item)), 'Admin 列表泄露密码哈希')
    const secondAdmin = await adminApi.inject({ method: 'GET', url: `/v1/users?limit=20&sort=created_at&order=asc&status=active&cursor=${encodeURIComponent(firstAdmin.page.nextCursor)}`, headers: auth(adminToken) })
    assert(secondAdmin.statusCode === 200, `Admin 第二页失败：${secondAdmin.statusCode} ${secondAdmin.body}`)
    const secondAdminBody = json(secondAdmin)
    assert(secondAdminBody.items.length === 3 && secondAdminBody.page.total === 23 && secondAdminBody.page.hasMore === false, 'Admin cursor 分页合同错误')

    const userRoutes = [
      ['/v1/monitors?limit=20&sort=updated_at_desc&order=desc', 'User monitors'],
      ['/v1/sellers?limit=20&sort=title_asc&order=asc', 'User sellers'],
      ['/v1/market/items?limit=20&sort=updated_at_desc&order=desc', 'User market items'],
      ['/v1/market/discoveries?limit=20&sort=priority_desc&order=desc', 'User discoveries'],
      ['/v1/events?limit=20&sort=title_asc&order=asc', 'User events'],
      ['/v1/logs?limit=20&sort=title_asc&order=asc', 'User logs'],
      ['/v1/ai/insights?limit=20&sort=priority_desc&order=desc', 'User ai']
    ]
    const userPages = {}
    for (const [url, label] of userRoutes) {
      const page = assertPage(await userApi.inject({ method: 'GET', url, headers: auth(userToken) }), label)
      userPages[label] = page
      if (label === 'User monitors') assert(page.items.every((item) => item.clientId === ownClientId), 'User monitors 泄露其他用户采集 run')
      if (label === 'User market items') assert(page.items.every((item) => item.id !== marketId(88)), 'User market items 泄露其他用户商品')
    }
    const adminRoutes = [
      ['/v1/users?limit=20&sort=title&order=asc', 'Admin users'],
      ['/v1/admin/billing?limit=20&sort=status&order=desc', 'Admin billing'],
      ['/v1/admin/market?limit=20&sort=title&order=asc', 'Admin market'],
      ['/v1/admin/quality?limit=20&sort=status&order=desc', 'Admin quality'],
      ['/v1/admin/uploads?limit=20&sort=title&order=asc', 'Admin uploads'],
      ['/v1/admin/ai?limit=20&sort=status&order=desc', 'Admin ai'],
      ['/v1/admin/capacity?limit=20&sort=title&order=asc', 'Admin capacity'],
      ['/v1/admin/audit?limit=20&sort=status&order=desc', 'Admin audit']
    ]
    const adminPages = {}
    for (const [url, label] of adminRoutes) {
      const page = assertPage(await adminApi.inject({ method: 'GET', url, headers: auth(adminToken) }), label)
      adminPages[label] = page
      const userAttempt = await adminApi.inject({ method: 'GET', url, headers: auth(userToken) })
      assert(userAttempt.statusCode === 403, `${label} 不应接受 User token：${userAttempt.statusCode}`)
    }

    console.log(JSON.stringify({
      scenario: 'phase2-cloud-api-pagination',
      migrations,
      assertions: {
        userAdminIdentityIsolation: true,
        unifiedPageContract: true,
        signedCursorAndSnapshot: true,
        filterSortBinding: true,
        snapshotExcludesConcurrentInsert: true,
        userCursorNoDuplicate: true,
        adminCursorNoDuplicate: true,
        adminRefreshRotation: true,
        corsPreflightAndOriginAllowlist: true,
        allWorkbenchListRoutes: true,
        userOwnershipFiltering: true
      },
      user: { firstPage: firstUser.items.length, secondPage: secondUser.items.length, total: secondUser.page.total, workbenchRoutes: Object.keys(userPages).length },
      admin: { firstPage: firstAdmin.items.length, secondPage: secondAdminBody.items.length, total: secondAdminBody.page.total, workbenchRoutes: Object.keys(adminPages).length }
    }, null, 2))
  } finally {
    await Promise.allSettled([userApi.close(), adminApi.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ scenario: 'phase2-cloud-api-pagination', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
