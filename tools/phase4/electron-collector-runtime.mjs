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
const databasePath = join(tmpdir(), `xianyu-phase4-desktop-cloud-${process.pid}-${Date.now()}`)
const userDataPath = mkdtempSync(join(tmpdir(), 'xianyu-phase4-desktop-'))
const password = 'p4-runtime-123456'
const email = 'phase4-runtime@example.test'
const domains = {
  user: { issuer: 'https://user.runtime.test', audience: 'user-api', secret: 'user-phase4-runtime-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.runtime.test', audience: 'admin-api', secret: 'admin-phase4-runtime-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.runtime.test', audience: 'collector-api', secret: 'collector-phase4-runtime-secret-012345678901234567890' }
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
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await locator.count() >= count) return
    await delay(100)
  }
  throw new Error(`等待日志数量 ${count} 超时`)
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

function searchFixture() {
  return `<!doctype html>
<meta charset="utf-8">
<title>闲鱼搜索夹具</title>
<body data-xianyu-selected-sort="" data-xianyu-selected-category="" data-xianyu-selected-region="" data-xianyu-selected-filter="">
  <nav data-xianyu-category-path="数码/笔记本/Apple">
    <button data-xianyu-category>数码</button><button data-xianyu-category>笔记本</button><button data-xianyu-category>Apple</button>
  </nav>
  <section>
    <button data-xianyu-sort="comprehensive">综合</button><button data-xianyu-sort="newly_reduced">新降价</button><button data-xianyu-sort="newly_published">新发布</button><button data-xianyu-sort="price_asc">价格从低到高</button><button data-xianyu-sort="price_desc">价格从高到低</button>
    <input data-xianyu-price="min" aria-label="最低价格"><input data-xianyu-price="max" aria-label="最高价格">
    <button data-xianyu-region>上海</button><button data-xianyu-filter="condition" data-xianyu-value="二手">二手</button>
  </section>
  <section id="items"></section><button data-xianyu-next>下一页</button>
  <script>
    const pages = [
      [
        ['101', 'MacBook Air 13', '¥ 100 上海 8人想要 1小时前发布'],
        ['102', 'MacBook Pro 14', '¥ 200 上海 12人想要 2小时前发布']
      ],
      [
        ['102', 'MacBook Pro 14', '¥ 200 上海 12人想要 2小时前发布'],
        ['103', 'MacBook Pro 16', '¥ 300 上海 5人想要 3小时前发布']
      ]
    ]
    let current = 0
    const render = () => {
      document.querySelector('#items').innerHTML = pages[current].map(([id, title, text]) => '<article data-xianyu-item><a href="/item?id=' + id + '"><h2 data-xianyu-title>' + title + '</h2><span data-xianyu-tag>笔记本</span><p>' + text + '</p><img data-xianyu-image src="/images/' + id + '.jpg"></a></article>').join('')
      document.querySelector('[data-xianyu-next]').disabled = current === pages.length - 1
    }
    document.querySelectorAll('[data-xianyu-category]').forEach((node) => node.addEventListener('click', () => document.body.dataset.xianyuSelectedCategory = node.textContent.trim()))
    document.querySelectorAll('[data-xianyu-sort]').forEach((node) => node.addEventListener('click', () => document.body.dataset.xianyuSelectedSort = node.dataset.xianyuSort))
    document.querySelector('[data-xianyu-region]').addEventListener('click', (event) => document.body.dataset.xianyuSelectedRegion = event.currentTarget.textContent.trim())
    document.querySelector('[data-xianyu-filter]').addEventListener('click', (event) => document.body.dataset.xianyuSelectedFilter = event.currentTarget.dataset.xianyuValue)
    document.querySelector('[data-xianyu-next]').addEventListener('click', () => { current = Math.min(current + 1, pages.length - 1); render() })
    render()
  </script>
</body>`
}

function detailFixture(itemId, changedPrice) {
  const items = {
    '101': { title: 'MacBook Air 13', price: changedPrice ? 130 : 100, want: 8 },
    '102': { title: 'MacBook Pro 14', price: 200, want: 12 },
    '103': { title: 'MacBook Pro 16', price: 300, want: 5 }
  }
  const item = items[itemId]
  if (!item) return '<!doctype html><title>商品不存在</title>'
  return `<!doctype html><meta charset="utf-8"><title>${item.title}</title><section data-xianyu-detail><h1 data-xianyu-title>${item.title}</h1><p data-xianyu-price>¥ ${item.price}</p><p data-xianyu-region>上海</p><p data-xianyu-published>1小时前发布</p><p data-xianyu-want>${item.want}人想要</p><p data-xianyu-description>公开商品详情</p><span data-xianyu-tag>笔记本</span><img data-xianyu-image src="/images/${itemId}.jpg"></section>`
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
      XIANYU_MONITOR_USER_DATA: userDataPath,
      XIANYU_SCHEDULER_INTERVAL_MS: '250',
      XIANYU_TASK_SYNC_INTERVAL_MS: '250'
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
  let fixtureMode = 'normal'
  let changedPrice = false
  let delayDetails = false
  let delayedDetailRequests = 0
  let resolveFirstDelayedDetail
  const firstDelayedDetail = new Promise((resolve) => { resolveFirstDelayedDetail = resolve })
  userApi.get('/browser-login', async (_request, reply) => reply.type('text/html').send('<!doctype html><title>Chrome local login</title>'))
  userApi.get('/search', async (request, reply) => {
    const keyword = String(request.query?.q ?? '')
    if (keyword === 'network') {
      reply.hijack()
      request.raw.destroy()
      return
    }
    const mode = ['login', 'access', 'structure'].includes(keyword) ? keyword : fixtureMode
    if (mode === 'login') return reply.type('text/html').send('<!doctype html><meta charset="utf-8"><title>登录</title><p>请登录后查看</p>')
    if (mode === 'access') return reply.type('text/html').send('<!doctype html><meta charset="utf-8"><title>非法访问</title><p>非法访问</p>')
    if (mode === 'structure') return reply.type('text/html').send('<!doctype html><meta charset="utf-8"><title>空页面</title><p>页面加载完成</p>')
    return reply.type('text/html').send(searchFixture())
  })
  userApi.get('/item', async (request, reply) => {
    if (delayDetails) {
      delayedDetailRequests += 1
      if (delayedDetailRequests === 1) resolveFirstDelayedDetail()
      await delay(800)
    }
    return reply.type('text/html').send(detailFixture(String(request.query?.id ?? ''), changedPrice))
  })
  const migrations = await applyMigrations(db)
  let desktop

  try {
    const registered = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password } })
    assert(registered.statusCode === 200, `运行测试账号创建失败：${registered.statusCode} ${registered.body}`)
    const userAccess = json(registered).accessToken
    const userId = String((await db.query("SELECT id FROM identity.users WHERE email_normalized='phase4-runtime@example.test'")).rows[0].id)
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at)
      VALUES ($1,$2,'collector',1,now(),'phase4-runtime',now())`, [randomUUID(), userId])

    const createTask = await userApi.inject({
      method: 'POST', url: '/v1/monitors', headers: auth(userAccess), payload: {
        rule: {
          keyword: 'MacBook', categoryPath: ['数码', '笔记本', 'Apple'], sort: 'newly_published', minPrice: 50, maxPrice: 500,
          region: '上海', filters: { condition: '二手' }, includeWords: ['MacBook'], excludeWords: ['故障'], pageLimit: 2
        },
        intervalSeconds: 1800
      }
    })
    assert(createTask.statusCode === 200, `监控任务创建失败：${createTask.statusCode} ${createTask.body}`)
    const taskId = json(createTask).id
    const patchTask = async (patch) => {
      const response = await userApi.inject({ method: 'PATCH', url: `/v1/monitors/${taskId}`, headers: auth(userAccess), payload: patch })
      assert(response.statusCode === 200, `监控任务更新失败：${response.statusCode} ${response.body}`)
    }

    const userApiUrl = await userApi.listen({ host: '127.0.0.1', port: 0 })
    const collectorApiUrl = await collectorApi.listen({ host: '127.0.0.1', port: 0 })
    desktop = await launchDesktop(userApiUrl, collectorApiUrl)
    await desktop.page.getByLabel('账号').fill(email)
    await desktop.page.getByLabel('密码').fill(password)
    await desktop.page.getByRole('button', { name: '登录并绑定' }).click()
    await waitForText(desktop.page, '设备已绑定，等待启动采集')
    await desktop.page.getByRole('button', { name: '打开 Chrome' }).click()
    await waitForText(desktop.page, 'Chrome 已打开')
    assert(existsSync(join(userDataPath, 'xianyu-chrome-profile')), '系统 Chrome 未创建本机专用 Profile')

    const runLog = desktop.page.getByText('“MacBook”采集完成', { exact: false })
    await desktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForCount(runLog, 1)
    await desktop.page.getByRole('button', { name: '暂停采集' }).click()
    await waitForText(desktop.page, '采集器已暂停')

    await patchTask({ status: 'active' })
    await desktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForCount(runLog, 2)
    await desktop.page.getByRole('button', { name: '暂停采集' }).click()
    await waitForText(desktop.page, '采集器已暂停')

    changedPrice = true
    await patchTask({ status: 'active' })
    await desktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForCount(runLog, 3)
    await desktop.page.getByRole('button', { name: '暂停采集' }).click()

    fixtureMode = 'normal'
    await patchTask({ rule: { keyword: 'login', categoryPath: ['数码', '笔记本', 'Apple'], sort: 'newly_published', minPrice: 50, maxPrice: 500, region: '上海', filters: { condition: '二手' }, includeWords: ['MacBook'], excludeWords: ['故障'], pageLimit: 2 } })
    await desktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForText(desktop.page, '闲鱼登录状态已失效，采集已暂停')

    await patchTask({ rule: { keyword: 'access', categoryPath: ['数码', '笔记本', 'Apple'], sort: 'newly_published', minPrice: 50, maxPrice: 500, region: '上海', filters: { condition: '二手' }, includeWords: ['MacBook'], excludeWords: ['故障'], pageLimit: 2 } })
    await desktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForText(desktop.page, '闲鱼页面拒绝访问，采集已暂停')

    await patchTask({ rule: { keyword: 'structure', categoryPath: ['数码', '笔记本', 'Apple'], sort: 'newly_published', minPrice: 50, maxPrice: 500, region: '上海', filters: { condition: '二手' }, includeWords: ['MacBook'], excludeWords: ['故障'], pageLimit: 2 } })
    await desktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForText(desktop.page, '闲鱼页面结构异常，采集已暂停')

    fixtureMode = 'normal'
    await patchTask({ rule: { keyword: 'network', categoryPath: ['数码', '笔记本', 'Apple'], sort: 'newly_published', minPrice: 50, maxPrice: 500, region: '上海', filters: { condition: '二手' }, includeWords: ['MacBook'], excludeWords: ['故障'], pageLimit: 2 } })
    await desktop.page.getByRole('button', { name: '启动采集' }).click()
    await waitForText(desktop.page, '闲鱼页面网络不可用，采集已暂停')

    delayDetails = true
    await patchTask({ rule: { keyword: 'revoke', categoryPath: ['数码', '笔记本', 'Apple'], sort: 'newly_published', minPrice: 50, maxPrice: 500, region: '上海', filters: { condition: '二手' }, includeWords: ['MacBook'], excludeWords: ['故障'], pageLimit: 2 } })
    const clientId = String((await db.query('SELECT id FROM identity.collector_clients WHERE user_id=$1 AND status=\'active\'', [userId])).rows[0].id)
    await desktop.page.getByRole('button', { name: '启动采集' }).click()
    await Promise.race([firstDelayedDetail, delay(20_000).then(() => { throw new Error('等待在途详情请求超时') })])
    const revoked = await userApi.inject({ method: 'POST', url: `/v1/collector-devices/${clientId}/revoke`, headers: auth(userAccess) })
    assert(revoked.statusCode === 200, `在途解绑失败：${revoked.statusCode} ${revoked.body}`)
    await waitForText(desktop.page, '本机设备授权已失效，采集已停止')
    await delay(250)
    assert(delayedDetailRequests === 1, `设备解绑后仍继续打开详情：${delayedDetailRequests}`)

    const exited = await closeDesktop(desktop)
    desktop = undefined
    assert(exited, '退出程序后 Electron 主进程没有结束')
    const localDatabasePath = join(userDataPath, 'monitor-data', 'launcher.db')
    const localBytes = readFileSync(localDatabasePath)
    assert(!localBytes.includes(Buffer.from(password)), '本系统密码写入了 SQLite')
    const localDatabase = new DatabaseSync(localDatabasePath)
    try {
      const itemTotal = Number(localDatabase.prepare('SELECT COUNT(*) AS total FROM local_items').get().total)
      const versionTotal = Number(localDatabase.prepare('SELECT COUNT(*) AS total FROM local_item_versions').get().total)
      const matchTotal = Number(localDatabase.prepare('SELECT COUNT(*) AS total FROM local_task_item_matches').get().total)
      const categoryTotal = Number(localDatabase.prepare('SELECT COUNT(*) AS total FROM local_categories').get().total)
      const outboxKinds = localDatabase.prepare('SELECT DISTINCT kind FROM outbox').all().map((row) => String(row.kind))
      const messages = localDatabase.prepare('SELECT message FROM launcher_logs').all().map((row) => String(row.message)).join('\n')
      assert(itemTotal === 3, `多页商品去重错误：${itemTotal}`)
      assert(versionTotal === 4, `本地版本去重或价格版本错误：${versionTotal}`)
      assert(matchTotal === 3, `任务商品命中关系错误：${matchTotal}`)
      assert(categoryTotal === 3, `三级类目解析错误：${categoryTotal}`)
      assert(outboxKinds.every((kind) => kind === 'heartbeat'), 'Outbox 出现了非 heartbeat 类型')
      assert(!messages.includes(password), '本系统密码写入了动态日志')
      assert(!/authorization|cookie|token/i.test(messages), '敏感认证信息写入了动态日志')
    } finally {
      localDatabase.close()
    }

    console.log(JSON.stringify({
      scenario: 'phase4-electron-collector-runtime', migrations,
      assertions: {
        actualElectronWindow: true,
        systemChromePersistentProfile: true,
        taskSnapshotSync: true,
        multiPageSearchAndDetailParsing: true,
        categorySortPriceRegionAndPublicFilters: true,
        localBaselineAndVersionDeduplication: true,
        loginAccessStructureAndNetworkErrors: true,
        inFlightRevokeStopsScan: true,
        heartbeatOnlyOutbox: true,
        localCredentialBoundary: true
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
  console.error(JSON.stringify({ scenario: 'phase4-electron-collector-runtime', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
