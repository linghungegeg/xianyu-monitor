import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createCollectorApi, createUserApi } from '../../services/cloud/src/api.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase4-cloud-${process.pid}-${Date.now()}`)
const domains = {
  user: { issuer: 'https://user.phase4.test', audience: 'user-api', secret: 'user-phase4-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.phase4.test', audience: 'admin-api', secret: 'admin-phase4-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.phase4.test', audience: 'collector-api', secret: 'collector-phase4-secret-012345678901234567890' }
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

function publicKey(pair) {
  return pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

function proof(userId, privateKey) {
  return sign(null, Buffer.from(userId), privateKey).toString('base64')
}

async function applyMigrations(db) {
  const migrations = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql')).sort()
  for (let pass = 0; pass < 2; pass += 1) {
    for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  }
  return migrations
}

async function registerUser(userApi, email) {
  const response = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'p4-task-123456' } })
  assert(response.statusCode === 200, `用户注册失败：${response.statusCode} ${response.body}`)
  return json(response).accessToken
}

async function userId(db, email) {
  return String((await db.query('SELECT id FROM identity.users WHERE email_normalized=$1', [email])).rows[0].id)
}

async function grantCollector(db, id, limit) {
  await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at)
    VALUES ($1,$2,'collector',$3,now(),'phase4-test',now())`, [randomUUID(), id, limit])
}

async function bindCollector(collectorApi, userAccess, id) {
  const pair = generateKeyPairSync('ed25519')
  const response = await collectorApi.inject({
    method: 'POST',
    url: '/v1/devices/bind',
    headers: auth(userAccess),
    payload: { publicKey: publicKey(pair), proof: proof(id, pair.privateKey), deviceName: 'phase4-device' }
  })
  assert(response.statusCode === 200, `设备绑定失败：${response.statusCode} ${response.body}`)
  return json(response)
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains, { allowedOrigins: ['http://localhost:5174'] })
  const collectorApi = createCollectorApi(sql, domains)
  const migrations = await applyMigrations(db)

  try {
    const userAEmail = 'phase4-a@example.test'
    const userBEmail = 'phase4-b@example.test'
    const userCEmail = 'phase4-c@example.test'
    const userAAccess = await registerUser(userApi, userAEmail)
    const userBAccess = await registerUser(userApi, userBEmail)
    const userCAccess = await registerUser(userApi, userCEmail)
    const userAId = await userId(db, userAEmail)
    const userBId = await userId(db, userBEmail)
    const userCId = await userId(db, userCEmail)
    await grantCollector(db, userAId, 1)
    await grantCollector(db, userCId, 2)

    const cors = await userApi.inject({
      method: 'OPTIONS',
      url: '/v1/monitors',
      headers: {
        origin: 'http://localhost:5174',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'Authorization, Content-Type'
      }
    })
    assert(cors.statusCode === 204 && String(cors.headers['access-control-allow-methods']).includes('PATCH') && String(cors.headers['access-control-allow-methods']).includes('DELETE'), '任务 CRUD CORS 方法未开放')

    const invalidMissingScope = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userAAccess), payload: { rule: {}, intervalSeconds: 1800 } })
    assert(invalidMissingScope.statusCode === 400, '缺少关键词和类目的规则未被拒绝')
    const invalidUnknownField = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userAAccess), payload: { rule: { keyword: '相机', cookie: 'forbidden' }, intervalSeconds: 1800 } })
    assert(invalidUnknownField.statusCode === 400, '规则白名单未拒绝未知字段')
    const invalidFilter = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userAAccess), payload: { rule: { keyword: '相机', filters: { token: 'forbidden' } }, intervalSeconds: 1800 } })
    assert(invalidFilter.statusCode === 400, '页面筛选白名单未拒绝未知字段')
    const invalidInterval = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userAAccess), payload: { rule: { keyword: '相机' }, intervalSeconds: 59 } })
    assert(invalidInterval.statusCode === 400, '过短频率未被拒绝')
    const invalidPrice = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userAAccess), payload: { rule: { keyword: '相机', minPrice: 100, maxPrice: 99 }, intervalSeconds: 1800 } })
    assert(invalidPrice.statusCode === 400, '反向价格区间未被拒绝')

    const concurrentTasks = await Promise.all([
      userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userCAccess), payload: { rule: { keyword: '并发任务 A', pageLimit: 1 }, intervalSeconds: 1800 } }),
      userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userCAccess), payload: { rule: { keyword: '并发任务 B', pageLimit: 1 }, intervalSeconds: 1800 } }),
      userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userCAccess), payload: { rule: { keyword: '并发任务 C', pageLimit: 1 }, intervalSeconds: 1800 } })
    ])
    const concurrentTaskIds = concurrentTasks.filter((response) => response.statusCode === 200).map((response) => json(response).id)
    assert(concurrentTaskIds.length === 2 && concurrentTasks.filter((response) => response.statusCode === 403).length === 1, '并发创建未正确利用或限制启用任务额度')
    for (const concurrentTaskId of concurrentTaskIds) {
      const deletedConcurrent = await userApi.inject({ method: 'DELETE', url: `/v1/monitors/${concurrentTaskId}`, headers: auth(userCAccess) })
      assert(deletedConcurrent.statusCode === 200, '并发任务清理失败')
    }

    const created = await userApi.inject({
      method: 'POST',
      url: '/v1/monitors',
      headers: auth(userAAccess),
      payload: {
        rule: {
          keyword: '富士相机',
          categoryPath: ['数码', '相机', '微单'],
          sort: 'newly_published',
          minPrice: 1000,
          maxPrice: 9000,
          region: '杭州',
          filters: { condition: 'used', shipping: 'included' },
          includeWords: ['原装', '快门低'],
          excludeWords: ['维修'],
          pageLimit: 2
        },
        intervalSeconds: 1800
      }
    })
    assert(created.statusCode === 200, `任务创建失败：${created.statusCode} ${created.body}`)
    const task = json(created)
    assert(task.status === 'active' && task.ruleVersion === 1 && task.intervalSeconds === 1800, '创建任务返回合同无效')
    assert(task.rule.categoryPath.length === 3 && task.rule.sort === 'newly_published', '任务规则未被规范化返回')

    const userBWithoutEntitlement = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userBAccess), payload: { rule: { keyword: '机械键盘', pageLimit: 1 }, intervalSeconds: 1800 } })
    assert(userBWithoutEntitlement.statusCode === 403, '没有采集权益时仍可启用任务')
    const userBTask = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userBAccess), payload: { rule: { keyword: '机械键盘', pageLimit: 1 }, intervalSeconds: 1800, status: 'paused' } })
    assert(userBTask.statusCode === 200, '第二用户暂停任务创建失败')
    const otherTaskId = json(userBTask).id
    const categoryOnlyTask = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userBAccess), payload: { rule: { categoryPath: ['家电', '厨房电器'], pageLimit: 1 }, intervalSeconds: 1800, status: 'paused' } })
    assert(categoryOnlyTask.statusCode === 200 && json(categoryOnlyTask).rule.categoryPath.length === 2 && !json(categoryOnlyTask).rule.keyword, '仅类目规则不能保存')
    const categoryOnlyTaskId = json(categoryOnlyTask).id

    const userBRead = await userApi.inject({ method: 'GET', url: `/v1/monitors/${task.id}`, headers: auth(userBAccess) })
    const userBPatch = await userApi.inject({ method: 'PATCH', url: `/v1/monitors/${task.id}`, headers: auth(userBAccess), payload: { status: 'paused' } })
    const userBDelete = await userApi.inject({ method: 'DELETE', url: `/v1/monitors/${task.id}`, headers: auth(userBAccess) })
    assert(userBRead.statusCode === 404 && userBPatch.statusCode === 404 && userBDelete.statusCode === 404, '用户可以访问或修改其他用户任务')

    const listed = await userApi.inject({ method: 'GET', url: '/v1/monitors?limit=20&sort=updated_at_desc&order=desc', headers: auth(userAAccess) })
    assert(listed.statusCode === 200, `任务列表失败：${listed.statusCode} ${listed.body}`)
    const taskPage = json(listed)
    assert(taskPage.page.total === 1 && taskPage.items.length === 1 && taskPage.items[0].id === task.id, '任务列表没有以用户任务为真源')

    const paused = await userApi.inject({ method: 'PATCH', url: `/v1/monitors/${task.id}`, headers: auth(userAAccess), payload: { status: 'paused' } })
    assert(paused.statusCode === 200 && json(paused).ruleVersion === 2 && json(paused).status === 'paused', '暂停任务未写入或未升级版本')

    const collectorSession = await bindCollector(collectorApi, userAAccess, userAId)
    const pausedTasks = await collectorApi.inject({ method: 'GET', url: '/v1/tasks', headers: auth(collectorSession.accessToken) })
    assert(pausedTasks.statusCode === 200 && json(pausedTasks).taskLimit === 1 && json(pausedTasks).items.length === 1 && json(pausedTasks).items[0].status === 'paused', '采集器任务快照没有保留暂停状态')

    const resumed = await userApi.inject({ method: 'PATCH', url: `/v1/monitors/${task.id}`, headers: auth(userAAccess), payload: { status: 'active', intervalSeconds: 3600 } })
    assert(resumed.statusCode === 200 && json(resumed).ruleVersion === 3 && json(resumed).intervalSeconds === 3600, '恢复任务未更新版本或频率')
    const collectorTasks = await collectorApi.inject({ method: 'GET', url: '/v1/tasks', headers: auth(collectorSession.accessToken) })
    assert(collectorTasks.statusCode === 200, `采集器领取任务失败：${collectorTasks.statusCode} ${collectorTasks.body}`)
    const collectorPage = json(collectorTasks)
    assert(typeof collectorPage.snapshotAt === 'string' && collectorPage.items.length === 1, '采集器任务快照无效')
    assert(collectorPage.items[0].id === task.id && collectorPage.items[0].status === 'active' && collectorPage.items[0].rule.keyword === '富士相机' && collectorPage.items[0].createdAt && collectorPage.items[0].updatedAt && collectorPage.items.every((item) => item.id !== otherTaskId), '采集器任务没有按绑定用户隔离或缺少缓存字段')

    await db.query("UPDATE billing.entitlement_grants SET limit_value=2 WHERE user_id=$1 AND capability='collector'", [userAId])
    const secondActive = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userAAccess), payload: { rule: { keyword: '第二条任务', pageLimit: 1 }, intervalSeconds: 1800 } })
    assert(secondActive.statusCode === 200, `提升权益后第二条任务创建失败：${secondActive.statusCode} ${secondActive.body}`)
    const secondTaskId = json(secondActive).id
    const expandedCollectorTasks = await collectorApi.inject({ method: 'GET', url: '/v1/tasks', headers: auth(collectorSession.accessToken) })
    assert(expandedCollectorTasks.statusCode === 200 && json(expandedCollectorTasks).taskLimit === 2 && json(expandedCollectorTasks).items.filter((item) => item.status === 'active').length === 2, '提升权益后未下发全部启用任务')
    await db.query("UPDATE billing.entitlement_grants SET limit_value=1 WHERE user_id=$1 AND capability='collector'", [userAId])
    const downgradedCollectorTasks = await collectorApi.inject({ method: 'GET', url: '/v1/tasks', headers: auth(collectorSession.accessToken) })
    assert(downgradedCollectorTasks.statusCode === 200 && json(downgradedCollectorTasks).taskLimit === 1 && json(downgradedCollectorTasks).items.filter((item) => item.status === 'active').length === 1 && json(downgradedCollectorTasks).items.every((item) => item.id !== secondTaskId), '权益降级后仍下发超额启用任务')

    const activeTaskOverLimit = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userAAccess), payload: { rule: { keyword: '超额任务', pageLimit: 1 }, intervalSeconds: 1800 } })
    assert(activeTaskOverLimit.statusCode === 403, '超过采集权益时仍可启用任务')
    const pausedOverflow = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userAAccess), payload: { rule: { keyword: '超额任务', pageLimit: 1 }, intervalSeconds: 1800, status: 'paused' } })
    assert(pausedOverflow.statusCode === 200, '超额任务不能作为暂停规则保存')
    const pausedOverflowId = json(pausedOverflow).id
    const activateOverflow = await userApi.inject({ method: 'PATCH', url: `/v1/monitors/${pausedOverflowId}`, headers: auth(userAAccess), payload: { status: 'active' } })
    assert(activateOverflow.statusCode === 403, '超过采集权益时仍可启用暂停任务')
    const deleteOverflow = await userApi.inject({ method: 'DELETE', url: `/v1/monitors/${pausedOverflowId}`, headers: auth(userAAccess) })
    assert(deleteOverflow.statusCode === 200, '超额暂停任务清理失败')

    await db.query("UPDATE billing.entitlement_grants SET limit_value=0 WHERE user_id=$1 AND capability='collector'", [userAId])
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at)
      VALUES ($1,$2,'ai',1,now(),'phase4-test',now())`, [randomUUID(), userAId])
    const deniedTasks = await collectorApi.inject({ method: 'GET', url: '/v1/tasks', headers: auth(collectorSession.accessToken) })
    const deniedEntitlements = await collectorApi.inject({ method: 'GET', url: '/v1/entitlements', headers: auth(collectorSession.accessToken) })
    assert(deniedTasks.statusCode === 403, '非 collector 权益不应允许领取任务')
    assert(deniedEntitlements.statusCode === 200 && json(deniedEntitlements).allowed === false, 'collector 权益开关错误地接受了其他 capability')
    await db.query("UPDATE billing.entitlement_grants SET limit_value=1 WHERE user_id=$1 AND capability='collector'", [userAId])

    const deleted = await userApi.inject({ method: 'DELETE', url: `/v1/monitors/${task.id}`, headers: auth(userAAccess) })
    assert(deleted.statusCode === 200 && json(deleted).deleted === true, '任务删除失败')
    const deletedSecond = await userApi.inject({ method: 'DELETE', url: `/v1/monitors/${secondTaskId}`, headers: auth(userAAccess) })
    assert(deletedSecond.statusCode === 200 && json(deletedSecond).deleted === true, '第二条任务删除失败')
    const deletedCategoryOnly = await userApi.inject({ method: 'DELETE', url: `/v1/monitors/${categoryOnlyTaskId}`, headers: auth(userBAccess) })
    assert(deletedCategoryOnly.statusCode === 200 && json(deletedCategoryOnly).deleted === true, '仅类目任务删除失败')
    const afterDelete = await collectorApi.inject({ method: 'GET', url: '/v1/tasks', headers: auth(collectorSession.accessToken) })
    assert(afterDelete.statusCode === 200 && json(afterDelete).items.length === 0, '删除任务仍被下发')

    const revoked = await userApi.inject({ method: 'POST', url: `/v1/collector-devices/${collectorSession.clientId}/revoke`, headers: auth(userAAccess) })
    const afterRevoke = await collectorApi.inject({ method: 'GET', url: '/v1/tasks', headers: auth(collectorSession.accessToken) })
    assert(revoked.statusCode === 200 && afterRevoke.statusCode === 403, '解绑后采集器仍可领取任务')

    console.log(JSON.stringify({
      scenario: 'phase4-cloud-monitor-tasks',
      migrations,
      assertions: {
        migrationAppliedTwice: true,
        strictSearchRuleWhitelist: true,
        userOwnedCrudAndList: true,
        collectorTaskSnapshotIncludesPausedState: true,
        collectorEntitlementSwitch: true,
        activeTaskCapacityGate: true,
        concurrentActiveTaskCapacityGate: true,
        categoryOnlyRuleCrud: true,
        entitlementDowngradeFiltersCollectorSnapshot: true,
        deviceRevokeStopsTaskPull: true,
        noSellerOrIngestRouteRequired: true
      }
    }, null, 2))
  } finally {
    await Promise.allSettled([userApi.close(), collectorApi.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ scenario: 'phase4-cloud-monitor-tasks', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
