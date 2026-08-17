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
    VALUES ($1,'phase7-admin@example.test',$2,'owner','active','enrolled',now())`, [randomUUID(), await hashPassword('phase7-admin-password-123')])
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
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains)
  const adminApi = createAdminApi(sql, domains)
  const migrations = await applyMigrations(db)
  const provider = new DeterministicProvider()

  try {
    const userAccess = await registerUser(userApi, 'phase7-user@example.test')
    const user = await userId(db, 'phase7-user@example.test')
    await grantAi(db, user)
    await createAdmin(db)
    const adminLogin = await adminApi.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'phase7-admin@example.test', password: 'phase7-admin-password-123' } })
    assert(adminLogin.statusCode === 200, `Admin 登录失败: ${adminLogin.body}`)
    const adminAccess = json(adminLogin).accessToken

    const providerConfig = await adminApi.inject({ method: 'POST', url: '/v1/admin/ai/providers', headers: auth(adminAccess), payload: { providerCode: 'test-provider', modelReference: 'deterministic-v1', apiKeyCiphertext: 'ciphertext:phase7-test', settings: { threshold: 0.8, concurrency: 1, budget: 100 }, status: 'active' } })
    assert(providerConfig.statusCode === 200 && !providerConfig.body.includes('ciphertext:phase7-test'), `AI 提供方配置或密钥脱敏失败: ${providerConfig.body}`)
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
    const jobPayload = { capabilityCode: 'price_band', input: { itemIds: ['item-phase7'] }, idempotencyKey: 'phase7-job-1' }
    const firstJob = await userApi.inject({ method: 'POST', url: '/v1/ai/jobs', headers: auth(userAccess), payload: jobPayload })
    assert(firstJob.statusCode === 200 || firstJob.statusCode === 202, `User 创建 AI 任务失败: ${firstJob.body}`)
    const firstJobBody = json(firstJob)
    const duplicateJob = await userApi.inject({ method: 'POST', url: '/v1/ai/jobs', headers: auth(userAccess), payload: jobPayload })
    assert((duplicateJob.statusCode === 200 || duplicateJob.statusCode === 202) && json(duplicateJob).id === firstJobBody.id, '重复 AI 任务未幂等')

    await runWorker(sql, provider)
    const failedInsights = await db.query('SELECT COUNT(*)::int AS total FROM ai.insights WHERE ai_job_id=$1', [firstJobBody.id])
    const failedLedger = await db.query("SELECT COUNT(*)::int AS total FROM billing.usage_ledger_dedup WHERE subject_type='user' AND subject_id=$1 AND idempotency_key=$2", [user, `ai:${firstJobBody.id}`])
    const firstState = await db.query('SELECT status,last_error FROM ai.jobs WHERE id=$1', [firstJobBody.id])
    assert(Number(failedInsights.rows[0].total) === 1 && Number(failedLedger.rows[0].total) === 1, `首次 worker 未生成结构化结论或用量账本: ${JSON.stringify(firstState.rows[0])}`)

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
    assert(userInsights.statusCode === 200 && json(userInsights).items.length === 2, `User 读取已发布结果失败: ${userInsights.body}`)
    const adminJobs = await adminApi.inject({ method: 'GET', url: `/v1/admin/ai/jobs?limit=20&requesting_user_id=${encodeURIComponent(user)}&sort=created_at&order=desc`, headers: auth(adminAccess) })
    assert(adminJobs.statusCode === 200 && json(adminJobs).page.total === 3 && json(adminJobs).items.some((job) => job.retryCount === 1 && job.costQuantity === 1), `Admin 任务审计字段或筛选失败: ${adminJobs.body}`)
    assert(!adminJobs.body.includes('test-provider') && !adminJobs.body.includes('promptBody'), 'Admin 任务列表泄露提示正文或 provider 密钥')

    console.log(JSON.stringify({ scenario: 'phase7-cloud-ai', migrations, assertions: { migrationRepeatable: true, capabilityAndPromptPublish: true, userPublishedOnly: true, jobIdempotency: true, concurrentJobIdempotency: true, workerProviderFixture: true, retryWithoutDuplicateBillingOrInsight: true, userAdminIsolation: true, adminCursorAudit: true } }, null, 2))
  } finally {
    await Promise.allSettled([userApi.close(), adminApi.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => { console.error(JSON.stringify({ scenario: 'phase7-cloud-ai', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })
