import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MonitorTask, NewTask, ScanLog, SearchItem } from '../shared/types'

type TaskRow = {
  id: string
  keyword: string
  min_price: number | null
  max_price: number | null
  region: string | null
  interval_minutes: number
  enabled: number
  last_scanned_at: string | null
  created_at: string
  updated_at: string
}

export class MonitorDatabase {
  private readonly db: DatabaseSync

  constructor() {
    const dataDir = join(app.getPath('userData'), 'monitor-data')
    mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(join(dataDir, 'monitor.db'))
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        keyword TEXT NOT NULL,
        min_price REAL,
        max_price REAL,
        region TEXT,
        interval_minutes INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_scanned_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS items (
        task_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        title TEXT NOT NULL,
        price REAL,
        region TEXT,
        published_text TEXT,
        want_count INTEGER,
        url TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (task_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS scan_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  }

  listTasks(): MonitorTask[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as TaskRow[]
    return rows.map(this.toTask)
  }

  saveTask(input: NewTask): MonitorTask {
    const now = new Date().toISOString()
    const task: MonitorTask = {
      ...input,
      id: crypto.randomUUID(),
      lastScannedAt: null,
      createdAt: now,
      updatedAt: now
    }
    this.db.prepare(`
      INSERT INTO tasks (id, keyword, min_price, max_price, region, interval_minutes, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(task.id, task.keyword, task.minPrice, task.maxPrice, task.region, task.intervalMinutes, Number(task.enabled), now, now)
    return task
  }

  setTaskEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE tasks SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(Number(enabled), new Date().toISOString(), id)
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM items WHERE task_id = ?').run(id)
    this.db.prepare('DELETE FROM scan_logs WHERE task_id = ?').run(id)
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  markTaskScanned(id: string): void {
    this.db.prepare('UPDATE tasks SET last_scanned_at = ? WHERE id = ?').run(new Date().toISOString(), id)
  }

  upsertItem(item: Omit<SearchItem, 'firstSeenAt' | 'lastSeenAt' | 'isNew'>): boolean {
    const exists = this.db.prepare('SELECT 1 FROM items WHERE task_id = ? AND item_id = ?').get(item.taskId, item.itemId)
    const now = new Date().toISOString()
    if (exists) {
      this.db.prepare(`
        UPDATE items SET title = ?, price = ?, region = ?, published_text = ?, want_count = ?, url = ?, last_seen_at = ?
        WHERE task_id = ? AND item_id = ?
      `).run(item.title, item.price, item.region, item.publishedText, item.wantCount, item.url, now, item.taskId, item.itemId)
      return false
    }
    this.db.prepare(`
      INSERT INTO items (task_id, item_id, title, price, region, published_text, want_count, url, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(item.taskId, item.itemId, item.title, item.price, item.region, item.publishedText, item.wantCount, item.url, now, now)
    return true
  }

  listItems(taskId?: string): SearchItem[] {
    const query = taskId
      ? 'SELECT * FROM items WHERE task_id = ? ORDER BY first_seen_at DESC LIMIT 200'
      : 'SELECT * FROM items ORDER BY first_seen_at DESC LIMIT 200'
    const rows = (taskId ? this.db.prepare(query).all(taskId) : this.db.prepare(query).all()) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      itemId: String(row.item_id),
      taskId: String(row.task_id),
      title: String(row.title),
      price: row.price === null ? null : Number(row.price),
      region: row.region === null ? null : String(row.region),
      publishedText: row.published_text === null ? null : String(row.published_text),
      wantCount: row.want_count === null ? null : Number(row.want_count),
      url: String(row.url),
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
      isNew: false
    }))
  }

  addLog(level: ScanLog['level'], message: string, taskId: string | null = null): void {
    this.db.prepare('INSERT INTO scan_logs (task_id, level, message, created_at) VALUES (?, ?, ?, ?)')
      .run(taskId, level, message, new Date().toISOString())
  }

  listLogs(): ScanLog[] {
    return this.db.prepare('SELECT * FROM scan_logs ORDER BY id DESC LIMIT 80').all() as ScanLog[]
  }

  private toTask = (row: TaskRow): MonitorTask => ({
    id: row.id,
    keyword: row.keyword,
    minPrice: row.min_price,
    maxPrice: row.max_price,
    region: row.region,
    intervalMinutes: row.interval_minutes,
    enabled: Boolean(row.enabled),
    lastScannedAt: row.last_scanned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}
