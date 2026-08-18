import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCollectorApi, createUserApi } from '../../services/cloud/src/api.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase5-published-cloud-${process.pid}-${Date.now()}`)
const domains = {
  user: { issuer: 'https://user.phase5-published.test', audience: 'user-api', secret: 'user-phase5-published-secret-012345678901' },
  admin: { issuer: 'https://admin.phase5-published.test', audience: 'admin-api', secret: 'admin-phase5-published-secret-012345678901' },
  collector: { issuer: 'https://collector.phase5-published.test', audience: 'collector-api', secret: 'collector-phase5-published-secret-012345' }
}

function assert(condition, message) { if (!condition) throw new Error(message) }
function json(response) { return JSON.parse(response.body) }
function auth(token) { return { authorization: `Bearer ${token}` } }

async function applyMigrations(db) {
  const migrations = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql')).sort()
  for (let pass = 0; pass < 2; pass += 1) for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  return migrations
}

async function registerUser(userApi, email) {
  const response = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'phase5-pub-1234' } })
  assert(response.statusCode === 200, `用户注册失败：${response.statusCode} ${response.body}`)
  return json(response).accessToken
}

async function bindCollector(collectorApi, userAccess, userId) {
  const pair = generateKeyPairSync('ed25519')
  const response = await collectorApi.inject({
    method: 'POST', url: '/v1/devices/bind', headers: auth(userAccess),
    payload: {
      publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      proof: sign(null, Buffer.from(userId), pair.privateKey).toString('base64'),
      deviceName: 'phase5-published-device'
    }
  })
  assert(response.statusCode === 200, `设备绑定失败：${response.statusCode} ${response.body}`)
  return json(response)
}

async function createPublishedTask(userApi, accessToken, payload) {
  const response = await userApi.inject({ method: 'POST', url: '/v1/published-item-monitors', headers: auth(accessToken), payload: { intervalSeconds: 1800, ...payload } })
  assert(response.statusCode === 200, `发布商品任务创建失败：${response.statusCode} ${response.body}`)
  return json(response)
}

async function seedClaimedPlan(db, userId, clientId) {
  const importBatchId = randomUUID()
  const materialId = randomUUID()
  const materialVersionId = randomUUID()
  const planId = randomUUID()
  const claimBatchId = randomUUID()
  await db.query(`INSERT INTO supply.import_batches (id,user_id,idempotency_key,source_type,source_format,payload_hash,received_count,inserted_count,deduplicated_count,failed_count,result,created_at,completed_at)
    VALUES ($1,$2,$3,'xianyu','parsed_snapshot_json',$4,1,1,0,0,'{}'::jsonb,now(),now())`, [importBatchId, userId, `phase5-import-${importBatchId}`, `hash-${importBatchId}`])
  await db.query(`INSERT INTO supply.materials (id,user_id,source_type,source_platform,source_item_id,source_url,title,price,main_images,import_batch_id,status,created_at,updated_at)
    VALUES ($1,$2,'xianyu','goofish',$3,$4,'phase5 material',1,'[]'::jsonb,$5,'ready',now(),now())`, [materialId, userId, `phase5-source-${materialId}`, `https://www.goofish.com/item?id=phase5-source-${materialId}`, importBatchId])
  await db.query(`INSERT INTO supply.material_versions (id,material_id,version,content_hash,canonical_snapshot,import_batch_id,created_at)
    VALUES ($1,$2,1,$3,'{}'::jsonb,$4,now())`, [materialVersionId, materialId, `phase5-version-${materialVersionId}`, importBatchId])
  await db.query(`INSERT INTO supply.publish_plans (id,user_id,material_id,material_version_id,material_version,material_snapshot,idempotency_key,schedule_mode,scheduled_at,status,claimed_by_client_id,claimed_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,1,'{}'::jsonb,$5,'immediate',now(),'claimed',$6,now(),now(),now())`, [planId, userId, materialId, materialVersionId, `phase5-plan-${planId}`, clientId])
  await db.query(`INSERT INTO supply.publish_claim_batches (id,user_id,client_id,idempotency_key,requested_limit,status,created_at)
    VALUES ($1,$2,$3,$4,1,'completed',now())`, [claimBatchId, userId, clientId, `phase5-claim-${claimBatchId}`])
  await db.query(`INSERT INTO supply.publish_plan_claims (id,claim_batch_id,plan_id,user_id,client_id,claimed_at)
    VALUES ($1,$2,$3,$4,$5,now())`, [randomUUID(), claimBatchId, planId, userId, clientId])
  return { planId, claimBatchId }
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains)
  const collectorApi = createCollectorApi(sql, domains)
  const migrations = await applyMigrations(db)
  try {
    const userAAccess = await registerUser(userApi, 'phase5-published-a@example.test')
    const userBAccess = await registerUser(userApi, 'phase5-published-b@example.test')
    const userAId = String((await db.query("SELECT id FROM identity.users WHERE email_normalized='phase5-published-a@example.test'")).rows[0].id)
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at)
      VALUES ($1,$2,'collector',20,now(),'phase5-published-test',now())`, [randomUUID(), userAId])
    const invalidHost = await userApi.inject({ method: 'POST', url: '/v1/published-item-monitors', headers: auth(userAAccess), payload: { itemUrl: 'https://evil.example/item?id=bad', intervalSeconds: 1800 } })
    assert(invalidHost.statusCode === 400, '非闲鱼商品链接未被拒绝')
    const invalidSensitive = await userApi.inject({ method: 'POST', url: '/v1/published-item-monitors', headers: auth(userAAccess), payload: { itemUrl: 'https://www.goofish.com/item?id=public-item', token: 'local-only', intervalSeconds: 1800 } })
    assert(invalidSensitive.statusCode === 400, '敏感字段未被白名单拒绝')
    const mismatch = await userApi.inject({ method: 'POST', url: '/v1/published-item-monitors', headers: auth(userAAccess), payload: { platformItemId: 'item-a', itemUrl: 'https://www.goofish.com/item?id=item-b', intervalSeconds: 1800 } })
    assert(mismatch.statusCode === 400, '商品 ID 与链接不匹配未被拒绝')

    const first = await createPublishedTask(userApi, userAAccess, { itemUrl: 'https://www.goofish.com/item?id=phase5-published-first&token=local-only#fragment' })
    assert(first.platformItemId === 'phase5-published-first' && first.itemUrl === 'https://www.goofish.com/item?id=phase5-published-first', '发布商品链接未规范化')
    const duplicate = await userApi.inject({ method: 'POST', url: '/v1/published-item-monitors', headers: auth(userAAccess), payload: { platformItemId: first.platformItemId, intervalSeconds: 1800 } })
    assert(duplicate.statusCode === 409, '同一用户重复发布商品监控未拒绝')
    for (let index = 0; index < 20; index += 1) await createPublishedTask(userApi, userAAccess, { platformItemId: `phase5-published-page-${index}`, status: 'paused' })
    const firstPageResponse = await userApi.inject({ method: 'GET', url: '/v1/published-item-monitors?limit=20&sort=created_at&order=asc', headers: auth(userAAccess) })
    assert(firstPageResponse.statusCode === 200, `发布商品监控分页失败：${firstPageResponse.statusCode} ${firstPageResponse.body}`)
    const firstPage = json(firstPageResponse)
    assert(firstPage.items.length === 20 && firstPage.page.total === 21 && firstPage.page.hasMore && firstPage.page.nextCursor, '发布商品监控第一页合同错误')
    const secondPageResponse = await userApi.inject({ method: 'GET', url: `/v1/published-item-monitors?limit=20&sort=created_at&order=asc&cursor=${encodeURIComponent(firstPage.page.nextCursor)}`, headers: auth(userAAccess) })
    const secondPage = json(secondPageResponse)
    assert(secondPageResponse.statusCode === 200 && secondPage.items.length === 1 && !new Set(firstPage.items.map((item) => item.id)).has(secondPage.items[0].id), '发布商品监控游标重复')
    const userBList = await userApi.inject({ method: 'GET', url: '/v1/published-item-monitors?limit=20', headers: auth(userBAccess) })
    assert(userBList.statusCode === 200 && json(userBList).page.total === 0, '其他用户看到发布商品监控')
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await userApi.inject({ method, url: `/v1/published-item-monitors/${first.id}`, headers: auth(userBAccess), payload: method === 'PATCH' ? { status: 'paused' } : undefined })
      assert(response.statusCode === 404, `其他用户可以${method}发布商品监控`)
    }

    const collectorSession = await bindCollector(collectorApi, userAAccess, userAId)
    const beforePublishSnapshot = await collectorApi.inject({ method: 'GET', url: '/v1/tasks', headers: auth(collectorSession.accessToken) })
    assert(beforePublishSnapshot.statusCode === 200 && json(beforePublishSnapshot).items.some((item) => item.kind === 'published_item' && item.platformItemId === first.platformItemId), 'Collector 未领取已发布商品任务')
    const { planId, claimBatchId } = await seedClaimedPlan(db, userAId, collectorSession.clientId)
    const publishResult = { schemaVersion: 1, deviceId: collectorSession.clientId, results: [{ planId, claimBatchId, attemptKey: `phase5-publish-result-${planId}`, status: 'succeeded', xianyuItemId: 'phase5-published-auto', xianyuUrl: 'https://www.goofish.com/item?id=phase5-published-auto' }] }
    const firstResult = await collectorApi.inject({ method: 'POST', url: '/v1/supply/publish-results', headers: auth(collectorSession.accessToken), payload: publishResult })
    const duplicateResult = await collectorApi.inject({ method: 'POST', url: '/v1/supply/publish-results', headers: auth(collectorSession.accessToken), payload: publishResult })
    assert(firstResult.statusCode === 200 && json(firstResult).accepted[0].duplicate === false, '发布结果首次回传失败')
    assert(duplicateResult.statusCode === 200 && json(duplicateResult).accepted[0].duplicate === true, '发布结果重复回传未幂等')
    const autoList = await userApi.inject({ method: 'GET', url: `/v1/published-item-monitors?limit=20&publishPlanId=${planId}`, headers: auth(userAAccess) })
    assert(autoList.statusCode === 200 && json(autoList).page.total === 1 && json(autoList).items[0].platformItemId === 'phase5-published-auto', '发布成功未自动绑定商品监控')
    const afterPublishSnapshot = await collectorApi.inject({ method: 'GET', url: '/v1/tasks', headers: auth(collectorSession.accessToken) })
    assert(afterPublishSnapshot.statusCode === 200 && json(afterPublishSnapshot).items.some((item) => item.kind === 'published_item' && item.publishPlanId === planId && item.platformItemId === 'phase5-published-auto'), 'Collector 未领取自动绑定任务')

    console.log(JSON.stringify({
      scenario: 'phase5-cloud-published-item-monitors',
      migrations,
      assertions: {
        migrationAppliedTwice: true,
        publicGoofishTargetOnly: true,
        sensitiveFieldRejected: true,
        duplicateTargetRejected: true,
        cursorPagination: true,
        userIsolation: true,
        collectorSnapshot: true,
        publishResultAutoBinding: true,
        publishResultIdempotency: true
      }
    }, null, 2))
  } finally {
    await Promise.allSettled([userApi.close(), collectorApi.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ scenario: 'phase5-cloud-published-item-monitors', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
