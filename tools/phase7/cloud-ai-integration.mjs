import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAdminApi, createUserApi } from '../../services/cloud/src/api.ts'
import { hashPassword } from '../../services/cloud/src/security.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase7-cloud-${process.pid}-${Date.now()}`)
const domains = {
  user: { issuer: 'https://user.phase7.test', audience: 'user-api', secret: 'user-phase7-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.phase7.test', audience: 'admin-api', secret: 'admin-phase7-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.phase7.test', audience: 'collector-api', secret: 'collector-phase7-secret-012345678901234567890' }
}

function assert(condition, message) { if (!condition) throw new Error(message) }
function json(response) { return JSON.parse(response.body) }
function auth(token) { return { authorization: `Bearer ${token}` } }

async function applyMigrations(db) {
  const migrations = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql')).sort()
  for (let pass = 0; pass < 2; pass += 1) {
    for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  }
  return migrations
}

async function registerUser(userApi, email) {
  const response = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'phase7-password-123' } })
  assert(response.statusCode === 200, `用户注册失败: ${response.statusCode} ${response.body}`)
  return json(response).accessToken
}

async function userId(db, email) {
  const result = await db.query('SELECT id FROM identity.users WHERE email_normalized=$1', [email])
  return String(result.rows[0].id)
}

async function grantAi(db, id) {
  await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at)
    VALUES ($1,$2,'ai',10,now(),'phase7-test',now())`, [randomUUID(), id])
}

async function createAdmin(db) {
  await db.query(`INSERT INTO identity.admin_users (id,email_normalized,password_hash,role,status,mfa_state,created_at)
    VALUES ($1,'phase7-admin@example.test',$2,'owner','active','enrolled',now())`, [randomUUID(), await hashPassword('p7-admin-123456')])
}

class DeterministicProvider {
  calls = []
  failNext = false

  async complete(input) {
    this.calls.push(input)
    if (this.failNext) {
      this.failNext = false
      throw new Error('phase7-transient-provider-failure')
    }
    return { insightType: 'price_band', entityReference: 'market:phase7', result: { summary: 'deterministic-result', inputHash: input.inputHash }, confidence: 0.91 }
  }
}

async function runWorker(sql, provider) {
  // The production worker is intentionally imported only when the API contract exists.
  // This keeps the fixture deterministic and makes a missing worker an explicit test failure.
  const module = await import('../../services/cloud/src/ai-worker.ts')
  const worker = module.createAiWorker(sql, { provider, workerId: 'phase7-test-worker' })
  return worker.runOnce()
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values), transaction: (callback) => db.transaction(callback) }
  const userApi = createUserApi(sql, domains)
  const adminApi = createAdminApi(sql, domains, { modelListProxy: async ({ baseUrl, modelReference, apiKeyCiphertext }) => {
    assert(baseUrl === 'https://models.phase7.test' && modelReference === 'deterministic-v1' && apiKeyCiphertext === 'ciphertext:phase7-test', '模型列表代理未收到正确配置')
    return { data: [{ id: 'deterministic-v1' }, { id: 'deterministic-v2' }] }
  } })
  const migrations = await applyMigrations(db)
  const provider = new DeterministicProvider()

  try {
    const userAccess = await registerUser(userApi, 'phase7-user@example.test')
    const user = await userId(db, 'phase7-user@example.test')
    await grantAi(db, user)
    await createAdmin(db)
    const adminLogin = await adminApi.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'phase7-admin@example.test', password: 'p7-admin-123456' } })
    assert(adminLogin.statusCode === 200, `Admin 登录失败: ${adminLogin.body}`)
    const adminAccess = json(adminLogin).accessToken

    const providerConfig = await adminApi.inject({ method: 'POST', url: '/v1/admin/ai/providers', headers: auth(adminAccess), payload: { providerCode: 'test-provider', baseUrl: 'https://models.phase7.test', modelReference: 'deterministic-v1', apiKeyCiphertext: 'ciphertext:phase7-test', stream: true, reasoning: true, settings: { threshold: 0.8, concurrency: 1, budget: 100 }, status: 'active' } })
    assert(providerConfig.statusCode === 200 && json(providerConfig).baseUrl === 'https://models.phase7.test' && json(providerConfig).stream === true && json(providerConfig).reasoning === true && !providerConfig.body.includes('ciphertext:phase7-test'), `AI 提供方配置或密钥脱敏失败: ${providerConfig.body}`)
    const providerUpdate = await adminApi.inject({ method: 'PATCH', url: `/v1/admin/ai/providers/${encodeURIComponent(json(providerConfig).id)}`, headers: auth(adminAccess), payload: { settings: { reasoningLevel: 'deep' }, stream: true, reasoning: true } })
    assert(providerUpdate.statusCode === 200 && json(providerUpdate).settings?.reasoningLevel === 'deep', `AI 推理等级配置保存失败: ${providerUpdate.body}`)
    const providerPage = await adminApi.inject({ method: 'GET', url: '/v1/admin/ai/providers?limit=20&sort=updated_at&order=desc', headers: auth(adminAccess) })
    assert(providerPage.statusCode === 200 && json(providerPage).items.length === 1 && json(providerPage).page.total === 1 && json(providerPage).page.nextCursor === null, `AI 提供方分页合同失败: ${providerPage.body}`)
    const modelList = await adminApi.inject({ method: 'GET', url: `/v1/admin/ai/providers/${encodeURIComponent(json(providerConfig).id)}/models`, headers: auth(adminAccess) })
    assert(modelList.statusCode === 200 && json(modelList).items.length === 2 && !modelList.body.includes('ciphertext:phase7-test'), `模型列表代理失败: ${modelList.body}`)
    const rawKey = await adminApi.inject({ method: 'POST', url: '/v1/admin/ai/providers', headers: auth(adminAccess), payload: { providerCode: 'invalid-provider', modelReference: 'invalid', apiKey: 'plain-text-key' } })
    assert(rawKey.statusCode === 400 && !rawKey.body.includes('plain-text-key'), 'AI 提供方接受或回显明文密钥')

    const capability = await adminApi.inject({
      method: 'POST', url: '/v1/admin/ai/capabilities', headers: auth(adminAccess),
      payload: { code: 'price_band', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, entitlement: 'ai' }
    })
    assert(capability.statusCode === 200, `创建 AI 能力失败: ${capability.body}`)
    const capabilityId = json(capability).id
    const unpublishedJob = await userApi.inject({ method: 'POST', url: '/v1/ai/jobs', headers: auth(userAccess), payload: { capabilityCode: 'price_band', input: {}, idempotencyKey: 'phase7-unpublished' } })
    assert(unpublishedJob.statusCode === 404, '未发布 AI 能力可被 User 调用')
    const prompt = await adminApi.inject({
      method: 'POST', url: '/v1/admin/ai/prompts', headers: auth(adminAccess),
      payload: { capabilityId, version: 1, providerReference: 'test-provider', modelReference: 'deterministic-v1', promptBody: 'public market input', status: 'draft' }
    })
    assert(prompt.statusCode === 200, `创建提示版本失败: ${prompt.body}`)
    const promptId = json(prompt).id
    const publishPrompt = await adminApi.inject({ method: 'POST', url: `/v1/admin/ai/prompts/${promptId}/publish`, headers: auth(adminAccess) })
    assert(publishPrompt.statusCode === 200, `发布提示版本失败: ${publishPrompt.body}`)
    const publishCapability = await adminApi.inject({ method: 'POST', url: `/v1/admin/ai/capabilities/${capabilityId}/publish`, headers: auth(adminAccess), payload: { promptVersionId: promptId } })
    assert(publishCapability.statusCode === 200, `发布 AI 能力失败: ${publishCapability.body}`)
    assert(!publishCapability.body.includes('secret') && !publishCapability.body.includes('apiKey'), '发布响应泄露 provider 密钥字段')

    await db.query(`INSERT INTO billing.user_points (user_id,balance,updated_at) VALUES ($1,42,now())`, [user])
    const clientId = randomUUID()
    await db.query(`INSERT INTO identity.collector_clients (id,user_id,device_public_key_fingerprint,device_name,platform,app_version,status,active_slot,created_at)
      VALUES ($1,$2,'phase7-fingerprint','phase7-device','windows','phase7','active',1,now())`, [clientId, user])
    const personalItemId = randomUUID()
    const globalOnlyItemId = randomUUID()
    const collectionRunId = randomUUID()
    await db.query(`INSERT INTO ops.collection_runs (id,client_id,client_run_id,kind,status,started_at,finished_at,result_counts)
      VALUES ($1,$2,'phase7-ai-scope','search','completed',now(),now(),'{}'::jsonb)`, [collectionRunId, clientId])
    await db.query(`INSERT INTO market.items (id,platform,platform_item_id,lifecycle_state,first_seen_at,last_seen_at)
      VALUES ($1,'goofish','phase7-personal','active',now(),now()),($2,'goofish','phase7-global','active',now(),now())`, [personalItemId, globalOnlyItemId])
    await db.query(`INSERT INTO market.item_versions (id,item_id,title,price,canonical_payload,content_hash,observed_at)
      VALUES ($1,$2,'个人可见商品',10,'{}'::jsonb,'phase7-personal-v1',now()),($3,$4,'全局商品',20,'{}'::jsonb,'phase7-global-v1',now())`, [randomUUID(), personalItemId, randomUUID(), globalOnlyItemId])
    await db.query(`INSERT INTO market.observations (id,collected_at,received_at,collection_run_id,item_id,platform_item_id,payload_hash)
      VALUES ($1,now(),now(),$2,$3,'phase7-personal','phase7-personal-observation')`, [randomUUID(), collectionRunId, personalItemId])
    await db.query(`INSERT INTO ops.ingest_batches (id,client_id,idempotency_key,payload_hash,status,accepted_count,received_at,schema_version,batch_sequence,cursor_start,cursor_end,received_count,deduplicated_count,inserted_count,failed_count,retry_count,quality_status,quality_result)
      VALUES ($1,$2,'phase7-upload','phase7-hash','completed',1,now(),1,1,'0','1',1,0,1,0,0,'passed','{}'::jsonb)`, [randomUUID(), clientId])
    const announcement = await adminApi.inject({ method: 'POST', url: '/v1/admin/announcements', headers: auth(adminAccess), payload: { title: '系统公告', body: '市场数据已更新', scope: 'global', enabled: true } })
    assert(announcement.statusCode === 200, `创建全局公告失败: ${announcement.body}`)
    const personalAnnouncement = await adminApi.inject({ method: 'POST', url: '/v1/admin/announcements', headers: auth(adminAccess), payload: { title: '个人公告', body: '仅当前用户可见', scope: 'personal', userId: user, enabled: true } })
    assert(personalAnnouncement.statusCode === 200, `创建个人公告失败: ${personalAnnouncement.body}`)
    const announcements = await userApi.inject({ method: 'GET', url: '/v1/announcements?limit=10&sort=starts_at&order=desc', headers: auth(userAccess) })
    assert(announcements.statusCode === 200 && json(announcements).items.length === 2 && json(announcements).page.total === 2 && json(announcements).page.nextCursor === null && !announcements.body.includes(user), `User 公告读取范围错误: ${announcements.body}`)
    for (let index = 0; index < 9; index += 1) {
      const extra = await adminApi.inject({ method: 'POST', url: '/v1/admin/announcements', headers: auth(adminAccess), payload: { title: `分页公告 ${index}`, body: `公告摘要 ${index}`, scope: 'global', enabled: true } })
      assert(extra.statusCode === 200, `分页公告创建失败: ${extra.body}`)
    }
    const announcementPage = await userApi.inject({ method: 'GET', url: '/v1/announcements?limit=10&sort=starts_at&order=desc', headers: auth(userAccess) })
    assert(announcementPage.statusCode === 200 && json(announcementPage).items.length === 10 && json(announcementPage).page.total === 11 && json(announcementPage).page.hasMore && typeof json(announcementPage).page.nextCursor === 'string', `User 公告分页合同错误: ${announcementPage.body}`)

    const userConfig = await userApi.inject({ method: 'GET', url: '/v1/admin/ai', headers: auth(userAccess) })
    const userAdminConfig = await adminApi.inject({ method: 'GET', url: '/v1/admin/ai', headers: auth(userAccess) })
    assert((userConfig.statusCode === 404 || userConfig.statusCode === 403) && userAdminConfig.statusCode === 403, 'User 可访问 Admin AI 配置')
    const unentitledAccess = await registerUser(userApi, 'phase7-unentitled@example.test')
    const unentitledJob = await userApi.inject({ method: 'POST', url: '/v1/ai/jobs', headers: auth(unentitledAccess), payload: { capabilityCode: 'price_band', input: {}, idempotencyKey: 'phase7-no-entitlement' } })
    assert(unentitledJob.statusCode === 403, '无 AI 权益用户可创建任务')
    const zeroLimitAccess = await registerUser(userApi, 'phase7-zero-limit@example.test')
    const zeroLimitId = await userId(db, 'phase7-zero-limit@example.test')
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at) VALUES ($1,$2,'ai',0,now(),'phase7-test',now())`, [randomUUID(), zeroLimitId])
    const zeroLimitJob = await userApi.inject({ method: 'POST', url: '/v1/ai/jobs', headers: auth(zeroLimitAccess), payload: { capabilityCode: 'price_band', input: {}, idempotencyKey: 'phase7-zero-limit' } })
    assert(zeroLimitJob.statusCode === 403, '零额度 AI 权益可创建任务')
    const jobPayload = { capabilityCode: 'price_band', input: { itemIds: ['item-phase7'] }, idempotencyKey: 'phase7-job-1', scope: 'personal' }
    const firstJob = await userApi.inject({ method: 'POST', url: '/v1/ai/jobs', headers: auth(userAccess), payload: jobPayload })
    assert(firstJob.statusCode === 200 || firstJob.statusCode === 202, `User 创建 AI 任务失败: ${firstJob.body}`)
    const firstJobBody = json(firstJob)
    const duplicateJob = await userApi.inject({ method: 'POST', url: '/v1/ai/jobs', headers: auth(userAccess), payload: jobPayload })
    assert((duplicateJob.statusCode === 200 || duplicateJob.statusCode === 202) && json(duplicateJob).id === firstJobBody.id, '重复 AI 任务未幂等')
    const conflictingScopeJob = await userApi.inject({ method: 'POST', url: '/v1/ai/jobs', headers: auth(userAccess), payload: { ...jobPayload, scope: 'global' } })
    assert((conflictingScopeJob.statusCode === 200 || conflictingScopeJob.statusCode === 202) && json(conflictingScopeJob).id === firstJobBody.id && json(conflictingScopeJob).scope === 'personal' && json(conflictingScopeJob).duplicate === true, '重复幂等键未返回数据库中的规范范围')

    await runWorker(sql, provider)
    const failedInsights = await db.query('SELECT COUNT(*)::int AS total FROM ai.insights WHERE ai_job_id=$1', [firstJobBody.id])
    const failedLedger = await db.query("SELECT COUNT(*)::int AS total FROM billing.usage_ledger_dedup WHERE subject_type='user' AND subject_id=$1 AND idempotency_key=$2", [user, `ai:${firstJobBody.id}`])
    const firstState = await db.query('SELECT status,last_error FROM ai.jobs WHERE id=$1', [firstJobBody.id])
    assert(Number(failedInsights.rows[0].total) === 1 && Number(failedLedger.rows[0].total) === 1, `首次 worker 未生成结构化结论或用量账本: ${JSON.stringify(firstState.rows[0])}`)

    const globalJob = await userApi.inject({ method: 'POST', url: '/v1/ai/jobs', headers: auth(userAccess), payload: { ...jobPayload, idempotencyKey: 'phase7-job-global', scope: 'global' } })
    assert(globalJob.statusCode === 202 && json(globalJob).scope === 'global', `全局 AI 任务创建失败: ${globalJob.body}`)
    await runWorker(sql, provider)
    const personalCall = provider.calls.find((call) => call.jobId === firstJobBody.id)
    const globalCall = provider.calls.find((call) => call.jobId === json(globalJob).id)
    assert(personalCall?.input?.scope === 'personal' && personalCall.input.marketItems.length === 1 && personalCall.input.marketItems[0].itemId === personalItemId && globalCall?.input?.scope === 'global' && globalCall.input.marketItems.some((item) => item.itemId === personalItemId) && globalCall.input.marketItems.some((item) => item.itemId === globalOnlyItemId), 'AI 个人/全局范围未按公开市场数据规范化')

    provider.failNext = true
    const retryJob = await userApi.inject({ method: 'POST', url: '/v1/ai/jobs', headers: auth(userAccess), payload: { ...jobPayload, idempotencyKey: 'phase7-job-2' } })
    assert(retryJob.statusCode === 200 || retryJob.statusCode === 202, `重试任务创建失败: ${retryJob.body}`)
    await runWorker(sql, provider)
    await runWorker(sql, provider)
    const retryId = json(retryJob).id
    const retryInsightCount = await db.query('SELECT COUNT(*)::int AS total FROM ai.insights WHERE ai_job_id=$1', [retryId])
    const retryLedgerCount = await db.query("SELECT COUNT(*)::int AS total FROM billing.usage_ledger_dedup WHERE subject_type='user' AND subject_id=$1 AND idempotency_key=$2", [user, `ai:${retryId}`])
    assert(Number(retryInsightCount.rows[0].total) === 1 && Number(retryLedgerCount.rows[0].total) === 1, 'worker 重试重复写入结论或重复记账')
    assert(provider.calls.length >= 3 && provider.calls.every((call) => typeof call.idempotencyKey === 'string' && call.idempotencyKey.startsWith('ai:')), '确定性 provider 未收到稳定计费幂等键')
    const concurrentPayload = { ...jobPayload, idempotencyKey: 'phase7-job-concurrent' }
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => userApi.inject({ method: 'POST', url: '/v1/ai/jobs', headers: auth(userAccess), payload: concurrentPayload })))
    const concurrentIds = new Set(concurrent.map((response) => json(response).id))
    assert(concurrent.every((response) => response.statusCode === 200 || response.statusCode === 202) && concurrentIds.size === 1, '并发重复 AI 任务未幂等')

    const userInsights = await userApi.inject({ method: 'GET', url: '/v1/ai/insights?limit=20&sort=created_at&order=desc', headers: auth(userAccess) })
    assert(userInsights.statusCode === 200 && json(userInsights).items.length === 3, `User 读取已发布结果失败: ${userInsights.body}`)
    const adminJobs = await adminApi.inject({ method: 'GET', url: `/v1/admin/ai/jobs?limit=20&requesting_user_id=${encodeURIComponent(user)}&sort=created_at&order=desc`, headers: auth(adminAccess) })
    assert(adminJobs.statusCode === 200 && json(adminJobs).page.total === 4 && json(adminJobs).items.some((job) => job.retryCount === 1 && job.costQuantity === 1 && job.requestingUserAccount === 'phase7-user@example.test' && job.provider === 'test-provider' && job.model === 'deterministic-v1'), `Admin 任务审计字段或筛选失败: ${adminJobs.body}`)
    const adminUsers = await adminApi.inject({ method: 'GET', url: `/v1/users?limit=20&q=phase7-user@example.test`, headers: auth(adminAccess) })
    assert(adminUsers.statusCode === 200 && json(adminUsers).items.some((item) => item.account === 'phase7-user@example.test' && item.points === 42 && item.userData?.deviceCount === 1 && item.userData?.uploadBatchCount === 1), `Admin 用户资料字段缺失: ${adminUsers.body}`)
    const pointsAdded = await adminApi.inject({ method: 'PATCH', url: `/v1/admin/users/${encodeURIComponent(user)}/points`, headers: auth(adminAccess), payload: { delta: 8 } })
    const pointsRemoved = await adminApi.inject({ method: 'PATCH', url: `/v1/admin/users/${encodeURIComponent(user)}/points`, headers: auth(adminAccess), payload: { delta: -8 } })
    assert(pointsAdded.statusCode === 200 && json(pointsAdded).points === 50 && pointsRemoved.statusCode === 200 && json(pointsRemoved).points === 42, `Admin 积分调整失败: ${pointsAdded.body} ${pointsRemoved.body}`)
    const adminUploads = await adminApi.inject({ method: 'GET', url: `/v1/admin/uploads?limit=20&user_id=${encodeURIComponent(user)}`, headers: auth(adminAccess) })
    assert(adminUploads.statusCode === 200 && json(adminUploads).items.some((item) => item.userAccount === 'phase7-user@example.test' && item.userId === user), `Admin 上传批次用户字段缺失: ${adminUploads.body}`)
    const adminAnnouncements = await adminApi.inject({ method: 'GET', url: '/v1/admin/announcements?limit=20&enabled=true', headers: auth(adminAccess) })
    assert(adminAnnouncements.statusCode === 200 && json(adminAnnouncements).page.total === 11, `Admin 公告查询失败: ${adminAnnouncements.body}`)
    const announcementUpdate = await adminApi.inject({ method: 'PATCH', url: `/v1/admin/announcements/${json(announcement).id}`, headers: auth(adminAccess), payload: { title: '系统公告（已更新）' } })
    assert(announcementUpdate.statusCode === 200 && json(announcementUpdate).title === '系统公告（已更新）', `Admin 公告更新失败: ${announcementUpdate.body}`)
    const disabledUser = await adminApi.inject({ method: 'PATCH', url: `/v1/admin/users/${encodeURIComponent(user)}/status`, headers: auth(adminAccess), payload: { enabled: false } })
    assert(disabledUser.statusCode === 200 && json(disabledUser).enabled === false, `Admin 禁用用户失败: ${disabledUser.body}`)
    const enabledUser = await adminApi.inject({ method: 'PATCH', url: `/v1/admin/users/${encodeURIComponent(user)}/status`, headers: auth(adminAccess), payload: { enabled: true } })
    assert(enabledUser.statusCode === 200 && json(enabledUser).enabled === true, `Admin 启用用户失败: ${enabledUser.body}`)
    const sessionUser = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'phase7-session@example.test', password: 'phase7-session-123' } })
    assert(sessionUser.statusCode === 200, `会话用户注册失败: ${sessionUser.body}`)
    const sessionUserId = await userId(db, 'phase7-session@example.test')
    const disabledSessionUser = await adminApi.inject({ method: 'PATCH', url: `/v1/admin/users/${encodeURIComponent(sessionUserId)}/status`, headers: auth(adminAccess), payload: { enabled: false } })
    const disabledAccess = await userApi.inject({ method: 'GET', url: '/v1/me', headers: auth(json(sessionUser).accessToken) })
    const disabledRefresh = await userApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: json(sessionUser).refreshToken } })
    assert(disabledSessionUser.statusCode === 200 && disabledAccess.statusCode === 401 && disabledRefresh.statusCode === 401, 'Admin 停用用户后旧会话仍可访问或刷新')
    assert(adminJobs.body.includes('test-provider') && adminJobs.body.includes('deterministic-v1') && !adminJobs.body.includes('promptBody') && !adminJobs.body.includes('ciphertext:phase7-test'), 'Admin 任务 provider/model 或敏感字段边界错误')

    console.log(JSON.stringify({ scenario: 'phase7-cloud-ai', migrations, assertions: { migrationRepeatable: true, capabilityAndPromptPublish: true, providerSettingsUpdate: true, userPublishedOnly: true, jobIdempotency: true, idempotentScopeCanonical: true, personalAndGlobalMarketScope: true, concurrentJobIdempotency: true, workerProviderFixture: true, retryWithoutDuplicateBillingOrInsight: true, userAdminIsolation: true, adminCursorAudit: true, adminPointsAdjustment: true, disabledSessionRevoked: true } }, null, 2))
  } finally {
    await Promise.allSettled([userApi.close(), adminApi.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => { console.error(JSON.stringify({ scenario: 'phase7-cloud-ai', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })
