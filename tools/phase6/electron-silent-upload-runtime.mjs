import { PGlite } from '@electric-sql/pglite'
import { _electron as electron } from 'playwright-core'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createCollectorApi, createUserApi } from '../../services/cloud/src/api.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase6-desktop-cloud-${process.pid}-${Date.now()}`)
const userDataPath = mkdtempSync(join(tmpdir(), 'xianyu-phase6-desktop-'))
const email = 'phase6-desktop@example.test'
const password = 'p6-desktop-123456'
const domains = {
  user: { issuer: 'https://user.phase6.desktop', audience: 'user-api', secret: 'user-phase6-desktop-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.phase6.desktop', audience: 'admin-api', secret: 'admin-phase6-desktop-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.phase6.desktop', audience: 'collector-api', secret: 'collector-phase6-desktop-secret-012345678901234567890' }
}
function assert(condition, message) { if (!condition) throw new Error(message) }
function json(response) { return JSON.parse(response.body) }
function auth(token) { return { authorization: `Bearer ${token}` } }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
async function applyMigrations(db) { const migrations = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql')).sort(); for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8')); return migrations }
async function launch(userApiUrl, collectorApiUrl) {
  const desktop = await electron.launch({ executablePath: join(workspace, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [workspace], env: { ...process.env, COLLECTOR_USER_API_URL: userApiUrl, COLLECTOR_API_URL: collectorApiUrl, XIANYU_LOGIN_URL: `${userApiUrl}/browser-login`, XIANYU_MONITOR_USER_DATA: userDataPath, XIANYU_SCHEDULER_INTERVAL_MS: '250' } })
  const page = await desktop.firstWindow(); await page.waitForLoadState('domcontentloaded'); return { desktop, page }
}
function seedLocalUpload() {
  const local = new DatabaseSync(join(userDataPath, 'monitor-data', 'launcher.db'))
  try {
    const now = new Date().toISOString()
    local.prepare(`INSERT INTO local_sellers (platform,platform_seller_id,profile_url,public_name,region,public_profile,first_seen_at,last_seen_at) VALUES ('goofish','seller-phase6-desktop','https://www.goofish.com/personal?userId=seller-phase6-desktop','公开卖家','上海','{}',?,?)`).run(now, now)
    local.prepare(`INSERT INTO local_items (platform,platform_item_id,url,title,price,region,image_urls,tags,first_seen_at,last_seen_at) VALUES ('goofish','item-phase6-desktop','https://www.goofish.com/item/item-phase6-desktop','公开商品',88,'上海','["https://img.example/item.jpg"]','[]',?,?)`).run(now, now)
    local.prepare(`INSERT INTO local_item_versions (platform,platform_item_id,content_hash,canonical_payload,observed_at) VALUES ('goofish','item-phase6-desktop','phase6-desktop-version','{"title":"公开商品","imageUrls":["https://img.example/item.jpg"]}',?)`).run(now)
    local.prepare(`INSERT INTO local_seller_item_relations (platform,platform_seller_id,platform_item_id,state,first_seen_at,last_seen_at) VALUES ('goofish','seller-phase6-desktop','item-phase6-desktop','active',?,?)`).run(now, now)
    local.prepare(`INSERT INTO local_item_events (id,platform,platform_seller_id,platform_item_id,event_type,details_json,event_key,occurred_at,detected_at) VALUES (?,'goofish','seller-phase6-desktop','item-phase6-desktop','new_listing','{}','phase6-desktop-event',?,?)`).run(randomUUID(), now, now)
  } finally { local.close() }
}
async function run() {
  const db = new PGlite(databasePath); const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains); const collectorApi = createCollectorApi(sql, domains); let ingestOnline = false
  collectorApi.addHook('onRequest', async (request, reply) => { if (request.url === '/v1/ingest' && !ingestOnline) return reply.code(503).send({ error: 'temporary offline' }) })
  userApi.get('/browser-login', async (_, reply) => reply.type('text/html').send('<!doctype html><title>local</title>'))
  const migrations = await applyMigrations(db); let first; let second
  try {
    const registered = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password } }); assert(registered.statusCode === 200, '用户注册失败')
    const userAccess = json(registered).accessToken; const userId = String((await db.query("SELECT id FROM identity.users WHERE email_normalized='phase6-desktop@example.test'")).rows[0].id)
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at) VALUES ($1,$2,'collector',1,now(),'phase6-desktop',now())`, [randomUUID(), userId])
    const userApiUrl = await userApi.listen({ host: '127.0.0.1', port: 0 }); const collectorApiUrl = await collectorApi.listen({ host: '127.0.0.1', port: 0 })
    first = await launch(userApiUrl, collectorApiUrl)
    await first.page.getByText('闲鱼采集器').waitFor({ state: 'visible', timeout: 15_000 })
    assert(await first.page.getByText('Windows Collector').count() === 0 && await first.page.getByText('DEVICE AUTHORIZATION').count() === 0, '采集器界面仍显示工程化文案')
    await first.page.getByLabel('账号').fill(email); await first.page.getByLabel('密码').fill(password); await first.page.getByRole('button', { name: '登录并绑定' }).click()
    await first.page.getByText('设备已绑定，等待启动采集').waitFor({ state: 'visible', timeout: 15_000 }); await first.desktop.close(); first = undefined
    seedLocalUpload()
    second = await launch(userApiUrl, collectorApiUrl)
    await second.page.getByRole('button', { name: '打开 Chrome' }).waitFor({ state: 'visible', timeout: 15_000 })
    await second.page.getByRole('button', { name: '启动采集' }).click(); await second.page.getByRole('heading', { name: '采集器正在运行' }).first().waitFor({ state: 'visible', timeout: 15_000 }); await delay(1_000)
    let local = new DatabaseSync(join(userDataPath, 'monitor-data', 'launcher.db')); const pending = Number(local.prepare("SELECT COUNT(*) AS total FROM outbox WHERE kind='market_batch'").get().total); local.close()
    assert(pending === 1, '断网上传未进入本机 Outbox')
    ingestOnline = true; await delay(5_500); await second.page.getByRole('button', { name: '暂停采集' }).click(); await second.page.getByRole('heading', { name: '采集器已暂停' }).waitFor({ state: 'visible', timeout: 15_000 }); await second.desktop.close(); second = undefined
    local = new DatabaseSync(join(userDataPath, 'monitor-data', 'launcher.db')); const remaining = Number(local.prepare("SELECT COUNT(*) AS total FROM outbox WHERE kind='market_batch'").get().total); const bytes = readFileSync(join(userDataPath, 'monitor-data', 'launcher.db')); local.close()
    assert(remaining === 0, '网络恢复后市场 Outbox 未清空'); assert(!bytes.includes(Buffer.from('temporary offline')) && !bytes.includes(Buffer.from('cookie')), 'SQLite 写入了云端错误或敏感状态')
    const count = await db.query("SELECT COUNT(*)::int AS total FROM market.items WHERE platform_item_id='item-phase6-desktop'"); assert(Number(count.rows[0].total) === 1, 'Electron 上传未写入共享市场池')
    console.log(JSON.stringify({ scenario: 'phase6-electron-silent-upload', migrations, assertions: { actualElectron: true, collectorChromeUi: true, localSqliteOutbox: true, offlineRetryRecovery: true, cursorBatchUpload: true, sensitiveStateLocalOnly: true, sharedMarketWrite: true } }, null, 2))
  } finally { await Promise.allSettled([first?.desktop.close(), second?.desktop.close(), userApi.close(), collectorApi.close()]); await db.close(); if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true }); if (existsSync(userDataPath)) rmSync(userDataPath, { recursive: true, force: true }) }
}
run().catch((error) => { console.error(JSON.stringify({ scenario: 'phase6-electron-silent-upload', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })
