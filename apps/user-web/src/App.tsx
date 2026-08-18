import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Activity, Bell, Bot, ChevronLeft, ChevronRight, ClipboardList,
  ExternalLink, FileSearch, Filter, Fish, Gauge, LayoutDashboard, LogOut, Menu, MoreHorizontal, PanelLeft, PanelLeftClose,
  PackageSearch, Pause, Pencil, Play, Plus, RefreshCw, Save, Search, Settings, ShieldCheck, SlidersHorizontal, Store, Trash2, X
} from 'lucide-react'
import {
  UserApiClient, UserApiError, readUserRuntimeConfig, type UserIdentity, type UserListRequest,
  type UserListResource, type UserPage, type MonitorTask, type MonitorTaskInput, type MonitorTaskRule,
  type MonitorTaskSort, type MonitorTaskStatus, type SellerEvent, type SellerItem, type SellerItemState,
  type SellerMonitor, type SellerMonitorInput, type SellerMonitorProfile, type SellerMonitorStatus, type SellerProfile
} from './api'

type PageKey = 'dashboard' | 'monitors' | 'sellers' | 'pool' | 'discoveries' | 'events' | 'logs' | 'ai' | 'settings'
type RowKind = Exclude<PageKey, 'dashboard' | 'settings'>
type Status = '正常' | '关注' | '已暂停' | '已处理' | '待处理'
type SortKey = 'updated_at_desc' | 'priority_desc' | 'title_asc'
type MonitorForm = {
  keyword: string
  categoryPath: string
  sort: MonitorTaskSort
  minPrice: string
  maxPrice: string
  region: string
  condition: string
  delivery: string
  shipping: string
  guarantee: string
  newOnly: string
  includeWords: string
  excludeWords: string
  pageLimit: string
  intervalSeconds: string
  status: MonitorTaskStatus
}

type SellerMonitorForm = {
  target: string
  intervalSeconds: string
  status: SellerMonitorStatus
}

type SellerTarget = {
  sellerId?: string
  platformSellerId: string
}

type TableRow = {
  id: string
  title: string
  subtitle: string
  metric: string
  updatedAt: string
  status: Status
  tag: string
  sellerTarget?: SellerTarget
}

const runtime = readUserRuntimeConfig()

const pages: Array<{ key: PageKey; label: string; icon: typeof Gauge }> = [
  { key: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
  { key: 'monitors', label: '我的监控', icon: Gauge },
  { key: 'sellers', label: '竞品商家', icon: Store },
  { key: 'pool', label: '市场商品', icon: PackageSearch },
  { key: 'discoveries', label: '市场发现', icon: FileSearch },
  { key: 'events', label: '事件中心', icon: Bell },
  { key: 'logs', label: '动态日志', icon: ClipboardList },
  { key: 'ai', label: 'AI 分析', icon: Bot },
  { key: 'settings', label: '账户设置', icon: Settings }
]

const pageCopy: Record<RowKind, { title: string; description: string; primary: string; columns: [string, string, string, string] }> = {
  monitors: { title: '我的监控', description: '查看关键词、分类和价格区间产生的市场变化。', primary: '新建监控', columns: ['监控条件', '最新命中', '本次变化', '状态'] },
  sellers: { title: '竞品商家', description: '跟踪已关注商家的公开商品与经营动态。', primary: '添加商家', columns: ['商家', '公开商品', '动态摘要', '状态'] },
  pool: { title: '市场商品池', description: '按条件查询已进入公共市场范围的商品快照。', primary: '保存筛选', columns: ['商品', '当前价格', '市场信号', '状态'] },
  discoveries: { title: '市场发现', description: '浏览按筛选条件整理出的近期市场机会。', primary: '新建筛选', columns: ['发现主题', '样本范围', '信号摘要', '状态'] },
  events: { title: '事件中心', description: '统一处理价格、上架、下架和卖家变化事件。', primary: '标为已读', columns: ['事件', '关联对象', '变化内容', '状态'] },
  logs: { title: '动态日志', description: '按对象、类型和时间筛选工作台可见的业务动态。', primary: '导出当前页', columns: ['动态', '对象', '记录内容', '状态'] },
  ai: { title: 'AI 分析', description: '阅读已发布的市场解读与竞品分析结果。', primary: '创建分析请求', columns: ['分析主题', '数据范围', '结论摘要', '状态'] }
}

const pageResources: Record<RowKind, UserListResource> = {
  monitors: 'monitors',
  sellers: 'sellers',
  pool: 'pool',
  discoveries: 'discoveries',
  events: 'events',
  logs: 'logs',
  ai: 'ai'
}

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: 'updated_at_desc', label: '最近更新' },
  { value: 'priority_desc', label: '优先级' },
  { value: 'title_asc', label: '名称' }
]

const bases: Record<RowKind, Omit<TableRow, 'id' | 'updatedAt'>[]> = {
  monitors: [
    { title: 'MacBook Air M2 16G', subtitle: '全国 · 3500-5500 元 · 每 15 分钟', metric: '新增 8 条，降价 3 条', status: '正常', tag: '关键词' },
    { title: '索尼 A7M4 机身', subtitle: '上海 / 杭州 · 9000-14000 元 · 每 30 分钟', metric: '新增 2 条，降价 1 条', status: '关注', tag: '价格区间' },
    { title: '任天堂 Switch OLED', subtitle: '全国 · 1200-1900 元 · 每 30 分钟', metric: '新增 11 条，降价 0 条', status: '正常', tag: '关键词' }
  ],
  sellers: [
    { title: '海风数码回收店', subtitle: '杭州 · 1,284 个公开商品 · 92% 好评', metric: '上新 6 件，调价 4 件', status: '关注', tag: '数码' },
    { title: '小陈的相机柜', subtitle: '上海 · 346 个公开商品 · 89% 好评', metric: '上新 1 件，已下架 2 件', status: '正常', tag: '摄影' },
    { title: '北城潮玩仓', subtitle: '北京 · 775 个公开商品 · 95% 好评', metric: '上新 12 件，调价 0 件', status: '正常', tag: '潮玩' }
  ],
  pool: [
    { title: 'MacBook Air 13 M2 16G 512G', subtitle: '杭州 · 个人闲置 · 2 小时前', metric: '¥4,280 · 26 人想要', status: '关注', tag: '笔记本', sellerTarget: { platformSellerId: 'demo-macbook-seller' } },
    { title: 'Sony A7M4 全画幅微单机身', subtitle: '上海 · 验货宝 · 38 分钟前', metric: '¥12,480 · 8 人想要', status: '正常', tag: '相机', sellerTarget: { platformSellerId: 'demo-camera-seller' } },
    { title: 'Switch OLED 白色国行', subtitle: '广州 · 包邮 · 1 小时前', metric: '¥1,365 · 17 人想要', status: '正常', tag: '游戏机', sellerTarget: { platformSellerId: 'demo-switch-seller' } }
  ],
  discoveries: [
    { title: '轻薄本周末价格带下移', subtitle: '笔记本电脑 · 全国 · 近 24 小时', metric: 'P50 下降 4.8%，样本 186', status: '待处理', tag: '价格' },
    { title: '二手微单新上架加速', subtitle: '摄影摄像 · 上海 / 杭州 · 近 12 小时', metric: '新上架 +31%，样本 74', status: '关注', tag: '上新' },
    { title: '掌机需求热度回升', subtitle: '游戏机 · 全国 · 近 7 天', metric: '想要数 +18%，样本 1,042', status: '正常', tag: '热度' }
  ],
  events: [
    { title: '价格下调', subtitle: 'MacBook Air M2 16G 512G', metric: '¥4,580 降至 ¥4,280 (-6.5%)', status: '待处理', tag: '价格' },
    { title: '竞品商家上新', subtitle: '海风数码回收店', metric: '新上架 6 件笔记本商品', status: '关注', tag: '商家' },
    { title: '商品已下架', subtitle: 'Sony A7M4 全画幅微单机身', metric: '最近一次公开快照已不可见', status: '已处理', tag: '商品' }
  ],
  logs: [
    { title: '监控条件完成一次检查', subtitle: 'MacBook Air M2 16G', metric: '发现 8 个新增公共商品快照', status: '正常', tag: '监控' },
    { title: '竞品商家变更已归档', subtitle: '小陈的相机柜', metric: '公开在售数 348 变为 346', status: '正常', tag: '商家' },
    { title: '市场筛选已更新', subtitle: '轻薄本价格带', metric: '为 186 个样本重新计算分位数', status: '正常', tag: '市场' }
  ],
  ai: [
    { title: '轻薄本价格带周报', subtitle: '笔记本电脑 · 全国 · 最近 7 天', metric: '低价端供给增加，成交热度保持平稳', status: '正常', tag: '市场' },
    { title: '海风数码回收店经营动态', subtitle: '竞品商家 · 最近 30 天', metric: '上新集中在周五，价格调整滞后约 6 小时', status: '关注', tag: '商家' },
    { title: '相机机身机会筛选', subtitle: '摄影摄像 · 上海 / 杭州 · 最近 72 小时', metric: '识别 3 个可复查的低于中位价格样本', status: '正常', tag: '机会' }
  ]
}

function makeRows(kind: RowKind): TableRow[] {
  return Array.from({ length: 31 }, (_, index) => {
    const base = bases[kind][index % bases[kind].length]
    const hour = String(9 + (index % 10)).padStart(2, '0')
    return { ...base, id: `${kind}-${index + 1}`, title: index < 3 ? base.title : `${base.title} · ${index + 1}`, updatedAt: `今天 ${hour}:${String((index * 7) % 60).padStart(2, '0')}` }
  })
}

const statusClass: Record<Status, string> = { 正常: 'ok', 关注: 'watch', 已暂停: 'muted', 已处理: 'done', 待处理: 'pending' }

function demoOffset(cursor: string | null): number {
  const match = cursor ? /^demo:(\d+)$/.exec(cursor) : null
  return match ? Number(match[1]) : 0
}

function demoPage(kind: RowKind, request: UserListRequest): Promise<UserPage<TableRow>> {
  return new Promise((resolve) => window.setTimeout(() => {
    const query = request.filters.q?.trim().toLowerCase() ?? ''
    const status = request.filters.status ?? ''
    let rows = makeRows(kind).filter((row) => {
      const matchesQuery = !query || `${row.title}${row.subtitle}${row.metric}`.toLowerCase().includes(query)
      const matchesStatus = !status || row.status === status
      return matchesQuery && matchesStatus
    })
    if (request.sort === 'title_asc') rows = [...rows].sort((left, right) => left.title.localeCompare(right.title))
    if (request.sort === 'priority_desc') rows = [...rows].sort((left, right) => Number(right.status === '待处理') - Number(left.status === '待处理'))
    const offset = demoOffset(request.cursor)
    const items = rows.slice(offset, offset + request.limit)
    const nextOffset = offset + items.length
    resolve({ items, total: rows.length, nextCursor: nextOffset < rows.length ? `demo:${nextOffset}` : null, hasMore: nextOffset < rows.length })
  }, 180))
}

function recordValue(record: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) if (typeof record[key] === 'string' && record[key]) return record[key] as string
  return fallback
}

function normalizeStatus(value: string): Status {
  if (value === '正常' || value === '关注' || value === '已暂停' || value === '已处理' || value === '待处理') return value
  if (value === 'pending' || value === 'open' || value === 'warning') return '待处理'
  if (value === 'paused' || value === 'disabled' || value === 'offline') return '已暂停'
  if (value === 'done' || value === 'resolved' || value === 'read') return '已处理'
  return '正常'
}

function normalizeApiRow(value: unknown, kind: RowKind, index: number): TableRow {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const id = recordValue(record, ['id', 'key'], `${kind}-${index + 1}`)
  const platformSellerId = recordValue(record, ['platformSellerId', 'platform_seller_id'], '')
  const sellerId = recordValue(record, ['sellerId', 'seller_id'], '')
  return {
    id,
    title: recordValue(record, ['title', 'name', 'subject'], id),
    subtitle: recordValue(record, ['subtitle', 'description', 'scope', 'region'], '暂无说明'),
    metric: recordValue(record, ['metric', 'summary', 'value', 'detail'], '暂无摘要'),
    updatedAt: recordValue(record, ['updatedAt', 'updated_at', 'occurredAt', 'occurred_at'], '最近更新未知'),
    status: normalizeStatus(recordValue(record, ['status', 'state'], '正常')),
    tag: recordValue(record, ['tag', 'type', 'eventType', 'event_type'], kind),
    ...(kind === 'pool' && platformSellerId ? { sellerTarget: { platformSellerId, ...(sellerId ? { sellerId } : {}) } } : {})
  }
}

const monitorSortOptions: Array<{ value: MonitorTaskSort; label: string }> = [
  { value: 'comprehensive', label: '综合排序' },
  { value: 'newly_reduced', label: '最新降价' },
  { value: 'newly_published', label: '最新发布' },
  { value: 'price_asc', label: '价格从低到高' },
  { value: 'price_desc', label: '价格从高到低' }
]

const demoMonitorTasks: MonitorTask[] = [
  {
    id: 'demo-monitor-1',
    rule: { keyword: 'MacBook Air M2', categoryPath: ['数码', '电脑'], sort: 'newly_reduced', minPrice: 3500, maxPrice: 5500, region: '全国', includeWords: ['16G'], excludeWords: ['维修'], pageLimit: 3 },
    ruleVersion: 1,
    intervalSeconds: 900,
    status: 'active',
    nextRunAt: '',
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z'
  },
  {
    id: 'demo-monitor-2',
    rule: { keyword: '索尼 A7M4', categoryPath: ['数码', '摄影摄像'], sort: 'comprehensive', minPrice: 9000, maxPrice: 14000, region: '上海', filters: { guarantee: '验货宝' }, pageLimit: 2 },
    ruleVersion: 1,
    intervalSeconds: 1800,
    status: 'paused',
    nextRunAt: '',
    createdAt: '2026-08-17T09:00:00.000Z',
    updatedAt: '2026-08-17T09:00:00.000Z'
  }
]

const demoSellerMonitors: SellerMonitor[] = [
  {
    id: 'demo-seller-monitor-1', sellerId: 'demo-seller-1', platform: 'goofish', platformSellerId: 'haifeng-digital', profileUrl: 'https://www.goofish.com/user/haifeng-digital', publicName: '海风数码回收店', region: '杭州', ruleVersion: 1, intervalSeconds: 900, status: 'active', nextRunAt: '', createdAt: '2026-08-18T09:00:00.000Z', updatedAt: '2026-08-18T09:00:00.000Z'
  },
  {
    id: 'demo-seller-monitor-2', sellerId: 'demo-seller-2', platform: 'goofish', platformSellerId: 'chen-camera', profileUrl: 'https://www.goofish.com/user/chen-camera', publicName: '小陈的相机柜', region: '上海', ruleVersion: 1, intervalSeconds: 1800, status: 'paused', nextRunAt: '', createdAt: '2026-08-17T09:00:00.000Z', updatedAt: '2026-08-17T09:00:00.000Z'
  }
]

const demoSellerProfiles: Record<string, SellerProfile> = {
  'demo-seller-1': { id: 'demo-seller-1', platform: 'goofish', platformSellerId: 'haifeng-digital', publicName: '海风数码回收店', region: '杭州', firstSeenAt: '2026-08-01T09:00:00.000Z', lastSeenAt: '2026-08-18T09:00:00.000Z' },
  'demo-seller-2': { id: 'demo-seller-2', platform: 'goofish', platformSellerId: 'chen-camera', publicName: '小陈的相机柜', region: '上海', firstSeenAt: '2026-08-02T09:00:00.000Z', lastSeenAt: '2026-08-17T09:00:00.000Z' }
}

const demoSellerItems: Record<string, SellerItem[]> = {
  'demo-seller-1': [
    { id: 'demo-item-501', platform: 'goofish', platformItemId: '501', state: 'active', firstSeenAt: '2026-08-10T09:00:00.000Z', lastSeenAt: '2026-08-18T09:00:00.000Z' },
    { id: 'demo-item-502', platform: 'goofish', platformItemId: '502', state: 'sold', firstSeenAt: '2026-08-09T09:00:00.000Z', lastSeenAt: '2026-08-17T08:00:00.000Z' },
    { id: 'demo-item-503', platform: 'goofish', platformItemId: '503', state: 'offline', firstSeenAt: '2026-08-08T09:00:00.000Z', lastSeenAt: '2026-08-16T08:00:00.000Z' }
  ],
  'demo-seller-2': [
    { id: 'demo-item-601', platform: 'goofish', platformItemId: '601', state: 'active', firstSeenAt: '2026-08-11T09:00:00.000Z', lastSeenAt: '2026-08-18T08:00:00.000Z' }
  ]
}

const demoSellerEvents: Record<string, SellerEvent[]> = {
  'demo-seller-1': [
    { id: 'demo-event-1', itemId: 'demo-item-501', sellerId: 'demo-seller-1', eventType: 'price_changed', eventKey: 'demo-price-1', occurredAt: '2026-08-18T08:00:00.000Z', detectedAt: '2026-08-18T08:05:00.000Z' },
    { id: 'demo-event-2', itemId: 'demo-item-502', sellerId: 'demo-seller-1', eventType: 'state_changed', eventKey: 'demo-state-1', occurredAt: '2026-08-17T08:00:00.000Z', detectedAt: '2026-08-17T08:05:00.000Z' }
  ],
  'demo-seller-2': []
}

function emptyMonitorForm(): MonitorForm {
  return {
    keyword: '', categoryPath: '', sort: 'comprehensive', minPrice: '', maxPrice: '', region: '',
    condition: '', delivery: '', shipping: '', guarantee: '', newOnly: '', includeWords: '', excludeWords: '',
    pageLimit: '2', intervalSeconds: '900', status: 'active'
  }
}

function emptySellerMonitorForm(): SellerMonitorForm {
  return { target: '', intervalSeconds: '900', status: 'active' }
}

function monitorFormFromTask(task: MonitorTask): MonitorForm {
  const filters = task.rule.filters ?? {}
  return {
    keyword: task.rule.keyword ?? '',
    categoryPath: task.rule.categoryPath?.join(' / ') ?? '',
    sort: task.rule.sort,
    minPrice: task.rule.minPrice === undefined ? '' : String(task.rule.minPrice),
    maxPrice: task.rule.maxPrice === undefined ? '' : String(task.rule.maxPrice),
    region: task.rule.region ?? '',
    condition: filters.condition ?? '',
    delivery: filters.delivery ?? '',
    shipping: filters.shipping ?? '',
    guarantee: filters.guarantee ?? '',
    newOnly: filters.newOnly ?? '',
    includeWords: task.rule.includeWords?.join('，') ?? '',
    excludeWords: task.rule.excludeWords?.join('，') ?? '',
    pageLimit: String(task.rule.pageLimit),
    intervalSeconds: String(task.intervalSeconds),
    status: task.status
  }
}

function monitorWords(value: string, field: string): string[] {
  const words = value.split(/[，,\n]/).map((word) => word.trim()).filter(Boolean)
  if (words.length > 20) throw new Error(`${field}最多 20 个`)
  if (words.some((word) => word.length > 48)) throw new Error(`${field}单项不能超过 48 个字符`)
  if (new Set(words).size !== words.length) throw new Error(`${field}不能重复`)
  return words
}

function monitorPositiveInteger(value: string, minimum: number, maximum: number, field: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${field}必须在 ${minimum}-${maximum} 之间`)
  return number
}

function monitorPrice(value: string, field: string): number | undefined {
  if (!value.trim()) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 100000000) throw new Error(`${field}必须是有效价格`)
  return number
}

function monitorInputFromForm(form: MonitorForm): MonitorTaskInput {
  const keyword = form.keyword.trim()
  const categoryPath = form.categoryPath.split(/[/>]/).map((part) => part.trim()).filter(Boolean)
  if (!keyword && !categoryPath.length) throw new Error('关键词或类目路径至少填写一项')
  if (keyword.length > 80) throw new Error('关键词不能超过 80 个字符')
  if (categoryPath.length > 3) throw new Error('类目路径最多 3 级')
  if (categoryPath.some((part) => part.length > 80) || new Set(categoryPath).size !== categoryPath.length) throw new Error('类目路径无效')
  const minPrice = monitorPrice(form.minPrice, '最低价')
  const maxPrice = monitorPrice(form.maxPrice, '最高价')
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) throw new Error('最低价不能高于最高价')
  const includeWords = monitorWords(form.includeWords, '包含词')
  const excludeWords = monitorWords(form.excludeWords, '排除词')
  if (includeWords.some((word) => excludeWords.includes(word))) throw new Error('包含词与排除词不能重复')
  const filters = Object.fromEntries(Object.entries({ condition: form.condition, delivery: form.delivery, shipping: form.shipping, guarantee: form.guarantee, newOnly: form.newOnly }).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)) as Record<string, string>
  const region = form.region.trim()
  if (region.length > 64) throw new Error('地区不能超过 64 个字符')
  const rule: MonitorTaskRule = {
    ...(keyword ? { keyword } : {}),
    ...(categoryPath.length ? { categoryPath } : {}),
    sort: form.sort,
    ...(minPrice === undefined ? {} : { minPrice }),
    ...(maxPrice === undefined ? {} : { maxPrice }),
    ...(region ? { region } : {}),
    ...(Object.keys(filters).length ? { filters } : {}),
    ...(includeWords.length ? { includeWords } : {}),
    ...(excludeWords.length ? { excludeWords } : {}),
    pageLimit: monitorPositiveInteger(form.pageLimit, 1, 10, '页数上限')
  }
  return { rule, intervalSeconds: monitorPositiveInteger(form.intervalSeconds, 60, 86400, '采集间隔'), status: form.status }
}

function sellerMonitorInputFromForm(form: SellerMonitorForm): SellerMonitorInput {
  const target = form.target.trim()
  if (!target) throw new Error('请输入公开卖家主页或卖家 ID')
  const intervalSeconds = monitorPositiveInteger(form.intervalSeconds, 60, 86_400, '采集间隔')
  try {
    const url = new URL(target)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
    return { profileUrl: url.toString(), intervalSeconds, status: form.status }
  } catch {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(target)) throw new Error('公开卖家主页或卖家 ID 无效')
    return { platformSellerId: target, intervalSeconds, status: form.status }
  }
}

function monitorInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`
  if (seconds % 60 === 0) return `每 ${seconds / 60} 分钟`
  return `每 ${seconds} 秒`
}

function monitorUpdatedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '最近更新未知' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

function sellerItemStateLabel(state: SellerItemState): string {
  if (state === 'active') return '在售'
  if (state === 'sold') return '已售'
  if (state === 'offline') return '已下架'
  return '未知'
}

function sellerEventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    new_listing: '上新',
    price_changed: '价格变化',
    state_changed: '状态变化',
    item_sold: '已售',
    item_offline: '下架',
    item_relisted: '重新上架',
    content_changed: '内容变化',
    seller_updated: '卖家资料变化'
  }
  return labels[eventType] ?? (eventType || '未知事件')
}

function sellerItemSummary(item: SellerItem): string {
  return [
    item.platformItemId,
    item.price ? `¥${item.price}` : '',
    item.region,
    item.conditionText,
    item.wantCount === undefined ? '' : `${item.wantCount} 人想要`
  ].filter(Boolean).join(' · ')
}

function sellerDetailPage<T>(items: T[], cursor: string | null, pageSize: number, prefix: string): UserPage<T> {
  const match = cursor ? new RegExp(`^${prefix}:(\\d+)$`).exec(cursor) : null
  const offset = match ? Number(match[1]) : 0
  const pageItems = items.slice(offset, offset + pageSize)
  const nextOffset = offset + pageItems.length
  return { items: pageItems, total: items.length, nextCursor: nextOffset < items.length ? `${prefix}:${nextOffset}` : null, hasMore: nextOffset < items.length }
}

function monitorRuleScope(rule: MonitorTaskRule): string {
  const price = rule.minPrice === undefined && rule.maxPrice === undefined ? '' : `${rule.minPrice ?? 0}-${rule.maxPrice ?? '不限'} 元`
  return [rule.categoryPath?.join(' / '), price, rule.region].filter(Boolean).join(' · ') || '未设置额外范围'
}

function monitorRuleFilters(rule: MonitorTaskRule): string {
  const sort = monitorSortOptions.find((option) => option.value === rule.sort)?.label ?? '综合排序'
  const words = [...(rule.includeWords ?? []).map((word) => `含 ${word}`), ...(rule.excludeWords ?? []).map((word) => `排 ${word}`)]
  return [sort, `最多 ${rule.pageLimit} 页`, ...words].join(' · ')
}

type AuthView = { status: 'checking' | 'signed-out' | 'ready'; user: UserIdentity | null; error: string | null }

function App(): ReactNode {
  const api = useMemo(() => new UserApiClient(runtime.baseUrl), [])
  const [auth, setAuth] = useState<AuthView>({ status: runtime.mode === 'demo' ? 'ready' : 'checking', user: runtime.mode === 'demo' ? { id: 'local-demo' } : null, error: null })

  useEffect(() => {
    if (runtime.mode === 'demo') return
    let active = true
    api.restoreSession().then((user) => {
      if (active) setAuth({ status: user ? 'ready' : 'signed-out', user, error: null })
    })
    return () => { active = false }
  }, [api])

  if (runtime.mode === 'api' && auth.status !== 'ready') return <AuthGate api={api} auth={auth} onAuthenticated={(user) => setAuth({ status: 'ready', user, error: null })} />
  return <Workbench api={api} user={auth.user ?? { id: 'local-demo' }} onLogout={() => { api.clearSession(); setAuth({ status: 'signed-out', user: null, error: null }) }} />
}

function AuthGate({ api, auth, onAuthenticated }: { api: UserApiClient; auth: AuthView; onAuthenticated: (user: UserIdentity) => void }): ReactNode {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(auth.error)
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSubmitting(true); setError(null)
    try { onAuthenticated(await api.login(email.trim(), password)) } catch (caught) { setError(caught instanceof UserApiError ? caught.message : '登录失败，请稍后重试') } finally { setSubmitting(false) }
  }
  return <main className="auth-shell"><section className="auth-panel"><div className="auth-brand"><span className="brand-mark">鱼</span><strong>闲鱼数据台</strong></div><div className="auth-heading"><h1>登录工作台</h1><p className="auth-copy">查看关注商品、市场变化和分析结果。</p></div>{!api.configured && <div className="auth-alert"><strong>暂时无法登录</strong><span>请稍后再试。</span></div>}<form onSubmit={(event) => void submit(event)}><label><span>邮箱</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></label><label><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" minLength={12} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary auth-submit" type="submit" disabled={submitting || !api.configured}>{submitting ? '正在登录…' : '登录'}</button></form></section></main>
}

function Workbench({ api, user, onLogout }: { api: UserApiClient; user: UserIdentity; onLogout: () => void }): ReactNode {
  const [active, setActive] = useState<PageKey>('dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [drawer, setDrawer] = useState<TableRow | null>(null)
  const [sellerTarget, setSellerTarget] = useState<SellerTarget | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState<SortKey>('updated_at_desc')
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([])
  const [pageSize, setPageSize] = useState(20)
  const [page, setPage] = useState<UserPage<TableRow>>({ items: [], total: 0, nextCursor: null, hasMore: false })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const activePage = pages.find((pageItem) => pageItem.key === active)!
  const listKind = active === 'dashboard' || active === 'settings' || active === 'monitors' || active === 'sellers' ? null : active
  const listRequest = useMemo<UserListRequest>(() => ({ limit: pageSize, cursor, sort, filters: { ...(query.trim() ? { q: query.trim() } : {}), ...(status ? { status } : {}) } }), [cursor, pageSize, query, sort, status])

  useEffect(() => {
    if (!listKind) { setPage({ items: [], total: 0, nextCursor: null, hasMore: false }); setLoading(false); setError(null); return }
    const controller = new AbortController(); let cancelled = false
    setLoading(true); setError(null)
    const load = runtime.mode === 'demo' ? demoPage(listKind, listRequest) : api.list<unknown>(pageResources[listKind], listRequest, controller.signal).then((result) => ({ ...result, items: result.items.map((item, index) => normalizeApiRow(item, listKind, index)) }))
    load.then((result) => { if (!cancelled) setPage(result) }).catch((caught) => { if (!cancelled && !(caught instanceof DOMException && caught.name === 'AbortError')) setError(caught instanceof UserApiError ? caught.message : '列表请求失败') }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; controller.abort() }
  }, [api, listKind, listRequest, reloadKey])

  const switchPage = (next: PageKey) => { setActive(next); setCursor(null); setCursorHistory([]); setQuery(''); setStatus(''); setSort('updated_at_desc'); setDrawer(null); setMenuOpen(false) }
  const openSellerFromItem = (target: SellerTarget) => { setSellerTarget(target); switchPage('sellers') }
  const changeFilter = (callback: () => void) => { callback(); setCursor(null); setCursorHistory([]) }
  const nextPage = () => { if (!page.nextCursor) return; setCursorHistory((history) => [...history, cursor]); setCursor(page.nextCursor) }
  const previousPage = () => { if (!cursorHistory.length) return; setCursor(cursorHistory[cursorHistory.length - 1] ?? null); setCursorHistory(cursorHistory.slice(0, -1)) }
  const accountName = runtime.mode === 'demo' ? '预览账户' : `用户 ${user.id.slice(0, 8)}`

  return <div className={`app ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><span className="brand-mark"><Fish size={18} /></span>{!collapsed && <span>闲鱼数据台</span>}</div>
      <nav>{pages.map((pageItem) => <button key={pageItem.key} className={`nav-item ${active === pageItem.key ? 'active' : ''}`} onClick={() => switchPage(pageItem.key)} title={collapsed ? pageItem.label : undefined}><pageItem.icon size={18} /><span>{pageItem.label}</span></button>)}</nav>
      <div className="sidebar-foot"><button className="collapse-button" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开侧边栏' : '收起侧边栏'}>{collapsed ? <PanelLeft size={17} /> : <PanelLeftClose size={17} />}</button></div>
    </aside>
    {menuOpen && <button className="backdrop" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
    <section className="main-shell"><header className="workspace-header"><div className="header-context"><button className="mobile-menu" title="打开导航" onClick={() => setMenuOpen(true)}><Menu size={19} /></button><span>{activePage.label}</span></div><div className="header-tools"><button className="icon-button notification" title="事件中心" onClick={() => switchPage('events')}><Bell size={18} /></button><div className="header-profile"><span className="header-avatar">{runtime.mode === 'demo' ? '预' : '用'}</span><span>{accountName}</span></div>{runtime.mode === 'api' && <button className="header-logout" title="退出登录" onClick={onLogout}><LogOut size={17} /></button>}</div></header>
      <main className="content">{active === 'dashboard' && <Dashboard mode={runtime.mode} onNavigate={switchPage} />}{active === 'monitors' && <MonitorPage api={api} mode={runtime.mode} />}{active === 'sellers' && <SellerMonitorPage api={api} mode={runtime.mode} initialTarget={sellerTarget} onInitialTargetConsumed={() => setSellerTarget(null)} />}{active === 'settings' && <SettingsPage />}{listKind && <ListPage copy={pageCopy[listKind]} rows={page.items} total={page.total} pageIndex={cursorHistory.length + 1} pageSize={pageSize} query={query} status={status} sort={sort} loading={loading} error={error} canGoBack={cursorHistory.length > 0} canGoForward={page.hasMore && Boolean(page.nextCursor)} onQuery={(value) => changeFilter(() => setQuery(value))} onStatus={(value) => changeFilter(() => setStatus(value))} onSort={(value) => changeFilter(() => setSort(value as SortKey))} onPageSize={(value) => { setPageSize(value); setCursor(null); setCursorHistory([]) }} onPrev={previousPage} onNext={nextPage} onReload={() => setReloadKey((value) => value + 1)} onRetry={() => setReloadKey((value) => value + 1)} onOpen={setDrawer} />}</main></section>
    {drawer && <DetailDrawer row={drawer} onClose={() => setDrawer(null)} onAddSeller={openSellerFromItem} />}
  </div>
}

function Dashboard({ mode, onNavigate }: { mode: 'demo' | 'api'; onNavigate: (key: PageKey) => void }): ReactNode {
  if (mode === 'api') return <ApiState title="暂无数据概览" description="数据概览准备完成后将在这里展示。" />
  const stats = [['生效监控', '18', '较昨日 +2', Gauge, 'blue'], ['关注商家', '36', '公开商品变化 14', Store, 'mint'], ['待处理事件', '7', '3 条价格变化', Bell, 'amber'], ['市场机会', '12', '过去 24 小时', FileSearch, 'rose']] as const
  return <><div className="page-heading"><div><p className="eyebrow">数据概览</p><h1>数据总览</h1><p>查看近期监控、市场和分析动态。</p></div><button className="primary" onClick={() => onNavigate('monitors')}><Plus size={16} />新建监控</button></div><section className="stats-grid">{stats.map(([label, value, note, Icon, tone]) => <article className="stat-card" key={label}><div className={`stat-icon ${tone}`}><Icon size={20} /></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>)}</section><section className="dashboard-grid"><section className="panel wide"><div className="panel-head"><div><h2>重点动态</h2><p>最近 24 小时</p></div><button className="text-button" onClick={() => onNavigate('events')}>查看全部 <ChevronRight size={15} /></button></div><div className="feed-list">{['MacBook Air M2 16G 512G 价格下降 6.5%', '海风数码回收店新增 6 个公开商品', '轻薄本价格带的低价供给增加 18%'].map((item, index) => <button className="feed" key={item} onClick={() => onNavigate('events')}><span className={`feed-dot d${index}`} /><div><strong>{item}</strong><small>{index + 1} 小时前</small></div><ChevronRight size={16} /></button>)}</div></section><section className="panel"><div className="panel-head"><div><h2>市场信号</h2><p>最近 24 小时</p></div><button className="text-button" onClick={() => onNavigate('discoveries')}>全部</button></div><div className="signal"><div><span>价格下降商品</span><strong>42</strong></div><div><span>新增样本</span><strong>186</strong></div><div><span>商家上新</span><strong>29</strong></div></div></section><section className="panel"><div className="panel-head"><div><h2>最新 AI 解读</h2><p>已更新</p></div><button className="text-button" onClick={() => onNavigate('ai')}>打开</button></div><div className="ai-preview"><Bot size={22} /><div><strong>轻薄本价格带周报</strong><p>低价供给增加，成交热度保持平稳。</p></div></div></section></section></>
}

function MonitorPage({ api, mode }: { api: UserApiClient; mode: 'demo' | 'api' }): ReactNode {
  const [tasks, setTasks] = useState<MonitorTask[]>(() => mode === 'demo' ? demoMonitorTasks : [])
  const [loading, setLoading] = useState(mode === 'api')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<MonitorTask | null>(null)
  const [form, setForm] = useState<MonitorForm>(emptyMonitorForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [workingId, setWorkingId] = useState<string | null>(null)

  useEffect(() => {
    if (mode === 'demo') return
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setLoadError(null)
    api.listMonitorTasks({ limit: 100, cursor: null, sort: 'updated_at_desc', filters: {} }, controller.signal)
      .then((page) => { if (active) setTasks(page.items) })
      .catch((caught) => {
        if (!active || (caught instanceof DOMException && caught.name === 'AbortError')) return
        setLoadError(caught instanceof UserApiError ? caught.message : '监控任务加载失败')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [api, mode, reloadKey])

  const closeEditor = (force = false) => {
    if (saving && !force) return
    setEditorOpen(false)
    setEditing(null)
    setFormError(null)
  }

  const createTask = () => {
    setEditing(null)
    setForm(emptyMonitorForm())
    setFormError(null)
    setEditorOpen(true)
  }

  const editTask = (task: MonitorTask) => {
    setEditing(task)
    setForm(monitorFormFromTask(task))
    setFormError(null)
    setEditorOpen(true)
  }

  const saveTask = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)
    let input: MonitorTaskInput
    try {
      input = monitorInputFromForm(form)
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : '规则填写无效')
      return
    }
    setSaving(true)
    try {
      if (mode === 'demo') {
        const now = new Date().toISOString()
        if (editing) {
          const updated: MonitorTask = { ...editing, rule: input.rule, intervalSeconds: input.intervalSeconds, status: input.status ?? editing.status, ruleVersion: editing.ruleVersion + 1, updatedAt: now }
          setTasks((current) => current.map((task) => task.id === updated.id ? updated : task))
        } else {
          const created: MonitorTask = { id: `demo-monitor-${Date.now()}`, rule: input.rule, intervalSeconds: input.intervalSeconds, status: input.status ?? 'active', ruleVersion: 1, nextRunAt: '', createdAt: now, updatedAt: now }
          setTasks((current) => [created, ...current])
        }
      } else if (editing) {
        const updated = await api.updateMonitorTask(editing.id, input)
        setTasks((current) => current.map((task) => task.id === updated.id ? updated : task))
      } else {
        const created = await api.createMonitorTask(input)
        setTasks((current) => [created, ...current])
      }
      closeEditor(true)
    } catch (caught) {
      setFormError(caught instanceof UserApiError ? caught.message : '保存监控任务失败')
    } finally {
      setSaving(false)
    }
  }

  const changeStatus = async (task: MonitorTask) => {
    const status: MonitorTaskStatus = task.status === 'active' ? 'paused' : 'active'
    setActionError(null)
    setWorkingId(task.id)
    try {
      if (mode === 'demo') {
        const updated = { ...task, status, updatedAt: new Date().toISOString() }
        setTasks((current) => current.map((entry) => entry.id === task.id ? updated : entry))
      } else {
        const updated = await api.updateMonitorTask(task.id, { status })
        setTasks((current) => current.map((entry) => entry.id === task.id ? updated : entry))
      }
    } catch (caught) {
      setActionError(caught instanceof UserApiError ? caught.message : '更新监控状态失败')
    } finally {
      setWorkingId(null)
    }
  }

  const deleteTask = async (task: MonitorTask) => {
    if (!window.confirm(`确定删除监控“${task.rule.keyword ?? task.id}”吗？`)) return
    setActionError(null)
    setWorkingId(task.id)
    try {
      if (mode !== 'demo') await api.deleteMonitorTask(task.id)
      setTasks((current) => current.filter((entry) => entry.id !== task.id))
    } catch (caught) {
      setActionError(caught instanceof UserApiError ? caught.message : '删除监控任务失败')
    } finally {
      setWorkingId(null)
    }
  }

  return <><div className="page-heading"><div><p className="eyebrow">规则管理</p><h1>我的监控</h1><p>设置关键词、公开筛选条件和本机采集频率。</p></div><button className="primary" onClick={createTask}><Plus size={16} />新建监控</button></div>{actionError && <div className="monitor-alert" role="alert">{actionError}</div>}<section className="table-panel monitor-table-panel"><div className="table-summary"><span>共 <strong>{tasks.length}</strong> 条监控</span><span>规则仅用于本机采集启动器。</span><button className="icon-button" title="刷新监控任务" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></div>{loadError ? <div className="state-box"><Activity size={27} /><strong>监控任务加载失败</strong><p>{loadError}</p><button className="primary small" onClick={() => setReloadKey((value) => value + 1)}><RefreshCw size={15} />重试</button></div> : loading ? <div className="state-box"><RefreshCw className="spin" size={27} /><strong>正在加载监控任务</strong><p>请稍候。</p></div> : tasks.length === 0 ? <div className="state-box"><Gauge size={27} /><strong>还没有监控任务</strong><p>新建一条规则后，已绑定设备会在下次检查时使用它。</p><button className="primary small" onClick={createTask}><Plus size={15} />新建监控</button></div> : <div className="table-wrap"><table className="monitor-table"><thead><tr><th>监控条件</th><th>范围</th><th>采集频率</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{tasks.map((task) => <tr key={task.id}><td><strong>{task.rule.keyword ?? '类目监控'}</strong><small>{monitorRuleFilters(task.rule)}</small></td><td><span>{monitorRuleScope(task.rule)}</span><small>更新于 {monitorUpdatedAt(task.updatedAt)}</small></td><td>{monitorInterval(task.intervalSeconds)}</td><td><span className={`status ${task.status === 'active' ? 'ok' : 'muted'}`}>{task.status === 'active' ? '已启用' : '已暂停'}</span></td><td><div className="monitor-actions"><button className="row-action" title="编辑监控" onClick={() => editTask(task)} disabled={workingId === task.id}><Pencil size={16} /></button><button className="row-action" title={task.status === 'active' ? '暂停采集' : '启用采集'} onClick={() => void changeStatus(task)} disabled={workingId === task.id}>{task.status === 'active' ? <Pause size={16} /> : <Play size={16} />}</button><button className="row-action monitor-delete" title="删除监控" onClick={() => void deleteTask(task)} disabled={workingId === task.id}><Trash2 size={16} /></button></div></td></tr>)}</tbody></table></div>}</section>{editorOpen && <MonitorEditor editing={editing} form={form} saving={saving} error={formError} onChange={(field, value) => setForm((current) => ({ ...current, [field]: value } as MonitorForm))} onClose={closeEditor} onSubmit={(event) => void saveTask(event)} />}</>
}

function MonitorEditor({ editing, form, saving, error, onChange, onClose, onSubmit }: { editing: MonitorTask | null; form: MonitorForm; saving: boolean; error: string | null; onChange: (field: keyof MonitorForm, value: string) => void; onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }): ReactNode {
  const setValue = (field: keyof MonitorForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange(field, event.target.value)
  return <div className="monitor-dialog-layer"><button className="monitor-dialog-backdrop" aria-label="关闭监控编辑器" onClick={onClose} /><section className="monitor-dialog" role="dialog" aria-modal="true" aria-labelledby="monitor-editor-title"><header><div><p className="eyebrow">监控规则</p><h2 id="monitor-editor-title">{editing ? '编辑监控' : '新建监控'}</h2></div><button className="icon-button" type="button" title="关闭" onClick={onClose} disabled={saving}><X size={18} /></button></header><form onSubmit={onSubmit}><div className="monitor-dialog-body"><div className="monitor-form-grid"><label className="monitor-field monitor-field-wide"><span>关键词</span><input value={form.keyword} onChange={setValue('keyword')} maxLength={80} required={!form.categoryPath.trim()} placeholder="例如 MacBook Air M2" autoFocus /></label><label className="monitor-field monitor-field-wide"><span>类目路径</span><input value={form.categoryPath} onChange={setValue('categoryPath')} required={!form.keyword.trim()} placeholder="用 / 分隔，最多 3 级，例如 数码 / 电脑 / 笔记本" /></label><label className="monitor-field"><span>排序</span><select value={form.sort} onChange={setValue('sort')}>{monitorSortOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label className="monitor-field"><span>地区</span><input value={form.region} onChange={setValue('region')} maxLength={64} placeholder="例如 全国、杭州" /></label><label className="monitor-field"><span>最低价（元）</span><input type="number" min="0" value={form.minPrice} onChange={setValue('minPrice')} placeholder="不限" /></label><label className="monitor-field"><span>最高价（元）</span><input type="number" min="0" value={form.maxPrice} onChange={setValue('maxPrice')} placeholder="不限" /></label></div><section className="monitor-form-section"><h3>公开筛选</h3><div className="monitor-form-grid"><label className="monitor-field"><span>成色</span><input value={form.condition} onChange={setValue('condition')} maxLength={40} placeholder="例如 全新" /></label><label className="monitor-field"><span>发货方式</span><input value={form.delivery} onChange={setValue('delivery')} maxLength={40} placeholder="例如 同城自提" /></label><label className="monitor-field"><span>配送</span><input value={form.shipping} onChange={setValue('shipping')} maxLength={40} placeholder="例如 包邮" /></label><label className="monitor-field"><span>保障</span><input value={form.guarantee} onChange={setValue('guarantee')} maxLength={40} placeholder="例如 验货宝" /></label><label className="monitor-field"><span>仅看全新</span><select value={form.newOnly} onChange={setValue('newOnly')}><option value="">不限</option><option value="是">是</option><option value="否">否</option></select></label></div></section><section className="monitor-form-section"><h3>匹配与频率</h3><div className="monitor-form-grid"><label className="monitor-field monitor-field-wide"><span>包含词</span><input value={form.includeWords} onChange={setValue('includeWords')} placeholder="用逗号分隔，例如 16G，国行" /></label><label className="monitor-field monitor-field-wide"><span>排除词</span><input value={form.excludeWords} onChange={setValue('excludeWords')} placeholder="用逗号分隔，例如 维修，配件" /></label><label className="monitor-field"><span>页数上限</span><input type="number" min="1" max="10" step="1" value={form.pageLimit} onChange={setValue('pageLimit')} /></label><label className="monitor-field"><span>采集间隔（秒）</span><input type="number" min="60" max="86400" step="60" value={form.intervalSeconds} onChange={setValue('intervalSeconds')} /></label><div className="monitor-field monitor-switch-field"><span>启用采集</span><button type="button" className={`toggle ${form.status === 'active' ? 'on' : ''}`} aria-label="启用采集" aria-pressed={form.status === 'active'} onClick={() => onChange('status', form.status === 'active' ? 'paused' : 'active')}><i /></button></div></div></section>{error && <p className="form-error monitor-form-error" role="alert">{error}</p>}</div><footer><button className="secondary" type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary" type="submit" disabled={saving}><Save size={16} />{saving ? '正在保存…' : '保存监控'}</button></footer></form></section></div>
}

function SellerMonitorPage({ api, mode, initialTarget, onInitialTargetConsumed }: { api: UserApiClient; mode: 'demo' | 'api'; initialTarget?: SellerTarget | null; onInitialTargetConsumed?: () => void }): ReactNode {
  const [page, setPage] = useState<UserPage<SellerMonitor>>({ items: [], total: 0, nextCursor: null, hasMore: false })
  const [demoTasks, setDemoTasks] = useState<SellerMonitor[]>(demoSellerMonitors)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([])
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(mode === 'api')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [form, setForm] = useState<SellerMonitorForm>(emptySellerMonitorForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [workingId, setWorkingId] = useState<string | null>(null)
  const [detailTask, setDetailTask] = useState<SellerMonitor | null>(null)
  const request = useMemo<UserListRequest>(() => ({ limit: pageSize, cursor, sort: 'updated_at_desc', filters: { ...(query.trim() ? { q: query.trim() } : {}), ...(status ? { status } : {}) } }), [cursor, pageSize, query, status])

  useEffect(() => {
    if (mode === 'demo') {
      const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
      const filtered = demoTasks.filter((task) => (!normalizedQuery || `${task.publicName ?? ''} ${task.platformSellerId} ${task.profileUrl}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) && (!status || task.status === status))
      const offsetMatch = /^demo:(\d+)$/.exec(cursor ?? '')
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0
      const items = filtered.slice(offset, offset + pageSize)
      const nextOffset = offset + items.length
      setPage({ items, total: filtered.length, nextCursor: nextOffset < filtered.length ? `demo:${nextOffset}` : null, hasMore: nextOffset < filtered.length })
      setLoadError(null)
      setLoading(false)
      return
    }

    const controller = new AbortController()
    let active = true
    setLoading(true)
    setLoadError(null)
    api.listSellerMonitors(request, controller.signal)
      .then((result) => { if (active) setPage(result) })
      .catch((caught) => {
        if (!active || (caught instanceof DOMException && caught.name === 'AbortError')) return
        setLoadError(caught instanceof UserApiError ? caught.message : '竞品商家加载失败')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [api, cursor, demoTasks, mode, pageSize, query, reloadKey, request, status])

  const resetToFirstPage = () => {
    setCursor(null)
    setCursorHistory([])
  }
  const closeEditor = (force = false) => {
    if (saving && !force) return
    setEditorOpen(false)
    setFormError(null)
  }
  const openEditor = (target = '') => {
    setForm({ ...emptySellerMonitorForm(), target })
    setFormError(null)
    setEditorOpen(true)
  }
  useEffect(() => {
    if (!initialTarget?.platformSellerId) return
    openEditor(initialTarget.platformSellerId)
    onInitialTargetConsumed?.()
  }, [initialTarget, onInitialTargetConsumed])
  const saveTask = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError(null)
    let input: SellerMonitorInput
    try {
      input = sellerMonitorInputFromForm(form)
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : '卖家信息无效')
      return
    }
    setSaving(true)
    try {
      if (mode === 'demo') {
        const now = new Date().toISOString()
        const platformSellerId = input.platformSellerId ?? `demo-seller-${Date.now()}`
        const profileUrl = input.profileUrl ?? `https://www.goofish.com/user/${encodeURIComponent(platformSellerId)}`
        setDemoTasks((current) => [{ id: `demo-seller-monitor-${Date.now()}`, sellerId: `demo-seller-${Date.now()}`, platform: 'goofish', platformSellerId, profileUrl, ruleVersion: 1, intervalSeconds: input.intervalSeconds, status: input.status ?? 'active', nextRunAt: '', createdAt: now, updatedAt: now }, ...current])
      } else {
        await api.createSellerMonitor(input)
      }
      resetToFirstPage()
      setReloadKey((value) => value + 1)
      closeEditor(true)
    } catch (caught) {
      setFormError(caught instanceof UserApiError ? caught.message : '添加竞品商家失败')
    } finally {
      setSaving(false)
    }
  }
  const changeStatus = async (task: SellerMonitor) => {
    const nextStatus: SellerMonitorStatus = task.status === 'active' ? 'paused' : 'active'
    setActionError(null)
    setWorkingId(task.id)
    try {
      if (mode === 'demo') {
        setDemoTasks((current) => current.map((entry) => entry.id === task.id ? { ...entry, status: nextStatus, updatedAt: new Date().toISOString() } : entry))
      } else {
        const updated = await api.updateSellerMonitor(task.id, { status: nextStatus })
        setPage((current) => ({ ...current, items: current.items.map((entry) => entry.id === updated.id ? updated : entry) }))
      }
    } catch (caught) {
      setActionError(caught instanceof UserApiError ? caught.message : '更新竞品商家状态失败')
    } finally {
      setWorkingId(null)
    }
  }
  const deleteTask = async (task: SellerMonitor) => {
    const label = task.publicName ?? task.platformSellerId ?? task.id
    if (!window.confirm(`确定删除竞品商家“${label}”吗？`)) return
    setActionError(null)
    setWorkingId(task.id)
    try {
      if (mode === 'demo') setDemoTasks((current) => current.filter((entry) => entry.id !== task.id))
      else await api.deleteSellerMonitor(task.id)
      if (detailTask?.id === task.id) setDetailTask(null)
      resetToFirstPage()
      setReloadKey((value) => value + 1)
    } catch (caught) {
      setActionError(caught instanceof UserApiError ? caught.message : '删除竞品商家失败')
    } finally {
      setWorkingId(null)
    }
  }
  const previousPage = () => {
    if (!cursorHistory.length) return
    setCursor(cursorHistory[cursorHistory.length - 1] ?? null)
    setCursorHistory(cursorHistory.slice(0, -1))
  }
  const nextPage = () => {
    if (!page.nextCursor) return
    setCursorHistory((history) => [...history, cursor])
    setCursor(page.nextCursor)
  }

  return <><div className="page-heading"><div><p className="eyebrow">竞品监控</p><h1>竞品商家</h1><p>管理公开卖家监控任务。</p></div><button className="primary" onClick={() => openEditor()}><Plus size={16} />添加商家</button></div>{actionError && <div className="monitor-alert" role="alert">{actionError}</div>}<section className="table-panel monitor-table-panel seller-monitor-table-panel"><div className="table-summary"><span>共 <strong>{page.total}</strong> 个商家</span><button className="icon-button" title="刷新竞品商家" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></div><div className="filter-bar seller-monitor-filter"><label className="search-field"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); resetToFirstPage() }} placeholder="搜索卖家" /></label><label><span>状态</span><select value={status} onChange={(event) => { setStatus(event.target.value); resetToFirstPage() }}><option value="">全部状态</option><option value="active">已启用</option><option value="paused">已暂停</option></select></label></div>{loadError ? <div className="state-box"><Activity size={27} /><strong>竞品商家加载失败</strong><p>{loadError}</p><button className="primary small" onClick={() => setReloadKey((value) => value + 1)}><RefreshCw size={15} />重试</button></div> : loading ? <div className="state-box"><RefreshCw className="spin" size={27} /><strong>正在加载竞品商家</strong><p>请稍候。</p></div> : page.items.length === 0 ? <div className="state-box"><Store size={27} /><strong>还没有竞品商家</strong><p>添加公开卖家主页后即可开始监控。</p><button className="primary small" onClick={() => openEditor()}><Plus size={15} />添加商家</button></div> : <div className="table-wrap"><table className="monitor-table seller-monitor-table"><thead><tr><th>商家</th><th>采集频率</th><th>最近更新</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{page.items.map((task) => <tr key={task.id}><td><strong>{task.publicName ?? task.platformSellerId}</strong><small>{task.profileUrl || task.platformSellerId}</small></td><td>{monitorInterval(task.intervalSeconds)}</td><td><span className="time">{monitorUpdatedAt(task.updatedAt)}</span></td><td><span className={`status ${task.status === 'active' ? 'ok' : 'muted'}`}>{task.status === 'active' ? '已启用' : '已暂停'}</span></td><td><div className="monitor-actions"><button className="row-action" title="查看商家详情" onClick={() => setDetailTask(task)}><MoreHorizontal size={17} /></button><button className="row-action" title={task.status === 'active' ? '暂停监控' : '启用监控'} onClick={() => void changeStatus(task)} disabled={workingId === task.id}>{task.status === 'active' ? <Pause size={16} /> : <Play size={16} />}</button><button className="row-action monitor-delete" title="删除商家" onClick={() => void deleteTask(task)} disabled={workingId === task.id}><Trash2 size={16} /></button></div></td></tr>)}</tbody></table></div>}<CursorPagination total={page.total} pageIndex={cursorHistory.length + 1} pageSize={pageSize} canGoBack={cursorHistory.length > 0} canGoForward={page.hasMore && Boolean(page.nextCursor)} onPrev={previousPage} onNext={nextPage} onPageSize={(value) => { setPageSize(value); resetToFirstPage() }} /></section>{editorOpen && <SellerMonitorEditor form={form} saving={saving} error={formError} onChange={(field, value) => setForm((current) => ({ ...current, [field]: value }))} onClose={closeEditor} onSubmit={(event) => void saveTask(event)} />}{detailTask && <SellerMonitorDetail api={api} mode={mode} task={detailTask} onClose={() => setDetailTask(null)} />}</>
}

function SellerMonitorEditor({ form, saving, error, onChange, onClose, onSubmit }: { form: SellerMonitorForm; saving: boolean; error: string | null; onChange: (field: keyof SellerMonitorForm, value: string) => void; onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }): ReactNode {
  const setValue = (field: keyof SellerMonitorForm) => (event: React.ChangeEvent<HTMLInputElement>) => onChange(field, event.target.value)
  return <div className="monitor-dialog-layer"><button className="monitor-dialog-backdrop" aria-label="关闭竞品商家编辑器" onClick={onClose} /><section className="monitor-dialog seller-monitor-dialog" role="dialog" aria-modal="true" aria-labelledby="seller-monitor-editor-title"><header><div><p className="eyebrow">竞品商家</p><h2 id="seller-monitor-editor-title">添加商家</h2></div><button className="icon-button" type="button" title="关闭" onClick={onClose} disabled={saving}><X size={18} /></button></header><form onSubmit={onSubmit}><div className="monitor-dialog-body"><div className="monitor-form-grid"><label className="monitor-field monitor-field-wide"><span>公开卖家主页或卖家 ID</span><input value={form.target} onChange={setValue('target')} maxLength={2048} placeholder="粘贴公开主页" autoFocus required /></label><label className="monitor-field"><span>采集间隔（秒）</span><input type="number" min="60" max="86400" step="60" value={form.intervalSeconds} onChange={setValue('intervalSeconds')} /></label><div className="monitor-field monitor-switch-field"><span>启用监控</span><button type="button" className={`toggle ${form.status === 'active' ? 'on' : ''}`} aria-label="启用监控" aria-pressed={form.status === 'active'} onClick={() => onChange('status', form.status === 'active' ? 'paused' : 'active')}><i /></button></div></div>{error && <p className="form-error monitor-form-error" role="alert">{error}</p>}</div><footer><button className="secondary" type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary" type="submit" disabled={saving}><Save size={16} />{saving ? '正在保存…' : '添加商家'}</button></footer></form></section></div>
}

type SellerDetailTab = 'items' | 'events'

function SellerMonitorDetail({ api, mode, task, onClose }: { api: UserApiClient; mode: 'demo' | 'api'; task: SellerMonitor; onClose: () => void }): ReactNode {
  const fallbackSeller = demoSellerProfiles[task.sellerId] ?? {
    id: task.sellerId,
    platform: 'goofish' as const,
    platformSellerId: task.platformSellerId,
    ...(task.publicName ? { publicName: task.publicName } : {}),
    ...(task.region ? { region: task.region } : {}),
    firstSeenAt: task.createdAt,
    lastSeenAt: task.updatedAt
  }
  const [profile, setProfile] = useState<SellerMonitorProfile>({ task, seller: fallbackSeller })
  const [profileLoading, setProfileLoading] = useState(mode === 'api')
  const [profileError, setProfileError] = useState<string | null>(null)
  const [tab, setTab] = useState<SellerDetailTab>('items')
  const [itemsPage, setItemsPage] = useState<UserPage<SellerItem>>({ items: [], total: 0, nextCursor: null, hasMore: false })
  const [eventsPage, setEventsPage] = useState<UserPage<SellerEvent>>({ items: [], total: 0, nextCursor: null, hasMore: false })
  const [itemsLoading, setItemsLoading] = useState(mode === 'api')
  const [eventsLoading, setEventsLoading] = useState(false)
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [itemQuery, setItemQuery] = useState('')
  const [itemState, setItemState] = useState<SellerItemState | ''>('')
  const [itemCursor, setItemCursor] = useState<string | null>(null)
  const [itemHistory, setItemHistory] = useState<Array<string | null>>([])
  const [itemPageSize, setItemPageSize] = useState(20)
  const [eventType, setEventType] = useState('')
  const [eventItemId, setEventItemId] = useState('')
  const [eventCursor, setEventCursor] = useState<string | null>(null)
  const [eventHistory, setEventHistory] = useState<Array<string | null>>([])
  const [eventPageSize, setEventPageSize] = useState(20)
  const [selectedItem, setSelectedItem] = useState<SellerItem | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const itemRequest = useMemo<UserListRequest>(() => ({
    limit: itemPageSize,
    cursor: itemCursor,
    sort: 'last_seen_at',
    filters: {
      ...(itemQuery.trim() ? { q: itemQuery.trim() } : {}),
      ...(itemState ? { state: itemState } : {})
    }
  }), [itemCursor, itemPageSize, itemQuery, itemState])
  const eventRequest = useMemo<UserListRequest>(() => ({
    limit: eventPageSize,
    cursor: eventCursor,
    sort: 'occurred_at',
    filters: {
      ...(eventType ? { eventType } : {}),
      ...(eventItemId.trim() ? { itemId: eventItemId.trim() } : {})
    }
  }), [eventCursor, eventItemId, eventPageSize, eventType])

  useEffect(() => {
    const seller = demoSellerProfiles[task.sellerId] ?? fallbackSeller
    setProfile({ task, seller })
    setProfileError(null)
    setProfileLoading(mode === 'api')
    setTab('items')
    setItemCursor(null)
    setItemHistory([])
    setEventCursor(null)
    setEventHistory([])
    setSelectedItem(null)
    if (mode === 'demo') return
    const controller = new AbortController()
    let active = true
    api.getSellerMonitorProfile(task.id, controller.signal)
      .then((result) => { if (active) setProfile(result) })
      .catch((caught) => {
        if (!active || (caught instanceof DOMException && caught.name === 'AbortError')) return
        setProfileError(caught instanceof UserApiError ? caught.message : '卖家公开资料加载失败')
      })
      .finally(() => { if (active) setProfileLoading(false) })
    return () => { active = false; controller.abort() }
  }, [api, mode, task])

  useEffect(() => {
    if (tab !== 'items') return
    if (mode === 'demo') {
      const query = itemQuery.trim().toLocaleLowerCase('zh-CN')
      const all = demoSellerItems[task.sellerId] ?? []
      const filtered = all.filter((item) => (!query || `${item.platformItemId} ${item.id}`.toLocaleLowerCase('zh-CN').includes(query)) && (!itemState || item.state === itemState))
      setItemsPage(sellerDetailPage(filtered, itemCursor, itemPageSize, 'demo-items'))
      setItemsError(null)
      setItemsLoading(false)
      return
    }
    const controller = new AbortController()
    let active = true
    setItemsLoading(true)
    setItemsError(null)
    api.listSellerMonitorItems(task.id, itemRequest, controller.signal)
      .then((result) => { if (active) setItemsPage(result) })
      .catch((caught) => {
        if (!active || (caught instanceof DOMException && caught.name === 'AbortError')) return
        setItemsError(caught instanceof UserApiError ? caught.message : '卖家商品加载失败')
      })
      .finally(() => { if (active) setItemsLoading(false) })
    return () => { active = false; controller.abort() }
  }, [api, itemCursor, itemPageSize, itemQuery, itemRequest, itemState, mode, reloadKey, tab, task])

  useEffect(() => {
    if (tab !== 'events') return
    if (mode === 'demo') {
      const all = demoSellerEvents[task.sellerId] ?? []
      const filtered = all.filter((event) => (!eventType || event.eventType === eventType) && (!eventItemId.trim() || event.itemId.includes(eventItemId.trim())))
      setEventsPage(sellerDetailPage(filtered, eventCursor, eventPageSize, 'demo-events'))
      setEventsError(null)
      setEventsLoading(false)
      return
    }
    const controller = new AbortController()
    let active = true
    setEventsLoading(true)
    setEventsError(null)
    api.listSellerMonitorEvents(task.id, eventRequest, controller.signal)
      .then((result) => { if (active) setEventsPage(result) })
      .catch((caught) => {
        if (!active || (caught instanceof DOMException && caught.name === 'AbortError')) return
        setEventsError(caught instanceof UserApiError ? caught.message : '卖家事件加载失败')
      })
      .finally(() => { if (active) setEventsLoading(false) })
    return () => { active = false; controller.abort() }
  }, [api, eventCursor, eventItemId, eventPageSize, eventRequest, eventType, mode, reloadKey, tab, task])

  const resetItems = () => { setItemCursor(null); setItemHistory([]) }
  const resetEvents = () => { setEventCursor(null); setEventHistory([]) }
  const nextItems = () => {
    if (!itemsPage.nextCursor) return
    setItemHistory((history) => [...history, itemCursor])
    setItemCursor(itemsPage.nextCursor)
  }
  const previousItems = () => {
    if (!itemHistory.length) return
    setItemCursor(itemHistory[itemHistory.length - 1] ?? null)
    setItemHistory(itemHistory.slice(0, -1))
  }
  const nextEvents = () => {
    if (!eventsPage.nextCursor) return
    setEventHistory((history) => [...history, eventCursor])
    setEventCursor(eventsPage.nextCursor)
  }
  const previousEvents = () => {
    if (!eventHistory.length) return
    setEventCursor(eventHistory[eventHistory.length - 1] ?? null)
    setEventHistory(eventHistory.slice(0, -1))
  }
  const seller = profile.seller
  const sellerName = seller.publicName ?? task.publicName ?? task.platformSellerId

  return <>
    <button className="drawer-backdrop" aria-label="关闭卖家详情" onClick={onClose} />
    <aside className="drawer seller-detail-drawer">
      <header>
        <div><span className="eyebrow">竞品商家</span><h2>{sellerName}</h2></div>
        <button className="icon-button" onClick={onClose} title="关闭"><X size={19} /></button>
      </header>
      <div className="drawer-body seller-detail-body">
        <section className="seller-profile-card">
          <div><strong>{sellerName}</strong><span>{seller.region ?? task.region ?? '地区未知'} · {seller.platformSellerId}</span></div>
          <span className={`status ${task.status === 'active' ? 'ok' : 'muted'}`}>{task.status === 'active' ? '已启用' : '已暂停'}</span>
          <dl>
            <div><dt>首次观测</dt><dd>{monitorUpdatedAt(seller.firstSeenAt)}</dd></div>
            <div><dt>最近观测</dt><dd>{monitorUpdatedAt(seller.lastSeenAt)}</dd></div>
            <div><dt>采集频率</dt><dd>{monitorInterval(task.intervalSeconds)}</dd></div>
          </dl>
          {task.profileUrl && <a className="seller-profile-link" href={task.profileUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开公开主页</a>}
        </section>
        {profileLoading && <div className="seller-detail-state"><RefreshCw className="spin" size={19} />正在加载公开资料</div>}
        {profileError && <div className="monitor-alert" role="alert">{profileError}</div>}
        <div className="seller-detail-tabs" role="tablist">
          <button className={tab === 'items' ? 'active' : ''} role="tab" aria-selected={tab === 'items'} onClick={() => setTab('items')}>商品 <strong>{itemsPage.total}</strong></button>
          <button className={tab === 'events' ? 'active' : ''} role="tab" aria-selected={tab === 'events'} onClick={() => setTab('events')}>事件 <strong>{eventsPage.total}</strong></button>
          <button className="icon-button" title="刷新详情" onClick={() => setReloadKey((value) => value + 1)}><RefreshCw size={16} /></button>
        </div>
        {tab === 'items' ? <section className="seller-detail-section">
          <div className="seller-detail-filter">
            <label className="search-field"><Search size={16} /><input value={itemQuery} onChange={(event) => { setItemQuery(event.target.value); resetItems() }} placeholder="搜索商品 ID" /></label>
            <label><span>状态</span><select value={itemState} onChange={(event) => { setItemState(event.target.value as SellerItemState | ''); resetItems() }}><option value="">全部</option><option value="active">在售</option><option value="sold">已售</option><option value="offline">已下架</option><option value="unknown">未知</option></select></label>
          </div>
          {itemsError ? <div className="seller-detail-state"><Activity size={20} /><strong>商品加载失败</strong><p>{itemsError}</p></div>
            : itemsLoading ? <div className="seller-detail-state"><RefreshCw className="spin" size={20} />正在加载商品</div>
              : itemsPage.items.length === 0 ? <div className="seller-detail-state"><PackageSearch size={20} /><strong>暂无商品</strong></div>
                : <div className="seller-item-list">{itemsPage.items.map((item) => <div className="seller-item-row" key={item.id}>
                  <div><strong>{(item.title ?? item.platformItemId) || item.id}</strong><small>{sellerItemSummary(item) || item.id}</small></div>
                  <span className={`status ${item.state === 'active' ? 'ok' : item.state === 'sold' ? 'watch' : 'muted'}`}>{sellerItemStateLabel(item.state)}</span>
                  <small>{monitorUpdatedAt(item.lastSeenAt)}</small>
                  <button className="row-action" title="查看商品详情" onClick={() => setSelectedItem(item)}><MoreHorizontal size={16} /></button>
                </div>)}</div>}
          {selectedItem && <section className="seller-item-detail"><header><strong>商品详情</strong><button className="icon-button" title="关闭商品详情" onClick={() => setSelectedItem(null)}><X size={15} /></button></header><dl>
            <div><dt>平台商品 ID</dt><dd>{selectedItem.platformItemId || selectedItem.id}</dd></div>
            {selectedItem.title && <div><dt>标题</dt><dd>{selectedItem.title}</dd></div>}
            {selectedItem.price && <div><dt>价格</dt><dd>¥{selectedItem.price}</dd></div>}
            {selectedItem.region && <div><dt>地区</dt><dd>{selectedItem.region}</dd></div>}
            {selectedItem.conditionText && <div><dt>成色</dt><dd>{selectedItem.conditionText}</dd></div>}
            {selectedItem.wantCount !== undefined && <div><dt>想要数</dt><dd>{selectedItem.wantCount}</dd></div>}
            <div><dt>状态</dt><dd>{sellerItemStateLabel(selectedItem.state)}</dd></div>
            <div><dt>首次观测</dt><dd>{monitorUpdatedAt(selectedItem.firstSeenAt)}</dd></div>
            <div><dt>最近观测</dt><dd>{monitorUpdatedAt(selectedItem.lastSeenAt)}</dd></div>
          </dl></section>}
          <CursorPagination total={itemsPage.total} pageIndex={itemHistory.length + 1} pageSize={itemPageSize} canGoBack={itemHistory.length > 0} canGoForward={itemsPage.hasMore && Boolean(itemsPage.nextCursor)} onPrev={previousItems} onNext={nextItems} onPageSize={(value) => { setItemPageSize(value); resetItems() }} />
        </section> : <section className="seller-detail-section">
          <div className="seller-detail-filter">
            <label><span>事件类型</span><select value={eventType} onChange={(event) => { setEventType(event.target.value); resetEvents() }}><option value="">全部事件</option><option value="new_listing">上新</option><option value="price_changed">价格变化</option><option value="state_changed">状态变化</option><option value="content_changed">内容变化</option></select></label>
            <label className="search-field"><Search size={16} /><input value={eventItemId} onChange={(event) => { setEventItemId(event.target.value); resetEvents() }} placeholder="商品 ID" /></label>
          </div>
          {eventsError ? <div className="seller-detail-state"><Activity size={20} /><strong>事件加载失败</strong><p>{eventsError}</p></div>
            : eventsLoading ? <div className="seller-detail-state"><RefreshCw className="spin" size={20} />正在加载事件</div>
              : eventsPage.items.length === 0 ? <div className="seller-detail-state"><Activity size={20} /><strong>暂无事件</strong></div>
                : <ol className="seller-event-timeline">{eventsPage.items.map((event) => <li key={event.id}><span className="seller-event-dot" /><div><strong>{sellerEventLabel(event.eventType)}</strong><small>商品 {event.itemId || '未知'}</small><p>{monitorUpdatedAt(event.occurredAt)} · 检测于 {monitorUpdatedAt(event.detectedAt)}</p></div></li>)}</ol>}
          <CursorPagination total={eventsPage.total} pageIndex={eventHistory.length + 1} pageSize={eventPageSize} canGoBack={eventHistory.length > 0} canGoForward={eventsPage.hasMore && Boolean(eventsPage.nextCursor)} onPrev={previousEvents} onNext={nextEvents} onPageSize={(value) => { setEventPageSize(value); resetEvents() }} />
        </section>}
      </div>
      <footer><button className="secondary" onClick={onClose}>关闭</button></footer>
    </aside>
  </>
}

function ApiState({ title, description }: { title: string; description: string }): ReactNode {
  return <div className="state-box api-state"><Activity size={27} /><strong>{title}</strong><p>{description}</p></div>
}

function ListPage(props: { copy: { title: string; description: string; primary: string; columns: [string, string, string, string] }; rows: TableRow[]; total: number; pageIndex: number; pageSize: number; query: string; status: string; sort: SortKey; loading: boolean; error: string | null; canGoBack: boolean; canGoForward: boolean; onQuery: (value: string) => void; onStatus: (value: string) => void; onSort: (value: string) => void; onPageSize: (value: number) => void; onPrev: () => void; onNext: () => void; onReload: () => void; onRetry: () => void; onOpen: (row: TableRow) => void }): ReactNode {
  const { copy, rows, total, pageIndex, pageSize, query, status, sort, loading, error } = props
  return <><div className="page-heading"><div><p className="eyebrow">数据中心</p><h1>{copy.title}</h1><p>{copy.description}</p></div><button className="primary"><Plus size={16} />{copy.primary}</button></div><section className="filter-bar"><label className="search-field"><Search size={17} /><input value={query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索名称、对象或变化内容" /></label><label><span>状态</span><select value={status} onChange={(event) => props.onStatus(event.target.value)}><option value="">全部状态</option><option value="正常">正常</option><option value="关注">关注</option><option value="待处理">待处理</option><option value="已处理">已处理</option></select></label><label><span>排序</span><select value={sort} onChange={(event) => props.onSort(event.target.value)}>{sortOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><button className="filter-button" title="更多筛选"><SlidersHorizontal size={17} />更多筛选</button><div className="filter-spacer" /><button className="icon-button" title="刷新" onClick={props.onReload}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></section><section className="table-panel"><div className="table-summary"><span>共 <strong>{total}</strong> 条</span><span>已按当前筛选加载</span></div>{error ? <div className="state-box"><Activity size={27} /><strong>列表加载失败</strong><p>{error}</p><button className="primary small" onClick={props.onRetry}><RefreshCw size={15} />重试</button></div> : loading ? <div className="state-box"><RefreshCw className="spin" size={27} /><strong>正在加载数据</strong><p>请稍候。</p></div> : rows.length === 0 ? <div className="state-box"><Filter size={27} /><strong>没有匹配的数据</strong><p>调整关键词或状态后重试。</p></div> : <div className="table-wrap"><table><thead><tr><th>{copy.columns[0]}</th><th>{copy.columns[1]}</th><th>{copy.columns[2]}</th><th>{copy.columns[3]}</th><th aria-label="操作" /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><span className="row-tag">{row.tag}</span><strong>{row.title}</strong><small>{row.subtitle}</small></td><td>{row.metric}</td><td><span className="time">{row.updatedAt}</span></td><td><span className={`status ${statusClass[row.status]}`}>{row.status}</span></td><td><button className="row-action" title="查看详情" onClick={() => props.onOpen(row)}><MoreHorizontal size={19} /></button></td></tr>)}</tbody></table></div>}<CursorPagination total={total} pageIndex={pageIndex} pageSize={pageSize} canGoBack={props.canGoBack} canGoForward={props.canGoForward} onPrev={props.onPrev} onNext={props.onNext} onPageSize={props.onPageSize} /></section></>
}

function CursorPagination({ total, pageIndex, pageSize, canGoBack, canGoForward, onPrev, onNext, onPageSize }: { total: number; pageIndex: number; pageSize: number; canGoBack: boolean; canGoForward: boolean; onPrev: () => void; onNext: () => void; onPageSize: (value: number) => void }): ReactNode {
  const start = total === 0 ? 0 : (pageIndex - 1) * pageSize + 1
  const end = Math.min(pageIndex * pageSize, total)
  return <div className="pagination"><span>{start}-{end} / {total}</span><select aria-label="每页条数" value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}><option value={20}>20 / 页</option><option value={50}>50 / 页</option><option value={100}>100 / 页</option></select><button disabled={!canGoBack} onClick={onPrev} title="上一页"><ChevronLeft size={17} /></button><button disabled={!canGoForward} onClick={onNext} title="下一页"><ChevronRight size={17} /></button></div>
}

function DetailDrawer({ row, onClose, onAddSeller }: { row: TableRow; onClose: () => void; onAddSeller: (target: SellerTarget) => void }): ReactNode {
  return <><button className="drawer-backdrop" aria-label="关闭详情" onClick={onClose} /><aside className="drawer"><header><div><span className="eyebrow">详情</span><h2>数据详情</h2></div><button className="icon-button" onClick={onClose} title="关闭"><X size={19} /></button></header><div className="drawer-body"><span className="row-tag">{row.tag}</span><h3>{row.title}</h3><p>{row.subtitle}</p><dl><div><dt>最新信息</dt><dd>{row.metric}</dd></div><div><dt>最近更新</dt><dd>{row.updatedAt}</dd></div><div><dt>状态</dt><dd><span className={`status ${statusClass[row.status]}`}>{row.status}</span></dd></div></dl><div className="drawer-note"><ShieldCheck size={18} /><span>仅展示当前账户可见的数据。</span></div></div><footer><button className="secondary" onClick={onClose}>关闭</button>{row.sellerTarget ? <button className="primary small" onClick={() => onAddSeller(row.sellerTarget!)}><Store size={15} />添加卖家监控</button> : <button className="primary small"><ExternalLink size={15} />查看关联对象</button>}</footer></aside></>
}

function SettingsPage(): ReactNode {
  return <><div className="page-heading"><div><p className="eyebrow">账户</p><h1>账户设置</h1><p>管理个人工作台的显示与提醒偏好。</p></div></div><div className="settings-grid"><section className="panel setting"><div className="panel-head"><div><h2>提醒偏好</h2><p>提醒仅用于当前账户。</p></div></div><Toggle title="价格变化提醒" subtitle="价格达到关注阈值时生成事件" enabled /><Toggle title="竞品商家动态" subtitle="商家公开商品发生变化时生成事件" enabled /><Toggle title="日报摘要" subtitle="每天汇总工作台的市场变化" /></section><section className="panel setting"><div className="panel-head"><div><h2>界面偏好</h2><p>修改后立即生效。</p></div></div><label className="setting-select"><span>默认市场范围</span><select><option>全国</option><option>常用地区</option></select></label><label className="setting-select"><span>列表默认排序</span><select><option>最近更新</option><option>优先级</option></select></label></section></div></>
}

function Toggle({ title, subtitle, enabled = false }: { title: string; subtitle: string; enabled?: boolean }): ReactNode {
  const [checked, setChecked] = useState(enabled)
  return <div className="toggle-row"><div><strong>{title}</strong><span>{subtitle}</span></div><button className={`toggle ${checked ? 'on' : ''}`} onClick={() => setChecked(!checked)} aria-label={title}><i /></button></div>
}

export default App
