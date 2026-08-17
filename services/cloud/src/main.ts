import { Pool } from 'pg'
import { createAdminApi, createCollectorApi, createUserApi } from './api.ts'
import { loadCloudConfig } from './config.ts'

export async function startCloudServices() {
  const config = loadCloudConfig()
  const pool = new Pool({ connectionString: config.databaseUrl, max: 20, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined })
  const sql = { query: (text: string, values?: unknown[]) => pool.query(text, values) }
  const services = [
    { app: createUserApi(sql, config.domains), port: config.userPort },
    { app: createAdminApi(sql, config.domains), port: config.adminPort },
    { app: createCollectorApi(sql, config.domains), port: config.collectorPort }
  ]

  try {
    await Promise.all(services.map(({ app, port }) => app.listen({ host: config.host, port })))
  } catch (error) {
    await Promise.allSettled(services.map(({ app }) => app.close()))
    await pool.end()
    throw error
  }

  const shutdown = async () => {
    await Promise.allSettled(services.map(({ app }) => app.close()))
    await pool.end()
  }
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })
}

if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  void startCloudServices().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
