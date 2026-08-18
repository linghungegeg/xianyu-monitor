import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCollectorApi, createUserApi } from '../../services/cloud/src/api.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-supply-migration-${process.pid}-${Date.now()}`)
const domains = {
  user: { issuer: 'https://user.supply-migration.test', audience: 'user-api', secret: 'user-supply-migration-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.supply-migration.test', audience: 'admin-api', secret: 'admin-supply-migration-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.supply-migration.test', audience: 'collector-api', secret: 'collector-supply-migration-secret-012345678901234567890' }
}

function assert(value, message) { if (!value) throw new Error(message) }
function json(response) { return JSON.parse(response.body) }
function auth(token) { return { authorization: `Bearer ${token}` } }

async function applyMigrations(db) {
  const files = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql')).sort()
  for (let pass = 0; pass < 2; pass += 1) for (const file of files) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  return files
}

async function registerUser(api, email) {
  const response = await api.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'phase6-migration-123' } })
  assert(response.statusCode === 200, `注册失败：${response.statusCode} ${response.body}`)
  return json(response).accessToken
}

async function bind(collectorApi, userAccess, userId) {
  const pair = generateKeyPairSync('ed25519')
  const response = await collectorApi.inject({ method: 'POST', url: '/v1/devices/bind', headers: auth(userAccess), payload: {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), proof: sign(null, Buffer.from(userId), pair.privateKey).toString('base64'), deviceName: 'phase6-migration-device'
  } })
  assert(response.statusCode === 200, `设备绑定失败：${response.statusCode} ${response.body}`)
  return json(response)
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains)
  const collectorApi = createCollectorApi(sql, domains)
  const migrations = await applyMigrations(db)
  try {
    const userAccess = await registerUser(userApi, 'phase6-migration@example.test')
    const userId = String((await db.query("SELECT id FROM identity.users WHERE email_normalized='phase6-migration@example.test'")).rows[0].id)
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at)
      VALUES ($1,$2,'collector',1,now(),'phase6-migration',now())`, [randomUUID(), userId])
    const device = await bind(collectorApi, userAccess, userId)

    const invalid = await userApi.inject({ method: 'POST', url: '/v1/supply/migrations', headers: auth(userAccess), payload: { schemaVersion: 1, idempotencyKey: 'migration-invalid', source: { kind: 'public_url', itemUrl: 'https://www.goofish.com/item?id=unsafe', cookie: 'forbidden' } } })
    assert(invalid.statusCode === 400, '敏感字段未被请求合同拒绝')
    const first = await userApi.inject({ method: 'POST', url: '/v1/supply/migrations', headers: auth(userAccess), payload: { schemaVersion: 1, idempotencyKey: 'migration-public', source: { kind: 'public_url', itemUrl: 'https://www.goofish.com/item?id=migration-item&token=discard#fragment' } } })
    assert(first.statusCode === 200, `公开链接请求失败：${first.statusCode} ${first.body}`)
    const request = json(first)
    assert(request.status === 'queued' && request.platformItemId === 'migration-item' && request.itemUrl === 'https://www.goofish.com/item?id=migration-item', '公开链接没有规范化')
    const replay = await userApi.inject({ method: 'POST', url: '/v1/supply/migrations', headers: auth(userAccess), payload: { schemaVersion: 1, idempotencyKey: 'migration-public', source: { kind: 'public_url', itemUrl: 'https://www.goofish.com/item?id=migration-item' } } })
    assert(replay.statusCode === 200 && json(replay).duplicate === true && json(replay).id === request.id, '搬家请求重复提交没有幂等')

    const claim = await collectorApi.inject({ method: 'POST', url: '/v1/supply/migrations/claim', headers: auth(device.accessToken), payload: { schemaVersion: 1, deviceId: device.clientId, idempotencyKey: 'migration-claim-a', limit: 1 } })
    assert(claim.statusCode === 200 && json(claim).items.length === 1 && json(claim).items[0].id === request.id, `设备未领取搬家请求：${claim.body}`)
    const snapshot = { sourcePlatform: 'goofish', sourceItemId: 'migration-item', sourceUrl: 'https://www.goofish.com/item?id=migration-item', title: '公开闲鱼商品', description: '公开详情', price: 99, mainImages: ['https://images.example.test/migration.jpg'], detailImages: [], sku: null, attributes: { condition: '95新' } }
    const resultPayload = { schemaVersion: 1, deviceId: device.clientId, attemptKey: 'migration-result-a', status: 'succeeded', snapshot }
    const result = await collectorApi.inject({ method: 'POST', url: `/v1/supply/migrations/${request.id}/result`, headers: auth(device.accessToken), payload: resultPayload })
    assert(result.statusCode === 200 && json(result).status === 'succeeded' && json(result).materialId, `搬家结果写入失败：${result.body}`)
    const duplicate = await collectorApi.inject({ method: 'POST', url: `/v1/supply/migrations/${request.id}/result`, headers: auth(device.accessToken), payload: resultPayload })
    assert(duplicate.statusCode === 200 && json(duplicate).duplicate === true, '搬家结果重传没有幂等')
    const material = (await db.query('SELECT source_type,source_platform,source_item_id,source_url,title,main_images,sku,attributes FROM supply.materials WHERE id=$1', [json(result).materialId])).rows[0]
    assert(material?.source_type === 'xianyu' && material.source_platform === 'goofish' && material.source_item_id === 'migration-item' && material.title === '公开闲鱼商品', '搬家素材没有按规范落库')
    const sensitive = await db.query("SELECT COUNT(*)::int AS total FROM supply.migration_requests r JOIN supply.migration_attempts a ON a.request_id=r.id WHERE row_to_json(r)::text ~* '(cookie|token|profile)' OR row_to_json(a)::text ~* '(cookie|token|profile)'")
    assert(Number(sensitive.rows[0].total) === 0, '搬家审计写入了本机敏感状态')

    console.log(JSON.stringify({ scenario: 'phase6-supply-migration', migrations, assertions: { migrationRepeatable: true, publicUrlSanitized: true, sensitiveFieldRejected: true, collectorBoundDeviceOnly: true, resultIdempotency: true, publicSnapshotOnly: true } }, null, 2))
  } finally {
    await Promise.allSettled([userApi.close(), collectorApi.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => { console.error(JSON.stringify({ scenario: 'phase6-supply-migration', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })
