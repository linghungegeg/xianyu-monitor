import { PGlite } from '@electric-sql/pglite'
import { _electron as electron } from 'playwright-core'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createCollectorApi, createUserApi } from '../../services/cloud/src/api.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrations = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase4-publish-${process.pid}-${Date.now()}`)
const userDataPath = mkdtempSync(join(tmpdir(), 'xianyu-phase4-publish-desktop-'))
const domains = {
  user: { issuer: 'https://user.phase4-publish.test', audience: 'user-api', secret: 'user-phase4-publish-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.phase4-publish.test', audience: 'admin-api', secret: 'admin-phase4-publish-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.phase4-publish.test', audience: 'collector-api', secret: 'collector-phase4-publish-secret-012345678901234567890' }
}

function assert(value, message) { if (!value) throw new Error(message) }
function json(response) { return JSON.parse(response.body) }
function auth(token) { return { authorization: `Bearer ${token}` } }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }

async function applyMigrations(db) {
  const files = readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort()
  for (const file of files) await db.exec(readFileSync(join(migrations, file), 'utf8'))
  return files
}

async function waitFor(check, label) {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(150)
  }
  throw new Error(`等待 ${label} 超时`)
}

function publishFixture(publishRecordUrl) {
  return `<!doctype html><meta charset="utf-8"><title>闲鱼发布夹具</title>
  <form><input data-xianyu-publish-title><textarea data-xianyu-publish-description></textarea><input data-xianyu-publish-price type="number"><input data-xianyu-publish-images type="file" multiple><textarea data-xianyu-publish-sku></textarea><select data-xianyu-publish-address><option value="上海仓">上海仓</option><option value="杭州仓">杭州仓</option></select><button data-xianyu-publish-submit type="button">发布</button></form><script>
  document.querySelector('[data-xianyu-publish-submit]').onclick = async () => { const files = document.querySelector('[data-xianyu-publish-images]').files; const params = new URLSearchParams({ title: document.querySelector('[data-xianyu-publish-title]').value, description: document.querySelector('[data-xianyu-publish-description]').value, price: document.querySelector('[data-xianyu-publish-price]').value, sku: document.querySelector('[data-xianyu-publish-sku]').value, address: document.querySelector('[data-xianyu-publish-address]').value, imageCount: String(files.length) }); await fetch(${JSON.stringify(publishRecordUrl)} + '?' + params); const result = document.createElement('strong'); result.dataset.xianyuPublishResultId = 'fixture-published-1001'; result.textContent = 'fixture-published-1001'; document.body.append(result) }
  </script>`
}

async function closeDesktop(instance) {
  if (!instance) return
  const process = instance.process()
  await instance.evaluate(({ app }) => app.quit()).catch(() => undefined)
  const deadline = Date.now() + 5_000
  while (process?.exitCode === null && Date.now() < deadline) await delay(100)
  if (process?.exitCode === null) process.kill()
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains)
  const collectorApi = createCollectorApi(sql, domains)
  const publishRecords = []
  let desktop
  let publishRecordUrl = ''
  const migrationFiles = await applyMigrations(db)
  try {
    userApi.get('/browser-login', async (_request, reply) => reply.type('text/html').send('<!doctype html><title>Chrome local login</title>'))
    userApi.get('/search', async (_request, reply) => reply.type('text/html').send('<!doctype html><title>搜索</title>'))
    userApi.get('/publish', async (_request, reply) => reply.type('text/html').send(publishFixture(publishRecordUrl)))
    userApi.get('/public-image.jpg', async (_request, reply) => reply.type('image/jpeg').send(Buffer.from([0xff, 0xd8, 0xff, 0xd9])))
    userApi.get('/publish-record', async (request) => { publishRecords.push(request.query); return { ok: true } })

    const registered = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'phase4-publish@example.test', password: 'phase4-publish-123' } })
    assert(registered.statusCode === 200, `注册失败: ${registered.body}`)
    const userAccess = json(registered).accessToken
    const userId = String((await db.query("SELECT id FROM identity.users WHERE email_normalized='phase4-publish@example.test'")).rows[0].id)
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at) VALUES ($1,$2,'collector',1,now(),'phase4-publish',now())`, [randomUUID(), userId])

    const userApiUrl = await userApi.listen({ host: '127.0.0.1', port: 0 })
    const collectorApiUrl = await collectorApi.listen({ host: '127.0.0.1', port: 0 })
    publishRecordUrl = `${userApiUrl}/publish-record`
    const materialImport = await userApi.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userAccess), payload: {
      schemaVersion: 1, sourceType: 'general', sourceFormat: 'parsed_snapshot_json', idempotencyKey: 'phase4-electron-import', snapshots: [{
        sourcePlatform: '1688', sourceItemId: 'phase4-electron-1001', sourceUrl: `${userApiUrl}/public-source?token=must-not-persist`, title: '发布夹具标题', description: '发布夹具描述', price: 88.5,
        mainImages: [`${userApiUrl}/public-image.jpg?session=must-not-persist`], sku: [{ name: '默认规格', price: 88.5 }], attrs: { publishAddress: '上海仓' }
      }]
    } })
    assert(materialImport.statusCode === 200, `素材导入失败: ${materialImport.body}`)
    const materials = await userApi.inject({ method: 'GET', url: '/v1/supply/materials?limit=20&source_platform=1688', headers: auth(userAccess) })
    const material = json(materials).items[0]
    const ready = await userApi.inject({ method: 'PATCH', url: `/v1/supply/materials/${material.id}`, headers: auth(userAccess), payload: { status: 'ready' } })
    assert(ready.statusCode === 200, `素材就绪失败: ${ready.body}`)
    const plan = await userApi.inject({ method: 'POST', url: '/v1/supply/publish-plans', headers: auth(userAccess), payload: { schemaVersion: 1, materialId: material.id, idempotencyKey: 'phase4-electron-plan', schedule: { mode: 'immediate' } } })
    assert(plan.statusCode === 200, `计划创建失败: ${plan.body}`)
    const planId = json(plan).id
    const publishTempRoot = join(tmpdir(), 'xianyu-monitor-publish')
    const publishTempBefore = existsSync(publishTempRoot) ? readdirSync(publishTempRoot).sort() : []

    desktop = await electron.launch({ executablePath: join(workspace, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [workspace], env: { ...process.env, TEMP: userDataPath, TMP: userDataPath, COLLECTOR_USER_API_URL: userApiUrl, COLLECTOR_API_URL: collectorApiUrl, XIANYU_LOGIN_URL: `${userApiUrl}/browser-login`, XIANYU_SEARCH_URL: `${userApiUrl}/search`, XIANYU_PUBLISH_URL: `${userApiUrl}/publish`, XIANYU_MONITOR_USER_DATA: userDataPath, XIANYU_SCHEDULER_INTERVAL_MS: '250', XIANYU_TASK_SYNC_INTERVAL_MS: '250', XIANYU_PUBLISH_ADDRESSES: JSON.stringify(['杭州仓']) } })
    const page = await desktop.firstWindow()
    await page.getByLabel('账号').fill('phase4-publish@example.test')
    await page.getByLabel('密码').fill('phase4-publish-123')
    await page.getByRole('button', { name: '登录并绑定' }).click()
    await page.getByText('设备已绑定，等待启动采集', { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByRole('button', { name: '启动采集' }).click()
    const published = await waitFor(async () => {
      const row = (await db.query('SELECT status,xianyu_item_id,xianyu_url FROM supply.publish_plans WHERE id=$1', [planId])).rows[0]
      return row?.status === 'published' ? row : false
    }, '发布状态回执')
    assert(published.status === 'published' && published.xianyu_item_id === 'fixture-published-1001', `发布结果未回写: ${JSON.stringify(published)}`)
    await waitFor(() => publishRecords.length === 1, '发布页字段回填')
    const record = publishRecords[0]
    assert(record && typeof record === 'object', `发布页字段无效: ${JSON.stringify(record)}`)
    assert(record.title === '发布夹具标题' && record.description === '发布夹具描述' && record.price === '88.5' && record.imageCount === '1' && record.address === '上海仓' && record.sku.includes('默认规格'), `发布页字段未完整回填: ${JSON.stringify(record)}`)
    assert(!JSON.stringify(record).match(/token|cookie|session|profile/i), '发布页接收了敏感本机状态')
    const attempts = await db.query('SELECT status,error_message,xianyu_item_id FROM supply.publish_attempts WHERE plan_id=$1', [planId])
    assert(attempts.rows.length === 1 && attempts.rows[0].status === 'succeeded' && attempts.rows[0].xianyu_item_id === 'fixture-published-1001', '云端发布尝试审计错误')
    const localDatabasePath = join(userDataPath, 'monitor-data', 'launcher.db')
    await waitFor(() => existsSync(localDatabasePath), '本机 SQLite')
    const localBytes = readFileSync(localDatabasePath)
    assert(!localBytes.includes(Buffer.from('must-not-persist')), '敏感 URL 查询参数写入本机发布状态')
    const publishTempAfter = existsSync(publishTempRoot) ? readdirSync(publishTempRoot).sort() : []
    assert(JSON.stringify(publishTempAfter) === JSON.stringify(publishTempBefore), '发布临时图片没有清理')
    console.log(JSON.stringify({ scenario: 'phase4-electron-supply-publish-runtime', migrations: migrationFiles, assertions: { actualElectron: true, persistentChromeProfile: true, claimedPlanFilledAndSubmitted: true, imageSkuPriceAddressFilled: true, cloudSuccessReceipt: true, localOutboxDelivery: true, sensitiveBoundary: true, temporaryImageCleanup: true } }, null, 2))
  } finally {
    await closeDesktop(desktop)
    await Promise.allSettled([userApi.close(), collectorApi.close()])
    await db.close()
    try { if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true }) } catch {}
    try { if (existsSync(userDataPath)) rmSync(userDataPath, { recursive: true, force: true }) } catch {}
  }
}

run().catch((error) => { console.error(JSON.stringify({ scenario: 'phase4-electron-supply-publish-runtime', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })
