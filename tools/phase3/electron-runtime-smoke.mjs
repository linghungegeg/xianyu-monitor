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
const databasePath = join(tmpdir(), `xianyu-phase3-desktop-cloud-${process.pid}-${Date.now()}`)
const userDataPath = mkdtempSync(join(tmpdir(), 'xianyu-phase3-desktop-'))
const password = 'phase3-runtime-password-123'
const email = 'runtime@example.test'
const domains = {
  user: { issuer: 'https://user.runtime.test', audience: 'user-api', secret: 'user-phase3-runtime-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.runtime.test', audience: 'admin-api', secret: 'admin-phase3-runtime-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.runtime.test', audience: 'collector-api', secret: 'collector-phase3-runtime-secret-012345678901234567890' }
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function applyMigrations(db) {
  const migrations = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql')).sort()
  for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  return migrations
}

async function waitForText(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 15_000 })
}

async function launchDesktop(userApiUrl, collectorApiUrl) {
  const desktop = await electron.launch({
    executablePath: join(workspace, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: [workspace],
    env: {
      ...process.env,
      COLLECTOR_USER_API_URL: userApiUrl,
      COLLECTOR_API_URL: collectorApiUrl,
      XIANYU_LOGIN_URL: `${userApiUrl}/browser-login`,
      XIANYU_MONITOR_USER_DATA: userDataPath
    }
  })
  const page = await desktop.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { desktop, page }
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains)
  const collectorApi = createCollectorApi(sql, domains)
  let heartbeatOnline = false
  let collectorOnline = true
  collectorApi.addHook('onRequest', async (request, reply) => {
    if (!collectorOnline && request.url === '/v1/entitlements') {
      reply.hijack()
      request.raw.destroy()
      return
    }
    if (request.url === '/v1/heartbeat' && !heartbeatOnline) return reply.code(503).send({ error: '心跳服务暂不可用' })
  })
  userApi.get('/browser-login', async (request, reply) => reply.type('text/html').send('<!doctype html><title>Chrome local login</title>'))
  const migrations = await applyMigrations(db)
  let firstDesktop
  let secondDesktop

  try {
    const registered = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password } })
    assert(registered.statusCode === 200, `运行测试账号创建失败：${registered.statusCode} ${registered.body}`)
    const userAccess = json(registered).accessToken
    const userId = String((await db.query("SELECT id FROM identity.users WHERE email_normalized='runtime@example.test'")).rows[0].id)
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at)
      VALUES ($1,$2,'collector',1,now(),'phase3-runtime',now())`, [randomUUID(), userId])

    const userApiUrl = await userApi.listen({ host: '127.0.0.1', port: 0 })
    const collectorApiUrl = await collectorApi.listen({ host: '127.0.0.1', port: 0 })
    firstDesktop = await launchDesktop(userApiUrl, collectorApiUrl)
    await firstDesktop.page.getByLabel('账号').fill(email)
    await firstDesktop.page.getByLabel('密码').fill(password)
    await firstDesktop.page.getByRole('button', { name: '登录并绑定' }).click()
    await waitForText(firstDesktop.page, '设备已绑定，等待启动采集')

    await firstDesktop.page.getByRole('button', { name: '打开 Chrome' }).click()
    await waitForText(firstDesktop.page, 'Chrome 已打开')
    assert(existsSync(join(userDataPath, 'xianyu-chrome-profile')), '系统 Chrome 未创建本机专用 Profile')

    await firstDesktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForText(firstDesktop.page, '采集器正在运行')
    heartbeatOnline = true
    await delay(5_500)
    await firstDesktop.page.getByRole('button', { name: '暂停采集' }).click()
    await waitForText(firstDesktop.page, '采集器已暂停')

    collectorOnline = false
    await firstDesktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForText(firstDesktop.page, '网络不可用，采集已暂停；恢复网络后可重新启动')
    assert(await firstDesktop.page.getByRole('button', { name: '启动采集' }).isEnabled(), '离线状态无法重新启动采集器')
    collectorOnline = true
    await firstDesktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForText(firstDesktop.page, '采集器正在运行')
    await firstDesktop.page.getByRole('button', { name: '暂停采集' }).click()
    await waitForText(firstDesktop.page, '采集器已暂停')

    const hiddenAfterClose = await firstDesktop.desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.close()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return window.isVisible()
    })
    assert(hiddenAfterClose === false, '关闭主窗口后程序没有最小化到托盘')
    const restored = await firstDesktop.desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.show()
      return window.isVisible()
    })
    assert(restored === true, '主窗口无法恢复')
    await firstDesktop.desktop.close()
    firstDesktop = undefined

    const localDatabasePath = join(userDataPath, 'monitor-data', 'launcher.db')
    const localBytes = readFileSync(localDatabasePath)
    assert(!localBytes.includes(Buffer.from(password)), '本系统密码写入了 SQLite')
    const localDatabase = new DatabaseSync(localDatabasePath)
    try {
      const pending = localDatabase.prepare('SELECT COUNT(*) AS total FROM outbox').get().total
      assert(Number(pending) === 0, '网络恢复后 Outbox 未完成补传')
      const messages = localDatabase.prepare('SELECT message FROM launcher_logs').all().map((row) => String(row.message)).join('\n')
      assert(!messages.includes(password), '本系统密码写入了动态日志')
    } finally {
      localDatabase.close()
    }

    secondDesktop = await launchDesktop(userApiUrl, collectorApiUrl)
    await waitForText(secondDesktop.page, '设备已绑定，等待启动采集')
    const clientId = String((await db.query('SELECT id FROM identity.collector_clients WHERE user_id=$1', [userId])).rows[0].id)
    const revoked = await userApi.inject({ method: 'POST', url: `/v1/collector-devices/${clientId}/revoke`, headers: auth(userAccess) })
    assert(revoked.statusCode === 200, `运行态解绑失败：${revoked.statusCode} ${revoked.body}`)
    await secondDesktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForText(secondDesktop.page, '本机设备授权已失效，采集已停止')
    await secondDesktop.desktop.close()
    secondDesktop = undefined

    console.log(JSON.stringify({
      scenario: 'phase3-electron-runtime',
      migrations,
      assertions: {
        actualElectronWindow: true,
        systemChromePersistentProfile: true,
        startPauseLifecycle: true,
        trayHideAndRestore: true,
        encryptedLocalSessionWithoutPassword: true,
        offlineOutboxRecovery: true,
        restoredCollectorRefresh: true,
        remoteUnbindStopsRuntime: true
      }
    }, null, 2))
  } finally {
    await Promise.allSettled([firstDesktop?.desktop.close(), secondDesktop?.desktop.close(), userApi.close(), collectorApi.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
    if (existsSync(userDataPath)) rmSync(userDataPath, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ scenario: 'phase3-electron-runtime', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
