import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAdminApi, createCollectorApi, createUserApi } from '../../services/cloud/src/api.ts'
import { hashPassword } from '../../services/cloud/src/security.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase6-cloud-${process.pid}-${Date.now()}`)
const domains = {
  user: { issuer: 'https://user.phase6.test', audience: 'user-api', secret: 'user-phase6-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.phase6.test', audience: 'admin-api', secret: 'admin-phase6-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.phase6.test', audience: 'collector-api', secret: 'collector-phase6-secret-012345678901234567890' }
}

function assert(condition, message) { if (!condition) throw new Error(message) }
function json(response) { return JSON.parse(response.body) }
function auth(token) { return { authorization: `Bearer ${token}` } }
function publicKey(pair) { return pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }
function proof(userId, pair) { return sign(null, Buffer.from(userId), pair.privateKey).toString('base64') }
async function applyMigrations(db) {
  const migrations = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql')).sort()
  for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  return migrations
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains)
  const collectorApi = createCollectorApi(sql, domains)
  const adminApi = createAdminApi(sql, domains)
  const migrations = await applyMigrations(db)
  try {
    const registration = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'phase6@example.test', password: 'phase6-password-123' } })
    assert(registration.statusCode === 200, `用户注册失败: ${registration.body}`)
    const userAccess = json(registration).accessToken
    const userId = String((await db.query("SELECT id FROM identity.users WHERE email_normalized='phase6@example.test'")).rows[0].id)
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at) VALUES ($1,$2,'collector',1,now(),'phase6',now())`, [randomUUID(), userId])
    const pair = generateKeyPairSync('ed25519')
    const boundResponse = await collectorApi.inject({ method: 'POST', url: '/v1/devices/bind', headers: auth(userAccess), payload: { publicKey: publicKey(pair), proof: proof(userId, pair), deviceName: 'phase6-device' } })
    assert(boundResponse.statusCode === 200, `设备绑定失败: ${boundResponse.body}`)
    const session = json(boundResponse)
    const records = [
      { type: 'seller', idempotencyKey: 'seller:phase6', platform: 'goofish', platformSellerId: 'seller-phase6', publicName: '公开卖家', publicProfile: { rating: '5' }, contentHash: 'seller-phase6-v1' },
      { type: 'version', idempotencyKey: 'version:phase6', platform: 'goofish', platformItemId: 'item-phase6', platformSellerId: 'seller-phase6', state: 'active', title: '公开商品', price: 99, contentHash: 'item-phase6-v1', payload: { title: '公开商品', imageUrls: ['https://img.example/public.jpg'] } },
      { type: 'snapshot', idempotencyKey: 'snapshot:phase6', platform: 'goofish', platformItemId: 'item-phase6', platformSellerId: 'seller-phase6', payloadHash: 'snapshot-phase6-v1' },
      { type: 'event', idempotencyKey: 'event:phase6', platform: 'goofish', platformItemId: 'item-phase6', platformSellerId: 'seller-phase6', eventType: 'new_listing', eventKey: 'event-phase6-v1' }
    ]
    const payload = { schemaVersion: 1, deviceId: session.clientId, batchId: randomUUID(), idempotencyKey: 'phase6-batch-1', batchSequence: 1, cursor: { start: '0', end: '1' }, records }
    const first = await collectorApi.inject({ method: 'POST', url: '/v1/ingest', headers: auth(session.accessToken), payload })
    assert(first.statusCode === 200, `批量上传失败: ${first.body}`)
    const firstBody = json(first)
    const rejections = await db.query('SELECT failure_reason FROM ops.ingest_rejections WHERE batch_id=$1', [payload.batchId])
    assert(firstBody.insertedCount === 4 && firstBody.failedCount === 0 && firstBody.cursor.end === '1', `批次结果或游标错误: ${first.body} ${JSON.stringify(rejections.rows)}`)
    const repeat = await collectorApi.inject({ method: 'POST', url: '/v1/ingest', headers: auth(session.accessToken), payload })
    assert(repeat.statusCode === 200 && json(repeat).duplicate === true && json(repeat).retryCount === 1, '同设备重复批次未幂等或未记录重试')
    const secondPayload = { ...payload, batchId: randomUUID(), idempotencyKey: 'phase6-batch-2', batchSequence: 2 }
    const second = await collectorApi.inject({ method: 'POST', url: '/v1/ingest', headers: auth(session.accessToken), payload: secondPayload })
    assert(second.statusCode === 200 && json(second).deduplicatedCount >= 2, '同版本或同事件重复上传未去重')
    const sensitive = await collectorApi.inject({ method: 'POST', url: '/v1/ingest', headers: auth(session.accessToken), payload: { ...payload, batchId: randomUUID(), idempotencyKey: 'phase6-sensitive', batchSequence: 3, records: [{ ...records[0], xianyuCookie: 'local-only', chromeProfilePath: 'C:\\profile' }] } })
    assert(sensitive.statusCode === 400 && !sensitive.body.includes('local-only'), '敏感字段未拒绝或泄漏到响应')
    const media = await collectorApi.inject({ method: 'POST', url: '/v1/ingest/media', headers: auth(session.accessToken), payload: { batchId: payload.batchId, sha256: 'a'.repeat(64), mimeType: 'image/jpeg', byteSize: 123, objectKey: 'public/a.jpg' } })
    assert(media.statusCode === 200 && json(media).storage === 'metadata-only', '公开媒体元数据未接收')
    await db.query("UPDATE billing.entitlement_grants SET effective_to=now() WHERE user_id=$1 AND capability='collector'", [userId])
    const expiredEntitlements = await collectorApi.inject({ method: 'GET', url: '/v1/entitlements', headers: auth(session.accessToken) })
    const expiredIngest = await collectorApi.inject({ method: 'POST', url: '/v1/ingest', headers: auth(session.accessToken), payload: { ...payload, batchId: randomUUID(), idempotencyKey: 'phase6-expired-entitlement', batchSequence: 4 } })
    const expiredMedia = await collectorApi.inject({ method: 'POST', url: '/v1/ingest/media', headers: auth(session.accessToken), payload: { batchId: payload.batchId, sha256: 'b'.repeat(64), mimeType: 'image/jpeg', byteSize: 123, objectKey: 'public/b.jpg' } })
    const refreshAfterEntitlementExpiry = await collectorApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: session.refreshToken } })
    assert(expiredEntitlements.statusCode === 200 && json(expiredEntitlements).allowed === false && expiredIngest.statusCode === 403 && expiredMedia.statusCode === 403 && refreshAfterEntitlementExpiry.statusCode === 401, '权益失效后旧设备仍可查询状态但不能上传或刷新')
    const itemCount = await db.query("SELECT COUNT(*)::int AS total FROM market.items WHERE platform_item_id='item-phase6'")
    const eventCount = await db.query("SELECT COUNT(*)::int AS total FROM market.item_event_dedup WHERE event_key='event-phase6-v1'")
    assert(Number(itemCount.rows[0].total) === 1 && Number(eventCount.rows[0].total) === 1, '规范化实体或事件重复写入')
    const marketRead = await userApi.inject({ method: 'GET', url: '/v1/market/items?limit=20&q=item-phase6', headers: auth(userAccess) })
    const forbiddenUserUpload = await userApi.inject({ method: 'GET', url: '/v1/uploads', headers: auth(userAccess) })
    assert(marketRead.statusCode === 200 && json(marketRead).items.some((item) => item.platformItemId === 'item-phase6') && forbiddenUserUpload.statusCode === 404, 'User 未只读最终市场数据或暴露上传状态')
    await db.query(`INSERT INTO identity.admin_users (id,email_normalized,password_hash,role,status,mfa_state,created_at) VALUES ($1,'admin-phase6@example.test',$2,'owner','active','enrolled',now())`, [randomUUID(), await hashPassword('p6-admin-123456')])
    const adminLogin = await adminApi.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'admin-phase6@example.test', password: 'p6-admin-123456' } })
    assert(adminLogin.statusCode === 200, 'Admin 登录失败')
    const uploads = await adminApi.inject({ method: 'GET', url: `/v1/admin/uploads?limit=20&user_id=${encodeURIComponent(userId)}&sort=received_at&order=desc`, headers: auth(json(adminLogin).accessToken) })
    assert(uploads.statusCode === 200 && json(uploads).items.length === 2 && json(uploads).items[0].receivedCount === 4, 'Admin 上传审计字段或用户筛选失败')
    const itemAudit = await adminApi.inject({ method: 'GET', url: '/v1/admin/uploads?limit=20&item_id=item-phase6&sort=received_at&order=desc', headers: auth(json(adminLogin).accessToken) })
    const eventAudit = await adminApi.inject({ method: 'GET', url: '/v1/admin/uploads?limit=20&event_key=event-phase6-v1&sort=received_at&order=desc', headers: auth(json(adminLogin).accessToken) })
    assert(itemAudit.statusCode === 200 && json(itemAudit).page.total === 2 && eventAudit.statusCode === 200 && json(eventAudit).page.total === 2, `Admin 商品或事件关联筛选失败: ${itemAudit.body} ${eventAudit.body}`)
    await userApi.inject({ method: 'POST', url: `/v1/collector-devices/${session.clientId}/revoke`, headers: auth(userAccess) })
    const afterRevoke = await collectorApi.inject({ method: 'POST', url: '/v1/ingest', headers: auth(session.accessToken), payload: { ...payload, batchId: randomUUID(), idempotencyKey: 'phase6-revoked', batchSequence: 5 } })
    const refreshAfterRevoke = await collectorApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: session.refreshToken } })
    assert(afterRevoke.statusCode === 403 && refreshAfterRevoke.statusCode === 401, '解绑后旧设备仍可上传或刷新')
    console.log(JSON.stringify({ scenario: 'phase6-cloud-silent-ingest', migrations, assertions: { migrationRepeatable: true, singleAndBatchSchema: true, batchAndRecordIdempotency: true, cursorAndResultTraceability: true, sensitivePayloadRejected: true, publicMediaMetadataOnly: true, userFinalMarketOnly: true, adminAuditFilters: true, expiredEntitlementQueryCompatible: true, expiredEntitlementBlocked: true, revokedDeviceBlocked: true } }, null, 2))
  } finally {
    await Promise.allSettled([userApi.close(), collectorApi.close(), adminApi.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}
run().catch((error) => { console.error(JSON.stringify({ scenario: 'phase6-cloud-silent-ingest', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })
