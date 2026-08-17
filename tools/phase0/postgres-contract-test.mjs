import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase0-pglite-${process.pid}-${Date.now()}`)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function countRows(db, query, parameters = []) {
  const result = await db.query(query, parameters)
  return Number(result.rows[0].total)
}

async function run() {
  const migrations = readdirSync(migrationDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(migrationDirectory, file), 'utf8') }))
  const db = new PGlite(databasePath)
  try {
    for (const migration of migrations) await db.exec(migration.sql)
    for (const migration of migrations) await db.exec(migration.sql)

    const tables = await countRows(db, `
      SELECT COUNT(*)::int AS total
      FROM information_schema.tables
      WHERE table_schema IN ('identity', 'billing', 'market', 'ops', 'ai')
    `)
    const inheritanceEntries = await countRows(db, `
      SELECT COUNT(*)::int AS total
      FROM pg_inherits
    `)
    const tablePartitions = await countRows(db, `
      SELECT COUNT(*)::int AS total
      FROM pg_inherits inheritance
      JOIN pg_class child ON child.oid = inheritance.inhrelid
      WHERE child.relkind = 'r'
    `)
    const indexes = await countRows(db, `
      SELECT COUNT(*)::int AS total
      FROM pg_indexes
      WHERE schemaname IN ('identity', 'billing', 'market', 'ops', 'ai')
    `)
    assert(tables >= 28, `实体表数量不足：${tables}`)
    assert(tablePartitions >= 24, `月表分区数量不足：${tablePartitions}`)
    assert(indexes >= 30, `索引数量不足：${indexes}`)

    const itemId = '00000000-0000-0000-0000-000000000101'
    await db.query(`
      INSERT INTO market.items (id, platform, platform_item_id, lifecycle_state, first_seen_at, last_seen_at)
      VALUES ($1, 'goofish', 'contract-item-1', 'active', now(), now())
    `, [itemId])
    const explain = await db.query(`
      EXPLAIN (COSTS OFF)
      SELECT id FROM market.items
      WHERE lifecycle_state = 'active'
      ORDER BY last_seen_at DESC, id DESC
      LIMIT 50
    `)
    const plan = explain.rows.map((row) => String(row['QUERY PLAN'])).join('\n')
    assert(plan.includes('idx_items_state_recent'), `关键分页查询未命中索引：${plan}`)

    const forbiddenColumns = await countRows(db, `
      SELECT COUNT(*)::int AS total
      FROM information_schema.columns
      WHERE table_schema IN ('identity', 'billing', 'market', 'ops', 'ai')
        AND column_name ~* '(cookie|token|password_plain|browser_profile)'
        AND column_name NOT IN ('password_hash', 'token_hash')
    `)
    assert(forbiddenColumns === 0, `发现不应进入云端的敏感列：${forbiddenColumns}`)

    console.log(JSON.stringify({
      scenario: 'phase0-postgres-contract',
      migrations: migrations.map((migration) => migration.file),
      migrationAppliedTwice: true,
      tables,
      tablePartitions,
      inheritanceEntries,
      indexes,
      explainPlan: plan,
      forbiddenColumns,
      assertions: {
        separateSchemas: true,
        monthlyTablePartitionsCreated: true,
        requiredIndexesCreated: true,
        keysetPaginationUsesIndex: true,
        noPlatformCredentialColumns: true
      }
    }, null, 2))
  } finally {
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ scenario: 'phase0-postgres-contract', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
