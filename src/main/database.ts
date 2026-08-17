import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LauncherLog, OutboxEntry } from '../shared/types'
import type { CollectedItem, SearchRule } from './search'

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

export type CachedMonitorTask = {
  id: string
  rule: SearchRule
  ruleVersion: number
  status: 'active' | 'paused'
  intervalSeconds: number
  nextRunAt: string
  createdAt: string
  updatedAt: string
}

type CachedMonitorTaskRow = {
  id: string
  rule_json: string
  rule_version: number
  status: CachedMonitorTask['status']
  interval_seconds: number
  next_run_at: string
  created_at: string
  updated_at: string
}

export type ItemSaveResult = { isNewItem: boolean; isNewVersion: boolean }

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
        kind TEXT NOT NULL CHECK (kind IN ('heartbeat')),
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (next_attempt_at, created_at, id);
      CREATE TABLE IF NOT EXISTS cached_monitor_tasks (
        id TEXT PRIMARY KEY,
        rule_json TEXT NOT NULL,
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
        rule_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
        scanned_count INTEGER NOT NULL CHECK (scanned_count >= 0),
        new_item_count INTEGER NOT NULL CHECK (new_item_count >= 0),
        new_version_count INTEGER NOT NULL CHECK (new_version_count >= 0),
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES cached_monitor_tasks (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_local_task_runs_timeline
        ON local_task_runs (task_id, started_at DESC, id DESC);
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

  listDueOutbox(now = new Date().toISOString()): OutboxEntry[] {
    const rows = this.db.prepare(`
      SELECT id, kind, payload, attempts, next_attempt_at, created_at
      FROM outbox WHERE next_attempt_at <= ? ORDER BY created_at ASC, id ASC LIMIT 50
    `).all(now) as OutboxRow[]
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: JSON.parse(row.payload) as Record<string, string>,
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

  syncMonitorTasks(tasks: readonly CachedMonitorTask[]): void {
    const insert = this.db.prepare(`
      INSERT INTO cached_monitor_tasks (id, rule_json, rule_version, status, interval_seconds, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        rule_json = excluded.rule_json,
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
        insert.run(task.id, JSON.stringify(task.rule), task.ruleVersion, task.status, task.intervalSeconds, task.nextRunAt, task.createdAt, task.updatedAt)
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
      SELECT id, rule_json, rule_version, status, interval_seconds, next_run_at, created_at, updated_at
      FROM cached_monitor_tasks
      WHERE status = 'active' AND (
        (last_run_at IS NULL AND next_run_at <= ?)
        OR (last_run_at IS NOT NULL AND datetime(last_run_at, '+' || interval_seconds || ' seconds') <= datetime(?))
      )
      ORDER BY CASE WHEN last_run_at IS NULL THEN next_run_at ELSE last_run_at END ASC, id ASC
    `).all(now, now) as CachedMonitorTaskRow[]
    return rows.map((row) => ({
      id: row.id,
      rule: JSON.parse(row.rule_json) as SearchRule,
      ruleVersion: row.rule_version,
      status: row.status,
      intervalSeconds: row.interval_seconds,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  markMonitorTaskRun(taskId: string, at = new Date().toISOString()): void {
    this.db.prepare('UPDATE cached_monitor_tasks SET last_run_at = ? WHERE id = ?').run(at, taskId)
  }

  recordMonitorTaskRun(input: { id: string; taskId: string; ruleVersion: number; status: 'completed' | 'failed'; scannedCount: number; newItemCount: number; newVersionCount: number; startedAt: string; finishedAt: string }): void {
    this.db.prepare(`
      INSERT INTO local_task_runs (id, task_id, rule_version, status, scanned_count, new_item_count, new_version_count, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.taskId, input.ruleVersion, input.status, input.scannedCount, input.newItemCount, input.newVersionCount, input.startedAt, input.finishedAt)
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
          UPDATE local_items SET url=?, title=?, price=?, region=?, published_text=?, want_count=?, image_urls=?, tags=?, description=?, last_seen_at=?
          WHERE platform=? AND platform_item_id=?
        `).run(item.url, item.title, item.price, item.region, item.publishedText, item.wantCount, JSON.stringify(item.imageUrls), JSON.stringify(item.tags), item.description, now, 'goofish', item.platformItemId)
      } else {
        this.db.prepare(`
          INSERT INTO local_items (platform, platform_item_id, url, title, price, region, published_text, want_count, image_urls, tags, description, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run('goofish', item.platformItemId, item.url, item.title, item.price, item.region, item.publishedText, item.wantCount, JSON.stringify(item.imageUrls), JSON.stringify(item.tags), item.description, now, now)
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

  close(): void {
    this.db.close()
  }
}
