import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LauncherLog, OutboxEntry } from '../shared/types'
import type { CollectedItem, SearchRule, SellerItemState, SellerProfile } from './search'

type LogRow = {
  id: number
  level: LauncherLog['level']
  message: string
  created_at: string
}

type OutboxRow = {
  id: string
  kind: OutboxEntry['kind']
  payload: string
  attempts: number
  next_attempt_at: string
  created_at: string
}

type CachedTaskBase = {
  id: string
  ruleVersion: number
  status: 'active' | 'paused'
  intervalSeconds: number
  nextRunAt: string
  createdAt: string
  updatedAt: string
}

export type CachedSearchMonitorTask = CachedTaskBase & {
  kind: 'search'
  rule: SearchRule
}

export type CachedSellerMonitorTask = CachedTaskBase & {
  kind: 'seller'
  platform: 'goofish'
  platformSellerId: string
  profileUrl: string
}

export type CachedMonitorTask = CachedSearchMonitorTask | CachedSellerMonitorTask

type CachedMonitorTaskRow = {
  id: string
  rule_json: string
  kind: CachedMonitorTask['kind'] | null
  target_json: string | null
  rule_version: number
  status: CachedMonitorTask['status']
  interval_seconds: number
  next_run_at: string
  created_at: string
  updated_at: string
}

export type ItemSaveResult = { isNewItem: boolean; isNewVersion: boolean }
export type SellerItemSaveResult = ItemSaveResult & { eventCount: number }

type ItemVersionRow = { content_hash: string; canonical_payload: string }
type SellerRelationRow = { state: SellerItemState }

type SellerItemSaveInput = {
  taskId: string
  scanId: string
  seller: SellerProfile
  state: Extract<SellerItemState, 'active' | 'sold'>
  item: CollectedItem
  contentHash: string
  canonicalPayload: string
}

function payloadRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function itemContentChanged(beforePayload: string, afterPayload: string): boolean {
  const before = payloadRecord(beforePayload)
  const after = payloadRecord(afterPayload)
  return ['title', 'description', 'conditionText', 'imageUrls', 'tags'].some((key) => !sameValue(before[key], after[key]))
}

export class MonitorDatabase {
  private readonly db: DatabaseSync

  constructor() {
    const dataDir = join(app.getPath('userData'), 'monitor-data')
    mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(join(dataDir, 'launcher.db'))
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS launcher_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS launcher_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL CHECK (level IN ('info', 'success', 'error')),
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('heartbeat', 'market_batch', 'supply_result')),
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (next_attempt_at, created_at, id);
      CREATE TABLE IF NOT EXISTS supply_publish_attempts (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        claim_batch_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed', 'needs_attention')),
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_supply_publish_attempts_plan ON supply_publish_attempts (plan_id, created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS cached_monitor_tasks (
        id TEXT PRIMARY KEY,
        rule_json TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'search' CHECK (kind IN ('search', 'seller')),
        target_json TEXT,
        rule_version INTEGER NOT NULL CHECK (rule_version >= 1),
        status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
        interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 60 AND 86400),
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cached_monitor_tasks_due
        ON cached_monitor_tasks (status, next_run_at, last_run_at, id);
      CREATE TABLE IF NOT EXISTS local_categories (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 3),
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_items (
        platform TEXT NOT NULL CHECK (platform = 'goofish'),
        platform_item_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        price REAL,
        region TEXT,
        published_text TEXT,
        want_count INTEGER,
        image_urls TEXT NOT NULL,
        tags TEXT NOT NULL,
        description TEXT,
        condition_text TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (platform, platform_item_id)
      );
      CREATE TABLE IF NOT EXISTS local_item_versions (
        platform TEXT NOT NULL CHECK (platform = 'goofish'),
        platform_item_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        canonical_payload TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (platform, platform_item_id, content_hash),
        FOREIGN KEY (platform, platform_item_id) REFERENCES local_items (platform, platform_item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_local_item_versions_timeline
        ON local_item_versions (platform, platform_item_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS local_task_item_matches (
        task_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform = 'goofish'),
        platform_item_id TEXT NOT NULL,
        first_matched_at TEXT NOT NULL,
        last_matched_at TEXT NOT NULL,
        PRIMARY KEY (task_id, platform, platform_item_id),
        FOREIGN KEY (task_id) REFERENCES cached_monitor_tasks (id) ON DELETE CASCADE,
        FOREIGN KEY (platform, platform_item_id) REFERENCES local_items (platform, platform_item_id)
      );
      CREATE TABLE IF NOT EXISTS local_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'search' CHECK (kind IN ('search', 'seller')),
        rule_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
        scanned_count INTEGER NOT NULL CHECK (scanned_count >= 0),
        new_item_count INTEGER NOT NULL CHECK (new_item_count >= 0),
        new_version_count INTEGER NOT NULL CHECK (new_version_count >= 0),
        event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES cached_monitor_tasks (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_local_task_runs_timeline
        ON local_task_runs (task_id, started_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS local_sellers (
        platform TEXT NOT NULL CHECK (platform = 'goofish'),
        platform_seller_id TEXT NOT NULL,
        profile_url TEXT NOT NULL,
        public_name TEXT,
        region TEXT,
        public_profile TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (platform, platform_seller_id)
      );
      CREATE TABLE IF NOT EXISTS local_seller_versions (
        platform TEXT NOT NULL CHECK (platform = 'goofish'),
        platform_seller_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        canonical_payload TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (platform, platform_seller_id, content_hash),
        FOREIGN KEY (platform, platform_seller_id) REFERENCES local_sellers (platform, platform_seller_id)
      );
      CREATE INDEX IF NOT EXISTS idx_local_seller_versions_timeline
        ON local_seller_versions (platform, platform_seller_id, observed_at DESC, content_hash DESC);
      CREATE TABLE IF NOT EXISTS local_seller_item_relations (
        platform TEXT NOT NULL CHECK (platform = 'goofish'),
        platform_seller_id TEXT NOT NULL,
        platform_item_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'sold', 'offline', 'unknown')),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_active_scan_id TEXT,
        PRIMARY KEY (platform, platform_seller_id, platform_item_id),
        FOREIGN KEY (platform, platform_seller_id) REFERENCES local_sellers (platform, platform_seller_id),
        FOREIGN KEY (platform, platform_item_id) REFERENCES local_items (platform, platform_item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_local_seller_items_state_recent
        ON local_seller_item_relations (platform, platform_seller_id, state, last_seen_at DESC, platform_item_id DESC);
      CREATE TABLE IF NOT EXISTS local_item_events (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL CHECK (platform = 'goofish'),
        platform_seller_id TEXT NOT NULL,
        platform_item_id TEXT,
        event_type TEXT NOT NULL CHECK (event_type IN ('new_listing', 'price_changed', 'state_changed', 'content_changed')),
        before_content_hash TEXT,
        after_content_hash TEXT,
        before_state TEXT,
        after_state TEXT,
        details_json TEXT NOT NULL,
        event_key TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        FOREIGN KEY (platform, platform_seller_id) REFERENCES local_sellers (platform, platform_seller_id)
      );
      CREATE INDEX IF NOT EXISTS idx_local_item_events_seller_timeline
        ON local_item_events (platform, platform_seller_id, occurred_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_local_item_events_item_timeline
        ON local_item_events (platform, platform_item_id, occurred_at DESC, id DESC);
    `)
    this.ensureOutboxKinds()
    this.ensureColumn('cached_monitor_tasks', 'kind', "TEXT NOT NULL DEFAULT 'search'")
    this.ensureColumn('cached_monitor_tasks', 'target_json', 'TEXT')
    this.ensureColumn('local_items', 'condition_text', 'TEXT')
    this.ensureColumn('local_task_runs', 'kind', "TEXT NOT NULL DEFAULT 'search'")
    this.ensureColumn('local_task_runs', 'event_count', 'INTEGER NOT NULL DEFAULT 0')
  }

  private ensureColumn(table: 'cached_monitor_tasks' | 'local_items' | 'local_task_runs', column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (columns.some((entry) => entry.name === column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private ensureOutboxKinds(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='outbox'").get() as { sql?: string } | undefined
    if (!row?.sql || row.sql.includes("'supply_result'")) return
    this.db.exec(`
      ALTER TABLE outbox RENAME TO outbox_legacy;
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('heartbeat', 'market_batch', 'supply_result')),
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO outbox (id,kind,payload,attempts,next_attempt_at,created_at)
        SELECT id,kind,payload,attempts,next_attempt_at,created_at FROM outbox_legacy;
      DROP TABLE outbox_legacy;
      CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (next_attempt_at, created_at, id);
    `)
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM launcher_state WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value ?? null
  }

  setState(key: string, value: string): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO launcher_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now)
  }

  deleteState(...keys: string[]): void {
    const statement = this.db.prepare('DELETE FROM launcher_state WHERE key = ?')
    for (const key of keys) statement.run(key)
  }

  addLog(level: LauncherLog['level'], message: string): void {
    this.db.prepare('INSERT INTO launcher_logs (level, message, created_at) VALUES (?, ?, ?)')
      .run(level, message, new Date().toISOString())
  }

  listLogs(): LauncherLog[] {
    const rows = this.db.prepare('SELECT id, level, message, created_at FROM launcher_logs ORDER BY id DESC LIMIT 60').all() as LogRow[]
    return rows.map((row) => ({ id: row.id, level: row.level, message: row.message, createdAt: row.created_at }))
  }

  enqueueHeartbeat(payload: { id: string; observedAt: string; appVersion: string }): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO outbox (id, kind, payload, attempts, next_attempt_at, created_at)
      VALUES (?, 'heartbeat', ?, 0, ?, ?)
    `).run(payload.id, JSON.stringify(payload), now, now)
  }

  enqueueMarketBatch(deviceId: string): string | null {
    const sequence = Number(this.getState('collector.upload-sequence') ?? '0') + 1
    const now = new Date().toISOString()
    const records: Array<Record<string, unknown>> = []
    const sellers = this.db.prepare(`SELECT platform,platform_seller_id,profile_url,public_name,region,public_profile FROM local_sellers ORDER BY platform_seller_id LIMIT 50`).all() as Array<Record<string, unknown>>
    for (const seller of sellers) records.push({ type: 'seller', idempotencyKey: `seller:${seller.platform}:${seller.platform_seller_id}`, platform: seller.platform, platformSellerId: seller.platform_seller_id, profileUrl: seller.profile_url, publicName: seller.public_name, region: seller.region, publicProfile: JSON.parse(String(seller.public_profile ?? '{}')) })
    const versions = this.db.prepare(`SELECT i.platform,i.platform_item_id,i.url,i.title,i.price,i.region,i.want_count,i.image_urls,i.tags,i.description,i.condition_text,v.content_hash,v.canonical_payload,v.observed_at,r.platform_seller_id,r.state
      FROM local_items i JOIN local_item_versions v ON v.platform=i.platform AND v.platform_item_id=i.platform_item_id
      LEFT JOIN local_seller_item_relations r ON r.platform=i.platform AND r.platform_item_id=i.platform_item_id
      ORDER BY v.observed_at DESC, i.platform_item_id LIMIT 50`).all() as Array<Record<string, unknown>>
    for (const row of versions) {
      const payload = JSON.parse(String(row.canonical_payload ?? '{}'))
      const common = { platform: row.platform, platformItemId: row.platform_item_id, platformSellerId: row.platform_seller_id ?? undefined, state: row.state ?? 'unknown', title: row.title, price: row.price, region: row.region, wantCount: row.want_count, conditionText: row.condition_text, contentHash: row.content_hash, observedAt: row.observed_at, payload, imageUrls: JSON.parse(String(row.image_urls ?? '[]')), tags: JSON.parse(String(row.tags ?? '[]')), description: row.description, url: row.url }
      records.push({ type: 'version', idempotencyKey: `version:${row.platform}:${row.platform_item_id}:${row.content_hash}`, ...common })
      records.push({ type: 'snapshot', idempotencyKey: `snapshot:${row.platform}:${row.platform_item_id}:${row.content_hash}`, payloadHash: String(row.content_hash), ...common })
    }
    const events = this.db.prepare(`SELECT event_key,platform_seller_id,platform_item_id,event_type,before_content_hash,after_content_hash,before_state,after_state,details_json,occurred_at FROM local_item_events ORDER BY occurred_at DESC,id DESC LIMIT 50`).all() as Array<Record<string, unknown>>
    for (const event of events) records.push({ type: 'event', idempotencyKey: `event:${event.event_key}`, eventKey: event.event_key, platform: 'goofish', platformItemId: event.platform_item_id ?? undefined, platformSellerId: event.platform_seller_id, eventType: event.event_type, beforeHash: event.before_content_hash, afterHash: event.after_content_hash, beforeState: event.before_state, afterState: event.after_state, occurredAt: event.occurred_at })
    if (!records.length) return null
    const contentHash = createHash('sha256').update(JSON.stringify(records)).digest('hex')
    if (this.getState('collector.upload-content-hash') === contentHash) return null
    const batchId = randomUUID()
    const payload = { schemaVersion: 1, deviceId, batchId, idempotencyKey: `${deviceId}:${sequence}`, batchSequence: sequence, cursor: { start: String(sequence - 1), end: String(sequence) }, records }
    this.db.prepare(`INSERT INTO outbox (id,kind,payload,attempts,next_attempt_at,created_at) VALUES (?,'market_batch',?,0,?,?)`).run(batchId, JSON.stringify(payload), now, now)
    this.setState('collector.upload-sequence', String(sequence))
    this.setState('collector.upload-content-hash', contentHash)
    return batchId
  }

  listDueOutbox(now = new Date().toISOString()): OutboxEntry[] {
    const rows = this.db.prepare(`
      SELECT id, kind, payload, attempts, next_attempt_at, created_at
      FROM outbox WHERE next_attempt_at <= ? ORDER BY created_at ASC, id ASC LIMIT 50
    `).all(now) as OutboxRow[]
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      createdAt: row.created_at
    }))
  }

  completeOutbox(id: string): void {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id)
  }

  deferOutbox(id: string, attempts: number): void {
    const delayMs = Math.min(60 * 60_000, Math.max(5_000, 2 ** Math.min(attempts, 8) * 1_000))
    this.db.prepare('UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?')
      .run(attempts, new Date(Date.now() + delayMs).toISOString(), id)
  }

  recordSupplyPublishAttempt(input: { id: string; planId: string; claimBatchId: string; status: 'claimed' | 'needs_attention'; message: string }): void {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO supply_publish_attempts (id,plan_id,claim_batch_id,status,message,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,message=excluded.message,updated_at=excluded.updated_at`)
      .run(input.id, input.planId, input.claimBatchId, input.status, input.message, now, now)
  }

  enqueueSupplyPublishResult(input: { id: string; planId: string; claimBatchId: string; attemptKey: string; status: 'failed' | 'needs_attention'; errorMessage: string }): void {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO outbox (id,kind,payload,attempts,next_attempt_at,created_at) VALUES (?,'supply_result',?,0,?,?)`)
      .run(input.id, JSON.stringify({ schemaVersion: 1, deviceId: this.getState('collector.client-id'), results: [{ planId: input.planId, claimBatchId: input.claimBatchId, attemptKey: input.attemptKey, status: input.status, errorMessage: input.errorMessage }] }), now, now)
  }

  syncMonitorTasks(tasks: readonly CachedMonitorTask[]): void {
    const insert = this.db.prepare(`
      INSERT INTO cached_monitor_tasks (id, rule_json, kind, target_json, rule_version, status, interval_seconds, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        rule_json = excluded.rule_json,
        kind = excluded.kind,
        target_json = excluded.target_json,
        rule_version = excluded.rule_version,
        status = excluded.status,
        interval_seconds = excluded.interval_seconds,
        next_run_at = excluded.next_run_at,
        last_run_at = CASE WHEN cached_monitor_tasks.rule_version <> excluded.rule_version THEN NULL ELSE cached_monitor_tasks.last_run_at END,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `)
    try {
      this.db.exec('BEGIN')
      for (const task of tasks) {
        const rule = task.kind === 'search' ? JSON.stringify(task.rule) : '{}'
        const target = task.kind === 'seller'
          ? JSON.stringify({ platform: task.platform, platformSellerId: task.platformSellerId, profileUrl: task.profileUrl })
          : null
        insert.run(task.id, rule, task.kind, target, task.ruleVersion, task.status, task.intervalSeconds, task.nextRunAt, task.createdAt, task.updatedAt)
      }
      if (tasks.length) {
        const placeholders = tasks.map(() => '?').join(', ')
        this.db.prepare(`DELETE FROM cached_monitor_tasks WHERE id NOT IN (${placeholders})`).run(...tasks.map((task) => task.id))
      } else {
        this.db.exec('DELETE FROM cached_monitor_tasks')
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listDueMonitorTasks(now = new Date().toISOString()): CachedMonitorTask[] {
    const rows = this.db.prepare(`
      SELECT id, rule_json, kind, target_json, rule_version, status, interval_seconds, next_run_at, created_at, updated_at
      FROM cached_monitor_tasks
      WHERE status = 'active' AND (
        (last_run_at IS NULL AND next_run_at <= ?)
        OR (last_run_at IS NOT NULL AND datetime(last_run_at, '+' || interval_seconds || ' seconds') <= datetime(?))
      )
      ORDER BY CASE WHEN last_run_at IS NULL THEN next_run_at ELSE last_run_at END ASC, id ASC
    `).all(now, now) as CachedMonitorTaskRow[]
    return rows.map((row) => {
      const common = {
        id: row.id,
        ruleVersion: row.rule_version,
        status: row.status,
        intervalSeconds: row.interval_seconds,
        nextRunAt: row.next_run_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      } as const
      if (row.kind === 'seller') {
        const target = payloadRecord(row.target_json ?? '')
        const platformSellerId = typeof target.platformSellerId === 'string' ? target.platformSellerId : ''
        const profileUrl = typeof target.profileUrl === 'string' ? target.profileUrl : ''
        if (target.platform !== 'goofish' || !platformSellerId || !profileUrl) throw new Error('本地卖家任务缓存无效')
        return { ...common, kind: 'seller' as const, platform: 'goofish' as const, platformSellerId, profileUrl }
      }
      return { ...common, kind: 'search' as const, rule: JSON.parse(row.rule_json) as SearchRule }
    })
  }

  markMonitorTaskRun(taskId: string, at = new Date().toISOString()): void {
    this.db.prepare('UPDATE cached_monitor_tasks SET last_run_at = ? WHERE id = ?').run(at, taskId)
  }

  recordMonitorTaskRun(input: { id: string; taskId: string; kind?: CachedMonitorTask['kind']; ruleVersion: number; status: 'completed' | 'failed'; scannedCount: number; newItemCount: number; newVersionCount: number; eventCount?: number; startedAt: string; finishedAt: string }): void {
    this.db.prepare(`
      INSERT INTO local_task_runs (id, task_id, kind, rule_version, status, scanned_count, new_item_count, new_version_count, event_count, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.taskId, input.kind ?? 'search', input.ruleVersion, input.status, input.scannedCount, input.newItemCount, input.newVersionCount, input.eventCount ?? 0, input.startedAt, input.finishedAt)
  }

  upsertLocalCategories(path: readonly string[]): void {
    const now = new Date().toISOString()
    const insert = this.db.prepare(`
      INSERT INTO local_categories (path, name, depth, observed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET observed_at = excluded.observed_at
    `)
    path.forEach((name, index) => insert.run(path.slice(0, index + 1).join('/'), name, index + 1, now))
  }

  saveCollectedItem(taskId: string, item: CollectedItem, contentHash: string, canonicalPayload: string): ItemSaveResult {
    const now = new Date().toISOString()
    try {
      this.db.exec('BEGIN')
      const existing = this.db.prepare('SELECT 1 FROM local_items WHERE platform = ? AND platform_item_id = ?').get('goofish', item.platformItemId)
      if (existing) {
        this.db.prepare(`
          UPDATE local_items SET url=?, title=?, price=?, region=?, published_text=?, want_count=?, image_urls=?, tags=?, description=?, condition_text=?, last_seen_at=?
          WHERE platform=? AND platform_item_id=?
        `).run(item.url, item.title, item.price, item.region, item.publishedText, item.wantCount, JSON.stringify(item.imageUrls), JSON.stringify(item.tags), item.description, item.conditionText, now, 'goofish', item.platformItemId)
      } else {
        this.db.prepare(`
          INSERT INTO local_items (platform, platform_item_id, url, title, price, region, published_text, want_count, image_urls, tags, description, condition_text, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('goofish', item.platformItemId, item.url, item.title, item.price, item.region, item.publishedText, item.wantCount, JSON.stringify(item.imageUrls), JSON.stringify(item.tags), item.description, item.conditionText, now, now)
      }
      const version = this.db.prepare(`
        INSERT OR IGNORE INTO local_item_versions (platform, platform_item_id, content_hash, canonical_payload, observed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('goofish', item.platformItemId, contentHash, canonicalPayload, now)
      this.db.prepare(`
        INSERT INTO local_task_item_matches (task_id, platform, platform_item_id, first_matched_at, last_matched_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id, platform, platform_item_id) DO UPDATE SET last_matched_at = excluded.last_matched_at
      `).run(taskId, 'goofish', item.platformItemId, now, now)
      this.db.exec('COMMIT')
      return { isNewItem: !existing, isNewVersion: version.changes > 0 }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  saveSellerProfile(profile: SellerProfile, contentHash: string, canonicalPayload: string): boolean {
    const now = new Date().toISOString()
    try {
      this.db.exec('BEGIN')
      const existing = this.db.prepare('SELECT 1 FROM local_sellers WHERE platform=? AND platform_seller_id=?')
        .get(profile.platform, profile.platformSellerId)
      if (existing) {
        this.db.prepare(`
          UPDATE local_sellers SET profile_url=?, public_name=?, region=?, public_profile=?, last_seen_at=?
          WHERE platform=? AND platform_seller_id=?
        `).run(profile.profileUrl, profile.publicName, profile.region, JSON.stringify(profile.publicProfile), now, profile.platform, profile.platformSellerId)
      } else {
        this.db.prepare(`
          INSERT INTO local_sellers (platform, platform_seller_id, profile_url, public_name, region, public_profile, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(profile.platform, profile.platformSellerId, profile.profileUrl, profile.publicName, profile.region, JSON.stringify(profile.publicProfile), now, now)
      }
      const version = this.db.prepare(`
        INSERT OR IGNORE INTO local_seller_versions (platform, platform_seller_id, content_hash, canonical_payload, observed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(profile.platform, profile.platformSellerId, contentHash, canonicalPayload, now)
      this.db.exec('COMMIT')
      return version.changes > 0
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  saveSellerItem(input: SellerItemSaveInput): SellerItemSaveResult {
    const now = new Date().toISOString()
    try {
      this.db.exec('BEGIN')
      const existingItem = this.db.prepare('SELECT 1 FROM local_items WHERE platform=? AND platform_item_id=?')
        .get('goofish', input.item.platformItemId)
      const previousVersion = this.db.prepare(`
        SELECT content_hash, canonical_payload FROM local_item_versions
        WHERE platform=? AND platform_item_id=?
        ORDER BY observed_at DESC, content_hash DESC LIMIT 1
      `).get('goofish', input.item.platformItemId) as ItemVersionRow | undefined
      const previousRelation = this.db.prepare(`
        SELECT state FROM local_seller_item_relations
        WHERE platform=? AND platform_seller_id=? AND platform_item_id=?
      `).get('goofish', input.seller.platformSellerId, input.item.platformItemId) as SellerRelationRow | undefined

      if (existingItem) {
        this.db.prepare(`
          UPDATE local_items SET url=?, title=?, price=?, region=?, published_text=?, want_count=?, image_urls=?, tags=?, description=?, condition_text=?, last_seen_at=?
          WHERE platform=? AND platform_item_id=?
        `).run(input.item.url, input.item.title, input.item.price, input.item.region, input.item.publishedText, input.item.wantCount, JSON.stringify(input.item.imageUrls), JSON.stringify(input.item.tags), input.item.description, input.item.conditionText, now, 'goofish', input.item.platformItemId)
      } else {
        this.db.prepare(`
          INSERT INTO local_items (platform, platform_item_id, url, title, price, region, published_text, want_count, image_urls, tags, description, condition_text, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('goofish', input.item.platformItemId, input.item.url, input.item.title, input.item.price, input.item.region, input.item.publishedText, input.item.wantCount, JSON.stringify(input.item.imageUrls), JSON.stringify(input.item.tags), input.item.description, input.item.conditionText, now, now)
      }

      const version = this.db.prepare(`
        INSERT OR IGNORE INTO local_item_versions (platform, platform_item_id, content_hash, canonical_payload, observed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('goofish', input.item.platformItemId, input.contentHash, input.canonicalPayload, now)
      this.db.prepare(`
        INSERT INTO local_task_item_matches (task_id, platform, platform_item_id, first_matched_at, last_matched_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id, platform, platform_item_id) DO UPDATE SET last_matched_at=excluded.last_matched_at
      `).run(input.taskId, 'goofish', input.item.platformItemId, now, now)
      this.db.prepare(`
        INSERT INTO local_seller_item_relations (platform, platform_seller_id, platform_item_id, state, first_seen_at, last_seen_at, last_active_scan_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform, platform_seller_id, platform_item_id) DO UPDATE SET
          state=excluded.state,
          last_seen_at=excluded.last_seen_at,
          last_active_scan_id=CASE WHEN excluded.state='active' THEN excluded.last_active_scan_id ELSE local_seller_item_relations.last_active_scan_id END
      `).run('goofish', input.seller.platformSellerId, input.item.platformItemId, input.state, now, now, input.state === 'active' ? input.scanId : null)

      let eventCount = 0
      if (!previousRelation && input.state === 'active') {
        eventCount += this.insertSellerEvent({
          sellerId: input.seller.platformSellerId,
          itemId: input.item.platformItemId,
          eventType: 'new_listing',
          beforeHash: undefined,
          afterHash: input.contentHash,
          beforeState: undefined,
          afterState: input.state,
          details: { state: input.state },
          occurredAt: now
        })
      }
      if (previousRelation && previousRelation.state !== input.state) {
        eventCount += this.insertSellerEvent({
          sellerId: input.seller.platformSellerId,
          itemId: input.item.platformItemId,
          eventType: 'state_changed',
          beforeHash: previousVersion?.content_hash,
          afterHash: input.contentHash,
          beforeState: previousRelation.state,
          afterState: input.state,
          details: { beforeState: previousRelation.state, afterState: input.state },
          occurredAt: now
        })
      }
      if (previousRelation && previousVersion && version.changes > 0) {
        const before = payloadRecord(previousVersion.canonical_payload)
        const after = payloadRecord(input.canonicalPayload)
        if (!sameValue(before.price, after.price)) {
          eventCount += this.insertSellerEvent({
            sellerId: input.seller.platformSellerId,
            itemId: input.item.platformItemId,
            eventType: 'price_changed',
            beforeHash: previousVersion.content_hash,
            afterHash: input.contentHash,
            beforeState: previousRelation.state,
            afterState: input.state,
            details: { beforePrice: before.price ?? null, afterPrice: after.price ?? null },
            occurredAt: now
          })
        }
        if (itemContentChanged(previousVersion.canonical_payload, input.canonicalPayload)) {
          eventCount += this.insertSellerEvent({
            sellerId: input.seller.platformSellerId,
            itemId: input.item.platformItemId,
            eventType: 'content_changed',
            beforeHash: previousVersion.content_hash,
            afterHash: input.contentHash,
            beforeState: previousRelation.state,
            afterState: input.state,
            details: { fields: ['title', 'description', 'conditionText', 'imageUrls', 'tags'] },
            occurredAt: now
          })
        }
      }
      this.db.exec('COMMIT')
      return { isNewItem: !existingItem, isNewVersion: version.changes > 0, eventCount }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  markSellerActiveItemsOffline(sellerId: string, scanId: string): number {
    const now = new Date().toISOString()
    try {
      this.db.exec('BEGIN')
      const relations = this.db.prepare(`
        SELECT platform_item_id FROM local_seller_item_relations
        WHERE platform='goofish' AND platform_seller_id=? AND state='active'
          AND COALESCE(last_active_scan_id, '') <> ?
      `).all(sellerId, scanId) as Array<{ platform_item_id: string }>
      let eventCount = 0
      for (const relation of relations) {
        const changed = this.db.prepare(`
          UPDATE local_seller_item_relations SET state='offline', last_seen_at=?
          WHERE platform='goofish' AND platform_seller_id=? AND platform_item_id=? AND state='active'
        `).run(now, sellerId, relation.platform_item_id)
        if (changed.changes === 0) continue
        const version = this.db.prepare(`
          SELECT content_hash FROM local_item_versions
          WHERE platform='goofish' AND platform_item_id=?
          ORDER BY observed_at DESC, content_hash DESC LIMIT 1
        `).get(relation.platform_item_id) as Pick<ItemVersionRow, 'content_hash'> | undefined
        eventCount += this.insertSellerEvent({
          sellerId,
          itemId: relation.platform_item_id,
          eventType: 'state_changed',
          beforeHash: version?.content_hash,
          afterHash: version?.content_hash,
          beforeState: 'active',
          afterState: 'offline',
          details: { beforeState: 'active', afterState: 'offline' },
          occurredAt: now
        })
      }
      this.db.exec('COMMIT')
      return eventCount
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private insertSellerEvent(input: {
    sellerId: string
    itemId?: string
    eventType: 'new_listing' | 'price_changed' | 'state_changed' | 'content_changed'
    beforeHash?: string
    afterHash?: string
    beforeState?: SellerItemState
    afterState?: SellerItemState
    details: Record<string, unknown>
    occurredAt: string
  }): number {
    const eventKey = createHash('sha256').update(JSON.stringify({
      platform: 'goofish', sellerId: input.sellerId, itemId: input.itemId ?? null, eventType: input.eventType,
      beforeHash: input.beforeHash ?? null, afterHash: input.afterHash ?? null,
      beforeState: input.beforeState ?? null, afterState: input.afterState ?? null
    })).digest('hex')
    const event = this.db.prepare(`
      INSERT OR IGNORE INTO local_item_events (
        id, platform, platform_seller_id, platform_item_id, event_type, before_content_hash, after_content_hash,
        before_state, after_state, details_json, event_key, occurred_at, detected_at
      ) VALUES (?, 'goofish', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), input.sellerId, input.itemId ?? null, input.eventType, input.beforeHash ?? null, input.afterHash ?? null,
      input.beforeState ?? null, input.afterState ?? null, JSON.stringify(input.details), eventKey, input.occurredAt, new Date().toISOString())
    return event.changes > 0 ? 1 : 0
  }

  close(): void {
    this.db.close()
  }
}
