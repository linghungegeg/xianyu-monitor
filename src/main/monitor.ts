import { app, safeStorage } from 'electron'
import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import type { LauncherStatus } from '../shared/types'
import { MonitorDatabase } from './database'

const GOOFISH_HOME = process.env.XIANYU_LOGIN_URL ?? 'https://www.goofish.com/'
const REQUEST_TIMEOUT_MS = 10_000
const TOKEN_RENEW_WINDOW_MS = 2 * 60_000
const SCHEDULER_INTERVAL_MS = 60_000
const STATE_REFRESH_TOKEN = 'collector.refresh-token'
const STATE_PRIVATE_KEY = 'collector.device-private-key'
const STATE_PUBLIC_KEY = 'collector.device-public-key'

type TokenResponse = { accessToken?: string; refreshToken?: string; clientId?: string }
type EntitlementResponse = { allowed?: boolean }
type DeviceKey = { publicKey: string; privateKey: ReturnType<typeof createPrivateKey> }

class CloudRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function apiBase(value: string, name: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name} 必须是 HTTP(S) 地址`)
  return url.toString().replace(/\/$/, '')
}

function responseMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const error = (payload as { error?: unknown }).error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return String((error as { message: string }).message)
  return fallback
}

function tokenExpiresSoon(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number }
    return !payload.exp || payload.exp * 1_000 - Date.now() <= TOKEN_RENEW_WINDOW_MS
  } catch {
    return true
  }
}

function tokenSubject(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string }
    if (payload.sub) return payload.sub
  } catch {
    // The cloud validates this token; parsing here only supplies the bind proof subject.
  }
  throw new Error('云端登录响应无效，请重新登录')
}

export class XianyuMonitor {
  private readonly userApiBase = apiBase(process.env.COLLECTOR_USER_API_URL ?? 'https://user-api.placeholder.invalid', 'User API 地址')
  private readonly collectorApiBase = apiBase(process.env.COLLECTOR_API_URL ?? 'https://collector-api.placeholder.invalid', 'Collector API 地址')
  private context: BrowserContext | undefined
  private timer: NodeJS.Timeout | undefined
  private accessToken: string | undefined
  private running = false
  private state: LauncherStatus = { session: 'signed-out', browser: 'idle', entitled: false, message: '请登录本系统账号并完成设备绑定' }

  constructor(private readonly db: MonitorDatabase, private readonly publish: (status: LauncherStatus) => void) {}

  status(): LauncherStatus {
    return this.state
  }

  async restore(): Promise<void> {
    if (!this.db.getState(STATE_REFRESH_TOKEN)) return
    this.updateStatus('checking', '正在恢复本机设备授权', false)
    try {
      await this.refreshCollectorSession()
      const allowed = await this.checkEntitlements()
      this.updateStatus(allowed ? 'ready' : 'paused', allowed ? '设备已绑定，等待启动采集' : '当前账号没有可用采集权益', allowed)
    } catch (error) {
      if (this.isNetworkError(error)) {
        this.updateStatus('offline', '无法连接云端，恢复网络后将重新校验授权', false)
        return
      }
      this.clearSession()
      this.updateStatus('signed-out', '本机授权已失效，请重新登录并绑定设备', false)
    }
  }

  async login(email: string, password: string): Promise<void> {
    if (!email.trim() || !password) throw new Error('请输入账号和密码')
    this.requireEncryption()
    this.updateStatus('checking', '正在验证账号并绑定本机设备', false)
    try {
      const userSession = await this.request<TokenResponse>(this.userApiBase, '/v1/auth/login', { method: 'POST', body: { email: email.trim(), password } })
      if (!userSession.accessToken) throw new Error('云端未返回登录授权')
      const deviceKey = this.getOrCreateDeviceKey()
      const bound = await this.request<TokenResponse>(this.collectorApiBase, '/v1/devices/bind', {
        method: 'POST',
        token: userSession.accessToken,
        body: {
          publicKey: deviceKey.publicKey,
          proof: sign(null, Buffer.from(tokenSubject(userSession.accessToken)), deviceKey.privateKey).toString('base64'),
          deviceName: app.getName()
        }
      })
      if (!bound.accessToken || !bound.refreshToken || !bound.clientId) throw new Error('云端未返回采集器授权')
      this.storeCollectorSession(bound)
      const allowed = await this.checkEntitlements()
      this.db.addLog('success', '本机设备绑定完成')
      this.updateStatus(allowed ? 'ready' : 'paused', allowed ? '设备已绑定，等待启动采集' : '当前账号没有可用采集权益', allowed)
    } catch (error) {
      const message = this.safeMessage(error, '账号登录或设备绑定失败')
      this.updateStatus('error', message, false)
      throw new Error(message)
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    this.db.enqueueHeartbeat({ id: randomUUID(), observedAt: new Date().toISOString(), appVersion: app.getVersion() })
    try {
      await this.ensureAuthorized()
      this.running = true
      this.startTimer()
      await this.flushOutbox()
      this.db.addLog('success', '采集器已启动')
      this.updateStatus('running', '采集器正在运行', true)
    } catch (error) {
      this.stopTimer()
      const message = this.handleRuntimeError(error)
      throw new Error(message)
    }
  }

  pause(): void {
    if (!this.running) return
    this.running = false
    this.stopTimer()
    this.db.addLog('info', '采集器已暂停')
    this.updateStatus('paused', '采集器已暂停', this.state.entitled)
  }

  async openLogin(): Promise<void> {
    try {
      await this.ensureAuthorized()
      const page = await this.openPage()
      await page.goto(GOOFISH_HOME, { waitUntil: 'domcontentloaded' }).catch(() => {
        throw new Error('无法打开闲鱼登录页，请检查网络后重试')
      })
      await page.bringToFront()
      this.db.addLog('info', '已打开本机 Chrome，请完成闲鱼扫码登录')
      this.updateStatus(this.running ? 'running' : 'ready', '请在本机 Chrome 完成闲鱼扫码登录', true)
    } catch (error) {
      const message = this.handleRuntimeError(error)
      throw new Error(message)
    }
  }

  async unbind(): Promise<void> {
    try {
      await this.ensureAccessToken()
      await this.request(this.collectorApiBase, '/v1/devices/unbind', { method: 'POST', token: this.accessToken })
      this.pause()
      this.clearSession()
      this.db.addLog('info', '本机设备已解绑')
      this.updateStatus('signed-out', '本机设备已解绑', false)
    } catch (error) {
      const message = this.safeMessage(error, '设备解绑失败')
      this.updateStatus('error', message, false)
      throw new Error(message)
    }
  }

  async shutdown(): Promise<void> {
    this.pause()
    if (this.context) await this.context.close().catch(() => undefined)
    this.context = undefined
    this.db.close()
  }

  private startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(() => void this.tick(), SCHEDULER_INTERVAL_MS)
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    if (!this.running) return
    try {
      await this.ensureAuthorized()
      this.db.enqueueHeartbeat({ id: randomUUID(), observedAt: new Date().toISOString(), appVersion: app.getVersion() })
      await this.flushOutbox()
    } catch (error) {
      this.stopTimer()
      this.running = false
      this.handleRuntimeError(error)
    }
  }

  private async ensureAuthorized(): Promise<void> {
    await this.ensureAccessToken()
    const allowed = await this.checkEntitlements()
    if (!allowed) throw new Error('当前账号没有可用采集权益')
  }

  private async ensureAccessToken(): Promise<void> {
    if (!this.accessToken || tokenExpiresSoon(this.accessToken)) await this.refreshCollectorSession()
  }

  private async refreshCollectorSession(): Promise<void> {
    const refreshToken = this.readSecret(STATE_REFRESH_TOKEN)
    if (!refreshToken) throw new Error('本机没有可用的设备授权')
    const refreshed = await this.request<TokenResponse>(this.collectorApiBase, '/v1/auth/refresh', { method: 'POST', body: { refreshToken } })
    if (!refreshed.accessToken || !refreshed.refreshToken) throw new Error('云端未返回刷新授权')
    this.storeCollectorSession(refreshed)
  }

  private async checkEntitlements(): Promise<boolean> {
    if (!this.accessToken) throw new Error('本机没有可用的设备授权')
    const entitlements = await this.request<EntitlementResponse>(this.collectorApiBase, '/v1/entitlements', { token: this.accessToken })
    return entitlements.allowed === true
  }

  private async flushOutbox(): Promise<void> {
    for (const entry of this.db.listDueOutbox()) {
      try {
        await this.request(this.collectorApiBase, '/v1/heartbeat', { method: 'POST', token: this.accessToken, body: entry.payload })
        this.db.completeOutbox(entry.id)
      } catch (error) {
        this.db.deferOutbox(entry.id, entry.attempts + 1)
        if (!this.isRetryableOutboxError(error)) throw error
        return
      }
    }
  }

  private async openPage(): Promise<Page> {
    if (!this.context) {
      const profileDir = join(app.getPath('userData'), 'xianyu-chrome-profile')
      mkdirSync(profileDir, { recursive: true })
      try {
        this.context = await chromium.launchPersistentContext(profileDir, {
          channel: 'chrome',
          headless: false,
          viewport: { width: 1280, height: 900 }
        })
      } catch {
        this.updateBrowser('error')
        throw new Error('未找到可用的系统 Google Chrome。请安装官方 Chrome 后重试。')
      }
      this.context.on('close', () => {
        this.context = undefined
        this.updateBrowser('idle')
      })
      this.updateBrowser('open')
    }
    return this.context.pages()[0] ?? this.context.newPage()
  }

  private getOrCreateDeviceKey(): DeviceKey {
    const privatePem = this.readSecret(STATE_PRIVATE_KEY)
    const publicKey = this.db.getState(STATE_PUBLIC_KEY)
    if (privatePem && publicKey) return { privateKey: createPrivateKey(privatePem), publicKey }
    if (privatePem || publicKey) throw new Error('本机设备密钥不完整，请重新登录后绑定')
    const pair = generateKeyPairSync('ed25519')
    const generatedPublicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const generatedPrivateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    this.writeSecret(STATE_PRIVATE_KEY, generatedPrivateKey)
    this.db.setState(STATE_PUBLIC_KEY, generatedPublicKey)
    return { privateKey: createPrivateKey(generatedPrivateKey), publicKey: generatedPublicKey }
  }

  private storeCollectorSession(session: TokenResponse): void {
    if (!session.accessToken || !session.refreshToken) throw new Error('云端未返回采集器授权')
    this.accessToken = session.accessToken
    this.writeSecret(STATE_REFRESH_TOKEN, session.refreshToken)
  }

  private clearSession(): void {
    this.accessToken = undefined
    this.db.deleteState(STATE_REFRESH_TOKEN)
  }

  private requireEncryption(): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储不可用，无法安全保存设备授权')
  }

  private readSecret(key: string): string | null {
    const stored = this.db.getState(key)
    if (!stored) return null
    this.requireEncryption()
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      throw new Error('本机安全存储无法读取设备授权')
    }
  }

  private writeSecret(key: string, value: string): void {
    this.requireEncryption()
    this.db.setState(key, safeStorage.encryptString(value).toString('base64'))
  }

  private async request<T = Record<string, unknown>>(baseUrl: string, path: string, options: { method?: 'GET' | 'POST'; token?: string; body?: unknown } = {}): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new CloudRequestError(response.status, responseMessage(payload, '云端请求失败'))
      return payload as T
    } catch (error) {
      if (error instanceof CloudRequestError) throw error
      throw new CloudRequestError(0, '无法连接云端')
    } finally {
      clearTimeout(timeout)
    }
  }

  private handleRuntimeError(error: unknown): string {
    this.running = false
    if (this.isNetworkError(error)) {
      this.updateStatus('offline', '网络不可用，采集已暂停；恢复网络后可重新启动', false)
      this.db.addLog('error', '网络不可用，采集已暂停')
      return '网络不可用，采集已暂停；恢复网络后可重新启动'
    }
    const remoteMessage = error instanceof CloudRequestError ? error.message : ''
    if (remoteMessage.includes('撤销') || remoteMessage.includes('会话已失效') || remoteMessage.includes('刷新令牌重放')) {
      this.clearSession()
      this.updateStatus('revoked', '本机设备授权已失效，采集已停止', false)
      this.db.addLog('error', '本机设备授权已失效，采集已停止')
      return '本机设备授权已失效，请重新登录并绑定设备'
    }
    const message = this.safeMessage(error, '云端授权校验失败')
    if (message.startsWith('未找到可用的系统 Google Chrome') || message.startsWith('无法打开闲鱼登录页')) {
      this.updateStatus('error', message, this.state.entitled)
      this.db.addLog('error', message.startsWith('未找到') ? '系统 Google Chrome 不可用' : '闲鱼登录页无法打开')
      return message
    }
    if (message.includes('权益')) {
      this.updateStatus('paused', '当前账号没有可用采集权益', false)
      this.db.addLog('error', '当前账号没有可用采集权益')
      return '当前账号没有可用采集权益'
    }
    this.updateStatus('error', '云端授权校验失败，请稍后重试', false)
    this.db.addLog('error', '云端授权校验失败')
    return '云端授权校验失败，请稍后重试'
  }

  private safeMessage(error: unknown, fallback: string): string {
    if (error instanceof CloudRequestError) {
      if (error.status === 0) return '无法连接云端，请检查网络后重试'
      if (error.message === '账号或密码错误' || error.message === '设备数量已达上限' || error.message === '设备已被封禁') return error.message
    }
    if (error instanceof Error && (
      error.message === '当前账号没有可用采集权益' ||
      error.message === '本机没有可用的设备授权' ||
      error.message.startsWith('未找到可用的系统 Google Chrome') ||
      error.message.startsWith('无法打开闲鱼登录页') ||
      error.message.startsWith('本机设备密钥不完整')
    )) return error.message
    if (error instanceof Error && error.message.startsWith('Windows 安全存储')) return error.message
    return fallback
  }

  private isNetworkError(error: unknown): boolean {
    return error instanceof CloudRequestError && error.status === 0
  }

  private isRetryableOutboxError(error: unknown): boolean {
    return this.isNetworkError(error) || (error instanceof CloudRequestError && error.status >= 500)
  }

  private updateBrowser(browser: LauncherStatus['browser']): void {
    this.state = { ...this.state, browser }
    this.publish(this.state)
  }

  private updateStatus(session: LauncherStatus['session'], message: string, entitled: boolean): void {
    this.state = { session, browser: this.state.browser, entitled, message }
    this.publish(this.state)
  }
}
