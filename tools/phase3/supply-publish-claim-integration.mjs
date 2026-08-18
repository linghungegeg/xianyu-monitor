import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCollectorApi, createUserApi } from '../../services/cloud/src/api.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase3-supply-claim-${process.pid}-${Date.now()}`)
const domains = {
  user: { issuer: 'https://user.phase3-supply.test', audience: 'user-api', secret: 'user-phase3-supply-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.phase3-supply.test', audience: 'admin-api', secret: 'admin-phase3-supply-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.phase3-supply.test', audience: 'collector-api', secret: 'collector-phase3-supply-secret-012345678901234567890' }
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

async function applyMigrations(db) {
  const migrations = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql')).sort()
  for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  return migrations
}

function publicKey(keyPair) {
  return keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

function proof(userId, keyPair) {
  return sign(null, Buffer.from(userId), keyPair.privateKey).toString('base64')
}

async function register(api, db, email) {
  const response = await api.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'phase3-supply-123' } })
  assert(response.statusCode === 200, `注册失败：${response.statusCode} ${response.body}`)
  const id = String((await db.query('SELECT id FROM identity.users WHERE email_normalized=$1', [email])).rows[0].id)
  await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at)
    VALUES ($1,$2,'collector',1,now(),'phase3-supply',now())`, [randomUUID(), id])
  return { id, accessToken: json(response).accessToken }
}

async function bind(collectorApi, user, name) {
  const keyPair = generateKeyPairSync('ed25519')
  const response = await collectorApi.inject({
    method: 'POST',
    url: '/v1/devices/bind',
    headers: auth(user.accessToken),
    payload: { publicKey: publicKey(keyPair), proof: proof(user.id, keyPair), deviceName: name }
  })
  assert(response.statusCode === 200, `设备绑定失败：${response.statusCode} ${response.body}`)
  return json(response)
}

async function materialAndPlan(userApi, token, sourceItemId, planKey, schedule = { mode: 'immediate' }) {
  const imported = await userApi.inject({
    method: 'POST',
    url: '/v1/supply/imports',
    headers: auth(token),
    payload: {
      schemaVersion: 1,
      sourceType: 'general',
      sourceFormat: 'parsed_snapshot_json',
      idempotencyKey: `import-${sourceItemId}`,
      snapshots: [{
        sourcePlatform: '1688',
        sourceItemId,
        sourceUrl: `https://detail.1688.com/offer/${sourceItemId}.html?token=never-cloud`,
        title: `冻结素材 ${sourceItemId}`,
        price: 19.9,
        mainImages: [`https://img.example.test/${sourceItemId}.jpg?session=local-only`]
      }]
    }
  })
  assert(imported.statusCode === 200, `素材导入失败：${imported.statusCode} ${imported.body}`)
  const materials = await userApi.inject({ method: 'GET', url: '/v1/supply/materials?limit=20&source_platform=1688', headers: auth(token) })
  const material = materials.statusCode === 200 ? json(materials).items.find((item) => item.sourceItemId === sourceItemId) : undefined
  assert(material, `导入素材查询失败：${materials.statusCode} ${materials.body}`)
  const materialId = material.id
  const plan = await userApi.inject({
    method: 'POST',
    url: '/v1/supply/publish-plans',
    headers: auth(token),
    payload: { schemaVersion: 1, materialId, idempotencyKey: planKey, schedule }
  })
  assert(plan.statusCode === 200, `计划创建失败：${plan.statusCode} ${plan.body}`)
  return { materialId, plan: json(plan) }
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains)
  const collectorApi = createCollectorApi(sql, domains)
  const migrations = await applyMigrations(db)
  await applyMigrations(db)

  try {
    const userA = await register(userApi, db, 'phase3-supply-a@example.test')
    const userB = await register(userApi, db, 'phase3-supply-b@example.test')
    const deviceA = await bind(collectorApi, userA, 'phase3-supply-device-a')
    const deviceB = await bind(collectorApi, userB, 'phase3-supply-device-b')
    const due = await materialAndPlan(userApi, userA.accessToken, 'due-001', 'phase3-due')
    const archived = await materialAndPlan(userApi, userA.accessToken, 'archived-001', 'phase3-archived')
    const archive = await userApi.inject({ method: 'DELETE', url: `/v1/supply/materials/${archived.materialId}`, headers: auth(userA.accessToken) })
    assert(archive.statusCode === 200, '归档素材失败')
    const future = await materialAndPlan(userApi, userA.accessToken, 'future-001', 'phase3-future', { mode: 'scheduled', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
    const other = await materialAndPlan(userApi, userB.accessToken, 'other-001', 'phase3-other')
    const cancelled = await materialAndPlan(userApi, userA.accessToken, 'cancelled-001', 'phase3-cancelled')
    const cancel = await userApi.inject({ method: 'PATCH', url: `/v1/supply/publish-plans/${cancelled.plan.id}`, headers: auth(userA.accessToken), payload: { status: 'cancelled' } })
    assert(cancel.statusCode === 200, '取消计划失败')

    const missingCollector = await collectorApi.inject({ method: 'POST', url: '/v1/supply/publish-plans/claim', payload: { schemaVersion: 1, deviceId: deviceA.clientId, idempotencyKey: 'missing', limit: 10 } })
    assert(missingCollector.statusCode === 403, '无采集器令牌可领取计划')
    const userTokenClaim = await collectorApi.inject({ method: 'POST', url: '/v1/supply/publish-plans/claim', headers: auth(userA.accessToken), payload: { schemaVersion: 1, deviceId: deviceA.clientId, idempotencyKey: 'wrong-subject', limit: 10 } })
    assert(userTokenClaim.statusCode === 403, '用户令牌可领取计划')
    const mismatchedDevice = await collectorApi.inject({ method: 'POST', url: '/v1/supply/publish-plans/claim', headers: auth(deviceA.accessToken), payload: { schemaVersion: 1, deviceId: deviceB.clientId, idempotencyKey: 'wrong-device', limit: 10 } })
    assert(mismatchedDevice.statusCode === 403, '令牌与 deviceId 不匹配仍可领取')

    const claimed = await collectorApi.inject({ method: 'POST', url: '/v1/supply/publish-plans/claim', headers: auth(deviceA.accessToken), payload: { schemaVersion: 1, deviceId: deviceA.clientId, idempotencyKey: 'phase3-claim-a', limit: 10 } })
    assert(claimed.statusCode === 200, `领取到期计划失败：${claimed.statusCode} ${claimed.body}`)
    const first = json(claimed)
    assert(first.schemaVersion === 1 && first.deviceId === deviceA.clientId && first.duplicate === false, '领取合同缺少版本或设备归属')
    assert(first.items.length === 2, `到期领取应包含冻结和归档素材计划：${claimed.body}`)
    assert(first.items.some((item) => item.id === due.plan.id) && first.items.some((item) => item.id === archived.plan.id), '没有返回正确的到期计划')
    assert(!first.items.some((item) => item.id === future.plan.id || item.id === cancelled.plan.id), '未来或已取消计划被领取')
    assert(first.items.every((item) => item.materialSnapshot.sourceUrl.includes('token=') === false && item.materialSnapshot.mainImages[0].includes('session=') === false), '敏感 URL 查询参数进入领取快照')
    assert(JSON.stringify(first).match(/cookie|authorization|profile|chrome/i) === null, '领取响应包含本机敏感状态')
    const frozen = first.items.find((item) => item.id === archived.plan.id)
    assert(frozen.materialSnapshot.title === '冻结素材 archived-001', '归档后未返回冻结素材快照')

    const race = await materialAndPlan(userApi, userA.accessToken, 'race-001', 'phase3-race')
    const concurrent = await Promise.all([
      collectorApi.inject({ method: 'POST', url: '/v1/supply/publish-plans/claim', headers: auth(deviceA.accessToken), payload: { schemaVersion: 1, deviceId: deviceA.clientId, idempotencyKey: 'phase3-claim-race', limit: 10 } }),
      collectorApi.inject({ method: 'POST', url: '/v1/supply/publish-plans/claim', headers: auth(deviceA.accessToken), payload: { schemaVersion: 1, deviceId: deviceA.clientId, idempotencyKey: 'phase3-claim-race', limit: 10 } })
    ])
    assert(concurrent.every((response) => response.statusCode === 200), `并发领取失败：${concurrent.map((response) => response.body).join(' | ')}`)
    const concurrentBodies = concurrent.map(json)
    assert(concurrentBodies.every((body) => body.claimBatchId === concurrentBodies[0].claimBatchId && body.items.map((item) => item.id).join(',') === race.plan.id), '并发同键领取返回了不同批次或重复计划')

    const repeated = await collectorApi.inject({ method: 'POST', url: '/v1/supply/publish-plans/claim', headers: auth(deviceA.accessToken), payload: { schemaVersion: 1, deviceId: deviceA.clientId, idempotencyKey: 'phase3-claim-a', limit: 1 } })
    assert(repeated.statusCode === 200, `重复领取失败：${repeated.statusCode} ${repeated.body}`)
    const replay = json(repeated)
    assert(replay.duplicate === true && replay.claimBatchId === first.claimBatchId && replay.items.map((item) => item.id).join(',') === first.items.map((item) => item.id).join(','), '同一设备重复领取未返回同一批冻结计划')
    const claimRows = await db.query('SELECT COUNT(*)::int AS total FROM supply.publish_plan_claims WHERE claim_batch_id=$1', [first.claimBatchId])
    assert(Number(claimRows.rows[0].total) === 2, '重复领取写入了重复明细')

    const otherDeviceClaim = await collectorApi.inject({ method: 'POST', url: '/v1/supply/publish-plans/claim', headers: auth(deviceB.accessToken), payload: { schemaVersion: 1, deviceId: deviceB.clientId, idempotencyKey: 'phase3-claim-b', limit: 10 } })
    assert(otherDeviceClaim.statusCode === 200 && json(otherDeviceClaim).items.map((item) => item.id).join(',') === other.plan.id, '其他设备越权领取了用户 A 的计划')
    const states = await db.query('SELECT id,status,claimed_by_client_id FROM supply.publish_plans WHERE id = ANY($1::uuid[])', [[due.plan.id, archived.plan.id, future.plan.id, cancelled.plan.id]])
    const stateById = new Map(states.rows.map((row) => [String(row.id), row]))
    assert(stateById.get(due.plan.id).status === 'claimed' && stateById.get(due.plan.id).claimed_by_client_id === deviceA.clientId, '到期计划没有绑定领取设备')
    assert(stateById.get(future.plan.id).status === 'planned' && stateById.get(cancelled.plan.id).status === 'cancelled', '未到期或取消计划状态被改变')
    const storedSensitive = await db.query("SELECT COUNT(*)::int AS total FROM supply.publish_claim_batches b JOIN supply.publish_plan_claims c ON c.claim_batch_id=b.id WHERE row_to_json(b)::text ILIKE '%cookie%' OR row_to_json(c)::text ILIKE '%cookie%'")
    assert(Number(storedSensitive.rows[0].total) === 0, '领取审计表写入了敏感状态')

    console.log(JSON.stringify({
      scenario: 'phase3-supply-publish-claim',
      migrations,
      assertions: {
        migrationRepeatable: true,
        collectorTokenAndBoundDeviceOnly: true,
        userIsolation: true,
        dueOnlyAndCancelledExcluded: true,
        claimIdempotency: true,
        concurrentClaimIdempotency: true,
        archivedMaterialUsesFrozenSnapshot: true,
        sensitiveBoundary: true,
        claimAuditNoSensitiveState: true
      }
    }, null, 2))
  } finally {
    await Promise.allSettled([userApi.close(), collectorApi.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ scenario: 'phase3-supply-publish-claim', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
