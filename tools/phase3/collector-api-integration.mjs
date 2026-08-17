import { PGlite } from '@electric-sql/pglite'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCollectorApi, createUserApi } from '../../services/cloud/src/api.ts'

const workspace = join(import.meta.dirname, '..', '..')
const migrationDirectory = join(workspace, 'infra', 'postgres', 'migrations')
const databasePath = join(tmpdir(), `xianyu-phase3-cloud-${process.pid}-${Date.now()}`)
const domains = {
  user: { issuer: 'https://user.test', audience: 'user-api', secret: 'user-phase3-secret-012345678901234567890' },
  admin: { issuer: 'https://admin.test', audience: 'admin-api', secret: 'admin-phase3-secret-012345678901234567890' },
  collector: { issuer: 'https://collector.test', audience: 'collector-api', secret: 'collector-phase3-secret-012345678901234567890' }
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
  for (const file of migrations) await db.exec(readFileSync(join(migrationDirectory, file), 'utf8'))
  return migrations
}

function deviceProof(userId, privateKey) {
  return sign(null, Buffer.from(userId), privateKey).toString('base64')
}

function devicePublicKey(keyPair) {
  return keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

async function run() {
  const db = new PGlite(databasePath)
  const sql = { query: (text, values) => db.query(text, values) }
  const userApi = createUserApi(sql, domains)
  const collectorApi = createCollectorApi(sql, domains)
  const migrations = await applyMigrations(db)

  try {
    const registered = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'collector@example.test', password: 'phase3-collector-password-123' } })
    assert(registered.statusCode === 200, `用户注册失败：${registered.statusCode} ${registered.body}`)
    const userAccess = json(registered).accessToken
    const userId = String((await db.query("SELECT id FROM identity.users WHERE email_normalized='collector@example.test'")).rows[0].id)
    await db.query(`INSERT INTO billing.entitlement_grants (id,user_id,capability,limit_value,effective_from,source,created_at)
      VALUES ($1,$2,'collector',1,now(),'phase3-test',now())`, [randomUUID(), userId])

    const keyPair = generateKeyPairSync('ed25519')
    const publicKey = devicePublicKey(keyPair)
    const unauthenticatedBind = await collectorApi.inject({
      method: 'POST',
      url: '/v1/devices/bind',
      payload: { publicKey, proof: deviceProof(userId, keyPair.privateKey), deviceName: 'phase3-device' }
    })
    assert(unauthenticatedBind.statusCode === 401, '设备绑定接受了缺失的用户授权')
    const bind = await collectorApi.inject({
      method: 'POST',
      url: '/v1/devices/bind',
      headers: auth(userAccess),
      payload: { publicKey, proof: deviceProof(userId, keyPair.privateKey), deviceName: 'phase3-device' }
    })
    assert(bind.statusCode === 200, `设备绑定失败：${bind.statusCode} ${bind.body}`)
    const bound = json(bind)
    assert(typeof bound.clientId === 'string' && typeof bound.refreshToken === 'string', '绑定没有返回采集器会话')
    const storedKey = (await db.query('SELECT device_public_key FROM identity.collector_clients WHERE id=$1', [bound.clientId])).rows[0]
    assert(storedKey.device_public_key === null, '云端不应保存设备原始公钥')

    const entitlements = await collectorApi.inject({ method: 'GET', url: '/v1/entitlements', headers: auth(bound.accessToken) })
    assert(entitlements.statusCode === 200 && json(entitlements).allowed === true, `权益校验失败：${entitlements.statusCode} ${entitlements.body}`)

    const firstRefresh = bound.refreshToken
    const refreshed = await collectorApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: firstRefresh } })
    assert(refreshed.statusCode === 200, `采集器刷新失败：${refreshed.statusCode} ${refreshed.body}`)
    const rotated = json(refreshed)
    const currentEntitlements = await collectorApi.inject({ method: 'GET', url: '/v1/entitlements', headers: auth(rotated.accessToken) })
    assert(currentEntitlements.statusCode === 200, '刷新后的 access token 无法校验权益')
    const replay = await collectorApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: firstRefresh } })
    assert(replay.statusCode === 401, '旧 refresh token 重放未拒绝')
    const descendantReplay = await collectorApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: rotated.refreshToken } })
    assert(descendantReplay.statusCode === 401, '重放旧 token 后的后代 refresh token 未撤销')

    const concurrentBind = await collectorApi.inject({
      method: 'POST',
      url: '/v1/devices/bind',
      headers: auth(userAccess),
      payload: { publicKey, proof: deviceProof(userId, keyPair.privateKey), deviceName: 'phase3-device' }
    })
    assert(concurrentBind.statusCode === 200, `并发 refresh 前重新签发失败：${concurrentBind.statusCode} ${concurrentBind.body}`)
    const concurrentSession = json(concurrentBind)
    const concurrentRefreshes = await Promise.all([
      collectorApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: concurrentSession.refreshToken } }),
      collectorApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: concurrentSession.refreshToken } })
    ])
    assert(concurrentRefreshes.filter((response) => response.statusCode === 200).length === 1, '并发 refresh 不应签发两个后代令牌')
    assert(concurrentRefreshes.filter((response) => response.statusCode === 401).length === 1, '并发 refresh 未识别重放')
    const concurrentWinner = json(concurrentRefreshes.find((response) => response.statusCode === 200))
    const concurrentDescendant = await collectorApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: concurrentWinner.refreshToken } })
    assert(concurrentDescendant.statusCode === 401, '并发重放没有撤销已签发后代')

    const rebound = await collectorApi.inject({
      method: 'POST',
      url: '/v1/devices/bind',
      headers: auth(userAccess),
      payload: { publicKey, proof: deviceProof(userId, keyPair.privateKey), deviceName: 'phase3-device' }
    })
    assert(rebound.statusCode === 200, `同设备重新签发失败：${rebound.statusCode} ${rebound.body}`)
    const reissued = json(rebound)
    assert(reissued.clientId === bound.clientId, '同一设备不应创建第二条绑定记录')
    const heartbeat = await collectorApi.inject({ method: 'POST', url: '/v1/heartbeat', headers: auth(reissued.accessToken), payload: { id: randomUUID() } })
    assert(heartbeat.statusCode === 200 && json(heartbeat).accepted === true, '设备心跳失败')

    const secondKeyPair = generateKeyPairSync('ed25519')
    const secondPublicKey = devicePublicKey(secondKeyPair)
    const secondBind = await collectorApi.inject({
      method: 'POST',
      url: '/v1/devices/bind',
      headers: auth(userAccess),
      payload: { publicKey: secondPublicKey, proof: deviceProof(userId, secondKeyPair.privateKey), deviceName: 'phase3-second-device' }
    })
    assert(secondBind.statusCode === 200, `第二台设备绑定失败：${secondBind.statusCode} ${secondBind.body}`)
    const releasedSecond = await userApi.inject({ method: 'POST', url: `/v1/collector-devices/${json(secondBind).clientId}/revoke`, headers: auth(userAccess) })
    assert(releasedSecond.statusCode === 200, '并发绑定前无法释放设备名额')

    const firstConcurrentKeyPair = generateKeyPairSync('ed25519')
    const secondConcurrentKeyPair = generateKeyPairSync('ed25519')
    const [firstConcurrentBind, secondConcurrentBind] = await Promise.all([
      collectorApi.inject({
        method: 'POST',
        url: '/v1/devices/bind',
        headers: auth(userAccess),
        payload: { publicKey: devicePublicKey(firstConcurrentKeyPair), proof: deviceProof(userId, firstConcurrentKeyPair.privateKey), deviceName: 'phase3-concurrent-device-a' }
      }),
      collectorApi.inject({
        method: 'POST',
        url: '/v1/devices/bind',
        headers: auth(userAccess),
        payload: { publicKey: devicePublicKey(secondConcurrentKeyPair), proof: deviceProof(userId, secondConcurrentKeyPair.privateKey), deviceName: 'phase3-concurrent-device-b' }
      })
    ])
    assert([firstConcurrentBind, secondConcurrentBind].filter((response) => response.statusCode === 200).length === 1, '剩余一个名额时并发绑定签发了多个设备')
    assert([firstConcurrentBind, secondConcurrentBind].filter((response) => response.statusCode === 403).length === 1, '剩余一个名额时并发绑定未拒绝超额设备')
    const activeDeviceCount = (await db.query("SELECT COUNT(*)::int AS total FROM identity.collector_clients WHERE user_id=$1 AND status='active'", [userId])).rows[0]
    assert(Number(activeDeviceCount.total) === 2, '并发绑定后激活设备超过两台')
    let duplicateActiveSlotRejected = false
    try {
      await db.query(`INSERT INTO identity.collector_clients (id,user_id,device_public_key_fingerprint,active_slot,device_name,platform,app_version,status,created_at)
        VALUES ($1,$2,'phase3-duplicate-slot',1,'phase3-duplicate-device','windows','phase3','active',now())`, [randomUUID(), userId])
    } catch {
      duplicateActiveSlotRejected = true
    }
    assert(duplicateActiveSlotRejected, '数据库未约束同一用户的 active 设备槽位')

    const suspendedKeyPair = generateKeyPairSync('ed25519')
    const suspendedPublicKey = devicePublicKey(suspendedKeyPair)
    const suspendedFingerprint = createHash('sha256').update(Buffer.from(suspendedPublicKey, 'base64')).digest('hex')
    const suspendedId = randomUUID()
    await db.query(`INSERT INTO identity.collector_clients (id,user_id,device_public_key_fingerprint,device_name,platform,app_version,status,revoked_at,created_at)
      VALUES ($1,$2,$3,'phase3-revoked-device','windows','phase3','revoked',now(),now())`, [suspendedId, userId, suspendedFingerprint])
    const limitRebind = await collectorApi.inject({
      method: 'POST',
      url: '/v1/devices/bind',
      headers: auth(userAccess),
      payload: { publicKey: suspendedPublicKey, proof: deviceProof(userId, suspendedKeyPair.privateKey), deviceName: 'phase3-revoked-device' }
    })
    assert(limitRebind.statusCode === 403, '已撤销设备在两台设备已激活时绕过了上限')
    await db.query("UPDATE identity.collector_clients SET status='blocked' WHERE id=$1", [suspendedId])
    const blockedRebind = await collectorApi.inject({
      method: 'POST',
      url: '/v1/devices/bind',
      headers: auth(userAccess),
      payload: { publicKey: suspendedPublicKey, proof: deviceProof(userId, suspendedKeyPair.privateKey), deviceName: 'phase3-blocked-device' }
    })
    assert(blockedRebind.statusCode === 403, '被封禁设备可被重新绑定')
    const blockedUnbind = await userApi.inject({ method: 'POST', url: `/v1/collector-devices/${suspendedId}/revoke`, headers: auth(userAccess) })
    assert(blockedUnbind.statusCode === 404, '被封禁设备可被用户解绑后复绑')
    const blockedState = (await db.query('SELECT status FROM identity.collector_clients WHERE id=$1', [suspendedId])).rows[0]
    assert(blockedState.status === 'blocked', '被封禁设备解绑后状态发生变化')

    const otherRegistered = await userApi.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'other@example.test', password: 'phase3-other-password-123' } })
    const crossUserRevoke = await userApi.inject({ method: 'POST', url: `/v1/collector-devices/${bound.clientId}/revoke`, headers: auth(json(otherRegistered).accessToken) })
    assert(crossUserRevoke.statusCode === 404, '其他用户可以解绑非自身设备')
    await db.query('UPDATE billing.entitlement_grants SET limit_value=0 WHERE user_id=$1', [userId])
    const zeroLimitEntitlements = await collectorApi.inject({ method: 'GET', url: '/v1/entitlements', headers: auth(reissued.accessToken) })
    assert(zeroLimitEntitlements.statusCode === 200 && json(zeroLimitEntitlements).allowed === false, '零额度权益不应允许采集')
    await db.query('UPDATE billing.entitlement_grants SET limit_value=1 WHERE user_id=$1', [userId])

    const revoked = await userApi.inject({ method: 'POST', url: `/v1/collector-devices/${bound.clientId}/revoke`, headers: auth(userAccess) })
    assert(revoked.statusCode === 200 && json(revoked).revoked === true, `用户解绑失败：${revoked.statusCode} ${revoked.body}`)
    const afterRevokeEntitlements = await collectorApi.inject({ method: 'GET', url: '/v1/entitlements', headers: auth(reissued.accessToken) })
    assert(afterRevokeEntitlements.statusCode === 403, '解绑后旧 access token 仍可继续采集')
    const afterRevokeRefresh = await collectorApi.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: reissued.refreshToken } })
    assert(afterRevokeRefresh.statusCode === 401, '解绑后旧 refresh token 仍可刷新')
    const afterRevokeHeartbeat = await collectorApi.inject({ method: 'POST', url: '/v1/heartbeat', headers: auth(reissued.accessToken), payload: { id: randomUUID() } })
    assert(afterRevokeHeartbeat.statusCode === 403, '解绑后旧设备仍可发送心跳')

    console.log(JSON.stringify({
      scenario: 'phase3-collector-device-lifecycle',
      migrations,
      assertions: {
        userHeaderAuthentication: true,
        missingUserAuthorizationRejected: true,
        deviceBinding: true,
        entitlementGate: true,
        zeroLimitEntitlementBlocked: true,
        refreshRotation: true,
        refreshReplayRevokesFamily: true,
        concurrentRefreshSingleIssue: true,
        blockedDeviceCannotRebind: true,
        blockedDeviceCannotBeUnblocked: true,
        deviceLimitIncludesRebind: true,
        concurrentNewDeviceLimit: true,
        databaseDeviceLimitConstraint: true,
        crossUserRevokeRejected: true,
        unbindRevokesAccessAndRefresh: true,
        heartbeatUsesCollectorAuthorization: true,
        rawDevicePublicKeyAbsent: true
      }
    }, null, 2))
  } finally {
    await Promise.allSettled([userApi.close(), collectorApi.close()])
    await db.close()
    if (existsSync(databasePath)) rmSync(databasePath, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ scenario: 'phase3-collector-device-lifecycle', error: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
})
