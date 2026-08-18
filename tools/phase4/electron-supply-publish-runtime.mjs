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
const email = 'phase4@t.co'
const password = 'phase4-publish-123'
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
  <form><input data-xianyu-publish-title><textarea data-xianyu-publish-description></textarea><input data-xianyu-publish-price type="number"><input name="originalPrice"><input name="category"><input name="condition"><input name="brand"><input name="delivery"><input name="postage"><input name="region"><input data-xianyu-publish-images type="file" multiple><section id="sku-specs"><button data-xianyu-publish-add-sku-type type="button">添加规格类型</button></section><table><tbody class="ant-table-tbody"><tr class="ant-table-row" data-row-key="黑色-M"><td>黑色 M</td><td><input placeholder="0.00"></td><td><input placeholder="0"></td></tr><tr class="ant-table-row" data-row-key="白色-L"><td>白色 L</td><td><input placeholder="0.00"></td><td><input placeholder="0"></td></tr></tbody></table><select data-xianyu-publish-address><option value="上海仓">上海仓</option><option value="杭州仓">杭州仓</option></select><button data-xianyu-publish-submit type="button">发布</button></form><script>
  let skuGroupCount = 0
  document.querySelector('[data-xianyu-publish-add-sku-type]').onclick = () => { const index = skuGroupCount++; const group = document.createElement('section'); group.dataset.xianyuSkuGroup = String(index); const type = document.createElement('select'); type.id = 'itemProperties_' + index + '_propertyName'; type.dataset.xianyuPublishSkuType = String(index); type.innerHTML = '<option value=""></option><option value="颜色">颜色</option><option value="尺寸">尺寸</option><option value="内存">内存</option>'; group.append(type); for (let valueIndex = 0; valueIndex < 30; valueIndex += 1) { const value = document.createElement('input'); value.id = 'itemProperties_' + index + '_propertyValues_' + valueIndex + '_propertyValue'; value.dataset.xianyuPublishSkuValue = index + ':' + valueIndex; group.append(value) } document.querySelector('#sku-specs').append(group) }
  document.querySelector('[data-xianyu-publish-submit]').onclick = async () => { const title = document.querySelector('[data-xianyu-publish-title]').value; const files = document.querySelector('[data-xianyu-publish-images]').files; const itemId = title.endsWith('二') ? 'fixture-published-1002' : 'fixture-published-1001'; const skuTypes = Array.from(document.querySelectorAll('[data-xianyu-publish-sku-type]')).map((node) => node.value); const skuValues = Array.from(document.querySelectorAll('[data-xianyu-publish-sku-value]')).filter((node) => node.value).map((node) => ({ key: node.dataset.xianyuPublishSkuValue, value: node.value })); const skuRows = Array.from(document.querySelectorAll('tbody.ant-table-tbody tr.ant-table-row')).map((row) => ({ key: row.dataset.rowKey, price: row.querySelector('input[placeholder="0.00"]').value, stock: row.querySelector('input[placeholder="0"]').value })); const params = new URLSearchParams({ title, description: document.querySelector('[data-xianyu-publish-description]').value, price: document.querySelector('[data-xianyu-publish-price]').value, originalPrice: document.querySelector('[name="originalPrice"]').value, category: document.querySelector('[name="category"]').value, condition: document.querySelector('[name="condition"]').value, brand: document.querySelector('[name="brand"]').value, delivery: document.querySelector('[name="delivery"]').value, postage: document.querySelector('[name="postage"]').value, region: document.querySelector('[name="region"]').value, skuTypes: JSON.stringify(skuTypes), skuValues: JSON.stringify(skuValues), skuRows: JSON.stringify(skuRows), address: document.querySelector('[data-xianyu-publish-address]').value, imageCount: String(files.length), itemId }); await fetch(${JSON.stringify(publishRecordUrl)} + '?' + params); const result = document.createElement('strong'); result.dataset.xianyuPublishResultId = itemId; result.textContent = itemId; document.body.append(result) }
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

    const registered = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password } })
    assert(registered.statusCode === 200, `注册失败: ${registered.body}`)
    const userAccess = json(registered).accessToken
    const userId = String((await db.query('SELECT id FROM identity.users WHERE email_normalized=$1', [email])).rows[0].id)
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at) VALUES ($1,$2,'collector',1,now(),'phase4-publish',now())`, [randomUUID(), userId])

    const userApiUrl = await userApi.listen({ host: '127.0.0.1', port: 0 })
    const collectorApiUrl = await collectorApi.listen({ host: '127.0.0.1', port: 0 })
    publishRecordUrl = `${userApiUrl}/publish-record`
    const materialImport = await userApi.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userAccess), payload: {
      schemaVersion: 1, sourceType: 'general', sourceFormat: 'parsed_snapshot_json', idempotencyKey: 'phase4-electron-import', snapshots: [{
        sourcePlatform: '1688', sourceItemId: 'phase4-electron-1001', sourceUrl: `${userApiUrl}/public-source?token=must-not-persist`, title: '发布夹具标题', description: '发布夹具描述', price: 88.5,
        mainImages: [`${userApiUrl}/public-image.jpg?session=must-not-persist`], sku: { specifications: [{ name: '颜色', values: ['黑色'] }, { name: '尺寸', values: ['M'] }], skus: [{ values: ['黑色', 'M'], price: 88.5, stock: 3 }] }, attrs: { publishAddressMode: 'random', publishAddressPool: ['上海仓', '杭州仓'], originalPrice: 128, category: '女装/上衣', condition: '全新', brand: '懒人', delivery: '快递发货', postage: '0', region: '杭州市' }
      }, {
        sourcePlatform: '1688', sourceItemId: 'phase4-electron-1002', sourceUrl: `${userApiUrl}/public-source-2?token=must-not-persist`, title: '发布夹具标题二', description: '发布夹具描述二', price: 99.5,
        mainImages: [`${userApiUrl}/public-image.jpg?session=must-not-persist`], sku: { 颜色: '白色', 尺寸: 'L' }, attrs: { publishAddressMode: 'random', publishAddressPool: ['上海仓', '杭州仓'] }
      }]
    } })
    assert(materialImport.statusCode === 200, `素材导入失败: ${materialImport.body}`)
    const materials = await userApi.inject({ method: 'GET', url: '/v1/supply/materials?limit=20&source_platform=1688', headers: auth(userAccess) })
    const importedMaterials = json(materials).items
    assert(importedMaterials.length === 2, `素材数量错误: ${materials.body}`)
    const planIds = []
    for (const material of importedMaterials) {
      const ready = await userApi.inject({ method: 'PATCH', url: `/v1/supply/materials/${material.id}`, headers: auth(userAccess), payload: { status: 'ready' } })
      assert(ready.statusCode === 200, `素材就绪失败: ${ready.body}`)
      const plan = await userApi.inject({ method: 'POST', url: '/v1/supply/publish-plans', headers: auth(userAccess), payload: { schemaVersion: 1, materialId: material.id, idempotencyKey: `phase4-electron-plan-${material.id}`, schedule: { mode: 'immediate' } } })
      assert(plan.statusCode === 200, `计划创建失败: ${plan.body}`)
      planIds.push(json(plan).id)
    }
    const publishTempRoot = join(tmpdir(), 'xianyu-monitor-publish')
    const publishTempBefore = existsSync(publishTempRoot) ? readdirSync(publishTempRoot).sort() : []

    desktop = await electron.launch({ executablePath: join(workspace, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [workspace], env: { ...process.env, TEMP: userDataPath, TMP: userDataPath, COLLECTOR_USER_API_URL: userApiUrl, COLLECTOR_API_URL: collectorApiUrl, XIANYU_LOGIN_URL: `${userApiUrl}/browser-login`, XIANYU_SEARCH_URL: `${userApiUrl}/search`, XIANYU_PUBLISH_URL: `${userApiUrl}/publish`, XIANYU_MONITOR_USER_DATA: userDataPath, XIANYU_SCHEDULER_INTERVAL_MS: '250', XIANYU_TASK_SYNC_INTERVAL_MS: '250', XIANYU_PUBLISH_ADDRESSES: JSON.stringify(['杭州仓']) } })
    const page = await desktop.firstWindow()
    await page.getByLabel('账号').fill(email)
    await page.getByLabel('密码').fill(password)
    await page.getByRole('button', { name: '登录' }).click()
    await page.getByText('设备已绑定，账号权益有效', { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByRole('button', { name: '启动采集' }).click()
    const published = await waitFor(async () => {
      const rows = (await db.query('SELECT id,status,xianyu_item_id,xianyu_url FROM supply.publish_plans WHERE id = ANY($1::uuid[]) ORDER BY id', [planIds])).rows
      return rows.length === 2 && rows.every((row) => row.status === 'published') ? rows : false
    }, '批量发布状态回执')
    assert(published.every((row) => /^fixture-published-100[12]$/.test(String(row.xianyu_item_id))), `发布结果未回写: ${JSON.stringify(published)}`)
    await waitFor(() => publishRecords.length === 2, '批量发布页字段回填')
    assert(publishRecords.every((record) => record && typeof record === 'object'), `发布页字段无效: ${JSON.stringify(publishRecords)}`)
    const structuredSkuRecord = publishRecords.find((record) => record.title === '发布夹具标题')
    assert(structuredSkuRecord?.description === '发布夹具描述' && structuredSkuRecord.price === '88.5' && structuredSkuRecord.imageCount === '1', `发布基础字段未完整回填: ${JSON.stringify(publishRecords)}`)
    assert(structuredSkuRecord.originalPrice === '128' && structuredSkuRecord.category === '女装/上衣' && structuredSkuRecord.condition === '全新' && structuredSkuRecord.brand === '懒人' && structuredSkuRecord.delivery === '快递发货' && structuredSkuRecord.postage === '0' && structuredSkuRecord.region === '杭州市', `懒人发布字段未完整回填: ${JSON.stringify(structuredSkuRecord)}`)
    const skuTypes = JSON.parse(String(structuredSkuRecord?.skuTypes ?? '[]'))
    const skuValues = JSON.parse(String(structuredSkuRecord?.skuValues ?? '[]'))
    const skuRows = JSON.parse(String(structuredSkuRecord?.skuRows ?? '[]'))
    assert(skuTypes.join('/') === '颜色/尺寸' && skuValues.some((item) => item.key === '0:0' && item.value === '黑色') && skuValues.some((item) => item.key === '1:0' && item.value === 'M') && skuRows.some((item) => item.key === '黑色-M' && item.price === '88.5' && item.stock === '3'), `结构化 SKU 规格类型、值或价格库存未写入: ${JSON.stringify(structuredSkuRecord)}`)
    assert(new Set(publishRecords.map((record) => record.address)).size === 2, `随机地址连续重复: ${JSON.stringify(publishRecords)}`)
    assert(!JSON.stringify(publishRecords).match(/token|cookie|session|profile/i), '发布页接收了敏感本机状态')
    await delay(750)
    assert(publishRecords.length === 2, `重复领取批次触发了重复发布: ${JSON.stringify(publishRecords)}`)
    const attempts = await db.query('SELECT status,error_message,xianyu_item_id FROM supply.publish_attempts WHERE plan_id = ANY($1::uuid[])', [planIds])
    assert(attempts.rows.length === 2 && attempts.rows.every((attempt) => attempt.status === 'succeeded' && /^fixture-published-100[12]$/.test(String(attempt.xianyu_item_id))), '云端发布尝试审计错误')
    const localDatabasePath = join(userDataPath, 'monitor-data', 'launcher.db')
    await waitFor(() => existsSync(localDatabasePath), '本机 SQLite')
    const localBytes = readFileSync(localDatabasePath)
    assert(!localBytes.includes(Buffer.from('must-not-persist')), '敏感 URL 查询参数写入本机发布状态')
    const publishTempAfter = existsSync(publishTempRoot) ? readdirSync(publishTempRoot).sort() : []
    assert(JSON.stringify(publishTempAfter) === JSON.stringify(publishTempBefore), '发布临时图片没有清理')
    console.log(JSON.stringify({ scenario: 'phase4-electron-supply-publish-runtime', migrations: migrationFiles, assertions: { actualElectron: true, persistentChromeProfile: true, batchClaimFilledAndSubmitted: true, skuTypeValueAndCombinationPriceStockFilled: true, randomAddressNoAdjacentRepeat: true, cloudSuccessReceipt: true, localOutboxDelivery: true, sensitiveBoundary: true, temporaryImageCleanup: true } }, null, 2))
  } finally {
    await closeDesktop(desktop)
    await Promise.allSettled([userApi.close(), collectorApi.close()])
    await db.close()
    try { if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true }) } catch {}
    try { if (existsSync(userDataPath)) rmSync(userDataPath, { recursive: true, force: true }) } catch {}
  }
}

run().catch((error) => { console.error(JSON.stringify({ scenario: 'phase4-electron-supply-publish-runtime', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })
