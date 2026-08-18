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
const databasePath = join(tmpdir(), `xianyu-phase5-desktop-cloud-${process.pid}-${Date.now()}`)
const userDataPath = mkdtempSync(join(tmpdir(), 'xianyu-phase5-desktop-'))
const password = 'p5-runtime-123456'
const cookieValue = 'phase5-cookie-local-only'
const email = 'phase5-runtime@example.test'
const sellerId = 'seller-phase5-001'
const domains = {
  user: { issuer: 'https://user.runtime.test', audience: 'user-api', secret: 'user-phase5-runtime-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.runtime.test', audience: 'admin-api', secret: 'admin-phase5-runtime-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.runtime.test', audience: 'collector-api', secret: 'collector-phase5-runtime-secret-012345678901234567890' }
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
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 })
  } catch {
    throw new Error(`未出现状态“${text}”：${(await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600)}`)
  }
}

async function waitForCount(locator, count) {
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    if (await locator.count() >= count) return
    await delay(100)
  }
  throw new Error(`等待卖家采集日志数量 ${count} 超时`)
}

async function closeDesktop(instance) {
  if (!instance) return true
  const desktopProcess = instance.desktop.process()
  const exited = new Promise((resolve) => {
    if (!desktopProcess || desktopProcess.exitCode !== null) return resolve(true)
    const timeout = setTimeout(() => resolve(false), 5_000)
    desktopProcess.once('exit', () => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
  await instance.desktop.evaluate(({ app }) => app.quit()).catch(() => undefined)
  const closed = await exited
  if (!closed) desktopProcess?.kill()
  return closed
}

function readOutboxCount(databasePath) {
  const database = new DatabaseSync(databasePath)
  try {
    return Number(database.prepare('SELECT COUNT(*) AS total FROM outbox').get().total)
  } finally {
    database.close()
  }
}

function baseItems() {
  return {
    '501': { title: 'MacBook Air 13', price: 100, want: 8, description: '公开商品详情 A', condition: '95新', imageKeys: ['501-a', '501-b'], tags: ['数码', '原装'] },
    '502': { title: 'MacBook Pro 14', price: 200, want: 12, description: '公开商品详情 B', condition: '9成新', imageKeys: ['502-a'], tags: ['数码', '笔记本'] },
    '503': { title: 'MacBook Pro 16', price: 300, want: 5, description: '公开商品详情 C', condition: '95新', imageKeys: ['503-a'], tags: ['数码', '高配'] },
    '504': { title: 'Mac mini M2', price: 40, want: 3, description: '公开商品详情 D', condition: '9成新', imageKeys: ['504-a'], tags: ['数码', '台式机'] },
    '505': { title: 'Magic Keyboard', price: 60, want: 9, description: '公开商品详情 E', condition: '95新', imageKeys: ['505-a'], tags: ['数码', '配件'] },
    '506': { title: 'Studio Display', price: 500, want: 2, description: '公开商品详情 F', condition: '99新', imageKeys: ['506-a'], tags: ['数码', '显示器'] }
  }
}

function sellerSnapshot(revision) {
  const items = baseItems()
  if (revision >= 2) {
    items['501'].price = 80
    items['502'].price = 250
    items['503'].description = '公开商品详情 C 已更新'
    items['503'].condition = '8成新'
    items['503'].imageKeys = ['503-b', '503-c']
    items['504'].price = 60
  }
  if (revision === 0 || revision === 1) {
    return {
      items,
      active: [['501', '502'], ['502', '503']],
      sold: [['504', '503'], ['504', '505']]
    }
  }
  if (revision === 2) {
    return {
      items,
      active: [['501', '503'], ['503', '505', '506']],
      sold: [['502', '504'], ['504']]
    }
  }
  if (revision === 3) {
    return {
      items,
      active: [['503']],
      sold: [['502', '504'], ['504']]
    }
  }
  return {
    items,
    active: [['503', '506']],
    sold: [['502', '504'], ['504']]
  }
}

function sellerFixture(snapshot) {
  const payload = JSON.stringify(snapshot)
  return `<!doctype html>
<meta charset="utf-8">
<title>闲鱼卖家夹具</title>
<body data-xianyu-selected-seller-state="active">
  <section data-xianyu-seller-profile data-seller-id="${sellerId}">
    <h1 data-seller-name>测试卖家</h1>
    <p data-seller-region>上海</p>
    <p data-xianyu-seller-followers>123 粉丝</p>
    <p data-xianyu-seller-rating>4.9</p>
    <p data-xianyu-seller-item-count>6 件</p>
  </section>
  <nav>
    <button data-xianyu-seller-tab="active">在售</button>
    <button data-xianyu-seller-tab="sold">已售</button>
  </nav>
  <section id="items"></section>
  <button data-xianyu-seller-next>下一页</button>
  <script>
    const fixture = ${payload}
    let state = 'active'
    let page = 0
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
    const render = () => {
      const entries = fixture[state][page] || []
      document.querySelector('#items').innerHTML = entries.map((id) => {
        const item = fixture.items[id]
        const tags = item.tags.map((tag) => '<span data-xianyu-tag>' + escapeHtml(tag) + '</span>').join('')
        const images = item.imageKeys.map((key) => '<img data-xianyu-image src="/asset/' + encodeURIComponent(key) + '.gif">').join('')
        return '<article data-xianyu-seller-item><a href="/item?id=' + encodeURIComponent(id) + '"><h2 data-xianyu-title>' + escapeHtml(item.title) + '</h2><p>¥ ' + item.price + ' 上海 ' + item.want + '人想要 1小时前发布</p>' + tags + images + '</a></article>'
      }).join('')
      document.querySelector('[data-xianyu-seller-next]').disabled = page >= fixture[state].length - 1
      document.body.dataset.xianyuSelectedSellerState = state
    }
    document.querySelectorAll('[data-xianyu-seller-tab]').forEach((node) => node.addEventListener('click', () => {
      state = node.dataset.xianyuSellerTab
      page = 0
      render()
    }))
    document.querySelector('[data-xianyu-seller-next]').addEventListener('click', () => {
      page = Math.min(page + 1, fixture[state].length - 1)
      render()
    })
    render()
  </script>
</body>`
}

function detailFixture(itemId, snapshot) {
  const item = snapshot.items[itemId]
  if (!item) return '<!doctype html><meta charset="utf-8"><title>商品不存在</title>'
  const tags = item.tags.map((tag) => `<span data-xianyu-tag>${tag}</span>`).join('')
  const images = item.imageKeys.map((key) => `<img data-xianyu-image src="/asset/${key}.gif">`).join('')
  return `<!doctype html><meta charset="utf-8"><title>${item.title}</title>
  <section data-xianyu-detail data-seller-id="${sellerId}">
    <h1 data-xianyu-title>${item.title}</h1>
    <p data-xianyu-price>¥ ${item.price}</p>
    <p data-xianyu-region>上海</p>
    <p data-xianyu-published>1小时前发布</p>
    <p data-xianyu-want>${item.want}人想要</p>
    <p data-xianyu-description>${item.description}</p>
    <p data-xianyu-condition>${item.condition}</p>
    ${tags}${images}
  </section>`
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
      XIANYU_SEARCH_URL: `${userApiUrl}/search`,
      XIANYU_PROFILE_ALLOWED_HOSTS: new URL(userApiUrl).hostname,
      XIANYU_MONITOR_USER_DATA: userDataPath,
      XIANYU_PHASE6_UPLOAD_ENABLED: 'false',
      XIANYU_SCHEDULER_INTERVAL_MS: '250',
      XIANYU_TASK_SYNC_INTERVAL_MS: '250',
      XIANYU_SELLER_PAGE_LIMIT: '4'
    }
  })
  const page = await desktop.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { desktop, page }
}

function count(database, query) {
  return Number(database.prepare(query).get().total)
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains, { sellerProfileHosts: ['127.0.0.1'] })
  const collectorApi = createCollectorApi(sql, domains)
  let fixtureRevision = 0
  let heartbeatOnline = false
  let heartbeatFailures = 0
  let ingestCalls = 0
  const collectorPaths = []
  const collectorPayloads = []
  const collectorCookies = []
  const userCookies = []
  let delayedDetailGate
  let revokedRunDetailRequests = 0
  let desktop

  collectorApi.addHook('onRequest', async (request, reply) => {
    collectorPaths.push(request.url)
    if (request.headers.cookie) collectorCookies.push(String(request.headers.cookie))
    if (request.url.startsWith('/v1/ingest')) {
      ingestCalls += 1
      return reply.code(500).send({ error: '采集器不应调用上传接口' })
    }
    if (request.url === '/v1/heartbeat' && !heartbeatOnline) {
      heartbeatFailures += 1
      return reply.code(503).send({ error: '本地断网夹具' })
    }
  })
  collectorApi.addHook('preHandler', async (request) => {
    if (request.body !== undefined) collectorPayloads.push({ path: request.url, body: JSON.stringify(request.body) })
  })
  userApi.addHook('onRequest', async (request) => {
    if (request.headers.cookie) userCookies.push({ path: request.url, value: String(request.headers.cookie) })
  })
  userApi.get('/browser-login', async (_request, reply) => reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><title>Chrome local login</title><script>document.cookie='xianyu_fixture_cookie=${cookieValue}; Path=/browser-login; SameSite=Lax'</script>`))
  userApi.get('/search', async (_request, reply) => reply.type('text/html').send('<!doctype html><meta charset="utf-8"><title>闲鱼搜索夹具</title>'))
  userApi.get('/seller', async (_request, reply) => reply.type('text/html').send(sellerFixture(sellerSnapshot(fixtureRevision))))
  userApi.get('/item', async (request, reply) => {
    if (delayedDetailGate && !delayedDetailGate.started) {
      delayedDetailGate.started = true
      revokedRunDetailRequests += 1
      delayedDetailGate.resolveStarted()
      await delayedDetailGate.release
    }
    return reply.type('text/html').send(detailFixture(String(request.query?.id ?? ''), sellerSnapshot(fixtureRevision)))
  })
  userApi.get('/asset/:name', async (_request, reply) => reply.type('image/gif').send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')))

  const migrations = await applyMigrations(db)

  try {
    const registered = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password } })
    assert(registered.statusCode === 200, `运行测试账号创建失败：${registered.statusCode} ${registered.body}`)
    const userAccess = json(registered).accessToken
    const userId = String((await db.query("SELECT id FROM identity.users WHERE email_normalized='phase5-runtime@example.test'")).rows[0].id)
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at)
      VALUES ($1,$2,'collector',1,now(),'phase5-runtime',now())`, [randomUUID(), userId])

    const userApiUrl = await userApi.listen({ host: '127.0.0.1', port: 0 })
    const collectorApiUrl = await collectorApi.listen({ host: '127.0.0.1', port: 0 })
    const created = await userApi.inject({
      method: 'POST',
      url: '/v1/seller-monitors',
      headers: auth(userAccess),
      payload: { platform: 'goofish', platformSellerId: sellerId, profileUrl: `${userApiUrl}/seller?userId=${sellerId}`, intervalSeconds: 1800 }
    })
    assert(created.statusCode === 200, `卖家监控任务创建失败：${created.statusCode} ${created.body}`)
    const taskId = json(created).id
    const patchTask = async () => {
      const response = await userApi.inject({ method: 'PATCH', url: `/v1/seller-monitors/${taskId}`, headers: auth(userAccess), payload: { status: 'active' } })
      assert(response.statusCode === 200, `卖家监控任务更新失败：${response.statusCode} ${response.body}`)
    }

    desktop = await launchDesktop(userApiUrl, collectorApiUrl)
    await desktop.page.getByLabel('账号').fill(email)
    await desktop.page.getByLabel('密码').fill(password)
    await desktop.page.getByRole('button', { name: '登录并绑定' }).click()
    await waitForText(desktop.page, '设备已绑定，等待启动采集')
    await desktop.page.getByRole('button', { name: '打开 Chrome' }).click()
    await waitForText(desktop.page, 'Chrome 已打开')
    assert(existsSync(join(userDataPath, 'xianyu-chrome-profile')), '系统 Chrome 未创建本机专用 Profile')

    const sellerLogs = desktop.page.getByText('“测试卖家”卖家采集完成', { exact: false })
    const runAndPause = async (expectedCount) => {
      await desktop.page.getByRole('button', { name: '启动采集' }).click()
      await waitForCount(sellerLogs, expectedCount)
      await desktop.page.getByRole('button', { name: '暂停采集' }).click()
      await waitForText(desktop.page, '采集器已暂停')
    }

    await runAndPause(1)
    assert(heartbeatFailures > 0, '断网夹具没有让首次 heartbeat 进入 Outbox')

    heartbeatOnline = true
    fixtureRevision = 1
    await patchTask()
    await runAndPause(2)
    await desktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForText(desktop.page, '采集器正在运行')
    await delay(6_500)
    await desktop.page.getByRole('button', { name: '暂停采集' }).click()
    await waitForText(desktop.page, '采集器已暂停')
    const recoveryDatabasePath = join(userDataPath, 'monitor-data', 'launcher.db')
    assert(readOutboxCount(recoveryDatabasePath) === 0, '断网恢复后的 Outbox 未在解绑前清空')

    fixtureRevision = 2
    await patchTask()
    await runAndPause(3)

    fixtureRevision = 3
    await patchTask()
    await runAndPause(4)

    const hiddenAfterClose = await desktop.desktop.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.close()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return window.isVisible()
    })
    assert(hiddenAfterClose === false, '关闭主窗口后程序没有最小化到托盘')
    const restored = await desktop.desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.show()
      return window.isVisible()
    })
    assert(restored === true, '主窗口无法从托盘恢复')

    fixtureRevision = 4
    await patchTask()
    let resolveStarted
    let releaseDetail
    const started = new Promise((resolve) => { resolveStarted = resolve })
    const release = new Promise((resolve) => { releaseDetail = resolve })
    delayedDetailGate = { started: false, resolveStarted, release }
    await desktop.page.getByRole('button', { name: '启动采集' }).click()
    await Promise.race([started, delay(20_000).then(() => { throw new Error('等待在途卖家商品详情请求超时') })])
    const clientId = String((await db.query("SELECT id FROM identity.collector_clients WHERE user_id=$1 AND status='active'", [userId])).rows[0].id)
    const revoked = await userApi.inject({ method: 'POST', url: `/v1/collector-devices/${clientId}/revoke`, headers: auth(userAccess) })
    assert(revoked.statusCode === 200, `在途解绑失败：${revoked.statusCode} ${revoked.body}`)
    releaseDetail()
    await waitForText(desktop.page, '本机设备授权已失效，采集已停止')
    await delay(350)
    assert(revokedRunDetailRequests === 1, `设备解绑后仍继续打开详情：${revokedRunDetailRequests}`)
    delayedDetailGate = undefined

    const exited = await closeDesktop(desktop)
    desktop = undefined
    assert(exited, '退出程序后 Electron 主进程没有结束')

    const localDatabasePath = join(userDataPath, 'monitor-data', 'launcher.db')
    const localBytes = readFileSync(localDatabasePath)
    assert(!localBytes.includes(Buffer.from(password)), '本系统密码写入了 SQLite')
    assert(!localBytes.includes(Buffer.from(cookieValue)), '闲鱼 Cookie 写入了采集器 SQLite')
    const localDatabase = new DatabaseSync(localDatabasePath)
    try {
      const itemTotal = count(localDatabase, 'SELECT COUNT(*) AS total FROM local_items')
      const itemVersionTotal = count(localDatabase, 'SELECT COUNT(*) AS total FROM local_item_versions')
      const sellerTotal = count(localDatabase, 'SELECT COUNT(*) AS total FROM local_sellers')
      const sellerVersionTotal = count(localDatabase, 'SELECT COUNT(*) AS total FROM local_seller_versions')
      const eventTotal = count(localDatabase, 'SELECT COUNT(*) AS total FROM local_item_events')
      const completedRuns = count(localDatabase, "SELECT COUNT(*) AS total FROM local_task_runs WHERE kind='seller' AND status='completed'")
      const failedRuns = count(localDatabase, "SELECT COUNT(*) AS total FROM local_task_runs WHERE kind='seller' AND status='failed'")
      const relationRows = localDatabase.prepare('SELECT platform_item_id, state FROM local_seller_item_relations ORDER BY platform_item_id').all()
      const relations = Object.fromEntries(relationRows.map((row) => [String(row.platform_item_id), String(row.state)]))
      const eventRows = localDatabase.prepare('SELECT event_type, COUNT(*) AS total FROM local_item_events GROUP BY event_type').all()
      const events = Object.fromEntries(eventRows.map((row) => [String(row.event_type), Number(row.total)]))
      const outboxKinds = localDatabase.prepare('SELECT DISTINCT kind FROM outbox').all().map((row) => String(row.kind))
      const pendingOutbox = count(localDatabase, 'SELECT COUNT(*) AS total FROM outbox')
      const messages = localDatabase.prepare('SELECT message FROM launcher_logs').all().map((row) => String(row.message)).join('\n')
      const stateValues = localDatabase.prepare('SELECT value FROM launcher_state').all().map((row) => String(row.value)).join('\n')

      assert(itemTotal === 6, `卖家多页商品去重错误：${itemTotal}`)
      assert(itemVersionTotal === 10, `无变化版本去重或商品变更版本错误：${itemVersionTotal}`)
      assert(sellerTotal === 1 && sellerVersionTotal === 1, `卖家资料去重错误：${sellerTotal}/${sellerVersionTotal}`)
      assert(eventTotal === 13, `卖家事件数量错误：${eventTotal}`)
      assert(events.new_listing === 4, `新增上架事件错误：${events.new_listing}`)
      assert(events.price_changed === 3, `价格变更事件错误：${events.price_changed}`)
      assert(events.content_changed === 1, `内容变更事件错误：${events.content_changed}`)
      assert(events.state_changed === 5, `状态变更事件错误：${events.state_changed}`)
      assert(relations['501'] === 'offline' && relations['502'] === 'sold' && relations['503'] === 'active' && relations['504'] === 'sold' && relations['505'] === 'offline' && relations['506'] === 'offline', `完整在售扫描后的商品状态错误：${JSON.stringify(relations)}`)
      assert(completedRuns === 4 && failedRuns === 1, `卖家任务运行记录错误：完成 ${completedRuns}，失败 ${failedRuns}`)
      assert(outboxKinds.every((kind) => kind === 'heartbeat'), 'Outbox 出现了非 heartbeat 类型')
      assert(!messages.includes(password) && !messages.includes(cookieValue), '敏感信息写入了动态日志')
      assert(!/authorization|cookie|token/i.test(messages), '认证信息写入了动态日志')
      assert(!stateValues.includes(password) && !stateValues.includes(cookieValue) && !stateValues.includes('eyJ'), '本机授权以明文写入 SQLite')
    } finally {
      localDatabase.close()
    }

    assert(ingestCalls === 0 && !collectorPaths.some((path) => path.startsWith('/v1/ingest')), '采集启动器调用了上传接口')
    assert(collectorCookies.length === 0, '闲鱼 Cookie 发送到了采集器云端接口')
    assert(userCookies.every((entry) => entry.path !== '/seller' && entry.path !== '/item'), '闲鱼 Cookie 随卖家页面请求离开本机 Profile')
    assert(collectorPayloads.every((entry) => !/cookie|xianyu-chrome-profile/i.test(entry.body)), 'Chrome Profile 或 Cookie 进入了采集器云端请求')

    console.log(JSON.stringify({
      scenario: 'phase5-electron-seller-runtime',
      migrations,
      assertions: {
        actualElectronWindow: true,
        systemChromePersistentProfile: true,
        sellerTaskSnapshotAndLocalProfile: true,
        activeAndSoldMultiPageDeduplication: true,
        baselineAndUnchangedVersionDeduplication: true,
        priceStateContentAndRelistEvents: true,
        completeActiveScanMarksOffline: true,
        heartbeatOnlyOutboxRecovery: true,
        trayHideRestoreAndExit: true,
        inFlightRevokeStopsNextDetail: true,
        localCredentialCookieAndProfileBoundary: true,
        noIngestUploadCall: true
      }
    }, null, 2))
  } finally {
    await Promise.allSettled([closeDesktop(desktop), userApi.close(), collectorApi.close()])
    await db.close()
    try { if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true }) } catch {}
    try { if (existsSync(userDataPath)) rmSync(userDataPath, { recursive: true, force: true }) } catch {}
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ scenario: 'phase5-electron-seller-runtime', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
