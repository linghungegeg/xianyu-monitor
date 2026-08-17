import type { Domains } from './api.ts'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

function port(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} 不是有效端口`)
  return value
}

export type CloudConfig = {
  databaseUrl: string
  host: string
  userPort: number
  adminPort: number
  collectorPort: number
  domains: Domains
}

export function loadCloudConfig(): CloudConfig {
  return {
    databaseUrl: required('DATABASE_URL'),
    host: process.env.CLOUD_API_HOST ?? '127.0.0.1',
    userPort: port('USER_API_PORT', 3101),
    adminPort: port('ADMIN_API_PORT', 3102),
    collectorPort: port('COLLECTOR_API_PORT', 3103),
    domains: {
      user: { issuer: required('USER_TOKEN_ISSUER'), audience: required('USER_TOKEN_AUDIENCE'), secret: required('USER_TOKEN_SECRET') },
      admin: { issuer: required('ADMIN_TOKEN_ISSUER'), audience: required('ADMIN_TOKEN_AUDIENCE'), secret: required('ADMIN_TOKEN_SECRET') },
      collector: { issuer: required('COLLECTOR_TOKEN_ISSUER'), audience: required('COLLECTOR_TOKEN_AUDIENCE'), secret: required('COLLECTOR_TOKEN_SECRET') }
    }
  }
}
