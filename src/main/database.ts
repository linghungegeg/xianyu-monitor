import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LauncherLog, OutboxEntry } from '../shared/types'

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

export class MonitorDatabase {
  private readonly db: DatabaseSync

  constructor() {
    const dataDir = join(app.getPath('userData'), 'monitor-data')
    mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(join(dataDir, 'launcher.db'))
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

  close(): void {
    this.db.close()
  }
}
