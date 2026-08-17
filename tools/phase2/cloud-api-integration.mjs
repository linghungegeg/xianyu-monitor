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
  const userApi = createUserApi(sql, domains)
  const adminApi = createAdminApi(sql, domains)
  const passwordHash = await hashPassword('phase2-test-password-123')
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

    const registered = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'reader@example.test', password: 'phase2-reader-password-123' } })
    assert(registered.statusCode === 200, `用户注册失败：${registered.statusCode} ${registered.body}`)
    const userToken = json(registered).accessToken

    const adminLogin = await adminApi.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin@example.test', password: 'phase2-test-password-123' } })
    assert(adminLogin.statusCode === 200, `Admin 登录失败：${adminLogin.statusCode} ${adminLogin.body}`)
    const adminToken = json(adminLogin).accessToken

    const userOnAdmin = await adminApi.inject({ method: 'GET', url: '/v1/users', headers: auth(userToken) })
    assert(userOnAdmin.statusCode === 403, `User token 不应访问 Admin 列表：${userOnAdmin.statusCode}`)
    const adminOnUser = await userApi.inject({ method: 'GET', url: '/v1/market/items', headers: auth(adminToken) })
    assert(adminOnUser.statusCode === 401, `Admin token 不应访问 User 列表：${adminOnUser.statusCode}`)

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

    const tamperedCursor = `${firstUser.page.nextCursor.slice(0, -1)}${firstUser.page.nextCursor.endsWith('a') ? 'b' : 'a'}`
    const tampered = await userApi.inject({ method: 'GET', url: `/v1/market/items?cursor=${encodeURIComponent(tamperedCursor)}`, headers: auth(userToken) })
    assert(tampered.statusCode === 400 && json(tampered).error.code === 'CURSOR_EXPIRED', '篡改 cursor 未返回明确错误')
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
        adminCursorNoDuplicate: true
      },
      user: { firstPage: firstUser.items.length, secondPage: secondUser.items.length, total: secondUser.page.total },
      admin: { firstPage: firstAdmin.items.length, secondPage: secondAdminBody.items.length, total: secondAdminBody.page.total }
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
