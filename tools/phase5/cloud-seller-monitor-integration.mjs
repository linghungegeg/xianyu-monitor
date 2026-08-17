import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCollectorApi, createUserApi } from '../../services/cloud/src/api.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase5-cloud-${process.pid}-${Date.now()}`)
const domains = {
  user: { issuer: 'https://user.phase5.test', audience: 'user-api', secret: 'user-phase5-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.phase5.test', audience: 'admin-api', secret: 'admin-phase5-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.phase5.test', audience: 'collector-api', secret: 'collector-phase5-secret-012345678901234567890' }
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

async function applyMigrations(db) {
  const migrations = readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql')).sort()
  for (let pass = 0; pass < 2; pass += 1) {
    for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  }
  return migrations
}

async function registerUser(userApi, email) {
  const response = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'phase5-seller-password-123' } })
  assert(response.statusCode === 200, `用户注册失败：${response.statusCode} ${response.body}`)
  return json(response).accessToken
}

async function findUserId(db, email) {
  return String((await db.query('SELECT id FROM identity.users WHERE email_normalized=$1', [email])).rows[0].id)
}

async function grantCollector(db, userId, limit = 20) {
  await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at)
    VALUES ($1,$2,'collector',$3,now(),'phase5-test',now())`, [randomUUID(), userId, limit])
}

function publicKey(pair) {
  return pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

function deviceProof(userId, privateKey) {
  return sign(null, Buffer.from(userId), privateKey).toString('base64')
}

async function bindCollector(collectorApi, userAccess, userId) {
  const pair = generateKeyPairSync('ed25519')
  const response = await collectorApi.inject({
    method: 'POST',
    url: '/v1/devices/bind',
    headers: auth(userAccess),
    payload: { publicKey: publicKey(pair), proof: deviceProof(userId, pair.privateKey), deviceName: 'phase5-seller-device' }
  })
  assert(response.statusCode === 200, `设备绑定失败：${response.statusCode} ${response.body}`)
  return json(response)
}

async function createSellerTask(userApi, token, payload) {
  const response = await userApi.inject({ method: 'POST', url: '/v1/seller-monitors', headers: auth(token), payload: { intervalSeconds: 600, ...payload } })
  assert(response.statusCode === 200, `卖家任务创建失败：${response.statusCode} ${response.body}`)
  return json(response)
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains, { allowedOrigins: ['http://localhost:5174'] })
  const collectorApi = createCollectorApi(sql, domains)
  const migrations = await applyMigrations(db)

  try {
    const userAEmail = 'phase5-seller-a@example.test'
    const userBEmail = 'phase5-seller-b@example.test'
    const userAAccess = await registerUser(userApi, userAEmail)
    const userBAccess = await registerUser(userApi, userBEmail)
    const userAId = await findUserId(db, userAEmail)
    const userBId = await findUserId(db, userBEmail)
    await grantCollector(db, userAId)

    const invalidUnknownField = await userApi.inject({
      method: 'POST',
      url: '/v1/seller-monitors',
      headers: auth(userAAccess),
      payload: { platformSellerId: 'seller-invalid', profileUrl: 'https://www.goofish.com/personal?userId=seller-invalid', cookie: 'forbidden', intervalSeconds: 600 }
    })
    assert(invalidUnknownField.statusCode === 400, '卖家任务白名单未拒绝敏感未知字段')
    const invalidUrl = await userApi.inject({ method: 'POST', url: '/v1/seller-monitors', headers: auth(userAAccess), payload: { profileUrl: 'not-a-url', intervalSeconds: 600 } })
    assert(invalidUrl.statusCode === 400, '无效公开主页地址未被拒绝')
    const invalidHost = await userApi.inject({ method: 'POST', url: '/v1/seller-monitors', headers: auth(userAAccess), payload: { profileUrl: 'https://evil.example/personal?userId=evil', intervalSeconds: 600 } })
    assert(invalidHost.statusCode === 400, '非闲鱼域名公开主页未被拒绝')
    const invalidProfileId = await userApi.inject({ method: 'POST', url: '/v1/seller-monitors', headers: auth(userAAccess), payload: { profileUrl: 'https://www.goofish.com/personal?foo=bar', intervalSeconds: 600 } })
    assert(invalidProfileId.statusCode === 400, '无法提取卖家 ID 的主页未被拒绝')
    const missingInterval = await userApi.inject({ method: 'POST', url: '/v1/seller-monitors', headers: auth(userAAccess), payload: { platformSellerId: 'seller-no-interval' } })
    assert(missingInterval.statusCode === 400, '缺少采集间隔的卖家任务未被拒绝')

    const firstTask = await createSellerTask(userApi, userAAccess, { platformSellerId: 'seller-id-only' })
    const urlOnlyTask = await createSellerTask(userApi, userAAccess, { profileUrl: 'https://www.goofish.com/personal?userId=seller-url-only' })
    const bothTask = await createSellerTask(userApi, userAAccess, { platformSellerId: 'seller-both', profileUrl: 'https://www.goofish.com/personal?userId=seller-both' })
    const sanitizedTask = await createSellerTask(userApi, userAAccess, { profileUrl: 'https://www.goofish.com/personal?userId=seller-sanitized&token=local-only&cookie=local-only#fragment', status: 'paused' })
    assert(firstTask.profileUrl.includes('userId=seller-id-only'), '仅 ID 创建未生成公开主页地址')
    assert(urlOnlyTask.platformSellerId === 'seller-url-only', '仅主页创建未提取稳定卖家 ID')
    assert(sanitizedTask.profileUrl === 'https://www.goofish.com/personal?userId=seller-sanitized', '公开主页地址未清除敏感 query/hash')
    const mismatchedProfile = await userApi.inject({ method: 'PATCH', url: `/v1/seller-monitors/${firstTask.id}`, headers: auth(userAAccess), payload: { profileUrl: 'https://www.goofish.com/personal?userId=other-seller' } })
    assert(mismatchedProfile.statusCode === 400, '更新时错配卖家主页未被拒绝')
    const duplicate = await userApi.inject({ method: 'POST', url: '/v1/seller-monitors', headers: auth(userAAccess), payload: { platformSellerId: 'seller-id-only', profileUrl: firstTask.profileUrl, intervalSeconds: 600 } })
    assert(duplicate.statusCode === 409, '同一用户重复关注卖家未被唯一约束拒绝')

    const capTasks = []
    for (let index = 0; index < 2; index += 1) capTasks.push(await createSellerTask(userApi, userAAccess, { platformSellerId: `seller-cap-${index}` }))
    const activeOverflow = await userApi.inject({ method: 'POST', url: '/v1/seller-monitors', headers: auth(userAAccess), payload: { platformSellerId: 'seller-active-overflow', intervalSeconds: 600 } })
    assert(activeOverflow.statusCode === 403, '第 6 个活动竞品商家未被 5 个槽位限制')
    const pausedOverflow = await createSellerTask(userApi, userAAccess, { platformSellerId: 'seller-paused-overflow', status: 'paused' })
    assert(pausedOverflow.status === 'paused', '活动槽位满时暂停任务不能保存')
    const resumedOverflow = await userApi.inject({ method: 'PATCH', url: `/v1/seller-monitors/${pausedOverflow.id}`, headers: auth(userAAccess), payload: { status: 'active' } })
    assert(resumedOverflow.statusCode === 403, '活动槽位满时暂停任务可以绕过上限启用')

    const pageTaskIds = [firstTask.id, urlOnlyTask.id, bothTask.id, sanitizedTask.id, ...capTasks.map((task) => task.id), pausedOverflow.id]
    for (let index = 0; index < 20; index += 1) {
      const task = await createSellerTask(userApi, userAAccess, { platformSellerId: `seller-page-${index}`, status: 'paused' })
      pageTaskIds.push(task.id)
    }
    const firstPageResponse = await userApi.inject({ method: 'GET', url: '/v1/seller-monitors?limit=20&sort=created_at&order=asc', headers: auth(userAAccess) })
    assert(firstPageResponse.statusCode === 200, `卖家任务第一页失败：${firstPageResponse.statusCode} ${firstPageResponse.body}`)
    const firstPage = json(firstPageResponse)
    assert(firstPage.items.length === 20 && firstPage.page.total === pageTaskIds.length, '卖家任务第一页或 total 错误')
    assert(firstPage.page.hasMore && typeof firstPage.page.nextCursor === 'string', '卖家任务第一页缺少游标')
    const secondPageResponse = await userApi.inject({ method: 'GET', url: `/v1/seller-monitors?limit=20&sort=created_at&order=asc&cursor=${encodeURIComponent(firstPage.page.nextCursor)}`, headers: auth(userAAccess) })
    assert(secondPageResponse.statusCode === 200, `卖家任务第二页失败：${secondPageResponse.statusCode} ${secondPageResponse.body}`)
    const secondPage = json(secondPageResponse)
    const firstIds = new Set(firstPage.items.map((item) => item.id))
    assert(secondPage.items.length === pageTaskIds.length - 20 && secondPage.page.total === pageTaskIds.length && secondPage.items.every((item) => !firstIds.has(item.id)), '卖家任务游标分页重复或 total 错误')
    const userBList = await userApi.inject({ method: 'GET', url: '/v1/seller-monitors?limit=20', headers: auth(userBAccess) })
    assert(userBList.statusCode === 200 && json(userBList).page.total === 0, '其他用户看到卖家任务')
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await userApi.inject({ method, url: `/v1/seller-monitors/${firstTask.id}`, headers: auth(userBAccess), payload: method === 'PATCH' ? { status: 'paused' } : undefined })
      assert(response.statusCode === 404, `其他用户可${method}卖家任务：${response.statusCode}`)
    }

    const searchTask = await userApi.inject({ method: 'POST', url: '/v1/monitors', headers: auth(userAAccess), payload: { rule: { keyword: 'phase5-search', pageLimit: 1 }, intervalSeconds: 600, status: 'paused' } })
    assert(searchTask.statusCode === 200, `搜索任务夹具创建失败：${searchTask.statusCode} ${searchTask.body}`)
    const collectorSession = await bindCollector(collectorApi, userAAccess, userAId)
    const taskSnapshot = await collectorApi.inject({ method: 'GET', url: '/v1/tasks', headers: auth(collectorSession.accessToken) })
    assert(taskSnapshot.statusCode === 200, `Collector 任务快照失败：${taskSnapshot.statusCode} ${taskSnapshot.body}`)
    const snapshot = json(taskSnapshot)
    assert(snapshot.items.some((item) => item.kind === 'search') && snapshot.items.some((item) => item.kind === 'seller' && item.platformSellerId === firstTask.platformSellerId), 'Collector 快照未同时下发 search 和 seller kind')
    assert(snapshot.sellerTaskLimit === 5, 'Collector 快照缺少卖家任务上限')

    const sellerId = firstTask.sellerId
    const itemIds = []
    for (let index = 0; index < 22; index += 1) {
      const itemId = randomUUID()
      itemIds.push(itemId)
      await db.query(`INSERT INTO market.items (id,platform,platform_item_id,seller_id,lifecycle_state,first_seen_at,last_seen_at)
        VALUES ($1,'goofish',$2,$3,'active',now() - ($4::int * interval '1 second'),now() - ($4::int * interval '1 second'))`, [itemId, `phase5-item-${index}`, sellerId, index])
    }
    await db.query(`INSERT INTO market.item_versions (id,item_id,title,price,region,condition_text,want_count,canonical_payload,content_hash,observed_at)
      VALUES ($1,$2,'phase5 seller item',123.45,'上海','95新',7,'{}'::jsonb,'phase5-seller-item-version',now())`, [randomUUID(), itemIds[0]])
    const userARunId = randomUUID()
    await db.query(`INSERT INTO ops.collection_runs (id,client_id,client_run_id,task_reference,kind,status,started_at,finished_at,result_counts)
      VALUES ($1,$2,$3,$4,'seller','completed',now(),now(),'{}'::jsonb)`, [userARunId, collectorSession.clientId, `phase5-user-a-${userARunId}`, firstTask.id])
    for (let index = 0; index < 21; index += 1) {
      await db.query(`INSERT INTO market.observations (id,collected_at,received_at,collection_run_id,item_id,platform_item_id,payload_hash)
        VALUES ($1,now(),now(),$2,$3,$4,$5)`, [randomUUID(), userARunId, itemIds[index], `phase5-item-${index}`, `phase5-user-a-payload-${index}`])
    }
    await db.query(`INSERT INTO market.item_events (id,occurred_at,detected_at,item_id,seller_id,event_type,event_key)
      VALUES ($1,now(),now(),$2,$3,'price_changed','phase5-price-event'),($4,now(),now(),$5,$3,'state_changed','phase5-state-event')`, [randomUUID(), itemIds[0], sellerId, randomUUID(), itemIds[1]])
    const itemPageResponse = await userApi.inject({ method: 'GET', url: `/v1/seller-monitors/${firstTask.id}/items?limit=20&sort=last_seen_at&order=desc`, headers: auth(userAAccess) })
    assert(itemPageResponse.statusCode === 200, `卖家商品分页失败：${itemPageResponse.statusCode} ${itemPageResponse.body}`)
    const itemPage = json(itemPageResponse)
    assert(itemPage.items.length === 20 && itemPage.page.total === 21 && itemPage.page.hasMore && itemPage.page.nextCursor, '卖家商品分页合同错误')
    const detailedItem = itemPage.items.find((item) => item.platformItemId === 'phase5-item-0')
    assert(detailedItem?.title === 'phase5 seller item' && String(detailedItem.price) === '123.45' && detailedItem.region === '上海' && detailedItem.conditionText === '95新' && detailedItem.wantCount === 7, '卖家商品详情未返回最新公开版本字段')
    assert(detailedItem?.sellerId === sellerId && detailedItem.platformSellerId === firstTask.platformSellerId, '卖家商品详情缺少稳定卖家引用')
    const marketItemResponse = await userApi.inject({ method: 'GET', url: '/v1/market/items?limit=20&q=phase5-item-0', headers: auth(userAAccess) })
    assert(marketItemResponse.statusCode === 200, `市场商品读取失败：${marketItemResponse.statusCode} ${marketItemResponse.body}`)
    const marketItem = json(marketItemResponse).items.find((item) => item.platformItemId === 'phase5-item-0')
    assert(marketItem?.sellerId === sellerId && marketItem.platformSellerId === firstTask.platformSellerId, '市场商品详情缺少可添加卖家的稳定引用')
    const eventPageResponse = await userApi.inject({ method: 'GET', url: `/v1/seller-monitors/${firstTask.id}/events?limit=20&eventType=price_changed`, headers: auth(userAAccess) })
    assert(eventPageResponse.statusCode === 200, `卖家事件分页失败：${eventPageResponse.statusCode} ${eventPageResponse.body}`)
    const eventPage = json(eventPageResponse)
    assert(eventPage.page.total === 1 && eventPage.items[0].eventType === 'price_changed', '卖家事件过滤未绑定任务卖家')

    await grantCollector(db, userBId)
    const collectorBSession = await bindCollector(collectorApi, userBAccess, userBId)
    const userBTask = await createSellerTask(userApi, userBAccess, { platformSellerId: firstTask.platformSellerId, status: 'paused' })
    const userBRunId = randomUUID()
    await db.query(`INSERT INTO ops.collection_runs (id,client_id,client_run_id,task_reference,kind,status,started_at,finished_at,result_counts)
      VALUES ($1,$2,$3,$4,'seller','completed',now(),now(),'{}'::jsonb)`, [userBRunId, collectorBSession.clientId, `phase5-user-b-${userBRunId}`, userBTask.id])
    await db.query(`INSERT INTO market.observations (id,collected_at,received_at,collection_run_id,item_id,platform_item_id,payload_hash)
      VALUES ($1,now(),now(),$2,$3,$4,$5)`, [randomUUID(), userBRunId, itemIds[21], 'phase5-item-21', 'phase5-user-b-payload'])
    await db.query(`INSERT INTO market.item_events (id,occurred_at,detected_at,item_id,seller_id,event_type,event_key)
      VALUES ($1,now(),now(),$2,$3,'price_changed','phase5-user-b-price-event')`, [randomUUID(), itemIds[21], sellerId])
    const userAItemIsolation = await userApi.inject({ method: 'GET', url: `/v1/seller-monitors/${firstTask.id}/items?limit=20&q=phase5-item-21`, headers: auth(userAAccess) })
    assert(userAItemIsolation.statusCode === 200 && json(userAItemIsolation).page.total === 0, '卖家商品将其他用户采集结果泄露给当前用户')
    const userBItemVisibility = await userApi.inject({ method: 'GET', url: `/v1/seller-monitors/${userBTask.id}/items?limit=20&q=phase5-item-21`, headers: auth(userBAccess) })
    assert(userBItemVisibility.statusCode === 200 && json(userBItemVisibility).page.total === 1 && json(userBItemVisibility).items[0].platformItemId === 'phase5-item-21', '当前用户自己的卖家商品被错误过滤')
    const userAEventIsolation = await userApi.inject({ method: 'GET', url: `/v1/seller-monitors/${firstTask.id}/events?limit=20&eventType=price_changed`, headers: auth(userAAccess) })
    assert(userAEventIsolation.statusCode === 200 && json(userAEventIsolation).page.total === 1, '卖家事件将其他用户采集结果泄露给当前用户')
    const userBEventVisibility = await userApi.inject({ method: 'GET', url: `/v1/seller-monitors/${userBTask.id}/events?limit=20&eventType=price_changed`, headers: auth(userBAccess) })
    assert(userBEventVisibility.statusCode === 200 && json(userBEventVisibility).page.total === 1 && json(userBEventVisibility).items[0].eventKey === 'phase5-user-b-price-event', '当前用户自己的卖家事件被错误过滤')
    const profile = await userApi.inject({ method: 'GET', url: `/v1/seller-monitors/${firstTask.id}/profile`, headers: auth(userAAccess) })
    assert(profile.statusCode === 200 && profile.body.includes(firstTask.platformSellerId), '卖家公开资料详情读取失败')

    const ingest = await collectorApi.inject({ method: 'POST', url: '/v1/ingest', headers: auth(collectorSession.accessToken), payload: {} })
    assert(ingest.statusCode === 400, '阶段 6 ingest 路由应拒绝缺少 schema 的旧请求')
    const unbound = await collectorApi.inject({ method: 'POST', url: '/v1/devices/unbind', headers: auth(collectorSession.accessToken) })
    assert(unbound.statusCode === 200, '卖家测试设备解绑失败')
    const afterUnbind = await collectorApi.inject({ method: 'GET', url: '/v1/tasks', headers: auth(collectorSession.accessToken) })
    assert(afterUnbind.statusCode === 403, '解绑后 Collector 仍可领取卖家任务')

    console.log(JSON.stringify({
      scenario: 'phase5-cloud-seller-monitors',
      migrations,
      assertions: {
        migrationAppliedTwice: true,
        sellerTargetEitherIdOrUrl: true,
        sellerTaskOwnership: true,
        sellerTaskFiveActiveSlotGate: true,
        sellerTaskCursorPagination: true,
        collectorSearchAndSellerKinds: true,
        sellerItemsAndEventsReadPagination: true,
        sellerItemLatestPublicDetail: true,
        marketItemSellerReference: true,
        sellerItemOwnership: true,
        sellerEventOwnership: true,
        sellerProfileHostAllowlist: true,
        sellerProfileQuerySanitized: true,
        sellerTaskInputValidation: true,
        sellerProfileRead: true,
        ingestRouteAbsent: true,
        unbindStopsSellerTaskPull: true
      }
    }, null, 2))
  } finally {
    await Promise.allSettled([userApi.close(), collectorApi.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ scenario: 'phase5-cloud-seller-monitors', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
