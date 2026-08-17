import { DatabaseSync } from 'node:sqlite'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

const DEFAULTS = {
  items: 20_000,
  devices: 4,
  batchSize: 250,
  database: 'temp'
}

function parseArguments() {
  const options = { ...DEFAULTS }
  for (const argument of process.argv.slice(2)) {
    const [name, value] = argument.split('=', 2)
    if (!value) throw new Error(`参数格式错误: ${argument}`)
    if (name === '--items') options.items = Number(value)
    else if (name === '--devices') options.devices = Number(value)
    else if (name === '--batch-size') options.batchSize = Number(value)
    else if (name === '--database') options.database = value
    else throw new Error(`未知参数: ${name}`)
  }
  if (!Number.isInteger(options.items) || options.items < 2) throw new Error('--items 必须是大于等于 2 的整数')
  if (!Number.isInteger(options.devices) || options.devices < 1) throw new Error('--devices 必须是正整数')
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) throw new Error('--batch-size 必须是正整数')
  if (!['memory', 'temp'].includes(options.database)) throw new Error('--database 只能是 memory 或 temp')
  return options
}

function elapsedMs(startedAt) {
  return Number((performance.now() - startedAt).toFixed(2))
}

function throughput(count, durationMs) {
  return durationMs === 0 ? null : Number((count / (durationMs / 1_000)).toFixed(2))
}

function assert(condition, message) {
  if (!condition) throw new Error(`校验失败: ${message}`)
}

function createDatabase(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE ingest_receipts (
      device_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      PRIMARY KEY (device_id, idempotency_key)
    );
    CREATE TABLE market_items (
      item_id TEXT PRIMARY KEY,
      current_price INTEGER NOT NULL,
      updated_seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE item_versions (
      item_id TEXT NOT NULL,
      version_fingerprint TEXT NOT NULL,
      price INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, version_fingerprint),
      FOREIGN KEY (item_id) REFERENCES market_items(item_id)
    );
    CREATE TABLE market_events (
      item_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, event_key),
      FOREIGN KEY (item_id) REFERENCES market_items(item_id)
    );
    CREATE INDEX idx_market_items_cursor ON market_items(updated_seq DESC, item_id DESC);
    CREATE INDEX idx_item_versions_item ON item_versions(item_id, observed_at DESC);
    CREATE INDEX idx_market_events_item ON market_events(item_id, created_at DESC);
  `)
  return db
}

function prepareStatements(db) {
  return {
    receipt: db.prepare(`
      INSERT OR IGNORE INTO ingest_receipts (device_id, idempotency_key, received_at)
      VALUES (?, ?, ?)
    `),
    item: db.prepare(`
      INSERT INTO market_items (item_id, current_price, updated_seq, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        current_price = excluded.current_price,
        updated_seq = excluded.updated_seq,
        updated_at = excluded.updated_at
    `),
    version: db.prepare(`
      INSERT OR IGNORE INTO item_versions (item_id, version_fingerprint, price, observed_at)
      VALUES (?, ?, ?, ?)
    `),
    event: db.prepare(`
      INSERT OR IGNORE INTO market_events (item_id, event_key, event_type, created_at)
      VALUES (?, ?, ?, ?)
    `),
    cursorPage: db.prepare(`
      SELECT item_id, updated_seq
      FROM market_items
      WHERE updated_seq <= ?
        AND (? IS NULL OR updated_seq < ? OR (updated_seq = ? AND item_id < ?))
      ORDER BY updated_seq DESC, item_id DESC
      LIMIT ?
    `),
    itemCount: db.prepare('SELECT COUNT(*) AS total FROM market_items'),
    versionCount: db.prepare('SELECT COUNT(*) AS total FROM item_versions'),
    eventCount: db.prepare('SELECT COUNT(*) AS total FROM market_events'),
    receiptCount: db.prepare('SELECT COUNT(*) AS total FROM ingest_receipts')
  }
}

function runInBatches(db, batchSize, total, callback) {
  for (let offset = 0; offset < total; offset += batchSize) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const end = Math.min(total, offset + batchSize)
      for (let index = offset; index < end; index += 1) callback(index)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

function run() {
  const options = parseArguments()
  const temporaryPath = options.database === 'temp'
    ? join(tmpdir(), `xianyu-phase0-sqlite-${process.pid}-${Date.now()}.db`)
    : ':memory:'
  const startedAt = performance.now()
  const db = createDatabase(temporaryPath)
  const statements = prepareStatements(db)
  const baseNow = Date.now()
  let sequence = 0
  let insertedReceipts = 0

  const ingest = (deviceIndex, itemIndex, version) => {
    const itemId = `item-${itemIndex.toString().padStart(8, '0')}`
    const deviceId = `device-${deviceIndex.toString().padStart(3, '0')}`
    const basePrice = 1_000 + (itemIndex % 500)
    const price = version === 1 ? basePrice - 100 : basePrice
    const idempotencyKey = `${version}:${itemId}`
    const receipt = statements.receipt.run(deviceId, idempotencyKey, baseNow + sequence)
    if (Number(receipt.changes) === 0) return

    insertedReceipts += 1
    sequence += 1
    statements.item.run(itemId, price, sequence, baseNow + sequence)
    statements.version.run(itemId, `price:${price}`, price, baseNow + sequence)
    if (version === 1) {
      statements.event.run(itemId, `price-change:${price}`, 'price_changed', baseNow + sequence)
    }
  }

  const initialCount = options.items * options.devices
  const initialStartedAt = performance.now()
  runInBatches(db, options.batchSize, initialCount, (index) => {
    const deviceIndex = Math.floor(index / options.items)
    const itemIndex = index % options.items
    ingest(deviceIndex, itemIndex, 0)
  })
  const initialDurationMs = elapsedMs(initialStartedAt)

  const changedItems = Math.floor(options.items / 3)
  const changedCount = changedItems * options.devices
  const priceChangeStartedAt = performance.now()
  runInBatches(db, options.batchSize, changedCount, (index) => {
    const deviceIndex = Math.floor(index / changedItems)
    const itemIndex = (index % changedItems) * 3
    ingest(deviceIndex, itemIndex, 1)
  })
  const priceChangeDurationMs = elapsedMs(priceChangeStartedAt)

  const receiptsBeforeReplay = insertedReceipts
  const replayStartedAt = performance.now()
  runInBatches(db, options.batchSize, initialCount + changedCount, (index) => {
    if (index < initialCount) {
      const deviceIndex = Math.floor(index / options.items)
      ingest(deviceIndex, index % options.items, 0)
      return
    }
    const replayIndex = index - initialCount
    const deviceIndex = Math.floor(replayIndex / changedItems)
    ingest(deviceIndex, (replayIndex % changedItems) * 3, 1)
  })
  const replayDurationMs = elapsedMs(replayStartedAt)
  assert(insertedReceipts === receiptsBeforeReplay, '重复批次不应接受新的 receipt')

  const itemsAtPaginationStart = Number(statements.itemCount.get().total)
  const snapshotMaxSequence = sequence
  const pageSize = 97
  const pagedItemIds = new Set()
  let cursor = null
  let pageCount = 0
  const paginationStartedAt = performance.now()
  do {
    const rows = statements.cursorPage.all(
      snapshotMaxSequence,
      cursor?.sequence ?? null,
      cursor?.sequence ?? null,
      cursor?.sequence ?? null,
      cursor?.itemId ?? null,
      pageSize
    )
    if (rows.length === 0) break
    pageCount += 1
    for (const row of rows) {
      const itemId = String(row.item_id)
      assert(!pagedItemIds.has(itemId), `游标分页出现重复商品 ${itemId}`)
      pagedItemIds.add(itemId)
    }
    const last = rows.at(-1)
    cursor = { sequence: Number(last.updated_seq), itemId: String(last.item_id) }
    if (pageCount === 1) {
      sequence += 1
      statements.item.run('item-added-during-pagination', 1_999, sequence, baseNow + sequence)
      statements.version.run('item-added-during-pagination', 'price:1999', 1_999, baseNow + sequence)
    }
  } while (true)
  const paginationDurationMs = elapsedMs(paginationStartedAt)
  assert(pagedItemIds.size === itemsAtPaginationStart, '游标分页遗漏了快照边界内的商品')
  assert(!pagedItemIds.has('item-added-during-pagination'), '游标分页混入了快照边界后的新增商品')

  const counts = {
    itemsBeforePaginationInsert: itemsAtPaginationStart,
    itemsAfterPaginationInsert: Number(statements.itemCount.get().total),
    versions: Number(statements.versionCount.get().total),
    events: Number(statements.eventCount.get().total),
    receipts: Number(statements.receiptCount.get().total)
  }
  const expected = {
    itemsBeforePaginationInsert: options.items,
    itemsAfterPaginationInsert: options.items + 1,
    versions: options.items + changedItems + 1,
    events: changedItems,
    receipts: initialCount + changedCount
  }
  for (const [name, value] of Object.entries(expected)) {
    assert(counts[name] === value, `${name} 期望 ${value}，实际 ${counts[name]}`)
  }

  const metrics = {
    scenario: 'phase0-synthetic-sqlite',
    database: options.database,
    parameters: options,
    schema: {
      itemDedupKey: 'market_items.item_id',
      idempotencyKey: 'ingest_receipts(device_id, idempotency_key)',
      versionDedupKey: 'item_versions(item_id, version_fingerprint)',
      eventDedupKey: 'market_events(item_id, event_key)',
      cursor: 'market_items(updated_seq DESC, item_id DESC) with snapshot maximum sequence'
    },
    workload: {
      initialSourceRecords: initialCount,
      priceChangeSourceRecords: changedCount,
      replaySourceRecords: initialCount + changedCount,
      changedItems
    },
    timingsMs: {
      initialIngest: initialDurationMs,
      priceChangeIngest: priceChangeDurationMs,
      idempotentReplay: replayDurationMs,
      cursorPagination: paginationDurationMs,
      total: elapsedMs(startedAt)
    },
    throughputRecordsPerSecond: {
      initialIngest: throughput(initialCount, initialDurationMs),
      priceChangeIngest: throughput(changedCount, priceChangeDurationMs),
      idempotentReplay: throughput(initialCount + changedCount, replayDurationMs),
      cursorPagination: throughput(itemsAtPaginationStart, paginationDurationMs)
    },
    pagination: {
      pageSize,
      pages: pageCount,
      snapshotItemCount: itemsAtPaginationStart,
      uniqueItemsReturned: pagedItemIds.size,
      postSnapshotInsertExcluded: true
    },
    counts,
    assertions: {
      idempotentReplayDidNotWrite: true,
      multiDeviceItemDedup: counts.itemsBeforePaginationInsert === options.items,
      priceVersionDedup: counts.versions === expected.versions,
      eventDedup: counts.events === expected.events,
      cursorPaginationStable: pagedItemIds.size === itemsAtPaginationStart
    }
  }
  console.log(JSON.stringify(metrics, null, 2))
  db.close()
  if (temporaryPath !== ':memory:' && existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
}

try {
  run()
} catch (error) {
  console.error(JSON.stringify({ scenario: 'phase0-synthetic-sqlite', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}
