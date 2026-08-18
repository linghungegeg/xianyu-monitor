import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUserApi } from '../../services/cloud/src/api.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase2-supply-${process.pid}-${Date.now()}`)
const domains = {
  user: { issuer: 'https://user.phase2-supply.test', audience: 'user-api', secret: 'user-phase2-supply-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.phase2-supply.test', audience: 'admin-api', secret: 'admin-phase2-supply-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.phase2-supply.test', audience: 'collector-api', secret: 'collector-phase2-supply-secret-012345678901234567890' }
}

function assert(condition, message) { if (!condition) throw new Error(message) }
function json(response) { return JSON.parse(response.body) }
function auth(accessToken) { return { authorization: `Bearer ${accessToken}` } }
async function applyMigrations(db) {
  const migrations = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql')).sort()
  for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  return migrations
}
async function register(api, email) {
  const response = await api.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'phase2-supply-123' } })
  assert(response.statusCode === 200, `注册失败: ${response.body}`)
  return json(response).accessToken
}

function snapshot(sourceItemId, title = `素材 ${sourceItemId}`) {
  return {
    sourcePlatform: '1688', sourceItemId, sourceUrl: `https://detail.1688.com/offer/${sourceItemId}.html`,
    title, description: '原始素材描述', price: 19.9, mainImages: [`https://images.example.test/${sourceItemId}.jpg`], detailImages: [], sku: [{ name: '默认', price: 19.9 }], attrs: { source: 'phase2' }
  }
}

async function importMaterial(api, token, key, sourceItemId = 'phase2-material') {
  const response = await api.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(token), payload: {
    schemaVersion: 1, sourceType: 'general', sourceFormat: 'parsed_snapshot_json', idempotencyKey: key, snapshots: [snapshot(sourceItemId)]
  } })
  assert(response.statusCode === 200 && json(response).insertedCount === 1, `素材导入失败: ${response.body}`)
  const materials = await api.inject({ method: 'GET', url: `/v1/supply/materials?limit=1&source_platform=1688&source_item_id=${encodeURIComponent(sourceItemId)}`, headers: auth(token) })
  assert(materials.statusCode === 400, '未允许 filter 不应静默接受')
  const list = await api.inject({ method: 'GET', url: '/v1/supply/materials?limit=100&source_platform=1688', headers: auth(token) })
  const material = json(list).items.find((entry) => entry.sourceItemId === sourceItemId)
  assert(material, `无法读取导入素材 ${sourceItemId}`)
  return material
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const api = createUserApi(sql, domains)
  const migrations = await applyMigrations(db)
  try {
    const userA = await register(api, 'phase2-supply-a@example.test')
    const userB = await register(api, 'phase2-supply-b@example.test')
    const materialA = await importMaterial(api, userA, 'phase2-import-a')
    const materialB = await importMaterial(api, userB, 'phase2-import-b')

    const forbiddenRead = await api.inject({ method: 'GET', url: `/v1/supply/materials/${materialA.id}`, headers: auth(userB) })
    assert(forbiddenRead.statusCode === 404, `跨用户素材读取未隔离: ${forbiddenRead.body}`)
    const patchPayload = { title: '已编辑素材', description: '编辑后的闲鱼描述', price: 29.8, mainImages: ['https://images.example.test/edited.jpg'], sku: [{ name: '黑色', price: 29.8 }], attributes: { source: 'phase2', color: 'black' }, status: 'ready' }
    const patched = await api.inject({ method: 'PATCH', url: `/v1/supply/materials/${materialA.id}`, headers: auth(userA), payload: patchPayload })
    assert(patched.statusCode === 200 && json(patched).currentVersion === 2 && json(patched).status === 'ready', `素材编辑或版本冻结前置失败: ${patched.body}`)
    const repeatedPatch = await api.inject({ method: 'PATCH', url: `/v1/supply/materials/${materialA.id}`, headers: auth(userA), payload: patchPayload })
    assert(repeatedPatch.statusCode === 200 && json(repeatedPatch).currentVersion === 2 && json(repeatedPatch).changed === false, `相同编辑不应新增版本: ${repeatedPatch.body}`)
    const revertedPatch = await api.inject({ method: 'PATCH', url: `/v1/supply/materials/${materialA.id}`, headers: auth(userA), payload: {
      title: '素材 phase2-material', description: '原始素材描述', price: 19.9, mainImages: ['https://images.example.test/phase2-material.jpg'], detailImages: [], sku: [{ name: '默认', price: 19.9 }], attributes: { source: 'phase2' }
    } })
    assert(revertedPatch.statusCode === 200 && json(revertedPatch).currentVersion === 1, `素材回退未复用原版本: ${revertedPatch.body}`)
    const restoredPatch = await api.inject({ method: 'PATCH', url: `/v1/supply/materials/${materialA.id}`, headers: auth(userA), payload: patchPayload })
    assert(restoredPatch.statusCode === 200 && json(restoredPatch).currentVersion === 2, `素材恢复未复用编辑版本: ${restoredPatch.body}`)
    const versionCount = await db.query('SELECT COUNT(*)::int AS total FROM supply.material_versions WHERE material_id=$1', [materialA.id])
    assert(Number(versionCount.rows[0].total) === 2, '素材编辑回退去重未生效')
    const sensitivePatch = await api.inject({ method: 'PATCH', url: `/v1/supply/materials/${materialA.id}`, headers: auth(userA), payload: { attributes: { xianyuCookie: 'local-only-cookie', chromeProfilePath: 'C:/local-only' } } })
    assert(sensitivePatch.statusCode === 400 && !sensitivePatch.body.includes('local-only'), `敏感编辑未拒绝或泄露: ${sensitivePatch.body}`)

    const immediatePayload = { schemaVersion: 1, materialId: materialA.id, idempotencyKey: 'phase2-immediate', schedule: { mode: 'immediate' } }
    const immediate = await api.inject({ method: 'POST', url: '/v1/supply/publish-plans', headers: auth(userA), payload: immediatePayload })
    assert(immediate.statusCode === 200 && json(immediate).scheduleMode === 'immediate' && json(immediate).materialVersion === 2 && json(immediate).status === 'planned', `立即计划创建失败: ${immediate.body}`)
    assert(json(immediate).materialSnapshot.title === '已编辑素材' && json(immediate).materialSnapshot.price === 29.8, '计划没有冻结当前素材版本')
    const repeatedImmediate = await api.inject({ method: 'POST', url: '/v1/supply/publish-plans', headers: auth(userA), payload: immediatePayload })
    assert(repeatedImmediate.statusCode === 200 && json(repeatedImmediate).duplicate === true && json(repeatedImmediate).id === json(immediate).id, `发布计划幂等失败: ${repeatedImmediate.body}`)
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const scheduled = await api.inject({ method: 'POST', url: '/v1/supply/publish-plans', headers: auth(userA), payload: { schemaVersion: 1, materialId: materialA.id, idempotencyKey: 'phase2-scheduled', schedule: { mode: 'scheduled', scheduledAt } } })
    assert(scheduled.statusCode === 200 && json(scheduled).scheduleMode === 'scheduled', `定时计划创建失败: ${scheduled.body}`)
    const windowStart = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const windowEnd = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
    const random = await api.inject({ method: 'POST', url: '/v1/supply/publish-plans', headers: auth(userA), payload: { schemaVersion: 1, materialId: materialA.id, idempotencyKey: 'phase2-random', schedule: { mode: 'random_window', windowStart, windowEnd } } })
    const randomPlan = json(random)
    assert(random.statusCode === 200 && randomPlan.scheduleMode === 'random_window' && Date.parse(randomPlan.scheduledAt) >= Date.parse(windowStart) && Date.parse(randomPlan.scheduledAt) <= Date.parse(windowEnd), `随机窗口计划错误: ${random.body}`)

    const laterPatch = await api.inject({ method: 'PATCH', url: `/v1/supply/materials/${materialA.id}`, headers: auth(userA), payload: { title: '后续编辑不影响旧计划', price: 39.8 } })
    assert(laterPatch.statusCode === 200 && json(laterPatch).currentVersion === 3, `后续编辑失败: ${laterPatch.body}`)
    const frozen = await api.inject({ method: 'GET', url: `/v1/supply/publish-plans/${json(immediate).id}`, headers: auth(userA) })
    assert(frozen.statusCode === 200 && json(frozen).materialVersion === 2 && json(frozen).materialSnapshot.title === '已编辑素材', `计划素材快照被后续编辑污染: ${frozen.body}`)
    const forbiddenPlanRead = await api.inject({ method: 'GET', url: `/v1/supply/publish-plans/${json(immediate).id}`, headers: auth(userB) })
    assert(forbiddenPlanRead.statusCode === 404, `跨用户计划读取未隔离: ${forbiddenPlanRead.body}`)
    const rescheduledAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    const rescheduled = await api.inject({ method: 'PATCH', url: `/v1/supply/publish-plans/${json(scheduled).id}`, headers: auth(userA), payload: { schedule: { mode: 'scheduled', scheduledAt: rescheduledAt } } })
    assert(rescheduled.statusCode === 200 && json(rescheduled).scheduledAt === rescheduledAt, `计划重排失败: ${rescheduled.body}`)
    const cancelled = await api.inject({ method: 'PATCH', url: `/v1/supply/publish-plans/${json(scheduled).id}`, headers: auth(userA), payload: { status: 'cancelled' } })
    assert(cancelled.statusCode === 200 && json(cancelled).status === 'cancelled', `计划取消失败: ${cancelled.body}`)
    const changeCancelled = await api.inject({ method: 'PATCH', url: `/v1/supply/publish-plans/${json(scheduled).id}`, headers: auth(userA), payload: { schedule: { mode: 'immediate' } } })
    assert(changeCancelled.statusCode === 409, `已取消计划不应继续编辑: ${changeCancelled.body}`)

    for (let index = 0; index < 100; index += 1) {
      const response = await api.inject({ method: 'POST', url: '/v1/supply/publish-plans', headers: auth(userA), payload: {
        schemaVersion: 1, materialId: materialA.id, idempotencyKey: `phase2-page-${index}`, schedule: { mode: 'scheduled', scheduledAt: new Date(Date.now() + (index + 10) * 60_000).toISOString() }
      } })
      assert(response.statusCode === 200, `批量发布计划 ${index} 失败: ${response.body}`)
    }
    const firstPage = await api.inject({ method: 'GET', url: '/v1/supply/publish-plans?limit=50&sort=scheduled_at&order=asc&status=planned', headers: auth(userA) })
    const first = json(firstPage)
    const secondPage = await api.inject({ method: 'GET', url: `/v1/supply/publish-plans?limit=50&sort=scheduled_at&order=asc&status=planned&cursor=${encodeURIComponent(first.page.nextCursor)}`, headers: auth(userA) })
    const second = json(secondPage)
    assert(firstPage.statusCode === 200 && secondPage.statusCode === 200 && first.items.length === 50 && second.items.length === 50 && first.items.every((item) => !second.items.some((next) => next.id === item.id)), '发布计划 cursor 分页存在重复或缺失')
    const otherPlans = await api.inject({ method: 'GET', url: '/v1/supply/publish-plans?limit=100', headers: auth(userB) })
    assert(otherPlans.statusCode === 200 && json(otherPlans).items.length === 0 && materialB.id !== materialA.id, `发布计划用户隔离失败: ${otherPlans.body}`)

    const archived = await api.inject({ method: 'DELETE', url: `/v1/supply/materials/${materialA.id}`, headers: auth(userA) })
    assert(archived.statusCode === 200 && json(archived).archived === true, `素材归档失败: ${archived.body}`)
    const materialStillExists = await db.query('SELECT status FROM supply.materials WHERE id=$1', [materialA.id])
    assert(materialStillExists.rows[0]?.status === 'archived', '素材删除不应物理删除')
    const archivedPlan = await api.inject({ method: 'POST', url: '/v1/supply/publish-plans', headers: auth(userA), payload: { schemaVersion: 1, materialId: materialA.id, idempotencyKey: 'phase2-archived', schedule: { mode: 'immediate' } } })
    assert(archivedPlan.statusCode === 409, `归档素材不应创建计划: ${archivedPlan.body}`)
    const privateValues = await db.query("SELECT COUNT(*)::int AS total FROM supply.material_versions WHERE canonical_snapshot::text ILIKE '%local-only%'")
    assert(Number(privateValues.rows[0].total) === 0, '敏感编辑值进入素材版本')
    console.log(JSON.stringify({ scenario: 'phase2-supply-materials-and-publish-plans', migrations, assertions: { migrationRepeatable: true, materialPatchVersionFreezeAndDeduplication: true, materialArchiveWithoutDelete: true, planImmediateScheduledRandomWindow: true, planIdempotency: true, planRescheduleAndCancellation: true, userIsolation: true, planCursorPagingOver100: true, sensitiveStateRejected: true } }, null, 2))
  } finally {
    await Promise.allSettled([api.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => { console.error(JSON.stringify({ scenario: 'phase2-supply-materials-and-publish-plans', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })
