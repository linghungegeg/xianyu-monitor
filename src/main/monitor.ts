import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import type { MonitorStatus, MonitorTask, ScanSummary, SearchItem } from '../shared/types'
import { MonitorDatabase } from './database'

const GOOFISH_HOME = 'https://www.goofish.com/'
const REGION_PATTERN = /(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)/

type PageItem = Omit<SearchItem, 'taskId' | 'firstSeenAt' | 'lastSeenAt' | 'isNew'>

export class XianyuMonitor {
  private context: BrowserContext | undefined
  private timer: NodeJS.Timeout | undefined
  private nextScanAt: string | null = null
  private state: MonitorStatus = { chrome: 'idle', message: 'Chrome 尚未启动', nextScanAt: null }

  constructor(private readonly db: MonitorDatabase, private readonly publish: (status: MonitorStatus) => void) {}

  status(): MonitorStatus {
    return this.state
  }

  async openLogin(): Promise<void> {
    const page = await this.openPage()
    await page.goto(GOOFISH_HOME, { waitUntil: 'domcontentloaded' })
    await page.bringToFront()
    this.updateStatus('login-required', '请在专用 Chrome 窗口完成闲鱼扫码登录')
    this.db.addLog('info', '已打开专用 Chrome，等待手动扫码登录')
  }

  async scanTask(task: MonitorTask): Promise<ScanSummary> {
    const page = await this.openPage()
    this.updateStatus('running', `正在搜索：${task.keyword}`)
    try {
      await page.goto(`https://www.goofish.com/search?q=${encodeURIComponent(task.keyword)}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2500)
      const items = await this.readSearchItems(page)
      if (items.length === 0 && await this.hasLoginPrompt(page)) {
        this.updateStatus('login-required', '登录状态已失效，请重新扫码')
        this.db.addLog('error', '搜索未返回商品，检测到登录提示', task.id)
        return { scanned: 0, newItems: 0 }
      }

      let newItems = 0
      for (const item of items) {
        if (!this.matchesTask(item, task)) continue
        if (this.db.upsertItem({ ...item, taskId: task.id })) newItems += 1
      }
      this.db.markTaskScanned(task.id)
      this.db.addLog('success', `“${task.keyword}” 扫描完成：${items.length} 条，新增 ${newItems} 条`, task.id)
      this.updateStatus('idle', `最近扫描完成：${task.keyword}`)
      return { scanned: items.length, newItems }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      this.db.addLog('error', `“${task.keyword}” 扫描失败：${message}`, task.id)
      this.updateStatus('error', '扫描失败，请查看运行日志')
      throw error
    }
  }

  startScheduler(getTasks: () => MonitorTask[]): void {
    this.stopScheduler()
    const tick = async (): Promise<void> => {
      const now = Date.now()
      const tasks = getTasks().filter((task) => task.enabled)
      for (const task of tasks) {
        const due = new Date(task.lastScannedAt ?? task.updatedAt).getTime() + task.intervalMinutes * 60_000
        if (due <= now) await this.scanTask(task).catch(() => undefined)
      }
      this.nextScanAt = tasks.length ? new Date(now + 60_000).toISOString() : null
      this.updateStatus(this.state.chrome === 'error' ? 'error' : 'idle', this.state.message)
    }
    this.timer = setInterval(() => void tick(), 60_000)
    void tick()
  }

  stopScheduler(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.nextScanAt = null
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
        this.updateStatus('error', '未找到可用的 Google Chrome，请安装 Chrome 后重试')
        throw new Error('无法启动 Google Chrome。请安装官方 Chrome 后再使用监控。')
      }
      this.context.on('close', () => {
        this.context = undefined
        this.updateStatus('idle', '专用 Chrome 已关闭')
      })
      this.db.addLog('info', '已启动专用 Chrome Profile')
    }
    const page = this.context.pages()[0] ?? await this.context.newPage()
    return page
  }

  private async hasLoginPrompt(page: Page): Promise<boolean> {
    return (await page.getByText('登录', { exact: true }).count()) > 0
  }

  private async readSearchItems(page: Page): Promise<PageItem[]> {
    const anchors = page.locator('a[href*="/item?id="]')
    await anchors.first().waitFor({ state: 'visible', timeout: 12_000 }).catch(() => undefined)
    const entries = await anchors.evaluateAll((nodes) => nodes.map((node) => ({
      href: (node as HTMLAnchorElement).href,
      text: (node.textContent || '').replace(/\s+/g, ' ').trim()
    })))
    const unique = new Map<string, PageItem>()
    for (const entry of entries) {
      const url = new URL(entry.href)
      const itemId = url.searchParams.get('id')
      if (!itemId || !entry.text) continue
      const priceMatch = entry.text.match(/¥\s*(\d+(?:\.\d+)?)/)
      const wantMatch = entry.text.match(/(\d+)人想要/)
      const publishedMatch = entry.text.match(/(\d+(?:分钟|小时|天|月)前(?:发布|降价)|刚刚发布|累计降价[^\s]+)/)
      const regionMatch = entry.text.match(REGION_PATTERN)
      const title = entry.text.split(/¥\s*\d/)[0].trim().slice(0, 300)
      unique.set(itemId, {
        itemId,
        title,
        price: priceMatch ? Number(priceMatch[1]) : null,
        region: regionMatch?.[1] ?? null,
        publishedText: publishedMatch?.[1] ?? null,
        wantCount: wantMatch ? Number(wantMatch[1]) : null,
        url: url.toString()
      })
    }
    return [...unique.values()]
  }

  private matchesTask(item: PageItem, task: MonitorTask): boolean {
    if (task.minPrice !== null && (item.price === null || item.price < task.minPrice)) return false
    if (task.maxPrice !== null && (item.price === null || item.price > task.maxPrice)) return false
    if (task.region && item.region !== task.region) return false
    return true
  }

  private updateStatus(chrome: MonitorStatus['chrome'], message: string): void {
    this.state = { chrome, message, nextScanAt: this.nextScanAt }
    this.publish(this.state)
  }
}
