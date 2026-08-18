import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUserApi } from '../../services/cloud/src/api.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase1-supply-${process.pid}-${Date.now()}`)
const domains = {
  user: { issuer: 'https://user.phase1.test', audience: 'user-api', secret: 'user-phase1-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.phase1.test', audience: 'admin-api', secret: 'admin-phase1-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.phase1.test', audience: 'collector-api', secret: 'collector-phase1-secret-012345678901234567890' }
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
  const response = await api.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password: 'phase1-material-123' } })
  assert(response.statusCode === 200, `注册失败: ${response.body}`)
  return json(response).accessToken
}

const pddSnapshot = {
  store: { initDataObj: { goods: {
    goodsID: '1001001', goodsName: 'PDD 已解析商品', minOnSaleGroupPrice: 1299,
    topGallery: ['https://images.example.test/pdd-cover.jpg'], detailGallery: ['https://images.example.test/pdd-detail.jpg'],
    skus: [{ skuId: 'pdd-sku-1', groupPrice: 1299, quantity: 10 }]
  } } }
}
const taobaoSnapshot = {
  data: { itemInfo: { itemId: '2002002', title: '淘宝已解析商品', price: '39.50', images: ['https://images.example.test/tb-cover.jpg'] }, skuCore: { sku2info: {} } }
}
const normalizedSnapshot = {
  sourcePlatform: '1688', sourceItemId: '3003003', sourceUrl: 'https://detail.1688.com/offer/3003003.html?token=discard-me',
  title: '通用已解析商品', price: 55, mainImages: ['https://images.example.test/1688-cover.jpg'], detailImages: [], sku: [{ name: '默认', price: 55 }], attrs: { brand: '测试' }
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const api = createUserApi(sql, domains)
  const migrations = await applyMigrations(db)
  try {
    const userA = await register(api, 'phase1-a@example.test')
    const userB = await register(api, 'phase1-b@example.test')
    const payload = { schemaVersion: 1, sourceType: 'general', sourceFormat: 'parsed_snapshot_json', idempotencyKey: 'phase1-import-a', snapshots: [pddSnapshot, taobaoSnapshot, normalizedSnapshot] }
    const first = await api.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userA), payload })
    assert(first.statusCode === 200 && json(first).insertedCount === 3 && json(first).deduplicatedCount === 0, `首次导入失败: ${first.body}`)
    const repeat = await api.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userA), payload })
    assert(repeat.statusCode === 200 && json(repeat).duplicate === true && json(repeat).insertedCount === 3, `批次幂等失败: ${repeat.body}`)
    const reimport = await api.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userA), payload: { ...payload, idempotencyKey: 'phase1-import-a-repeat' } })
    assert(reimport.statusCode === 200 && json(reimport).insertedCount === 0 && json(reimport).deduplicatedCount === 3, `版本去重失败: ${reimport.body}`)
    const changed = structuredClone(pddSnapshot)
    changed.store.initDataObj.goods.minOnSaleGroupPrice = 1599
    const changedImport = await api.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userA), payload: { ...payload, idempotencyKey: 'phase1-import-a-changed', snapshots: [changed] } })
    assert(changedImport.statusCode === 200 && json(changedImport).insertedCount === 1, `同商品新版本失败: ${changedImport.body}`)
    const versionCount = await db.query(`SELECT COUNT(*)::int AS total FROM supply.material_versions v JOIN supply.materials m ON m.id=v.material_id WHERE m.source_platform='pdd' AND m.source_item_id='1001001'`)
    assert(Number(versionCount.rows[0].total) === 2, '商品新版本未保留')
    const listA = await api.inject({ method: 'GET', url: '/v1/supply/materials?limit=20&source_platform=1688&sort=updated_at&order=desc', headers: auth(userA) })
    assert(listA.statusCode === 200 && json(listA).items.length === 1 && !listA.body.includes('discard-me'), `素材分页或凭据查询参数剥离失败: ${listA.body}`)
    const importB = await api.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userB), payload: { ...payload, idempotencyKey: 'phase1-import-b' } })
    const listB = await api.inject({ method: 'GET', url: '/v1/supply/materials?limit=20', headers: auth(userB) })
    assert(importB.statusCode === 200 && json(importB).insertedCount === 3 && listB.statusCode === 200 && json(listB).page.total === 3, `用户素材隔离或跨用户同源导入失败: ${importB.body} ${listB.body}`)
    const partial = await api.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userA), payload: { ...payload, idempotencyKey: 'phase1-partial', snapshots: [normalizedSnapshot, { sourcePlatform: '1688', sourceItemId: 'missing-title', sourceUrl: 'https://detail.1688.com/offer/missing-title.html', price: 1, mainImages: ['https://images.example.test/missing.jpg'] }] } })
    assert(partial.statusCode === 200 && json(partial).insertedCount === 0 && json(partial).deduplicatedCount === 1 && json(partial).failedCount === 1 && json(partial).rejections[0]?.recordIndex === 1, `部分失败批次未记录行号: ${partial.body}`)
    const rejectionCount = await db.query('SELECT COUNT(*)::int AS total FROM supply.import_rejections WHERE batch_id=$1', [json(partial).batchId])
    assert(Number(rejectionCount.rows[0].total) === 1, '部分失败未写入批次拒绝明细')
    const bulkSnapshots = Array.from({ length: 100 }, (_, index) => ({
      sourcePlatform: '1688',
      sourceItemId: `bulk-${String(index).padStart(3, '0')}`,
      sourceUrl: `https://detail.1688.com/offer/bulk-${String(index).padStart(3, '0')}.html`,
      title: `批量素材 ${index}`,
      price: index + 1,
      mainImages: [`https://images.example.test/bulk-${index}.jpg`]
    }))
    const bulk = await api.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userA), payload: { ...payload, idempotencyKey: 'phase1-bulk-100', snapshots: bulkSnapshots } })
    assert(bulk.statusCode === 200 && json(bulk).insertedCount === 100 && json(bulk).failedCount === 0, `100 条批量导入失败: ${bulk.body}`)
    const firstBulkPage = await api.inject({ method: 'GET', url: '/v1/supply/materials?limit=50&source_platform=1688&sort=title&order=asc', headers: auth(userA) })
    const nextCursor = json(firstBulkPage).page?.nextCursor
    const secondBulkPage = await api.inject({ method: 'GET', url: `/v1/supply/materials?limit=50&source_platform=1688&sort=title&order=asc&cursor=${encodeURIComponent(nextCursor)}`, headers: auth(userA) })
    assert(firstBulkPage.statusCode === 200 && secondBulkPage.statusCode === 200 && json(firstBulkPage).items.length === 50 && json(secondBulkPage).items.length === 50 && json(firstBulkPage).items.every((item) => !json(secondBulkPage).items.some((nextItem) => nextItem.id === item.id)), '100 条批量分页存在缺失或重复')
    const sensitive = await api.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userA), payload: { ...payload, idempotencyKey: 'phase1-sensitive', snapshots: [{ ...normalizedSnapshot, cookie: 'local-only' }] } })
    assert(sensitive.statusCode === 200 && json(sensitive).failedCount === 1 && !sensitive.body.includes('local-only'), `敏感字段未拒绝或泄露: ${sensitive.body}`)
    const textImport = await api.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userA), payload: { schemaVersion: 1, sourceType: 'general', sourceFormat: 'link_text', idempotencyKey: 'phase1-links', snapshots: ['https://item.taobao.com/item.htm?id=1'] } })
    assert(textImport.statusCode === 400 && textImport.body.includes('不接受链接文本'), `链接文本未拒绝: ${textImport.body}`)
    const rawLinkText = await api.inject({ method: 'POST', url: '/v1/supply/imports', headers: auth(userA), payload: 'https://item.taobao.com/item.htm?id=1' })
    assert(rawLinkText.statusCode >= 400 && rawLinkText.statusCode < 500, `原始链接文本未拒绝: ${rawLinkText.body}`)
    const privateRows = await db.query("SELECT COUNT(*)::int AS total FROM supply.material_versions WHERE canonical_snapshot::text ILIKE '%local-only%'")
    assert(Number(privateRows.rows[0].total) === 0, '敏感值进入供应素材数据库')
    console.log(JSON.stringify({ scenario: 'phase1-supply-material-import', migrations, assertions: { migrationRepeatable: true, pddTaobaoAndNormalizedSnapshots: true, batchIdempotency: true, versionDeduplication: true, partialBatchRejections: true, batchImport100AndCursorPaging: true, userIsolation: true, cursorListContract: true, linkTextRejected: true, sensitiveFieldsAndUrlQuerySanitized: true } }, null, 2))
  } finally {
    await Promise.allSettled([api.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => { console.error(JSON.stringify({ scenario: 'phase1-supply-material-import', error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1 })
