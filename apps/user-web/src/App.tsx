import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Activity, Bell, Bot, ChevronLeft, ChevronRight, ExternalLink, FileSearch, Filter, Fish, Gauge, LayoutDashboard, LogOut, Menu, MoreHorizontal, PanelLeft, PanelLeftClose, PackageSearch, Pause, Pencil, Play, Plus, RefreshCw, Save, Search, Settings, Store, Trash2, X } from 'lucide-react'
import { UserApiClient, UserApiError, readUserRuntimeConfig, type UserIdentity, type UserListRequest, type UserListResource, type UserPage, type MonitorTask, type MonitorTaskInput, type MonitorTaskRule, type MonitorTaskSort, type MonitorTaskStatus, type SellerEvent, type SellerItem, type SellerItemState, type SellerMonitor, type SellerMonitorInput, type SellerMonitorProfile, type SellerMonitorStatus, type SellerProfile, type UserAnnouncement, type SupplyImportResult, type SupplyMaterial, type SupplyMaterialPatch, type SupplyPublishPlan, type SupplyPublishSchedule, type SupplySourceType, type MarketCategory, type MarketRegion } from './api'

type PageKey = 'dashboard' | 'monitors' | 'sellers' | 'market' | 'dynamic' | 'ai' | 'xianyuSupply' | 'generalSupply' | 'settings'
type RowKind = 'monitors' | 'sellers' | 'pool' | 'discoveries' | 'events' | 'logs' | 'ai'
type Status = '正常' | '关注' | '已暂停' | '已处理' | '失败' | '待编辑' | '已停用'
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

type MarketItemInfo = {
  platform: string
  platformItemId: string
  sellerId?: string
  platformSellerId?: string
  sourceUrl?: string
  price?: string
  previousPrice?: number
  currentPrice?: number
  region?: string
  conditionText?: string
  wantCount?: number
  images: string[]
  firstSeenAt?: string
  lastSeenAt?: string
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
  market?: MarketItemInfo
}

const runtime = readUserRuntimeConfig()

const pages: Array<{ key: PageKey; label: string; icon: typeof Gauge }> = [
  { key: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
  { key: 'monitors', label: '我的监控', icon: Gauge },
  { key: 'sellers', label: '竞品商家', icon: Store },
  { key: 'market', label: '市场动态', icon: PackageSearch },
  { key: 'dynamic', label: '动态趋势', icon: Bell },
  { key: 'ai', label: 'AI 分析', icon: Bot },
  { key: 'xianyuSupply', label: '咸鱼搬家', icon: PackageSearch },
  { key: 'generalSupply', label: '通用铺货', icon: Store },
  { key: 'settings', label: '账户设置', icon: Settings }
]

const pageCopy: Record<
  RowKind,
  {
    title: string
    description: string
    primary: string
    columns: [string, string, string, string]
  }
> = {
  monitors: {
    title: '我的监控',
    description: '查看关键词、分类和价格区间产生的市场变化。',
    primary: '新建监控',
    columns: ['监控条件', '最新命中', '本次变化', '状态']
  },
  sellers: {
    title: '竞品商家',
    description: '跟踪已关注商家的公开商品与经营动态。',
    primary: '添加商家',
    columns: ['商家', '公开商品', '动态摘要', '状态']
  },
  pool: {
    title: '市场动态',
    description: '查看市场商品、价格变化和近期机会。',
    primary: '保存筛选',
    columns: ['商品', '当前价格', '最近更新', '状态']
  },
  discoveries: {
    title: '市场动态',
    description: '浏览按筛选条件整理出的近期市场机会。',
    primary: '查看筛选',
    columns: ['发现主题', '样本范围', '信号摘要', '状态']
  },
  events: {
    title: '动态趋势',
    description: '统一查看价格、上架、下架和卖家变化。',
    primary: '查看筛选',
    columns: ['事件', '变化内容', '发生时间', '状态']
  },
  logs: {
    title: '动态趋势',
    description: '按对象、类型和时间筛选工作台可见的业务动态。',
    primary: '导出当前页',
    columns: ['动态', '记录内容', '发生时间', '状态']
  },
  ai: {
    title: 'AI 分析',
    description: '阅读已发布的市场解读与竞品分析结果。',
    primary: '创建分析请求',
    columns: ['分析主题', '数据范围', '结论摘要', '状态']
  }
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
    {
      title: 'MacBook Air M2 16G',
      subtitle: '全国 · 3500-5500 元 · 每 30 分钟',
      metric: '新增 8 条，降价 3 条',
      status: '正常',
      tag: '关键词'
    },
    {
      title: '索尼 A7M4 机身',
      subtitle: '上海 / 杭州 · 9000-14000 元 · 每 30 分钟',
      metric: '新增 2 条，降价 1 条',
      status: '关注',
      tag: '价格区间'
    },
    {
      title: '任天堂 Switch OLED',
      subtitle: '全国 · 1200-1900 元 · 每 30 分钟',
      metric: '新增 11 条，降价 0 条',
      status: '正常',
      tag: '关键词'
    }
  ],
  sellers: [
    {
      title: '海风数码回收店',
      subtitle: '杭州 · 1,284 个公开商品 · 92% 好评',
      metric: '上新 6 件，调价 4 件',
      status: '关注',
      tag: '数码'
    },
    {
      title: '小陈的相机柜',
      subtitle: '上海 · 346 个公开商品 · 89% 好评',
      metric: '上新 1 件，已下架 2 件',
      status: '正常',
      tag: '摄影'
    },
    {
      title: '北城潮玩仓',
      subtitle: '北京 · 775 个公开商品 · 95% 好评',
      metric: '上新 12 件，调价 0 件',
      status: '正常',
      tag: '潮玩'
    }
  ],
  pool: [
    {
      title: 'MacBook Air 13 M2 16G 512G',
      subtitle: '杭州 · 个人闲置 · 2 小时前',
      metric: '¥4,280 · 26 人想要',
      status: '关注',
      tag: '笔记本',
      sellerTarget: { platformSellerId: 'demo-macbook-seller' },
      market: {
        platform: 'goofish',
        platformItemId: 'demo-macbook-1',
        platformSellerId: 'demo-macbook-seller',
        sourceUrl: 'https://www.goofish.com/item/demo-macbook-1',
        price: '4280',
        region: '杭州',
        conditionText: '个人闲置',
        wantCount: 26,
        images: ['https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=960&q=80'],
        firstSeenAt: '2026-08-18T08:00:00.000Z',
        lastSeenAt: '2026-08-18T10:00:00.000Z'
      }
    },
    {
      title: 'Sony A7M4 全画幅微单机身',
      subtitle: '上海 · 验货宝 · 38 分钟前',
      metric: '¥12,480 · 8 人想要',
      status: '正常',
      tag: '相机',
      sellerTarget: { platformSellerId: 'demo-camera-seller' },
      market: {
        platform: 'goofish',
        platformItemId: 'demo-camera-1',
        platformSellerId: 'demo-camera-seller',
        sourceUrl: 'https://www.goofish.com/item/demo-camera-1',
        price: '12480',
        region: '上海',
        conditionText: '验货宝',
        wantCount: 8,
        images: ['https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=960&q=80'],
        firstSeenAt: '2026-08-18T09:00:00.000Z',
        lastSeenAt: '2026-08-18T11:22:00.000Z'
      }
    },
    {
      title: 'Switch OLED 白色国行',
      subtitle: '广州 · 包邮 · 1 小时前',
      metric: '¥1,365 · 17 人想要',
      status: '正常',
      tag: '游戏机',
      sellerTarget: { platformSellerId: 'demo-switch-seller' },
      market: {
        platform: 'goofish',
        platformItemId: 'demo-switch-1',
        platformSellerId: 'demo-switch-seller',
        sourceUrl: 'https://www.goofish.com/item/demo-switch-1',
        price: '1365',
        region: '广州',
        conditionText: '包邮',
        wantCount: 17,
        images: ['https://images.unsplash.com/photo-1578303512597-81e6cc155b3e?auto=format&fit=crop&w=960&q=80'],
        firstSeenAt: '2026-08-18T09:20:00.000Z',
        lastSeenAt: '2026-08-18T11:00:00.000Z'
      }
    }
  ],
  discoveries: [
    {
      title: '轻薄本周末价格带下移',
      subtitle: '笔记本电脑 · 全国 · 近 24 小时',
      metric: 'P50 下降 4.8%，样本 186',
      status: '关注',
      tag: '价格'
    },
    {
      title: '二手微单新上架加速',
      subtitle: '摄影摄像 · 上海 / 杭州 · 近 12 小时',
      metric: '新上架 +31%，样本 74',
      status: '关注',
      tag: '上新'
    },
    {
      title: '掌机需求热度回升',
      subtitle: '游戏机 · 全国 · 近 7 天',
      metric: '想要数 +18%，样本 1,042',
      status: '正常',
      tag: '热度'
    }
  ],
  events: [
    {
      title: '价格下调',
      subtitle: 'MacBook Air M2 16G 512G',
      metric: '¥4,580 降至 ¥4,280 (-6.5%)',
      status: '关注',
      tag: '价格'
    },
    {
      title: '竞品商家上新',
      subtitle: '海风数码回收店',
      metric: '新上架 6 件笔记本商品',
      status: '关注',
      tag: '商家'
    },
    {
      title: '商品已下架',
      subtitle: 'Sony A7M4 全画幅微单机身',
      metric: '最近一次公开快照已不可见',
      status: '已处理',
      tag: '商品'
    }
  ],
  logs: [
    {
      title: '监控条件完成一次检查',
      subtitle: 'MacBook Air M2 16G',
      metric: '发现 8 个新增公共商品快照',
      status: '正常',
      tag: '监控'
    },
    {
      title: '竞品商家变更已归档',
      subtitle: '小陈的相机柜',
      metric: '公开在售数 348 变为 346',
      status: '正常',
      tag: '商家'
    },
    {
      title: '市场筛选已更新',
      subtitle: '轻薄本价格带',
      metric: '为 186 个样本重新计算分位数',
      status: '正常',
      tag: '市场'
    }
  ],
  ai: [
    {
      title: '轻薄本价格带周报',
      subtitle: '笔记本电脑 · 全国 · 最近 7 天',
      metric: '低价端供给增加，成交热度保持平稳',
      status: '正常',
      tag: '市场'
    },
    {
      title: '海风数码回收店经营动态',
      subtitle: '竞品商家 · 最近 30 天',
      metric: '上新集中在周五，价格调整滞后约 6 小时',
      status: '关注',
      tag: '商家'
    },
    {
      title: '相机机身机会筛选',
      subtitle: '摄影摄像 · 上海 / 杭州 · 最近 72 小时',
      metric: '识别 3 个可复查的低于中位价格样本',
      status: '正常',
      tag: '机会'
    }
  ]
}

function makeRows(kind: RowKind): TableRow[] {
  return Array.from({ length: 31 }, (_, index) => {
    const base = bases[kind][index % bases[kind].length]
    const hour = String(9 + (index % 10)).padStart(2, '0')
    return {
      ...base,
      id: `${kind}-${index + 1}`,
      title: index < 3 ? base.title : `${base.title} · ${index + 1}`,
      updatedAt: `今天 ${hour}:${String((index * 7) % 60).padStart(2, '0')}`
    }
  })
}

const statusClass: Record<Status, string> = {
  正常: 'ok',
  关注: 'watch',
  已暂停: 'muted',
  已处理: 'done',
  失败: 'failed',
  待编辑: 'pending',
  已停用: 'muted'
}

function demoOffset(cursor: string | null): number {
  const match = cursor ? /^demo:(\d+)$/.exec(cursor) : null
  return match ? Number(match[1]) : 0
}

function demoPage(kind: RowKind, request: UserListRequest): Promise<UserPage<TableRow>> {
  return new Promise((resolve) =>
    window.setTimeout(() => {
      const query = request.filters.q?.trim().toLowerCase() ?? ''
      const status = request.filters.status ?? ''
      let rows = makeRows(kind).filter((row) => {
        const matchesQuery = !query || `${row.title}${row.subtitle}${row.metric}`.toLowerCase().includes(query)
        const matchesStatus = !status || row.status === status
        return matchesQuery && matchesStatus
      })
      if (request.sort === 'title_asc') rows = [...rows].sort((left, right) => left.title.localeCompare(right.title))
      if (request.sort === 'priority_desc') rows = [...rows].sort((left, right) => Number(right.status === '失败') - Number(left.status === '失败'))
      const offset = demoOffset(request.cursor)
      const items = rows.slice(offset, offset + request.limit)
      const nextOffset = offset + items.length
      resolve({
        items,
        total: rows.length,
        nextCursor: nextOffset < rows.length ? `demo:${nextOffset}` : null,
        hasMore: nextOffset < rows.length
      })
    }, 180)
  )
}

function recordValue(record: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) if (typeof record[key] === 'string' && record[key]) return record[key] as string
  for (const key of keys) if (typeof record[key] === 'number' && Number.isFinite(record[key])) return String(record[key])
  return fallback
}

function recordNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

function recordImages(record: Record<string, unknown>): string[] {
  const value = record.mainImages ?? record.main_images ?? record.images ?? record.imageUrls ?? record.image_urls
  if (typeof value === 'string' && value) return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 10)
}

function normalizeStatus(value: string): Status {
  if (value === '正常' || value === '关注' || value === '已暂停' || value === '已处理' || value === '失败' || value === '待编辑' || value === '已停用') return value
  if (value === 'failed' || value === 'error') return '失败'
  if (value === 'pending' || value === 'open' || value === 'warning') return '关注'
  if (value === 'paused' || value === 'disabled' || value === 'offline') return '已暂停'
  if (value === 'done' || value === 'resolved' || value === 'read') return '已处理'
  return '正常'
}

function normalizeApiRow(value: unknown, kind: RowKind, index: number): TableRow {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const id = recordValue(record, ['id', 'key'], `${kind}-${index + 1}`)
  const platformSellerId = recordValue(record, ['platformSellerId', 'platform_seller_id'], '')
  const sellerId = recordValue(record, ['sellerId', 'seller_id'], '')
  const platformItemId = recordValue(record, ['platformItemId', 'platform_item_id'], '')
  const platform = recordValue(record, ['platform'], '')
  const market =
    kind === 'pool'
      ? {
          platform,
          platformItemId,
          ...(sellerId ? { sellerId } : {}),
          ...(platformSellerId ? { platformSellerId } : {}),
          ...(recordValue(record, ['sourceUrl', 'source_url', 'itemUrl', 'item_url', 'url'], '')
            ? {
                sourceUrl: recordValue(record, ['sourceUrl', 'source_url', 'itemUrl', 'item_url', 'url'], '')
              }
            : {}),
          ...(recordValue(record, ['price'], '') ? { price: recordValue(record, ['price'], '') } : {}),
          ...(recordNumber(record, ['previousPrice', 'previous_price']) === undefined
            ? {}
            : {
                previousPrice: recordNumber(record, ['previousPrice', 'previous_price'])
              }),
          ...(recordNumber(record, ['currentPrice', 'current_price']) === undefined
            ? {}
            : {
                currentPrice: recordNumber(record, ['currentPrice', 'current_price'])
              }),
          ...(recordValue(record, ['region'], '') ? { region: recordValue(record, ['region'], '') } : {}),
          ...(recordValue(record, ['conditionText', 'condition_text'], '')
            ? {
                conditionText: recordValue(record, ['conditionText', 'condition_text'], '')
              }
            : {}),
          ...(recordNumber(record, ['wantCount', 'want_count']) === undefined ? {} : { wantCount: recordNumber(record, ['wantCount', 'want_count']) }),
          images: recordImages(record),
          ...(recordValue(record, ['firstSeenAt', 'first_seen_at'], '')
            ? {
                firstSeenAt: recordValue(record, ['firstSeenAt', 'first_seen_at'], '')
              }
            : {}),
          ...(recordValue(record, ['lastSeenAt', 'last_seen_at'], '')
            ? {
                lastSeenAt: recordValue(record, ['lastSeenAt', 'last_seen_at'], '')
              }
            : {})
        }
      : undefined
  const previousPrice = recordNumber(record, ['previousPrice', 'previous_price'])
  const currentPrice = recordNumber(record, ['currentPrice', 'current_price'])
  const priceMetric = previousPrice !== undefined && currentPrice !== undefined ? `¥${previousPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} -> ¥${currentPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` : currentPrice !== undefined ? `现价 ¥${currentPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` : undefined
  return {
    id,
    title: recordValue(record, ['title', 'name', 'subject', 'platformItemId', 'platform_item_id'], id),
    subtitle: recordValue(record, ['subtitle', 'description', 'scope', 'region'], '暂无说明'),
    metric: priceMetric ?? recordValue(record, ['metric', 'summary', 'value', 'detail'], '暂无摘要'),
    updatedAt: recordValue(record, ['updatedAt', 'updated_at', 'occurredAt', 'occurred_at'], '最近更新未知'),
    status: normalizeStatus(recordValue(record, ['status', 'state'], '正常')),
    tag: recordValue(record, ['tag', 'type', 'eventType', 'event_type'], kind),
    ...(kind === 'pool' && platformSellerId
      ? {
          sellerTarget: { platformSellerId, ...(sellerId ? { sellerId } : {}) }
        }
      : {}),
    ...(market ? { market } : {})
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
    rule: {
      keyword: 'MacBook Air M2',
      categoryPath: ['数码', '电脑'],
      sort: 'newly_reduced',
      minPrice: 3500,
      maxPrice: 5500,
      region: '全国',
      includeWords: ['16G'],
      excludeWords: ['维修'],
      pageLimit: 3
    },
    ruleVersion: 1,
    intervalSeconds: 1800,
    status: 'active',
    nextRunAt: '',
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z'
  },
  {
    id: 'demo-monitor-2',
    rule: {
      keyword: '索尼 A7M4',
      categoryPath: ['数码', '摄影摄像'],
      sort: 'comprehensive',
      minPrice: 9000,
      maxPrice: 14000,
      region: '上海',
      filters: { guarantee: '验货宝' },
      pageLimit: 2
    },
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
    id: 'demo-seller-monitor-1',
    sellerId: 'demo-seller-1',
    platform: 'goofish',
    platformSellerId: 'haifeng-digital',
    profileUrl: 'https://www.goofish.com/user/haifeng-digital',
    publicName: '海风数码回收店',
    region: '杭州',
    ruleVersion: 1,
    intervalSeconds: 1800,
    status: 'active',
    nextRunAt: '',
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z'
  },
  {
    id: 'demo-seller-monitor-2',
    sellerId: 'demo-seller-2',
    platform: 'goofish',
    platformSellerId: 'chen-camera',
    profileUrl: 'https://www.goofish.com/user/chen-camera',
    publicName: '小陈的相机柜',
    region: '上海',
    ruleVersion: 1,
    intervalSeconds: 1800,
    status: 'paused',
    nextRunAt: '',
    createdAt: '2026-08-17T09:00:00.000Z',
    updatedAt: '2026-08-17T09:00:00.000Z'
  }
]

const demoSellerProfiles: Record<string, SellerProfile> = {
  'demo-seller-1': {
    id: 'demo-seller-1',
    platform: 'goofish',
    platformSellerId: 'haifeng-digital',
    publicName: '海风数码回收店',
    region: '杭州',
    firstSeenAt: '2026-08-01T09:00:00.000Z',
    lastSeenAt: '2026-08-18T09:00:00.000Z'
  },
  'demo-seller-2': {
    id: 'demo-seller-2',
    platform: 'goofish',
    platformSellerId: 'chen-camera',
    publicName: '小陈的相机柜',
    region: '上海',
    firstSeenAt: '2026-08-02T09:00:00.000Z',
    lastSeenAt: '2026-08-17T09:00:00.000Z'
  }
}

const demoSellerItems: Record<string, SellerItem[]> = {
  'demo-seller-1': [
    {
      id: 'demo-item-501',
      platform: 'goofish',
      platformItemId: '501',
      state: 'active',
      title: '索尼 WH-1000XM5 头戴式耳机',
      price: '1680',
      previousPrice: '1799',
      currentPrice: '1680',
      region: '杭州',
      conditionText: '95新',
      wantCount: 14,
      images: ['https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=640&q=80'],
      tags: ['数码', '耳机'],
      description: '公开商品描述。',
      firstSeenAt: '2026-08-10T09:00:00.000Z',
      lastSeenAt: '2026-08-18T09:00:00.000Z'
    },
    {
      id: 'demo-item-502',
      platform: 'goofish',
      platformItemId: '502',
      state: 'sold',
      title: '富士 X100V 银色',
      price: '9200',
      region: '杭州',
      conditionText: '99新',
      wantCount: 8,
      images: [],
      firstSeenAt: '2026-08-09T09:00:00.000Z',
      lastSeenAt: '2026-08-17T08:00:00.000Z'
    },
    {
      id: 'demo-item-503',
      platform: 'goofish',
      platformItemId: '503',
      state: 'offline',
      title: '罗技 MX Keys 键盘',
      price: '399',
      region: '杭州',
      images: [],
      firstSeenAt: '2026-08-08T09:00:00.000Z',
      lastSeenAt: '2026-08-16T08:00:00.000Z'
    }
  ],
  'demo-seller-2': [
    {
      id: 'demo-item-601',
      platform: 'goofish',
      platformItemId: '601',
      state: 'active',
      title: '佳能 RF 50mm F1.8 镜头',
      price: '890',
      region: '上海',
      images: [],
      firstSeenAt: '2026-08-11T09:00:00.000Z',
      lastSeenAt: '2026-08-18T08:00:00.000Z'
    }
  ]
}

const demoSellerEvents: Record<string, SellerEvent[]> = {
  'demo-seller-1': [
    {
      id: 'demo-event-1',
      itemId: 'demo-item-501',
      sellerId: 'demo-seller-1',
      eventType: 'price_changed',
      eventKey: 'demo-price-1',
      occurredAt: '2026-08-18T08:00:00.000Z',
      detectedAt: '2026-08-18T08:05:00.000Z'
    },
    {
      id: 'demo-event-2',
      itemId: 'demo-item-502',
      sellerId: 'demo-seller-1',
      eventType: 'state_changed',
      eventKey: 'demo-state-1',
      occurredAt: '2026-08-17T08:00:00.000Z',
      detectedAt: '2026-08-17T08:05:00.000Z'
    }
  ],
  'demo-seller-2': []
}

function emptyMonitorForm(): MonitorForm {
  return {
    keyword: '',
    categoryPath: '',
    sort: 'comprehensive',
    minPrice: '',
    maxPrice: '',
    region: '',
    condition: '',
    delivery: '',
    shipping: '',
    guarantee: '',
    newOnly: '',
    includeWords: '',
    excludeWords: '',
    pageLimit: '2',
    intervalSeconds: '30',
    status: 'active'
  }
}

function emptySellerMonitorForm(): SellerMonitorForm {
  return { target: '', intervalSeconds: '30', status: 'active' }
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
    intervalSeconds: String(Math.max(30, Math.ceil(task.intervalSeconds / 60))),
    status: task.status
  }
}

function monitorWords(value: string, field: string): string[] {
  const words = value
    .split(/[，,\n]/)
    .map((word) => word.trim())
    .filter(Boolean)
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
  const categoryPath = form.categoryPath
    .split(/[/>]/)
    .map((part) => part.trim())
    .filter(Boolean)
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
  const filters = Object.fromEntries(
    Object.entries({
      condition: form.condition,
      delivery: form.delivery,
      shipping: form.shipping,
      guarantee: form.guarantee,
      newOnly: form.newOnly
    })
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value)
  ) as Record<string, string>
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
  return {
    rule,
    intervalSeconds: monitorPositiveInteger(form.intervalSeconds, 30, 1440, '采集间隔（分钟）') * 60,
    status: form.status
  }
}

function sellerMonitorInputFromForm(form: SellerMonitorForm): SellerMonitorInput {
  const target = form.target.trim()
  if (!target) throw new Error('请输入公开卖家主页或卖家 ID')
  const intervalSeconds = monitorPositiveInteger(form.intervalSeconds, 30, 1_440, '采集间隔（分钟）') * 60
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
  return Number.isNaN(date.getTime())
    ? '最近更新未知'
    : date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      })
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
  return [item.platformItemId, item.price ? `¥${item.price}` : '', item.region, item.conditionText, item.wantCount === undefined ? '' : `${item.wantCount} 人想要`].filter(Boolean).join(' · ')
}

function sellerSkuLines(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const source = value as Record<string, unknown>
  const groups = Array.isArray(source.groups) ? source.groups : Array.isArray(source.specifications) ? source.specifications : []
  const groupLines = groups.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const group = entry as Record<string, unknown>
    const name = typeof group.name === 'string' ? group.name.trim() : ''
    const values = Array.isArray(group.values) ? group.values.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
    return name && values.length ? [`${name}：${values.join(' / ')}`] : []
  })
  if (groupLines.length) return groupLines
  return Object.entries(source).flatMap(([key, raw]) => {
    if (Array.isArray(raw)) {
      const values = raw
        .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
        .map(String)
        .filter(Boolean)
      return values.length ? [`${key}：${values.join(' / ')}`] : []
    }
    return typeof raw === 'string' || typeof raw === 'number' ? [`${key}：${raw}`] : []
  })
}

function sellerDetailPage<T>(items: T[], cursor: string | null, pageSize: number, prefix: string): UserPage<T> {
  const match = cursor ? new RegExp(`^${prefix}:(\\d+)$`).exec(cursor) : null
  const offset = match ? Number(match[1]) : 0
  const pageItems = items.slice(offset, offset + pageSize)
  const nextOffset = offset + pageItems.length
  return {
    items: pageItems,
    total: items.length,
    nextCursor: nextOffset < items.length ? `${prefix}:${nextOffset}` : null,
    hasMore: nextOffset < items.length
  }
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

type AuthView = {
  status: 'checking' | 'signed-out' | 'ready'
  user: UserIdentity | null
  error: string | null
}

const rememberedLoginKey = 'xianyu-user-web.remembered-credentials.v1'

function readRememberedLogin(): { account: string; password: string } {
  try {
    const value = JSON.parse(localStorage.getItem(rememberedLoginKey) ?? '{}') as Partial<{ account: string; password: string }>
    if (typeof value.account === 'string' && typeof value.password === 'string') return { account: value.account, password: value.password }
  } catch {
    localStorage.removeItem(rememberedLoginKey)
  }
  return { account: '', password: '' }
}

function App(): ReactNode {
  const api = useMemo(() => new UserApiClient(runtime.baseUrl), [])
  const [auth, setAuth] = useState<AuthView>({
    status: runtime.mode === 'demo' ? 'ready' : 'checking',
    user: runtime.mode === 'demo' ? { id: 'local-demo' } : null,
    error: null
  })

  useEffect(() => {
    if (runtime.mode === 'demo') return
    let active = true
    api.restoreSession().then((user) => {
      if (active) setAuth({ status: user ? 'ready' : 'signed-out', user, error: null })
    })
    return () => {
      active = false
    }
  }, [api])

  if (runtime.mode === 'api' && auth.status !== 'ready') return <AuthGate api={api} auth={auth} onAuthenticated={(user) => setAuth({ status: 'ready', user, error: null })} />
  return (
    <Workbench
      api={api}
      user={auth.user ?? { id: 'local-demo' }}
      onLogout={() => {
        api.clearSession()
        setAuth({ status: 'signed-out', user: null, error: null })
      }}
    />
  )
}

function AuthGate({ api, auth, onAuthenticated }: { api: UserApiClient; auth: AuthView; onAuthenticated: (user: UserIdentity) => void }): ReactNode {
  const [remembered] = useState(readRememberedLogin)
  const [email, setEmail] = useState(remembered.account)
  const [password, setPassword] = useState(remembered.password)
  const [rememberPassword, setRememberPassword] = useState(Boolean(remembered.account && remembered.password))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(auth.error)
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    if (!email.trim()) {
      setError('请输入账号')
      setSubmitting(false)
      return
    }
    if (email.trim().length < 6) {
      setError('账号不低于6位')
      setSubmitting(false)
      return
    }
    if (email.trim().length > 20) {
      setError('账号不超过20位')
      setSubmitting(false)
      return
    }
    if (!password) {
      setError('请输入密码')
      setSubmitting(false)
      return
    }
    if (password.length < 12) {
      setError('密码至少12位')
      setSubmitting(false)
      return
    }
    try {
      onAuthenticated(await api.login(email.trim(), password))
      if (rememberPassword) localStorage.setItem(rememberedLoginKey, JSON.stringify({ account: email.trim(), password }))
      else localStorage.removeItem(rememberedLoginKey)
    } catch (caught) {
      setError(caught instanceof UserApiError ? caught.message : '登录失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <span className="brand-mark">鱼</span>
          <strong>闲鱼数据台</strong>
        </div>
        <div className="auth-heading">
          <h1>登录工作台</h1>
        </div>
        {!api.configured && (
          <div className="auth-alert">
            <strong>暂时无法登录</strong>
            <span>请稍后再试。</span>
          </div>
        )}
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>账号</span>
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              placeholder="请输入账号"
              onInvalid={(event) => {
                const input = event.currentTarget
                input.setCustomValidity(!input.value ? '请输入账号' : input.value.length < 6 ? '账号不低于6位' : '账号不超过20位')
              }}
              onInput={(event) => event.currentTarget.setCustomValidity('')}
              pattern=".{6,20}"
              minLength={6}
              maxLength={20}
              required
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="请输入密码"
              onInvalid={(event) => {
                const input = event.currentTarget
                input.setCustomValidity(!input.value ? '请输入密码' : input.value.length < 12 ? '密码至少12位' : '')
              }}
              onInput={(event) => event.currentTarget.setCustomValidity('')}
              minLength={12}
              required
            />
          </label>
          <label className="remember-password">
            <input type="checkbox" checked={rememberPassword} onChange={(event) => setRememberPassword(event.target.checked)} />
            <span>记住账号和密码</span>
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary auth-submit" type="submit" disabled={submitting || !api.configured}>
            {submitting ? '正在登录…' : '登录'}
          </button>
        </form>
      </section>
    </main>
  )
}

function Workbench({ api, user, onLogout }: { api: UserApiClient; user: UserIdentity; onLogout: () => void }): ReactNode {
  const [active, setActive] = useState<PageKey>('dashboard')
  const [dynamicView, setDynamicView] = useState<RowKind>('events')
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
  const [page, setPage] = useState<UserPage<TableRow>>({
    items: [],
    total: 0,
    nextCursor: null,
    hasMore: false
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const activePage = pages.find((pageItem) => pageItem.key === active)!
  const listKind: RowKind | null = active === 'market' ? 'pool' : active === 'dynamic' ? dynamicView : active === 'ai' ? 'ai' : null
  const listRequest = useMemo<UserListRequest>(
    () => ({
      limit: pageSize,
      cursor,
      sort,
      filters: {
        ...(query.trim() ? { q: query.trim() } : {}),
        ...(status ? { status } : {})
      }
    }),
    [cursor, pageSize, query, sort, status]
  )

  useEffect(() => {
    if (!listKind) {
      setPage({ items: [], total: 0, nextCursor: null, hasMore: false })
      setLoading(false)
      setError(null)
      return
    }
    const controller = new AbortController()
    let cancelled = false
    setLoading(true)
    setError(null)
    const load =
      runtime.mode === 'demo'
        ? demoPage(listKind, listRequest)
        : api.list<unknown>(pageResources[listKind], listRequest, controller.signal).then((result) => ({
            ...result,
            items: result.items.map((item, index) => normalizeApiRow(item, listKind, index))
          }))
    load
      .then((result) => {
        if (!cancelled) setPage(result)
      })
      .catch((caught) => {
        if (!cancelled && !(caught instanceof DOMException && caught.name === 'AbortError')) setError(caught instanceof UserApiError ? caught.message : '列表请求失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [api, listKind, listRequest, reloadKey])

  const switchPage = (next: PageKey) => {
    setActive(next)
    setCursor(null)
    setCursorHistory([])
    setQuery('')
    setStatus('')
    setSort('updated_at_desc')
    setDrawer(null)
    setMenuOpen(false)
  }
  const switchListView = (next: RowKind) => {
    if (next === 'events' || next === 'logs') setDynamicView(next)
    setCursor(null)
    setCursorHistory([])
    setQuery('')
    setStatus('')
    setSort('updated_at_desc')
    setDrawer(null)
  }
  const openSellerFromItem = (target: SellerTarget) => {
    setSellerTarget(target)
    switchPage('sellers')
  }
  const openItemEvents = () => {
    setDynamicView('events')
    switchPage('dynamic')
  }
  const changeFilter = (callback: () => void) => {
    callback()
    setCursor(null)
    setCursorHistory([])
  }
  const nextPage = () => {
    if (!page.nextCursor) return
    setCursorHistory((history) => [...history, cursor])
    setCursor(page.nextCursor)
  }
  const previousPage = () => {
    if (!cursorHistory.length) return
    setCursor(cursorHistory[cursorHistory.length - 1] ?? null)
    setCursorHistory(cursorHistory.slice(0, -1))
  }
  const accountName = runtime.mode === 'demo' ? '预览账户' : `用户 ${user.id.slice(0, 8)}`

  return (
    <div className={`app ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">
            <Fish size={18} />
          </span>
          {!collapsed && <span>闲鱼数据台</span>}
        </div>
        <nav>
          {pages
            .filter((pageItem) => pageItem.key !== 'xianyuSupply' && pageItem.key !== 'generalSupply')
            .slice(0, -1)
            .map((pageItem) => (
              <button key={pageItem.key} className={`nav-item ${active === pageItem.key ? 'active' : ''}`} onClick={() => switchPage(pageItem.key)} title={collapsed ? pageItem.label : undefined}>
                <pageItem.icon size={18} />
                <span>{pageItem.label}</span>
              </button>
            ))}
          {pages
            .filter((pageItem) => pageItem.key === 'xianyuSupply' || pageItem.key === 'generalSupply')
            .map((pageItem) => (
              <button key={pageItem.key} className={`nav-item supply-nav-item ${active === pageItem.key ? 'active' : ''}`} onClick={() => switchPage(pageItem.key)} title={collapsed ? pageItem.label : undefined}>
                <pageItem.icon size={18} />
                <span>{pageItem.label}</span>
              </button>
            ))}
          {pages
            .filter((pageItem) => pageItem.key === 'settings')
            .map((pageItem) => (
              <button key={pageItem.key} className={`nav-item ${active === pageItem.key ? 'active' : ''}`} onClick={() => switchPage(pageItem.key)} title={collapsed ? pageItem.label : undefined}>
                <pageItem.icon size={18} />
                <span>{pageItem.label}</span>
              </button>
            ))}
        </nav>
        <div className="sidebar-foot">
          <button className="collapse-button" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开侧边栏' : '收起侧边栏'}>
            {collapsed ? <PanelLeft size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
      </aside>
      {menuOpen && <button className="backdrop" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
      <section className="main-shell">
        <header className="workspace-header">
          <div className="header-context">
            <button className="mobile-menu" title="打开导航" onClick={() => setMenuOpen(true)}>
              <Menu size={19} />
            </button>
            <span>{activePage.label}</span>
          </div>
          <div className="header-tools">
            <button className="icon-button notification" title="查看动态" onClick={() => switchPage('dynamic')}>
              <Bell size={18} />
            </button>
            <div className="header-profile">
              <span className="header-avatar">{runtime.mode === 'demo' ? '预' : '用'}</span>
              <span>{accountName}</span>
            </div>
            {runtime.mode === 'api' && (
              <button className="header-logout" title="退出登录" onClick={onLogout}>
                <LogOut size={17} />
              </button>
            )}
          </div>
        </header>
        <main className="content">
          {active === 'dashboard' && <Dashboard mode={runtime.mode} onNavigate={switchPage} />}
          {active === 'monitors' && <MonitorPage api={api} mode={runtime.mode} />}
          {active === 'sellers' && <SellerMonitorPage api={api} mode={runtime.mode} initialTarget={sellerTarget} onInitialTargetConsumed={() => setSellerTarget(null)} />}
          {active === 'xianyuSupply' && <SupplyPage api={api} mode={runtime.mode} sourceType="xianyu" />}
          {active === 'generalSupply' && <SupplyPage api={api} mode={runtime.mode} sourceType="general" />}
          {active === 'settings' && <SettingsPage />}
          {listKind && (
            <ListPage
              api={api}
              mode={runtime.mode}
              resource={listKind}
              copy={pageCopy[listKind]}
              rows={page.items}
              total={page.total}
              pageIndex={cursorHistory.length + 1}
              pageSize={pageSize}
              query={query}
              status={status}
              sort={sort}
              loading={loading}
              error={error}
              canGoBack={cursorHistory.length > 0}
              canGoForward={page.hasMore && Boolean(page.nextCursor)}
              onQuery={(value) => changeFilter(() => setQuery(value))}
              onStatus={(value) => changeFilter(() => setStatus(value))}
              onSort={(value) => changeFilter(() => setSort(value as SortKey))}
              onPageSize={(value) => {
                setPageSize(value)
                setCursor(null)
                setCursorHistory([])
              }}
              onPrev={previousPage}
              onNext={nextPage}
              onReload={() => setReloadKey((value) => value + 1)}
              onRetry={() => setReloadKey((value) => value + 1)}
              onOpen={setDrawer}
              tabs={
                active === 'dynamic'
                  ? [
                      { key: 'events' as RowKind, label: '变化事件' },
                      { key: 'logs' as RowKind, label: '系统日志' }
                    ]
                  : undefined
              }
              tabMode={active === 'dynamic' ? 'select' : undefined}
              onTabChange={switchListView}
            />
          )}
        </main>
      </section>
      {drawer && (drawer.market ? <MarketItemDetail api={api} mode={runtime.mode} row={drawer} onClose={() => setDrawer(null)} onAddSeller={openSellerFromItem} onOpenEvents={openItemEvents} /> : <DetailDrawer row={drawer} onClose={() => setDrawer(null)} onAddSeller={openSellerFromItem} />)}
      <AnnouncementModal api={api} mode={runtime.mode} />
    </div>
  )
}

function AnnouncementModal({ api, mode }: { api: UserApiClient; mode: 'demo' | 'api' }): ReactNode {
  const [items, setItems] = useState<UserAnnouncement[]>([])
  const [open, setOpen] = useState(false)
  const todayKey = `xianyu-user-web.announcement-dismissed.${new Date().toISOString().slice(0, 10)}`
  useEffect(() => {
    if (mode === 'demo' || localStorage.getItem(todayKey)) return
    const controller = new AbortController()
    void api
      .listAnnouncements(controller.signal)
      .then((result) => {
        if (result.length) {
          setItems(result)
          setOpen(true)
        }
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [api, mode, todayKey])
  if (!open || !items.length) return null
  return (
    <div className="modal-layer announcement-layer">
      <button className="modal-backdrop" aria-label="关闭公告" onClick={() => setOpen(false)} />
      <section className="modal-shell announcement-modal" role="dialog" aria-modal="true" aria-labelledby="announcement-title">
        <header>
          <div>
            <p className="eyebrow">系统公告</p>
            <h2 id="announcement-title">{items[0].title}</h2>
          </div>
          <button className="icon-button" title="关闭" onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </header>
        <div className="modal-body announcement-body">
          {items.map((item) => (
            <article key={item.id}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
        <footer>
          <label className="remember-password">
            <input
              type="checkbox"
              onChange={(event) => {
                if (event.target.checked) localStorage.setItem(todayKey, '1')
              }}
            />
            <span>今日不再查看</span>
          </label>
          <button className="primary" onClick={() => setOpen(false)}>
            我知道了
          </button>
        </footer>
      </section>
    </div>
  )
}

function Dashboard({ mode, onNavigate }: { mode: 'demo' | 'api'; onNavigate: (key: PageKey) => void }): ReactNode {
  if (mode === 'api') return <ApiState title="暂无数据概览" description="数据概览准备完成后将在这里展示。" />
  const stats = [
    ['生效监控', '18', '较昨日 +2', Gauge, 'blue'],
    ['关注商家', '36', '公开商品变化 14', Store, 'mint'],
    ['失败任务', '0', '最近 24 小时', Bell, 'amber'],
    ['市场机会', '12', '过去 24 小时', FileSearch, 'rose']
  ] as const
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">数据概览</p>
          <h1>数据总览</h1>
          <p>查看近期监控、市场和分析动态。</p>
        </div>
        <button className="primary" onClick={() => onNavigate('monitors')}>
          <Plus size={16} />
          新建监控
        </button>
      </div>
      <section className="stats-grid">
        {stats.map(([label, value, note, Icon, tone]) => (
          <article className="stat-card" key={label}>
            <div className={`stat-icon ${tone}`}>
              <Icon size={20} />
            </div>
            <div>
              <span>{label}</span>
              <strong>{value}</strong>
              <small>{note}</small>
            </div>
          </article>
        ))}
      </section>
      <section className="dashboard-grid">
        <section className="panel wide">
          <div className="panel-head">
            <div>
              <h2>重点动态</h2>
              <p>最近 24 小时</p>
            </div>
            <button className="text-button" onClick={() => onNavigate('dynamic')}>
              查看全部 <ChevronRight size={15} />
            </button>
          </div>
          <div className="feed-list">
            {['MacBook Air M2 16G 512G 价格下降 6.5%', '海风数码回收店新增 6 个公开商品', '轻薄本价格带的低价供给增加 18%'].map((item, index) => (
              <button className="feed" key={item} onClick={() => onNavigate('dynamic')}>
                <span className={`feed-dot d${index}`} />
                <div>
                  <strong>{item}</strong>
                  <small>{index + 1} 小时前</small>
                </div>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>市场信号</h2>
              <p>最近 24 小时</p>
            </div>
            <button className="text-button" onClick={() => onNavigate('market')}>
              全部
            </button>
          </div>
          <div className="signal">
            <div>
              <span>价格下降商品</span>
              <strong>42</strong>
            </div>
            <div>
              <span>新增样本</span>
              <strong>186</strong>
            </div>
            <div>
              <span>商家上新</span>
              <strong>29</strong>
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>最新 AI 解读</h2>
              <p>已更新</p>
            </div>
            <button className="text-button" onClick={() => onNavigate('ai')}>
              打开
            </button>
          </div>
          <div className="ai-preview">
            <Bot size={22} />
            <div>
              <strong>轻薄本价格带周报</strong>
              <p>低价供给增加，成交热度保持平稳。</p>
            </div>
          </div>
        </section>
      </section>
    </>
  )
}

function MonitorPage({ api, mode }: { api: UserApiClient; mode: 'demo' | 'api' }): ReactNode {
  const [tasks, setTasks] = useState<MonitorTask[]>(() => (mode === 'demo' ? demoMonitorTasks : []))
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
  const [categoryPaths, setCategoryPaths] = useState<string[]>(() => Array.from(new Set(demoMonitorTasks.flatMap((task) => task.rule.categoryPath?.join(' / ') ?? []).filter(Boolean))))
  const [regions, setRegions] = useState<string[]>(() => Array.from(new Set(demoMonitorTasks.map((task) => task.rule.region).filter((value): value is string => Boolean(value)))))

  useEffect(() => {
    if (mode === 'demo') return
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setLoadError(null)
    api
      .listMonitorTasks({ limit: 100, cursor: null, sort: 'updated_at_desc', filters: {} }, controller.signal)
      .then((page) => {
        if (active) setTasks(page.items)
      })
      .catch((caught) => {
        if (!active || (caught instanceof DOMException && caught.name === 'AbortError')) return
        setLoadError(caught instanceof UserApiError ? caught.message : '监控任务加载失败')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [api, mode, reloadKey])

  useEffect(() => {
    if (mode === 'demo') return
    const controller = new AbortController()
    let active = true
    const loadOptions = async () => {
      const categories: MarketCategory[] = []
      let categoryCursor: string | null = null
      do {
        const page = await api.listMarketCategories(
          {
            limit: 100,
            cursor: categoryCursor,
            sort: 'path',
            filters: { platform: 'goofish', active: 'true' }
          },
          controller.signal
        )
        categories.push(...page.items)
        categoryCursor = page.nextCursor
      } while (categoryCursor)
      const collectedRegions: MarketRegion[] = []
      let regionCursor: string | null = null
      do {
        const page = await api.listMarketRegions(
          {
            limit: 100,
            cursor: regionCursor,
            sort: 'name',
            filters: { platform: 'goofish' }
          },
          controller.signal
        )
        collectedRegions.push(...page.items)
        regionCursor = page.nextCursor
      } while (regionCursor)
      if (!active) return
      setCategoryPaths(Array.from(new Set(categories.map((category) => category.path.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right, 'zh-CN')))
      setRegions(Array.from(new Set(collectedRegions.map((region) => region.name.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right, 'zh-CN')))
    }
    void loadOptions().catch((caught) => {
      if (!active || (caught instanceof DOMException && caught.name === 'AbortError')) return
      setCategoryPaths([])
      setRegions([])
    })
    return () => {
      active = false
      controller.abort()
    }
  }, [api, mode])

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
          const updated: MonitorTask = {
            ...editing,
            rule: input.rule,
            intervalSeconds: input.intervalSeconds,
            status: input.status ?? editing.status,
            ruleVersion: editing.ruleVersion + 1,
            updatedAt: now
          }
          setTasks((current) => current.map((task) => (task.id === updated.id ? updated : task)))
        } else {
          const created: MonitorTask = {
            id: `demo-monitor-${Date.now()}`,
            rule: input.rule,
            intervalSeconds: input.intervalSeconds,
            status: input.status ?? 'active',
            ruleVersion: 1,
            nextRunAt: '',
            createdAt: now,
            updatedAt: now
          }
          setTasks((current) => [created, ...current])
        }
      } else if (editing) {
        const updated = await api.updateMonitorTask(editing.id, input)
        setTasks((current) => current.map((task) => (task.id === updated.id ? updated : task)))
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
        const updated = {
          ...task,
          status,
          updatedAt: new Date().toISOString()
        }
        setTasks((current) => current.map((entry) => (entry.id === task.id ? updated : entry)))
      } else {
        const updated = await api.updateMonitorTask(task.id, { status })
        setTasks((current) => current.map((entry) => (entry.id === task.id ? updated : entry)))
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

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">规则管理</p>
          <h1>我的监控</h1>
          <p>设置关键词、公开筛选条件和本机采集频率。</p>
        </div>
        <button className="primary" onClick={createTask}>
          <Plus size={16} />
          新建监控
        </button>
      </div>
      {actionError && (
        <div className="monitor-alert" role="alert">
          {actionError}
        </div>
      )}
      <section className="table-panel monitor-table-panel">
        <div className="table-summary">
          <span>
            共 <strong>{tasks.length}</strong> 条监控
          </span>
          <span>规则仅用于本机采集启动器。</span>
          <button className="icon-button" title="刷新监控任务" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
            <RefreshCw size={17} className={loading ? 'spin' : ''} />
          </button>
        </div>
        {loadError ? (
          <div className="state-box">
            <Activity size={27} />
            <strong>监控任务加载失败</strong>
            <p>{loadError}</p>
            <button className="primary small" onClick={() => setReloadKey((value) => value + 1)}>
              <RefreshCw size={15} />
              重试
            </button>
          </div>
        ) : loading ? (
          <div className="state-box">
            <RefreshCw className="spin" size={27} />
            <strong>正在加载监控任务</strong>
            <p>请稍候。</p>
          </div>
        ) : tasks.length === 0 ? (
          <div className="state-box">
            <Gauge size={27} />
            <strong>还没有监控任务</strong>
            <p>新建一条规则后，已绑定设备会在下次检查时使用它。</p>
            <button className="primary small" onClick={createTask}>
              <Plus size={15} />
              新建监控
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="monitor-table">
              <thead>
                <tr>
                  <th>监控条件</th>
                  <th>范围</th>
                  <th>采集频率</th>
                  <th>状态</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <strong>{task.rule.keyword ?? '类目监控'}</strong>
                      <small>{monitorRuleFilters(task.rule)}</small>
                    </td>
                    <td>
                      <span>{monitorRuleScope(task.rule)}</span>
                      <small>更新于 {monitorUpdatedAt(task.updatedAt)}</small>
                    </td>
                    <td>{monitorInterval(task.intervalSeconds)}</td>
                    <td>
                      <span className={`status ${task.status === 'active' ? 'ok' : 'muted'}`}>{task.status === 'active' ? '已启用' : '已暂停'}</span>
                    </td>
                    <td>
                      <div className="monitor-actions">
                        <button className="row-action" title="编辑监控" onClick={() => editTask(task)} disabled={workingId === task.id}>
                          <Pencil size={16} />
                        </button>
                        <button className="row-action" title={task.status === 'active' ? '暂停采集' : '启用采集'} onClick={() => void changeStatus(task)} disabled={workingId === task.id}>
                          {task.status === 'active' ? <Pause size={16} /> : <Play size={16} />}
                        </button>
                        <button className="row-action monitor-delete" title="删除监控" onClick={() => void deleteTask(task)} disabled={workingId === task.id}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editorOpen && <MonitorEditor editing={editing} form={form} categoryPaths={categoryPaths} regions={regions} saving={saving} error={formError} onChange={(field, value) => setForm((current) => ({ ...current, [field]: value }) as MonitorForm)} onClose={closeEditor} onSubmit={(event) => void saveTask(event)} />}
    </>
  )
}

function MonitorEditor({ editing, form, categoryPaths, regions, saving, error, onChange, onClose, onSubmit }: { editing: MonitorTask | null; form: MonitorForm; categoryPaths: string[]; regions: string[]; saving: boolean; error: string | null; onChange: (field: keyof MonitorForm, value: string) => void; onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }): ReactNode {
  const setValue = (field: keyof MonitorForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange(field, event.target.value)
  const options = (value: string, preset: string[]) => Array.from(new Set(['', ...preset, ...(value ? [value] : [])]))
  return (
    <div className="monitor-dialog-layer">
      <button className="monitor-dialog-backdrop" aria-label="关闭监控编辑器" onClick={onClose} />
      <section className="monitor-dialog" role="dialog" aria-modal="true" aria-labelledby="monitor-editor-title">
        <header>
          <div>
            <p className="eyebrow">监控规则</p>
            <h2 id="monitor-editor-title">{editing ? '编辑监控' : '新建监控'}</h2>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose} disabled={saving}>
            <X size={18} />
          </button>
        </header>
        <form onSubmit={onSubmit}>
          <div className="monitor-dialog-body">
            <div className="monitor-form-grid">
              <label className="monitor-field monitor-field-wide">
                <span>关键词</span>
                <input value={form.keyword} onChange={setValue('keyword')} maxLength={80} required={!form.categoryPath.trim()} placeholder="例如 MacBook Air M2" autoFocus />
              </label>
              <label className="monitor-field monitor-field-wide">
                <span>类目路径</span>
                <select value={form.categoryPath} onChange={setValue('categoryPath')} required={!form.keyword.trim()}>
                  {options(form.categoryPath, categoryPaths).map((option) => (
                    <option value={option} key={option}>
                      {option || '不限'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="monitor-field">
                <span>排序</span>
                <select value={form.sort} onChange={setValue('sort')}>
                  {monitorSortOptions.map((option) => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="monitor-field">
                <span>地区</span>
                <select value={form.region} onChange={setValue('region')}>
                  {options(form.region, ['全国', ...regions]).map((option) => (
                    <option value={option} key={option}>
                      {option || '不限'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="monitor-field">
                <span>最低价（元）</span>
                <input type="number" min="0" value={form.minPrice} onChange={setValue('minPrice')} placeholder="不限" />
              </label>
              <label className="monitor-field">
                <span>最高价（元）</span>
                <input type="number" min="0" value={form.maxPrice} onChange={setValue('maxPrice')} placeholder="不限" />
              </label>
            </div>
            <section className="monitor-form-section">
              <h3>公开筛选</h3>
              <div className="monitor-form-grid">
                <label className="monitor-field">
                  <span>成色</span>
                  <select value={form.condition} onChange={setValue('condition')}>
                    {options(form.condition, ['全新', '几乎全新', '轻微使用痕迹', '明显使用痕迹', '维修/瑕疵']).map((option) => (
                      <option value={option} key={option}>
                        {option || '不限'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="monitor-field">
                  <span>发货方式</span>
                  <select value={form.delivery} onChange={setValue('delivery')}>
                    {options(form.delivery, ['同城自提', '快递', '包邮', '到付']).map((option) => (
                      <option value={option} key={option}>
                        {option || '不限'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="monitor-field">
                  <span>配送</span>
                  <select value={form.shipping} onChange={setValue('shipping')}>
                    {options(form.shipping, ['包邮', '买家自提', '同城配送', '快递']).map((option) => (
                      <option value={option} key={option}>
                        {option || '不限'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="monitor-field">
                  <span>保障</span>
                  <select value={form.guarantee} onChange={setValue('guarantee')}>
                    {options(form.guarantee, ['验货宝', '平台验货', '无保障']).map((option) => (
                      <option value={option} key={option}>
                        {option || '不限'}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="monitor-field">
                  <span>仅看全新</span>
                  <select value={form.newOnly} onChange={setValue('newOnly')}>
                    <option value="">不限</option>
                    <option value="是">是</option>
                    <option value="否">否</option>
                  </select>
                </label>
              </div>
            </section>
            <section className="monitor-form-section">
              <h3>匹配与频率</h3>
              <div className="monitor-form-grid">
                <label className="monitor-field monitor-field-wide">
                  <span>包含词</span>
                  <input value={form.includeWords} onChange={setValue('includeWords')} placeholder="用逗号分隔，例如 16G，国行" />
                </label>
                <label className="monitor-field monitor-field-wide">
                  <span>排除词</span>
                  <input value={form.excludeWords} onChange={setValue('excludeWords')} placeholder="用逗号分隔，例如 维修，配件" />
                </label>
                <label className="monitor-field">
                  <span>页数上限</span>
                  <input type="number" min="1" max="10" step="1" value={form.pageLimit} onChange={setValue('pageLimit')} />
                </label>
                <label className="monitor-field">
                  <span>采集间隔（分钟）</span>
                  <input type="number" min="30" max="1440" step="1" value={form.intervalSeconds} onChange={setValue('intervalSeconds')} />
                </label>
                <div className="monitor-field monitor-switch-field">
                  <span>启用采集</span>
                  <button type="button" className={`toggle ${form.status === 'active' ? 'on' : ''}`} aria-label="启用采集" aria-pressed={form.status === 'active'} onClick={() => onChange('status', form.status === 'active' ? 'paused' : 'active')}>
                    <i />
                  </button>
                </div>
              </div>
            </section>
            {error && (
              <p className="form-error monitor-form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer>
            <button className="secondary" type="button" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button className="primary" type="submit" disabled={saving}>
              <Save size={16} />
              {saving ? '正在保存…' : '保存监控'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

function SellerMonitorPage({ api, mode, initialTarget, onInitialTargetConsumed }: { api: UserApiClient; mode: 'demo' | 'api'; initialTarget?: SellerTarget | null; onInitialTargetConsumed?: () => void }): ReactNode {
  const [page, setPage] = useState<UserPage<SellerMonitor>>({
    items: [],
    total: 0,
    nextCursor: null,
    hasMore: false
  })
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
  const [intervalTask, setIntervalTask] = useState<SellerMonitor | null>(null)
  const request = useMemo<UserListRequest>(
    () => ({
      limit: pageSize,
      cursor,
      sort: 'updated_at_desc',
      filters: {
        ...(query.trim() ? { q: query.trim() } : {}),
        ...(status ? { status } : {})
      }
    }),
    [cursor, pageSize, query, status]
  )

  useEffect(() => {
    if (mode === 'demo') {
      const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
      const filtered = demoTasks.filter((task) => (!normalizedQuery || `${task.publicName ?? ''} ${task.platformSellerId} ${task.profileUrl}`.toLocaleLowerCase('zh-CN').includes(normalizedQuery)) && (!status || task.status === status))
      const offsetMatch = /^demo:(\d+)$/.exec(cursor ?? '')
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0
      const items = filtered.slice(offset, offset + pageSize)
      const nextOffset = offset + items.length
      setPage({
        items,
        total: filtered.length,
        nextCursor: nextOffset < filtered.length ? `demo:${nextOffset}` : null,
        hasMore: nextOffset < filtered.length
      })
      setLoadError(null)
      setLoading(false)
      return
    }

    const controller = new AbortController()
    let active = true
    setLoading(true)
    setLoadError(null)
    api
      .listSellerMonitors(request, controller.signal)
      .then((result) => {
        if (active) setPage(result)
      })
      .catch((caught) => {
        if (!active || (caught instanceof DOMException && caught.name === 'AbortError')) return
        setLoadError(caught instanceof UserApiError ? caught.message : '竞品商家加载失败')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
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
        setDemoTasks((current) => [
          {
            id: `demo-seller-monitor-${Date.now()}`,
            sellerId: `demo-seller-${Date.now()}`,
            platform: 'goofish',
            platformSellerId,
            profileUrl,
            ruleVersion: 1,
            intervalSeconds: input.intervalSeconds,
            status: input.status ?? 'active',
            nextRunAt: '',
            createdAt: now,
            updatedAt: now
          },
          ...current
        ])
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
        setDemoTasks((current) =>
          current.map((entry) =>
            entry.id === task.id
              ? {
                  ...entry,
                  status: nextStatus,
                  updatedAt: new Date().toISOString()
                }
              : entry
          )
        )
      } else {
        const updated = await api.updateSellerMonitor(task.id, {
          status: nextStatus
        })
        setPage((current) => ({
          ...current,
          items: current.items.map((entry) => (entry.id === updated.id ? updated : entry))
        }))
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
  const saveInterval = async (task: SellerMonitor, minutes: number) => {
    const intervalSeconds = minutes * 60
    setActionError(null)
    setWorkingId(task.id)
    try {
      if (mode === 'demo') {
        setDemoTasks((current) =>
          current.map((entry) =>
            entry.id === task.id
              ? {
                  ...entry,
                  intervalSeconds,
                  updatedAt: new Date().toISOString()
                }
              : entry
          )
        )
      } else {
        const updated = await api.updateSellerMonitor(task.id, {
          intervalSeconds
        })
        setPage((current) => ({
          ...current,
          items: current.items.map((entry) => (entry.id === updated.id ? updated : entry))
        }))
      }
      setIntervalTask(null)
    } catch (caught) {
      setActionError(caught instanceof UserApiError ? caught.message : '更新采集间隔失败')
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

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">竞品监控</p>
          <h1>竞品商家</h1>
          <p>管理公开卖家监控任务。</p>
        </div>
        <button className="primary" onClick={() => openEditor()}>
          <Plus size={16} />
          添加商家
        </button>
      </div>
      {actionError && (
        <div className="monitor-alert" role="alert">
          {actionError}
        </div>
      )}
      <section className="table-panel monitor-table-panel seller-monitor-table-panel">
        <div className="table-summary">
          <span>
            共 <strong>{page.total}</strong> 个商家
          </span>
          <button className="icon-button" title="刷新竞品商家" onClick={() => setReloadKey((value) => value + 1)} disabled={loading}>
            <RefreshCw size={17} className={loading ? 'spin' : ''} />
          </button>
        </div>
        <div className="filter-bar seller-monitor-filter">
          <label className="search-field">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                resetToFirstPage()
              }}
              placeholder="搜索卖家"
            />
          </label>
          <label>
            <span>状态</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value)
                resetToFirstPage()
              }}
            >
              <option value="">全部状态</option>
              <option value="active">已启用</option>
              <option value="paused">已暂停</option>
            </select>
          </label>
        </div>
        {loadError ? (
          <div className="state-box">
            <Activity size={27} />
            <strong>竞品商家加载失败</strong>
            <p>{loadError}</p>
            <button className="primary small" onClick={() => setReloadKey((value) => value + 1)}>
              <RefreshCw size={15} />
              重试
            </button>
          </div>
        ) : loading ? (
          <div className="state-box">
            <RefreshCw className="spin" size={27} />
            <strong>正在加载竞品商家</strong>
            <p>请稍候。</p>
          </div>
        ) : page.items.length === 0 ? (
          <div className="state-box">
            <Store size={27} />
            <strong>还没有竞品商家</strong>
            <p>添加公开卖家主页后即可开始监控。</p>
            <button className="primary small" onClick={() => openEditor()}>
              <Plus size={15} />
              添加商家
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="monitor-table seller-monitor-table">
              <thead>
                <tr>
                  <th>商家</th>
                  <th>采集频率</th>
                  <th>最近更新</th>
                  <th>状态</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {page.items.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <strong>{task.publicName ?? task.platformSellerId}</strong>
                      <small>{task.profileUrl || task.platformSellerId}</small>
                    </td>
                    <td>{monitorInterval(task.intervalSeconds)}</td>
                    <td>
                      <span className="time">{monitorUpdatedAt(task.updatedAt)}</span>
                    </td>
                    <td>
                      <span className={`status ${task.status === 'active' ? 'ok' : 'muted'}`}>{task.status === 'active' ? '已启用' : '已暂停'}</span>
                    </td>
                    <td>
                      <div className="monitor-actions">
                        <button className="row-action" title="查看商家详情" onClick={() => setDetailTask(task)}>
                          <MoreHorizontal size={17} />
                        </button>
                        <button className="row-action" title="编辑采集间隔" onClick={() => setIntervalTask(task)} disabled={workingId === task.id}>
                          <Pencil size={16} />
                        </button>
                        <button className="row-action" title={task.status === 'active' ? '暂停监控' : '启用监控'} onClick={() => void changeStatus(task)} disabled={workingId === task.id}>
                          {task.status === 'active' ? <Pause size={16} /> : <Play size={16} />}
                        </button>
                        <button className="row-action monitor-delete" title="删除商家" onClick={() => void deleteTask(task)} disabled={workingId === task.id}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <CursorPagination
          total={page.total}
          pageIndex={cursorHistory.length + 1}
          pageSize={pageSize}
          canGoBack={cursorHistory.length > 0}
          canGoForward={page.hasMore && Boolean(page.nextCursor)}
          onPrev={previousPage}
          onNext={nextPage}
          onPageSize={(value) => {
            setPageSize(value)
            resetToFirstPage()
          }}
        />
      </section>
      {editorOpen && <SellerMonitorEditor form={form} saving={saving} error={formError} onChange={(field, value) => setForm((current) => ({ ...current, [field]: value }))} onClose={closeEditor} onSubmit={(event) => void saveTask(event)} />}
      {intervalTask && <SellerMonitorIntervalModal task={intervalTask} saving={workingId === intervalTask.id} onClose={() => setIntervalTask(null)} onSave={(minutes) => void saveInterval(intervalTask, minutes)} />}
      {detailTask && <SellerMonitorDetail api={api} mode={mode} task={detailTask} onClose={() => setDetailTask(null)} />}
    </>
  )
}

function SellerMonitorEditor({ form, saving, error, onChange, onClose, onSubmit }: { form: SellerMonitorForm; saving: boolean; error: string | null; onChange: (field: keyof SellerMonitorForm, value: string) => void; onClose: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }): ReactNode {
  const setValue = (field: keyof SellerMonitorForm) => (event: React.ChangeEvent<HTMLInputElement>) => onChange(field, event.target.value)
  return (
    <div className="monitor-dialog-layer">
      <button className="monitor-dialog-backdrop" aria-label="关闭竞品商家编辑器" onClick={onClose} />
      <section className="monitor-dialog seller-monitor-dialog" role="dialog" aria-modal="true" aria-labelledby="seller-monitor-editor-title">
        <header>
          <div>
            <p className="eyebrow">竞品商家</p>
            <h2 id="seller-monitor-editor-title">添加商家</h2>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose} disabled={saving}>
            <X size={18} />
          </button>
        </header>
        <form onSubmit={onSubmit}>
          <div className="monitor-dialog-body">
            <div className="monitor-form-grid">
              <label className="monitor-field monitor-field-wide">
                <span>公开卖家主页或卖家 ID</span>
                <input value={form.target} onChange={setValue('target')} maxLength={2048} placeholder="粘贴公开主页" autoFocus required />
              </label>
              <label className="monitor-field">
                <span>采集间隔（分钟）</span>
                <input type="number" min="30" max="1440" step="1" value={form.intervalSeconds} onChange={setValue('intervalSeconds')} />
              </label>
              <div className="monitor-field monitor-switch-field">
                <span>启用监控</span>
                <button type="button" className={`toggle ${form.status === 'active' ? 'on' : ''}`} aria-label="启用监控" aria-pressed={form.status === 'active'} onClick={() => onChange('status', form.status === 'active' ? 'paused' : 'active')}>
                  <i />
                </button>
              </div>
            </div>
            {error && (
              <p className="form-error monitor-form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer>
            <button className="secondary" type="button" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button className="primary" type="submit" disabled={saving}>
              <Save size={16} />
              {saving ? '正在保存…' : '添加商家'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

function SellerMonitorIntervalModal({ task, saving, onClose, onSave }: { task: SellerMonitor; saving: boolean; onClose: () => void; onSave: (minutes: number) => void }): ReactNode {
  const [minutes, setMinutes] = useState(String(Math.max(30, Math.round(task.intervalSeconds / 60))))
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    const value = Number(minutes)
    if (!Number.isInteger(value) || value < 30 || value > 1440) {
      setError('采集间隔需为 30 到 1440 分钟的整数')
      return
    }
    onSave(value)
  }
  return (
    <Modal
      title="编辑采集间隔"
      onClose={onClose}
      footer={
        <>
          <button className="secondary" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="primary" onClick={submit} disabled={saving}>
            {saving ? '正在保存…' : '保存'}
          </button>
        </>
      }
    >
      <label className="modal-field">
        <span>采集间隔（分钟）</span>
        <input type="number" min="30" max="1440" step="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} autoFocus />
      </label>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
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
  const [profile, setProfile] = useState<SellerMonitorProfile>({
    task,
    seller: fallbackSeller
  })
  const [profileLoading, setProfileLoading] = useState(mode === 'api')
  const [profileError, setProfileError] = useState<string | null>(null)
  const [tab, setTab] = useState<SellerDetailTab>('items')
  const [itemsPage, setItemsPage] = useState<UserPage<SellerItem>>({
    items: [],
    total: 0,
    nextCursor: null,
    hasMore: false
  })
  const [eventsPage, setEventsPage] = useState<UserPage<SellerEvent>>({
    items: [],
    total: 0,
    nextCursor: null,
    hasMore: false
  })
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
  const [migratingItemId, setMigratingItemId] = useState<string | null>(null)
  const [migratedItemIds, setMigratedItemIds] = useState<string[]>([])
  const [migrationError, setMigrationError] = useState<string | null>(null)

  const itemRequest = useMemo<UserListRequest>(
    () => ({
      limit: itemPageSize,
      cursor: itemCursor,
      sort: 'last_seen_at',
      filters: {
        ...(itemQuery.trim() ? { q: itemQuery.trim() } : {}),
        ...(itemState ? { state: itemState } : {})
      }
    }),
    [itemCursor, itemPageSize, itemQuery, itemState]
  )
  const eventRequest = useMemo<UserListRequest>(
    () => ({
      limit: eventPageSize,
      cursor: eventCursor,
      sort: 'occurred_at',
      filters: {
        ...(eventType ? { eventType } : {}),
        ...(eventItemId.trim() ? { itemId: eventItemId.trim() } : {})
      }
    }),
    [eventCursor, eventItemId, eventPageSize, eventType]
  )

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
    api
      .getSellerMonitorProfile(task.id, controller.signal)
      .then((result) => {
        if (active) setProfile(result)
      })
      .catch((caught) => {
        if (!active || (caught instanceof DOMException && caught.name === 'AbortError')) return
        setProfileError(caught instanceof UserApiError ? caught.message : '卖家公开资料加载失败')
      })
      .finally(() => {
        if (active) setProfileLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
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
    api
      .listSellerMonitorItems(task.id, itemRequest, controller.signal)
      .then((result) => {
        if (active) setItemsPage(result)
      })
      .catch((caught) => {
        if (!active || (caught instanceof DOMException && caught.name === 'AbortError')) return
        setItemsError(caught instanceof UserApiError ? caught.message : '卖家商品加载失败')
      })
      .finally(() => {
        if (active) setItemsLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
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
    api
      .listSellerMonitorEvents(task.id, eventRequest, controller.signal)
      .then((result) => {
        if (active) setEventsPage(result)
      })
      .catch((caught) => {
        if (!active || (caught instanceof DOMException && caught.name === 'AbortError')) return
        setEventsError(caught instanceof UserApiError ? caught.message : '卖家事件加载失败')
      })
      .finally(() => {
        if (active) setEventsLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [api, eventCursor, eventItemId, eventPageSize, eventRequest, eventType, mode, reloadKey, tab, task])

  const resetItems = () => {
    setItemCursor(null)
    setItemHistory([])
  }
  const resetEvents = () => {
    setEventCursor(null)
    setEventHistory([])
  }
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
  const migrateItem = async (item: SellerItem) => {
    setMigratingItemId(item.id)
    setMigrationError(null)
    try {
      if (mode !== 'demo')
        await api.createSupplyMigration({
          schemaVersion: 1,
          idempotencyKey: newSupplyKey(),
          source: { kind: 'market_item', sourceId: item.id }
        })
      setMigratedItemIds((ids) => (ids.includes(item.id) ? ids : [...ids, item.id]))
    } catch (caught) {
      setMigrationError(caught instanceof UserApiError ? caught.message : '创建搬家请求失败')
    } finally {
      setMigratingItemId(null)
    }
  }
  const seller = profile.seller
  const sellerName = seller.publicName ?? task.publicName ?? task.platformSellerId

  return (
    <>
      <button className="drawer-backdrop" aria-label="关闭卖家详情" onClick={onClose} />
      <aside className="drawer seller-detail-drawer">
        <header>
          <div>
            <span className="eyebrow">竞品商家</span>
            <h2>{sellerName}</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭">
            <X size={19} />
          </button>
        </header>
        <div className="drawer-body seller-detail-body">
          <section className="seller-profile-card">
            <div>
              <strong>{sellerName}</strong>
              <span>
                {seller.region ?? task.region ?? '地区未知'} · {seller.platformSellerId}
              </span>
            </div>
            <span className={`status ${task.status === 'active' ? 'ok' : 'muted'}`}>{task.status === 'active' ? '已启用' : '已暂停'}</span>
            <dl>
              <div>
                <dt>首次观测</dt>
                <dd>{monitorUpdatedAt(seller.firstSeenAt)}</dd>
              </div>
              <div>
                <dt>最近观测</dt>
                <dd>{monitorUpdatedAt(seller.lastSeenAt)}</dd>
              </div>
              <div>
                <dt>采集频率</dt>
                <dd>{monitorInterval(task.intervalSeconds)}</dd>
              </div>
            </dl>
            {task.profileUrl && (
              <a className="seller-profile-link" href={task.profileUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                打开公开主页
              </a>
            )}
          </section>
          {profileLoading && (
            <div className="seller-detail-state">
              <RefreshCw className="spin" size={19} />
              正在加载公开资料
            </div>
          )}
          {profileError && (
            <div className="monitor-alert" role="alert">
              {profileError}
            </div>
          )}
          <div className="seller-detail-tabs" role="tablist">
            <button className={tab === 'items' ? 'active' : ''} role="tab" aria-selected={tab === 'items'} onClick={() => setTab('items')}>
              商品 <strong>{itemsPage.total}</strong>
            </button>
            <button className={tab === 'events' ? 'active' : ''} role="tab" aria-selected={tab === 'events'} onClick={() => setTab('events')}>
              事件 <strong>{eventsPage.total}</strong>
            </button>
            <button className="icon-button" title="刷新详情" onClick={() => setReloadKey((value) => value + 1)}>
              <RefreshCw size={16} />
            </button>
          </div>
          {tab === 'items' ? (
            <section className="seller-detail-section">
              <div className="seller-detail-filter">
                <label className="search-field">
                  <Search size={16} />
                  <input
                    value={itemQuery}
                    onChange={(event) => {
                      setItemQuery(event.target.value)
                      resetItems()
                    }}
                    placeholder="搜索商品 ID"
                  />
                </label>
                <label>
                  <span>状态</span>
                  <select
                    value={itemState}
                    onChange={(event) => {
                      setItemState(event.target.value as SellerItemState | '')
                      resetItems()
                    }}
                  >
                    <option value="">全部</option>
                    <option value="active">在售</option>
                    <option value="sold">已售</option>
                    <option value="offline">已下架</option>
                    <option value="unknown">未知</option>
                  </select>
                </label>
              </div>
              {itemsError ? (
                <div className="seller-detail-state">
                  <Activity size={20} />
                  <strong>商品加载失败</strong>
                  <p>{itemsError}</p>
                </div>
              ) : itemsLoading ? (
                <div className="seller-detail-state">
                  <RefreshCw className="spin" size={20} />
                  正在加载商品
                </div>
              ) : itemsPage.items.length === 0 ? (
                <div className="seller-detail-state">
                  <PackageSearch size={20} />
                  <strong>暂无商品</strong>
                </div>
              ) : (
                <div className="seller-item-list">
                  {itemsPage.items.map((item) => (
                    <div className="seller-item-row" key={item.id}>
                      <div>
                        <strong>{(item.title ?? item.platformItemId) || item.id}</strong>
                        <small>{sellerItemSummary(item) || item.id}</small>
                      </div>
                      <span className={`status ${item.state === 'active' ? 'ok' : item.state === 'sold' ? 'watch' : 'muted'}`}>{sellerItemStateLabel(item.state)}</span>
                      <small>{monitorUpdatedAt(item.lastSeenAt)}</small>
                      <div className="seller-item-actions">
                        <button className="text-button seller-item-migrate" disabled={migratingItemId === item.id || migratedItemIds.includes(item.id)} onClick={() => void migrateItem(item)}>
                          {migratedItemIds.includes(item.id) ? '已搬家' : migratingItemId === item.id ? '提交中…' : '搬家'}
                        </button>
                        <button className="row-action" title="查看商品详情" onClick={() => setSelectedItem(item)}>
                          <MoreHorizontal size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {migrationError && (
                <p className="form-error" role="alert">
                  {migrationError}
                </p>
              )}
              <CursorPagination
                total={itemsPage.total}
                pageIndex={itemHistory.length + 1}
                pageSize={itemPageSize}
                canGoBack={itemHistory.length > 0}
                canGoForward={itemsPage.hasMore && Boolean(itemsPage.nextCursor)}
                onPrev={previousItems}
                onNext={nextItems}
                onPageSize={(value) => {
                  setItemPageSize(value)
                  resetItems()
                }}
              />
            </section>
          ) : (
            <section className="seller-detail-section">
              <div className="seller-detail-filter">
                <label>
                  <span>事件类型</span>
                  <select
                    value={eventType}
                    onChange={(event) => {
                      setEventType(event.target.value)
                      resetEvents()
                    }}
                  >
                    <option value="">全部事件</option>
                    <option value="new_listing">上新</option>
                    <option value="price_changed">价格变化</option>
                    <option value="state_changed">状态变化</option>
                    <option value="content_changed">内容变化</option>
                  </select>
                </label>
                <label className="search-field">
                  <Search size={16} />
                  <input
                    value={eventItemId}
                    onChange={(event) => {
                      setEventItemId(event.target.value)
                      resetEvents()
                    }}
                    placeholder="商品 ID"
                  />
                </label>
              </div>
              {eventsError ? (
                <div className="seller-detail-state">
                  <Activity size={20} />
                  <strong>事件加载失败</strong>
                  <p>{eventsError}</p>
                </div>
              ) : eventsLoading ? (
                <div className="seller-detail-state">
                  <RefreshCw className="spin" size={20} />
                  正在加载事件
                </div>
              ) : eventsPage.items.length === 0 ? (
                <div className="seller-detail-state">
                  <Activity size={20} />
                  <strong>暂无事件</strong>
                </div>
              ) : (
                <ol className="seller-event-timeline">
                  {eventsPage.items.map((event) => (
                    <li key={event.id}>
                      <span className="seller-event-dot" />
                      <div>
                        <strong>{sellerEventLabel(event.eventType)}</strong>
                        <small>商品 {event.itemId || '未知'}</small>
                        <p>
                          {monitorUpdatedAt(event.occurredAt)} · 检测于 {monitorUpdatedAt(event.detectedAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              <CursorPagination
                total={eventsPage.total}
                pageIndex={eventHistory.length + 1}
                pageSize={eventPageSize}
                canGoBack={eventHistory.length > 0}
                canGoForward={eventsPage.hasMore && Boolean(eventsPage.nextCursor)}
                onPrev={previousEvents}
                onNext={nextEvents}
                onPageSize={(value) => {
                  setEventPageSize(value)
                  resetEvents()
                }}
              />
            </section>
          )}
        </div>
        <footer>
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
        </footer>
      </aside>
      {selectedItem && <SellerItemDetailModal item={selectedItem} migrating={migratingItemId === selectedItem.id} migrated={migratedItemIds.includes(selectedItem.id)} onClose={() => setSelectedItem(null)} onMigrate={() => void migrateItem(selectedItem)} />}
    </>
  )
}

function SellerItemDetailModal({ item, migrating, migrated, onClose, onMigrate }: { item: SellerItem; migrating: boolean; migrated: boolean; onClose: () => void; onMigrate: () => void }): ReactNode {
  const currentPrice = item.currentPrice ?? item.price
  const originalPrice = item.previousPrice
  const skuLines = sellerSkuLines(item.sku)
  const formatPrice = (value?: string) => (value === undefined || value === '' ? '暂无价格' : `¥${value}`)
  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭商品详情" onClick={onClose} />
      <section className="modal-shell seller-item-modal" role="dialog" aria-modal="true" aria-labelledby="seller-item-detail-title">
        <header>
          <div>
            <span className="eyebrow">竞品商品</span>
            <h2 id="seller-item-detail-title">{item.title || item.platformItemId || item.id}</h2>
          </div>
          <button className="icon-button" title="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="modal-body seller-item-modal-body">
          <section className="seller-item-hero">
            {item.images[0] ? (
              <img src={item.images[0]} alt="" />
            ) : (
              <div className="market-image-empty">
                <PackageSearch size={24} />
              </div>
            )}
            <div>
              <strong>{formatPrice(currentPrice)}</strong>
              {originalPrice && currentPrice && originalPrice !== currentPrice && <small>原价 ¥{originalPrice}</small>}
              <p>
                {item.region || '地区未采集'}
                {item.conditionText ? ` · ${item.conditionText}` : ''}
                {item.wantCount === undefined ? '' : ` · ${item.wantCount} 人想要`}
              </p>
              <span className={`status ${item.state === 'active' ? 'ok' : item.state === 'sold' ? 'watch' : 'muted'}`}>{sellerItemStateLabel(item.state)}</span>
            </div>
          </section>
          <section className="seller-item-detail-section">
            <h3>商品信息</h3>
            <dl>
              <div>
                <dt>平台商品 ID</dt>
                <dd>{item.platformItemId || item.id}</dd>
              </div>
              <div>
                <dt>类目路径</dt>
                <dd>{item.categoryPath?.join(' / ') || '暂未采集'}</dd>
              </div>
              <div>
                <dt>地区</dt>
                <dd>{item.region || '暂未采集'}</dd>
              </div>
              <div>
                <dt>商品状态</dt>
                <dd>{sellerItemStateLabel(item.state)}</dd>
              </div>
              {item.sourceUrl && (
                <div>
                  <dt>公开链接</dt>
                  <dd>
                    <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                      打开商品页 <ExternalLink size={13} />
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <section className="seller-item-detail-section">
            <h3>价格与规格</h3>
            <dl>
              <div>
                <dt>商家现价</dt>
                <dd>{formatPrice(currentPrice)}</dd>
              </div>
              <div>
                <dt>商家原价</dt>
                <dd>{originalPrice ? formatPrice(originalPrice) : '暂无历史价格'}</dd>
              </div>
              <div>
                <dt>规格</dt>
                <dd>
                  {skuLines.length
                    ? skuLines.map((line) => (
                        <span className="seller-item-sku-line" key={line}>
                          {line}
                        </span>
                      ))
                    : '暂未采集规格'}
                </dd>
              </div>
            </dl>
          </section>
          {item.description && (
            <section className="seller-item-detail-section">
              <h3>商品描述</h3>
              <p className="seller-item-description">{item.description}</p>
            </section>
          )}
          {item.tags?.length ? (
            <section className="seller-item-detail-section">
              <h3>标签</h3>
              <div className="seller-item-tags">
                {item.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </section>
          ) : null}
          <section className="seller-item-detail-section">
            <h3>发现记录</h3>
            <dl>
              <div>
                <dt>首次发现</dt>
                <dd>{monitorUpdatedAt(item.firstSeenAt)}</dd>
              </div>
              <div>
                <dt>最近发现</dt>
                <dd>{monitorUpdatedAt(item.lastSeenAt)}</dd>
              </div>
            </dl>
          </section>
        </div>
        <footer>
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
          <button className="primary small" onClick={onMigrate} disabled={migrating || migrated}>
            {migrated ? '已搬家' : migrating ? '提交中…' : '搬家'}
          </button>
        </footer>
      </section>
    </div>
  )
}

function ApiState({ title, description }: { title: string; description: string }): ReactNode {
  return (
    <div className="state-box api-state">
      <Activity size={27} />
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  )
}

function ListPage(props: {
  api: UserApiClient
  mode: 'demo' | 'api'
  resource: RowKind
  copy: {
    title: string
    description: string
    primary: string
    columns: [string, string, string, string]
  }
  rows: TableRow[]
  total: number
  pageIndex: number
  pageSize: number
  query: string
  status: string
  sort: SortKey
  loading: boolean
  error: string | null
  canGoBack: boolean
  canGoForward: boolean
  onQuery: (value: string) => void
  onStatus: (value: string) => void
  onSort: (value: string) => void
  onPageSize: (value: number) => void
  onPrev: () => void
  onNext: () => void
  onReload: () => void
  onRetry: () => void
  onOpen: (row: TableRow) => void
  tabs?: Array<{ key: RowKind; label: string }>
  tabMode?: 'tabs' | 'select'
  onTabChange: (next: RowKind) => void
}): ReactNode {
  const { copy, rows, total, pageIndex, pageSize, query, status, sort, loading, error } = props
  const [aiOpen, setAiOpen] = useState(false)
  const exportCurrentPage = () => {
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`
    const lines = [copy.columns, ...rows.map((row) => [row.title, row.metric, row.updatedAt, row.status])]
    const blob = new Blob([`\ufeff${lines.map((line) => line.map(escape).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${copy.title}-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(link.href)
  }
  const handlePrimary = () => {
    if (props.resource === 'logs') return exportCurrentPage()
    if (props.resource === 'ai') return setAiOpen(true)
  }
  const hasPrimary = props.resource === 'logs' || props.resource === 'ai'
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">数据中心</p>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        {hasPrimary && (
          <button className="primary" onClick={handlePrimary}>
            {props.resource === 'logs' ? <ExternalLink size={16} /> : <Bot size={16} />}
            {copy.primary}
          </button>
        )}
      </div>
      {props.tabs && props.tabMode !== 'select' && (
        <div className="content-tabs" role="tablist">
          {props.tabs.map((tab) => (
            <button key={tab.key} className={props.resource === tab.key ? 'active' : ''} role="tab" aria-selected={props.resource === tab.key} onClick={() => props.onTabChange(tab.key)}>
              {tab.label}
            </button>
          ))}
        </div>
      )}
      <section className="filter-bar">
        <label className="search-field">
          <Search size={17} />
          <input value={query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索名称、对象或变化内容" />
        </label>
        {props.tabs && props.tabMode === 'select' && (
          <label className="trend-filter">
            <span>动态类型</span>
            <select value={props.resource} onChange={(event) => props.onTabChange(event.target.value as RowKind)}>
              {props.tabs.map((tab) => (
                <option value={tab.key} key={tab.key}>
                  {tab.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span>状态</span>
          <select value={status} onChange={(event) => props.onStatus(event.target.value)}>
            <option value="">全部状态</option>
            <option value="正常">正常</option>
            <option value="关注">关注</option>
            <option value="失败">失败</option>
            <option value="已处理">已处理</option>
          </select>
        </label>
        <label>
          <span>排序</span>
          <select value={sort} onChange={(event) => props.onSort(event.target.value)}>
            {sortOptions.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="filter-spacer" />
        <button className="icon-button" title="刷新" onClick={props.onReload}>
          <RefreshCw size={17} className={loading ? 'spin' : ''} />
        </button>
      </section>
      <section className="table-panel">
        <div className="table-summary">
          <span>
            共 <strong>{total}</strong> 条
          </span>
        </div>
        {error ? (
          <div className="state-box">
            <Activity size={27} />
            <strong>列表加载失败</strong>
            <p>{error}</p>
            <button className="primary small" onClick={props.onRetry}>
              <RefreshCw size={15} />
              重试
            </button>
          </div>
        ) : loading ? (
          <div className="state-box">
            <RefreshCw className="spin" size={27} />
            <strong>正在加载数据</strong>
            <p>请稍候。</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="state-box">
            <Filter size={27} />
            <strong>没有匹配的数据</strong>
            <p>调整关键词或状态后重试。</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{copy.columns[0]}</th>
                  <th>{copy.columns[1]}</th>
                  <th>{copy.columns[2]}</th>
                  <th>{copy.columns[3]}</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span className="row-tag">{row.tag}</span>
                      <strong>{row.title}</strong>
                      <small>{row.subtitle}</small>
                    </td>
                    <td>{row.metric}</td>
                    <td>
                      <span className="time">{row.updatedAt}</span>
                    </td>
                    <td>
                      <span className={`status ${statusClass[row.status]}`}>{row.status}</span>
                    </td>
                    <td>
                      <div className="supply-actions">
                        <button className="row-action" title="查看详情" onClick={() => props.onOpen(row)}>
                          <MoreHorizontal size={19} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <CursorPagination total={total} pageIndex={pageIndex} pageSize={pageSize} canGoBack={props.canGoBack} canGoForward={props.canGoForward} onPrev={props.onPrev} onNext={props.onNext} onPageSize={props.onPageSize} />
      </section>
      {aiOpen && <AiRequestModal api={props.api} mode={props.mode} resource={props.resource} query={query} status={status} sort={sort} rows={rows} onClose={() => setAiOpen(false)} />}
    </>
  )
}

function AiRequestModal({ api, mode, resource, query, status, sort, rows, onClose }: { api: UserApiClient; mode: 'demo' | 'api'; resource: RowKind; query: string; status: string; sort: SortKey; rows: TableRow[]; onClose: () => void }): ReactNode {
  const [scope, setScope] = useState<'personal' | 'global'>('personal')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState<string | null>(null)
  const submit = async () => {
    setSubmitting(true)
    setError(null)
    try {
      if (mode === 'demo') {
        setSubmitted(`demo-ai-${Date.now()}`)
        return
      }
      const key = typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
      const job = await api.createAiJob({
        capabilityCode: 'price_band',
        scope,
        input: {
          resource,
          query,
          status,
          sort,
          itemIds: scope === 'personal' ? rows.map((row) => row.id) : []
        },
        idempotencyKey: `user-ai:${resource}:${scope}:${key}`
      })
      setSubmitted(job.id)
    } catch (caught) {
      setError(caught instanceof UserApiError ? caught.message : '分析请求提交失败')
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭分析请求" onClick={onClose} />
      <section className="modal-shell ai-request-modal" role="dialog" aria-modal="true" aria-labelledby="ai-request-title">
        <header>
          <div>
            <p className="eyebrow">AI 分析</p>
            <h2 id="ai-request-title">选择分析范围</h2>
          </div>
          <button className="icon-button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">
          {submitted ? (
            <div className="submit-success">
              <Bot size={23} />
              <strong>分析请求已提交</strong>
              <p>结果生成后会出现在 AI 分析列表。</p>
            </div>
          ) : (
            <>
              <label className="scope-option">
                <input type="radio" name="ai-scope" checked={scope === 'personal'} onChange={() => setScope('personal')} />
                <span>
                  <strong>个人数据</strong>
                  <small>分析当前账户已关注的公开市场数据。</small>
                </span>
              </label>
              <label className="scope-option">
                <input type="radio" name="ai-scope" checked={scope === 'global'} onChange={() => setScope('global')} />
                <span>
                  <strong>全局市场</strong>
                  <small>分析共享市场中的公开数据。</small>
                </span>
              </label>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
        <footer>
          {submitted ? (
            <button className="primary" onClick={onClose}>
              完成
            </button>
          ) : (
            <>
              <button className="secondary" onClick={onClose} disabled={submitting}>
                取消
              </button>
              <button className="primary" onClick={() => void submit()} disabled={submitting}>
                {submitting ? '正在提交…' : '开始分析'}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  )
}

function CursorPagination({ total, pageIndex, pageSize, canGoBack, canGoForward, onPrev, onNext, onPageSize }: { total: number; pageIndex: number; pageSize: number; canGoBack: boolean; canGoForward: boolean; onPrev: () => void; onNext: () => void; onPageSize: (value: number) => void }): ReactNode {
  const start = total === 0 ? 0 : (pageIndex - 1) * pageSize + 1
  const end = Math.min(pageIndex * pageSize, total)
  return (
    <div className="pagination">
      <span>
        {start}-{end} / {total}
      </span>
      <select aria-label="每页条数" value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}>
        <option value={20}>20 / 页</option>
        <option value={50}>50 / 页</option>
        <option value={100}>100 / 页</option>
      </select>
      <button disabled={!canGoBack} onClick={onPrev} title="上一页">
        <ChevronLeft size={17} />
      </button>
      <button disabled={!canGoForward} onClick={onNext} title="下一页">
        <ChevronRight size={17} />
      </button>
    </div>
  )
}

function MarketItemDetail({ api, mode, row, onClose, onAddSeller, onOpenEvents }: { api: UserApiClient; mode: 'demo' | 'api'; row: TableRow; onClose: () => void; onAddSeller: (target: SellerTarget) => void; onOpenEvents: () => void }): ReactNode {
  const market = row.market!
  const [migrating, setMigrating] = useState(false)
  const [migrationResult, setMigrationResult] = useState<string | null>(null)
  const [migrationError, setMigrationError] = useState<string | null>(null)
  const currentPrice = market.currentPrice ?? (market.price ? Number(market.price) : undefined)
  const price = currentPrice === undefined || !Number.isFinite(currentPrice) ? '暂无价格' : `¥${currentPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
  const priceChange = market.previousPrice === undefined || currentPrice === undefined ? null : `原价 ¥${market.previousPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} -> 现价 ¥${currentPrice.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`
  const itemId = market.platformItemId || row.id
  const sellerName = market.platformSellerId || market.sellerId || '暂无公开卖家标识'
  const formatDate = (value?: string) => (value ? supplyDate(value) : '暂无记录')
  const migrate = async () => {
    setMigrating(true)
    setMigrationError(null)
    try {
      const request =
        mode === 'demo'
          ? { status: 'queued', platformItemId: itemId }
          : await api.createSupplyMigration({
              schemaVersion: 1,
              idempotencyKey: newSupplyKey(),
              source: { kind: 'market_item', sourceId: row.id }
            })
      setMigrationResult(`商品 ${request.platformItemId} 已加入搬家队列${request.status === 'queued' ? '，等待本机采集器处理' : ''}`)
    } catch (caught) {
      setMigrationError(caught instanceof UserApiError ? caught.message : '创建搬家请求失败')
    } finally {
      setMigrating(false)
    }
  }
  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭商品详情" onClick={onClose} />
      <section className="modal-shell market-detail-modal" role="dialog" aria-modal="true" aria-labelledby="market-detail-title">
        <header>
          <div>
            <span className="eyebrow">市场商品</span>
            <h2 id="market-detail-title">{row.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭">
            <X size={19} />
          </button>
        </header>
        <div className="modal-body market-detail-body">
          <section className="market-detail-hero">
            {market.images[0] ? (
              <img src={market.images[0]} alt="" />
            ) : (
              <div className="market-image-empty">
                <PackageSearch size={24} />
              </div>
            )}
            <div>
              <span className="row-tag">{row.tag}</span>
              <strong>{price}</strong>
              {priceChange && <small>{priceChange}</small>}
              <p>
                {market.region || '地区未知'}
                {market.conditionText ? ` · ${market.conditionText}` : ''}
                {market.wantCount === undefined ? '' : ` · ${market.wantCount} 人想要`}
              </p>
            </div>
          </section>
          <section className="market-detail-section">
            <h3>商品信息</h3>
            <dl>
              <div>
                <dt>平台</dt>
                <dd>{market.platform || '闲鱼'}</dd>
              </div>
              <div>
                <dt>商品 ID</dt>
                <dd>{itemId}</dd>
              </div>
              <div>
                <dt>商品状态</dt>
                <dd>
                  <span className={`status ${statusClass[row.status]}`}>{row.status}</span>
                </dd>
              </div>
              {market.sourceUrl && (
                <div>
                  <dt>公开链接</dt>
                  <dd>
                    <a href={market.sourceUrl} target="_blank" rel="noreferrer">
                      打开商品页 <ExternalLink size={13} />
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <section className="market-detail-section">
            <h3>卖家</h3>
            <dl>
              <div>
                <dt>公开卖家 ID</dt>
                <dd>{sellerName}</dd>
              </div>
              <div>
                <dt>卖家记录</dt>
                <dd>{market.sellerId || '尚未关联本地卖家记录'}</dd>
              </div>
            </dl>
            {row.sellerTarget && (
              <button className="text-button market-detail-link" onClick={() => onAddSeller(row.sellerTarget!)}>
                <Store size={15} />
                查看关联卖家
              </button>
            )}
          </section>
          <section className="market-detail-section">
            <h3>最近快照</h3>
            <dl>
              <div>
                <dt>首次发现</dt>
                <dd>{formatDate(market.firstSeenAt)}</dd>
              </div>
              <div>
                <dt>最近发现</dt>
                <dd>{formatDate(market.lastSeenAt)}</dd>
              </div>
              <div>
                <dt>当前摘要</dt>
                <dd>{row.metric}</dd>
              </div>
            </dl>
          </section>
          <section className="market-detail-section">
            <h3>变化事件</h3>
            <p className="market-detail-note">价格、状态和卖家变化会归入动态中的变化事件。</p>
            <button className="text-button market-detail-link" onClick={onOpenEvents}>
              <Bell size={15} />
              查看关联事件
            </button>
          </section>
          {migrationError && <p className="form-error">{migrationError}</p>}
          {migrationResult && (
            <div className="supply-result">
              <strong>搬家请求已提交</strong>
              <span>{migrationResult}</span>
            </div>
          )}
        </div>
        <footer>
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
          <button className="primary small" onClick={() => void migrate()} disabled={migrating || Boolean(migrationResult)}>
            {migrating ? '正在提交…' : '搬家'}
          </button>
          {market.sourceUrl && (
            <a className="primary small" href={market.sourceUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={15} />
              打开商品页
            </a>
          )}
        </footer>
      </section>
    </div>
  )
}

function DetailDrawer({ row, onClose, onAddSeller }: { row: TableRow; onClose: () => void; onAddSeller: (target: SellerTarget) => void }): ReactNode {
  const [relatedOpen, setRelatedOpen] = useState(false)
  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭详情" onClick={onClose} />
      <section className="modal-shell detail-modal" role="dialog" aria-modal="true" aria-labelledby="detail-modal-title">
        <header>
          <div>
            <span className="eyebrow">详情</span>
            <h2 id="detail-modal-title">{row.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭">
            <X size={19} />
          </button>
        </header>
        <div className="modal-body">
          <span className="row-tag">{row.tag}</span>
          <p className="detail-summary">{row.subtitle}</p>
          <dl>
            <div>
              <dt>最新信息</dt>
              <dd>{row.metric}</dd>
            </div>
            <div>
              <dt>最近更新</dt>
              <dd>{row.updatedAt}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>
                <span className={`status ${statusClass[row.status]}`}>{row.status}</span>
              </dd>
            </div>
          </dl>
          {relatedOpen && (
            <section className="related-content">
              <h3>关联内容</h3>
              <p>{row.title}</p>
              <span>{row.subtitle}</span>
              <strong>{row.metric}</strong>
            </section>
          )}
        </div>
        <footer>
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
          {row.sellerTarget ? (
            <button className="primary small" onClick={() => onAddSeller(row.sellerTarget!)}>
              <Store size={15} />
              添加卖家监控
            </button>
          ) : (
            <button className="primary small" onClick={() => setRelatedOpen((value) => !value)}>
              <ExternalLink size={15} />
              {relatedOpen ? '收起关联内容' : '查看关联对象'}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}

const demoSupplyMaterials: SupplyMaterial[] = [
  {
    id: 'demo-supply-xianyu-1',
    sourceType: 'xianyu',
    sourcePlatform: 'goofish',
    sourceItemId: 'xy-1001',
    sourceUrl: 'https://www.goofish.com/item/xy-1001',
    title: '闲置机械键盘 87 键',
    description: '已整理的公开商品素材。',
    price: 168,
    mainImages: ['https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=360&q=80'],
    detailImages: [],
    sku: null,
    attributes: { condition: '二手' },
    currentVersion: 1,
    status: 'ready',
    importBatchId: 'demo-batch-1',
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z'
  },
  {
    id: 'demo-supply-general-1',
    sourceType: 'general',
    sourcePlatform: 'pdd',
    sourceItemId: 'pdd-1001',
    sourceUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=1001',
    title: '收纳盒桌面整理套装',
    description: '已解析的商品快照。',
    price: 19.9,
    mainImages: ['https://images.unsplash.com/photo-1583847268964-b28dc8f51f92?auto=format&fit=crop&w=360&q=80'],
    detailImages: [],
    sku: null,
    attributes: { category: '家居' },
    currentVersion: 1,
    status: 'draft',
    importBatchId: 'demo-batch-2',
    createdAt: '2026-08-18T08:00:00.000Z',
    updatedAt: '2026-08-18T08:00:00.000Z'
  }
]

function supplyDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function supplyStatusLabel(status: string): string {
  return status === 'ready' ? '可发布' : status === 'archived' ? '已归档' : '待编辑'
}

function newSupplyKey(): string {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function SupplyPage({ api, mode, sourceType }: { api: UserApiClient; mode: 'demo' | 'api'; sourceType: SupplySourceType }): ReactNode {
  const [materials, setMaterials] = useState<SupplyMaterial[]>(() => (mode === 'demo' ? demoSupplyMaterials.filter((item) => item.sourceType === sourceType) : []))
  const [total, setTotal] = useState(materials.length)
  const [cursor, setCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<Array<string | null>>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(mode === 'api')
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [importOpen, setImportOpen] = useState(false)
  const [migrationOpen, setMigrationOpen] = useState(false)
  const [publishedMigrationOpen, setPublishedMigrationOpen] = useState(false)
  const [selected, setSelected] = useState<SupplyMaterial | null>(null)
  const [editing, setEditing] = useState<SupplyMaterial | null>(null)
  const [selectedMaterialIds, setSelectedMaterialIds] = useState<string[]>([])
  const [batchPlanning, setBatchPlanning] = useState(false)
  const [batchPlanNotice, setBatchPlanNotice] = useState<string | null>(null)
  const publishIdempotencyKeys = useRef(new Map<string, string>())

  useEffect(() => {
    if (mode === 'demo') {
      const rows = demoSupplyMaterials.filter((item) => item.sourceType === sourceType && (!query || item.title.includes(query)) && (!status || item.status === status))
      setMaterials(rows.slice(0, pageSize))
      setTotal(rows.length)
      setNextCursor(null)
      setLoading(false)
      setError(null)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void api
      .listSupplyMaterials(
        {
          limit: pageSize,
          cursor,
          sort: 'updated_at',
          filters: {
            source_type: sourceType,
            ...(query.trim() ? { q: query.trim() } : {}),
            ...(status ? { status } : {})
          }
        },
        controller.signal
      )
      .then((page) => {
        setMaterials(page.items)
        setTotal(page.total)
        setNextCursor(page.nextCursor)
      })
      .catch((caught) => {
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) setError(caught instanceof UserApiError ? caught.message : '素材加载失败')
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [api, cursor, mode, pageSize, query, reloadKey, sourceType, status])

  const reset = (callback: () => void) => {
    callback()
    setCursor(null)
    setHistory([])
  }
  const archive = async (material: SupplyMaterial) => {
    if (!window.confirm(`归档“${material.title}”？`)) return
    try {
      if (mode === 'demo') setMaterials((items) => items.map((item) => (item.id === material.id ? { ...item, status: 'archived' } : item)))
      else await api.updateSupplyMaterial(material.id, { status: 'archived' })
      setReloadKey((value) => value + 1)
    } catch (caught) {
      setError(caught instanceof UserApiError ? caught.message : '归档失败')
    }
  }
  const createBatchPlans = async () => {
    const selectedMaterials = materials.filter((item) => selectedMaterialIds.includes(item.id) && item.status === 'ready')
    if (!selectedMaterials.length) {
      setBatchPlanNotice('请先选择可发布素材')
      return
    }
    setBatchPlanning(true)
    setBatchPlanNotice(null)
    let succeeded = 0
    let failed = 0
    for (const material of selectedMaterials) {
      try {
        const idempotencyKey = publishIdempotencyKeys.current.get(material.id) ?? newSupplyKey()
        publishIdempotencyKeys.current.set(material.id, idempotencyKey)
        if (mode !== 'demo')
          await api.createSupplyPublishPlan({
            schemaVersion: 1,
            materialId: material.id,
            idempotencyKey,
            schedule: { mode: 'immediate' }
          })
        publishIdempotencyKeys.current.delete(material.id)
        succeeded += 1
      } catch {
        failed += 1
      }
    }
    setSelectedMaterialIds([])
    setBatchPlanNotice(`已创建 ${succeeded} 个发布计划${failed ? `，失败 ${failed} 个` : ''}`)
    setBatchPlanning(false)
  }
  const pageIndex = history.length + 1
  const title = sourceType === 'xianyu' ? '咸鱼搬家' : '通用铺货'
  const description = sourceType === 'xianyu' ? '粘贴公开闲鱼商品链接，由本机采集器读取详情后生成待编辑素材。' : '导入已解析的平台商品快照，整理成适用于闲鱼发布的素材。'
  return (
    <>
      <div className="page-heading supply-heading">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className="supply-actions">
          {sourceType === 'xianyu' ? (
            <>
              <button className="secondary" onClick={() => setPublishedMigrationOpen(true)}>
                已发布商品搬家
              </button>
              <button className="primary" onClick={() => setMigrationOpen(true)}>
                <Plus size={16} />
                搬家商品
              </button>
            </>
          ) : (
            <button className="primary" onClick={() => setImportOpen(true)}>
              <Plus size={16} />
              导入素材
            </button>
          )}
        </div>
      </div>
      <section className="filter-bar supply-filter">
        <label className="search-field">
          <Search size={16} />
          <input value={query} onChange={(event) => reset(() => setQuery(event.target.value))} placeholder="搜索标题或来源 ID" />
        </label>
        <label>
          <span>状态</span>
          <select value={status} onChange={(event) => reset(() => setStatus(event.target.value))}>
            <option value="">全部状态</option>
            <option value="draft">待编辑</option>
            <option value="ready">可发布</option>
            <option value="archived">已归档</option>
          </select>
        </label>
        <button className="icon-button" title="刷新素材" onClick={() => setReloadKey((value) => value + 1)}>
          <RefreshCw size={17} />
        </button>
      </section>
      {error && <div className="monitor-alert">{error}</div>}
      <section className="table-panel supply-table-panel">
        <div className="table-summary">
          <span>素材列表</span>
          <div className="supply-summary-actions">
            <button className="primary small" disabled={batchPlanning || selectedMaterialIds.length === 0} onClick={() => void createBatchPlans()}>
              {batchPlanning ? '正在创建…' : `发布已选${selectedMaterialIds.length ? ` (${selectedMaterialIds.length})` : ''}`}
            </button>
            {batchPlanNotice && <span className="supply-hint">{batchPlanNotice}</span>}
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table supply-table">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" aria-label="全选当前页素材" checked={materials.length > 0 && materials.every((item) => selectedMaterialIds.includes(item.id))} onChange={(event) => setSelectedMaterialIds(event.target.checked ? materials.map((item) => item.id) : [])} />
                </th>
                <th>素材</th>
                <th>价格对比</th>
                <th>来源</th>
                <th>版本</th>
                <th>状态</th>
                <th>更新时间</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8}>
                    <div className="state-box">
                      <RefreshCw className="spin" size={18} />
                      正在加载素材
                    </div>
                  </td>
                </tr>
              ) : materials.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="state-box">
                      <PackageSearch size={20} />
                      <strong>暂无素材</strong>
                      <p>导入已解析的 JSON 或 JSONL 快照后会显示在这里。</p>
                    </div>
                  </td>
                </tr>
              ) : (
                materials.map((material) => {
                  const originalPrice = Number(material.attributes.originalPrice)
                  return (
                    <tr key={material.id}>
                      <td>
                        <input type="checkbox" aria-label={`选择素材 ${material.title}`} checked={selectedMaterialIds.includes(material.id)} onChange={(event) => setSelectedMaterialIds((current) => (event.target.checked ? [...current, material.id] : current.filter((id) => id !== material.id)))} />
                      </td>
                      <td>
                        <div className="supply-material-title">
                          {material.mainImages[0] && <img src={material.mainImages[0]} alt="" />}
                          <div>
                            <strong>{material.title}</strong>
                            <small>{material.sourceItemId}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="supply-price-comparison">
                          <small>商家原价 {Number.isFinite(originalPrice) ? `¥${originalPrice.toFixed(2)}` : '暂无'}</small>
                          <strong>我的售价 ¥{Number(material.price).toFixed(2)}</strong>
                        </div>
                      </td>
                      <td>{material.sourcePlatform}</td>
                      <td>v{material.currentVersion}</td>
                      <td>
                        <span className={`status ${material.status === 'ready' ? 'ok' : material.status === 'archived' ? 'muted' : 'pending'}`}>{supplyStatusLabel(material.status)}</span>
                      </td>
                      <td>{supplyDate(material.updatedAt)}</td>
                      <td>
                        <div className="supply-actions">
                          <button className="icon-button" title="预览" onClick={() => setSelected(material)}>
                            <ExternalLink size={16} />
                          </button>
                          <button className="icon-button" title="编辑" onClick={() => setEditing(material)}>
                            <Pencil size={16} />
                          </button>
                          {material.status !== 'archived' && (
                            <button className="icon-button" title="归档" onClick={() => void archive(material)}>
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        <CursorPagination
          total={total}
          pageIndex={pageIndex}
          pageSize={pageSize}
          canGoBack={history.length > 0}
          canGoForward={Boolean(nextCursor)}
          onPrev={() => {
            const previous = history[history.length - 1] ?? null
            setHistory((items) => items.slice(0, -1))
            setCursor(previous)
          }}
          onNext={() => {
            if (!nextCursor) return
            setHistory((items) => [...items, cursor])
            setCursor(nextCursor)
          }}
          onPageSize={(value) => {
            setPageSize(value)
            setCursor(null)
            setHistory([])
          }}
        />
      </section>
      {importOpen && <SupplyImportModal api={api} mode={mode} sourceType={sourceType} onClose={() => setImportOpen(false)} onImported={() => setReloadKey((value) => value + 1)} />}
      {migrationOpen && <SupplyMigrationModal api={api} mode={mode} sourceKind="public_url" onClose={() => setMigrationOpen(false)} />}
      {publishedMigrationOpen && <SupplyMigrationModal api={api} mode={mode} sourceKind="published_item" onClose={() => setPublishedMigrationOpen(false)} />}
      {selected && <SupplyPreviewModal material={selected} onClose={() => setSelected(null)} />}
      {editing && (
        <SupplyEditModal
          api={api}
          mode={mode}
          material={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            setReloadKey((value) => value + 1)
          }}
        />
      )}
    </>
  )
}

function publishImageUrls(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return values.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 5)
}

function xianyuPublishSnapshot(value: unknown, sourceType: SupplySourceType): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('导入记录必须是对象')
  const source = value as Record<string, unknown>
  const images = publishImageUrls(source.mainImages ?? source.images ?? source.imageUrls ?? source.image_urls)
  const sourcePlatform = typeof source.sourcePlatform === 'string' ? source.sourcePlatform : typeof source.platform === 'string' ? source.platform : 'external'
  const sourceItemId = typeof source.sourceItemId === 'string' ? source.sourceItemId : typeof source.itemId === 'string' ? source.itemId : typeof source.id === 'string' ? source.id : ''
  const sourceUrl = typeof source.sourceUrl === 'string' ? source.sourceUrl : typeof source.url === 'string' ? source.url : typeof source.productUrl === 'string' ? source.productUrl : ''
  const price = Number(source.price ?? source.salePrice ?? source.currentPrice)
  const attributes = source.attributes && typeof source.attributes === 'object' && !Array.isArray(source.attributes) ? (source.attributes as Record<string, unknown>) : {}
  const originalPrice = Number(source.originalPrice ?? source.listPrice ?? source.marketPrice)
  return {
    sourceType,
    sourcePlatform,
    sourceItemId,
    sourceUrl,
    title: typeof source.title === 'string' ? source.title : typeof source.name === 'string' ? source.name : '',
    description: typeof source.description === 'string' ? source.description : typeof source.content === 'string' ? source.content : '',
    price,
    mainImages: images,
    detailImages: [],
    sku: source.sku ?? source.skuConfig ?? null,
    attributes: {
      ...attributes,
      publishTarget: 'goofish',
      ...(Number.isFinite(originalPrice) ? { originalPrice } : {})
    }
  }
}

function SupplyImportModal({ api, mode, sourceType, onClose, onImported }: { api: UserApiClient; mode: 'demo' | 'api'; sourceType: SupplySourceType; onClose: () => void; onImported: () => void }): ReactNode {
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<SupplyImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!file) {
      setError('请选择 JSON 或 JSONL 文件')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const text = await file.text()
      const rawSnapshots = file.name.toLowerCase().endsWith('.jsonl')
        ? text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : (() => {
            const value = JSON.parse(text)
            return Array.isArray(value) ? value : [value]
          })()
      const snapshots = rawSnapshots.map((snapshot) => xianyuPublishSnapshot(snapshot, sourceType))
      if (!snapshots.length || snapshots.length > 100) throw new Error('每次导入仅支持 1 到 100 条已解析快照')
      const imported =
        mode === 'demo'
          ? {
              batchId: `demo-${newSupplyKey()}`,
              receivedCount: snapshots.length,
              insertedCount: snapshots.length,
              deduplicatedCount: 0,
              failedCount: 0,
              rejections: [],
              duplicate: false
            }
          : await api.importSupplySnapshots({
              schemaVersion: 1,
              sourceType,
              sourceFormat: file.name.toLowerCase().endsWith('.jsonl') ? 'parsed_snapshot_jsonl' : 'parsed_snapshot_json',
              idempotencyKey: newSupplyKey(),
              snapshots
            })
      setResult(imported)
      onImported()
    } catch (caught) {
      setError(caught instanceof UserApiError ? caught.message : caught instanceof Error ? caught.message : '素材导入失败')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      title="导入发布素材"
      onClose={onClose}
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
          <button className="primary" disabled={saving || Boolean(result)} onClick={() => void submit()}>
            {saving ? '正在导入…' : '开始导入'}
          </button>
        </>
      }
    >
      <label className="modal-field file-picker">
        <span>素材文件</span>
        <input type="file" accept=".json,.jsonl,.txt,application/json,application/x-ndjson,text/plain" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      </label>
      <p className="supply-hint">导入已提取的商品数据后，会统一转换为闲鱼发布素材；仅保留最多 5 张发布主图。</p>
      {error && <p className="form-error">{error}</p>}
      {result && (
        <div className="supply-result">
          <strong>导入完成</strong>
          <span>
            接收 {result.receivedCount}，新增 {result.insertedCount}，去重 {result.deduplicatedCount}，失败 {result.failedCount}
          </span>
          {result.rejections.length > 0 && (
            <small>
              失败记录：
              {result.rejections.map((item) => `${item.recordIndex + 1} (${item.reasonCode})`).join('，')}
            </small>
          )}
        </div>
      )}
    </Modal>
  )
}

function SupplyMigrationModal({ api, mode, sourceKind, onClose }: { api: UserApiClient; mode: 'demo' | 'api'; sourceKind: 'public_url' | 'published_item'; onClose: () => void }): ReactNode {
  const [sourceValue, setSourceValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{
    status: string
    platformItemId: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!sourceValue.trim()) {
      setError(sourceKind === 'public_url' ? '请输入公开闲鱼商品链接' : '请输入已发布商品记录 ID')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const migration =
        mode === 'demo'
          ? { status: 'queued', platformItemId: 'demo-migration-item' }
          : await api.createSupplyMigration({
              schemaVersion: 1,
              idempotencyKey: newSupplyKey(),
              source: sourceKind === 'public_url' ? { kind: 'public_url', itemUrl: sourceValue.trim() } : { kind: 'published_item', sourceId: sourceValue.trim() }
            })
      setResult({
        status: migration.status,
        platformItemId: migration.platformItemId
      })
    } catch (caught) {
      setError(caught instanceof UserApiError ? caught.message : '创建搬家请求失败')
    } finally {
      setSaving(false)
    }
  }
  const published = sourceKind === 'published_item'
  return (
    <Modal
      title={published ? '搬家已发布商品' : '搬家闲鱼商品'}
      onClose={onClose}
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
          <button className="primary" disabled={saving || Boolean(result)} onClick={() => void submit()}>
            {saving ? '正在提交…' : '开始搬家'}
          </button>
        </>
      }
    >
      {published ? (
        <>
          <label className="modal-field">
            <span>已发布商品记录 ID</span>
            <input value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} placeholder="粘贴已发布商品监控记录 ID" />
          </label>
          <p className="supply-hint">仅支持当前账户的已发布商品监控记录；本机采集器会读取该闲鱼商品的公开详情后生成素材。</p>
        </>
      ) : (
        <>
          <label className="modal-field">
            <span>公开商品链接</span>
            <input value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} placeholder="粘贴闲鱼公开商品链接" />
          </label>
          <p className="supply-hint">已绑定的本机采集器会使用本机 Chrome 读取公开详情，完成后自动生成素材。</p>
        </>
      )}
      {error && <p className="form-error">{error}</p>}
      {result && (
        <div className="supply-result">
          <strong>搬家请求已提交</strong>
          <span>
            商品 {result.platformItemId} · {result.status === 'queued' ? '等待本机采集器处理' : result.status}
          </span>
        </div>
      )}
    </Modal>
  )
}

function SupplyPreviewModal({ material, onClose }: { material: SupplyMaterial; onClose: () => void }): ReactNode {
  return (
    <Modal
      title="素材预览"
      onClose={onClose}
      footer={
        <button className="primary" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="supply-preview">
        {material.mainImages[0] && <img src={material.mainImages[0]} alt={material.title} />}
        <div>
          <strong>{material.title}</strong>
          <b>¥{Number(material.price).toFixed(2)}</b>
          <p>{material.description || '暂无商品描述'}</p>
          <small>
            {material.sourcePlatform} · {material.sourceItemId} · v{material.currentVersion}
          </small>
        </div>
      </div>
    </Modal>
  )
}

type SupplySkuGroup = { name: string; values: string[] }
type SupplySkuCombination = {
  key: string
  values: string[]
  price: string
  stock: string
  manualPrice?: boolean
}
const supplySkuTypeOptions = ['颜色', '尺码', '容量', '份数', '大小', '高度', '总量']

function skuCombinationKey(groups: SupplySkuGroup[], values: string[]): string {
  return groups.map((group, index) => `${group.name.trim()}=${values[index] ?? ''}`).join('|')
}

function buildSkuCombinations(groups: SupplySkuGroup[], current: SupplySkuCombination[], defaultPrice: string): SupplySkuCombination[] {
  const usableGroups = groups.filter((group) => group.name.trim() && group.values.some((value) => value.trim()))
  if (!usableGroups.length) return []
  const existing = new Map(current.map((item) => [item.key, item]))
  const combinations = usableGroups.reduce<string[][]>((items, group) => items.flatMap((item) => group.values.filter((value) => value.trim()).map((value) => [...item, value.trim()])), [[]])
  return combinations.map((values) => {
    const key = skuCombinationKey(usableGroups, values)
    return existing.get(key) ?? { key, values, price: '', stock: '' }
  })
}

function supplySkuConfig(value: unknown, defaultPrice: string): { groups: SupplySkuGroup[]; combinations: SupplySkuCombination[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { groups: [], combinations: [] }
  const source = value as Record<string, unknown>
  const groups = Array.isArray(source.groups)
    ? source.groups.slice(0, 2).flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const group = item as Record<string, unknown>
        const name = typeof group.name === 'string' ? group.name : ''
        const values = Array.isArray(group.values) ? group.values.filter((entry): entry is string => typeof entry === 'string') : []
        return name || values.length ? [{ name, values }] : []
      })
    : Object.entries(source)
        .flatMap(([name, entry]) => (typeof entry === 'string' ? [{ name, values: [entry] }] : []))
        .slice(0, 2)
  const imported = Array.isArray(source.combinations)
    ? source.combinations.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const row = item as Record<string, unknown>
        const values = Array.isArray(row.values) ? row.values.filter((entry): entry is string => typeof entry === 'string') : []
        return values.length
          ? [
              {
                key: skuCombinationKey(groups, values),
                values,
                price: row.price === undefined || row.price === null ? '' : String(row.price),
                stock: String(row.stock ?? ''),
                manualPrice: row.price !== undefined && row.price !== null
              }
            ]
          : []
      })
    : []
  return {
    groups,
    combinations: buildSkuCombinations(groups, imported, defaultPrice)
  }
}

function SupplyEditModal({ api, mode, material, onClose, onSaved }: { api: UserApiClient; mode: 'demo' | 'api'; material: SupplyMaterial; onClose: () => void; onSaved: () => void }): ReactNode {
  const [title, setTitle] = useState(material.title)
  const [description, setDescription] = useState(material.description ?? '')
  const [price, setPrice] = useState(String(material.price))
  const [status, setStatus] = useState(material.status)
  const [mainImages, setMainImages] = useState(material.mainImages.join('\n'))
  const [detailImages, setDetailImages] = useState(material.detailImages.join('\n'))
  const [category, setCategory] = useState(String(material.attributes.category ?? ''))
  const [condition, setCondition] = useState(String(material.attributes.condition ?? material.attributes.conditionText ?? ''))
  const [brand, setBrand] = useState(String(material.attributes.brand ?? ''))
  const [delivery, setDelivery] = useState(String(material.attributes.delivery ?? ''))
  const [shipping, setShipping] = useState(String(material.attributes.shipping ?? ''))
  const [postage, setPostage] = useState(String(material.attributes.postage ?? ''))
  const [region, setRegion] = useState(String(material.attributes.region ?? ''))
  const [originalPrice] = useState(String(material.attributes.originalPrice ?? ''))
  const [skuGroups, setSkuGroups] = useState<SupplySkuGroup[]>(() => supplySkuConfig(material.sku, String(material.price)).groups)
  const [skuCombinations, setSkuCombinations] = useState<SupplySkuCombination[]>(() => supplySkuConfig(material.sku, String(material.price)).combinations)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aiNotice, setAiNotice] = useState<string | null>(null)
  const [aiSubmitting, setAiSubmitting] = useState(false)
  const [aiDialogOpen, setAiDialogOpen] = useState(false)
  const publishIdempotencyKey = useRef<string | null>(null)
  const parseImageUrls = (value: string, field: string, minimum: number, maximum: number): string[] => {
    const urls = value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (urls.length < minimum || urls.length > maximum) throw new Error(`${field}数量需在 ${minimum}-${maximum} 张之间`)
    const normalized = urls.map((item) => {
      let url: URL
      try {
        url = new URL(item)
      } catch {
        throw new Error(`${field}包含无效 URL`)
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${field}仅支持公开 HTTP(S) URL`)
      url.hash = ''
      return url.toString()
    })
    if (new Set(normalized).size !== normalized.length) throw new Error(`${field}不能重复`)
    return normalized
  }
  const updateSkuGroups = (updater: (current: SupplySkuGroup[]) => SupplySkuGroup[]) => {
    setSkuGroups((current) => {
      const next = updater(current)
      setSkuCombinations((existing) => buildSkuCombinations(next, existing, price))
      return next
    })
  }
  const submit = async (publishAfterSave = false) => {
    const numericPrice = Number(price)
    if (!title.trim()) {
      setError('请输入标题')
      return
    }
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      setError('请输入有效价格')
      return
    }
    try {
      const groups = skuGroups
        .map((group) => ({
          name: group.name.trim(),
          values: group.values.map((value) => value.trim()).filter(Boolean)
        }))
        .filter((group) => group.name && group.values.length)
      const sku = groups.length
        ? {
            groups,
            combinations: skuCombinations.map((item) => ({
              values: item.values,
              price: item.manualPrice && Number.isFinite(Number(item.price)) && item.price.trim() ? Number(item.price) : null,
              stock: Number.isFinite(Number(item.stock)) && item.stock.trim() ? Number(item.stock) : 0
            }))
          }
        : null
      const { publishAddressMode: _addressMode, publishAddressPool: _addressPool, ...existingAttributes } = material.attributes
      const attributes = {
        ...existingAttributes,
        category: category.trim(),
        categoryPath: category.trim(),
        condition: condition.trim(),
        conditionText: condition.trim(),
        brand: brand.trim(),
        delivery: delivery.trim(),
        shipping: shipping.trim(),
        postage: postage.trim(),
        region: region.trim(),
        publishAddressStrategy: 'local_random_pool'
      }
      const patch: SupplyMaterialPatch = {
        title: title.trim(),
        description: description.trim() || null,
        price: numericPrice,
        status: status as SupplyMaterial['status'],
        mainImages: parseImageUrls(mainImages, '发布主图', 1, 5),
        detailImages: parseImageUrls(detailImages, '详情图', 0, 120),
        sku,
        attributes
      }
      setSaving(true)
      setError(null)
      if (mode !== 'demo') {
        await api.updateSupplyMaterial(material.id, patch)
        if (publishAfterSave)
          await api.createSupplyPublishPlan({
            schemaVersion: 1,
            materialId: material.id,
            idempotencyKey: publishIdempotencyKey.current ?? (publishIdempotencyKey.current = newSupplyKey()),
            schedule: { mode: 'immediate' }
          })
        if (publishAfterSave) publishIdempotencyKey.current = null
      }
      onSaved()
    } catch (caught) {
      setError(caught instanceof UserApiError ? caught.message : caught instanceof Error ? caught.message : '素材保存失败')
    } finally {
      setSaving(false)
    }
  }
  const requestAiRewrite = async () => {
    setAiSubmitting(true)
    setError(null)
    setAiNotice(null)
    try {
      if (mode === 'demo') {
        setAiNotice('AI 二创请求已提交，完成后可在 AI 分析中查看标题和内容建议。')
        return
      }
      await api.createAiJob({
        capabilityCode: 'supply_rewrite',
        scope: 'personal',
        idempotencyKey: `supply-rewrite:${material.id}:${newSupplyKey()}`,
        input: {
          materialId: material.id,
          title: title.trim(),
          description: description.trim(),
          price: Number(price),
          attributes: material.attributes
        }
      })
      setAiNotice('AI 二创请求已提交，完成后可在 AI 分析中查看标题和内容建议。')
    } catch (caught) {
      setError(caught instanceof UserApiError ? caught.message : 'AI 二创请求失败')
    } finally {
      setAiSubmitting(false)
    }
  }
  return (
    <>
      <Modal
        title="编辑素材"
        onClose={onClose}
        footer={
          <>
            <button className="secondary" onClick={onClose}>
              取消
            </button>
            <button className="secondary" disabled={saving || status !== 'ready'} onClick={() => void submit(true)}>
              发布
            </button>
            <button className="primary" disabled={saving} onClick={() => void submit()}>
              {saving ? '正在保存…' : '保存'}
            </button>
          </>
        }
      >
        <div className="supply-edit-grid">
          <label className="modal-field supply-edit-wide">
            <span>标题</span>
            <div className="supply-field-heading">
              <button
                className="text-button"
                onClick={() => {
                  setAiNotice(null)
                  setAiDialogOpen(true)
                }}
              >
                AI 二创标题与内容
              </button>
            </div>
            <input value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="modal-field">
            <span>我的售价</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(event) => {
                const nextPrice = event.target.value
                setSkuCombinations((rows) => rows.map((row) => row.manualPrice ? row : { ...row, price: nextPrice }))
                setPrice(nextPrice)
              }}
            />
          </label>
          <label className="modal-field">
            <span>商家原价（仅展示）</span>
            <input value={originalPrice} disabled placeholder="暂无原价" />
          </label>
          <label className="modal-field">
            <span>类目</span>
            <input value={category} maxLength={80} onChange={(event) => setCategory(event.target.value)} />
          </label>
          <label className="modal-field">
            <span>品牌</span>
            <input value={brand} maxLength={80} onChange={(event) => setBrand(event.target.value)} />
          </label>
          <label className="modal-field">
            <span>成色</span>
            <input value={condition} maxLength={40} onChange={(event) => setCondition(event.target.value)} />
          </label>
          <label className="modal-field">
            <span>发货方式</span>
            <input value={delivery} maxLength={40} onChange={(event) => setDelivery(event.target.value)} />
          </label>
          <label className="modal-field">
            <span>配送方式</span>
            <input value={shipping} maxLength={40} onChange={(event) => setShipping(event.target.value)} />
          </label>
          <label className="modal-field">
            <span>运费</span>
            <input value={postage} maxLength={40} onChange={(event) => setPostage(event.target.value)} />
          </label>
          <label className="modal-field">
            <span>所在地</span>
            <input value={region} maxLength={64} onChange={(event) => setRegion(event.target.value)} />
          </label>
          <label className="modal-field">
            <span>状态</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as SupplyMaterial['status'])}>
              <option value="draft">待编辑</option>
              <option value="ready">可发布</option>
              <option value="archived">已归档</option>
            </select>
          </label>
          <label className="modal-field supply-edit-wide">
            <span>描述</span>
            <textarea value={description} maxLength={10000} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <section className="supply-sku-section supply-edit-wide">
            <div className="supply-section-heading">
              <h3>规格</h3>
              <button className="text-button" disabled={skuGroups.length >= 2} onClick={() => updateSkuGroups((groups) => [...groups, { name: '颜色', values: [''] }])}>
                添加规格
              </button>
            </div>
            {skuGroups.length === 0 && <p className="supply-hint">暂无规格，可按需添加。</p>}
            {skuGroups.map((group, groupIndex) => {
              const isPreset = supplySkuTypeOptions.includes(group.name)
              return (
                <div className="supply-sku-group" key={`${group.name}-${groupIndex}`}>
                  <div className="supply-sku-group-head">
                    <select
                      aria-label={`规格类型 ${groupIndex + 1}`}
                      value={isPreset ? group.name : 'custom'}
                      onChange={(event) =>
                        updateSkuGroups((groups) =>
                          groups.map((item, index) =>
                            index === groupIndex
                              ? {
                                  ...item,
                                  name: event.target.value === 'custom' ? '' : event.target.value
                                }
                              : item
                          )
                        )
                      }
                    >
                      {supplySkuTypeOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                      <option value="custom">自定义</option>
                    </select>
                    {!isPreset && <input value={group.name} placeholder="自定义规格名" onChange={(event) => updateSkuGroups((groups) => groups.map((item, index) => (index === groupIndex ? { ...item, name: event.target.value } : item)))} />}
                    <button className="row-action" title="删除规格" onClick={() => updateSkuGroups((groups) => groups.filter((_, index) => index !== groupIndex))}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                  {group.values.map((value, valueIndex) => (
                    <div className="supply-sku-value" key={`${value}-${valueIndex}`}>
                      <input value={value} placeholder="规格值" onChange={(event) => updateSkuGroups((groups) => groups.map((item, index) => (index === groupIndex ? { ...item, values: item.values.map((entry, valuePosition) => (valuePosition === valueIndex ? event.target.value : entry)) } : item)))} />
                      <button className="row-action" title="删除规格值" disabled={group.values.length === 1} onClick={() => updateSkuGroups((groups) => groups.map((item, index) => (index === groupIndex ? { ...item, values: item.values.filter((_, valuePosition) => valuePosition !== valueIndex) } : item)))}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                  <button className="text-button" onClick={() => updateSkuGroups((groups) => groups.map((item, index) => (index === groupIndex ? { ...item, values: [...item.values, ''] } : item)))}>
                    添加规格值
                  </button>
                </div>
              )
            })}
            {skuCombinations.length > 0 && (
              <div className="supply-sku-combinations">
                <h4>规格组合</h4>
                <table>
                  <thead>
                    <tr>
                      <th>规格</th>
                      <th>售价</th>
                      <th>库存</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skuCombinations.map((item, index) => (
                      <tr key={item.key}>
                        <td>{item.values.join(' / ')}</td>
                        <td>
                          <input type="number" min="0" step="0.01" value={item.price || price} onChange={(event) => setSkuCombinations((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, price: event.target.value, manualPrice: true } : row)))} />
                        </td>
                        <td>
                          <input type="number" min="0" step="1" value={item.stock} onChange={(event) => setSkuCombinations((rows) => rows.map((row, rowIndex) => (rowIndex === index ? { ...row, stock: event.target.value } : row)))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <label className="modal-field supply-edit-wide">
            <span>主图 URL（每行一条）</span>
            <textarea value={mainImages} onChange={(event) => setMainImages(event.target.value)} placeholder="https://example.com/image.jpg" />
          </label>
          <label className="modal-field supply-edit-wide">
            <span>详情图 URL（每行一条）</span>
            <textarea value={detailImages} onChange={(event) => setDetailImages(event.target.value)} placeholder="可留空" />
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
      </Modal>
      {aiDialogOpen && (
        <Modal
          title="AI 二创"
          onClose={() => setAiDialogOpen(false)}
          footer={
            aiNotice ? (
              <button className="primary" onClick={() => setAiDialogOpen(false)}>
                关闭
              </button>
            ) : (
              <>
                <button className="secondary" disabled={aiSubmitting} onClick={() => setAiDialogOpen(false)}>
                  取消
                </button>
                <button className="primary" disabled={aiSubmitting} onClick={() => void requestAiRewrite()}>
                  {aiSubmitting ? '正在提交…' : '确认提交'}
                </button>
              </>
            )
          }
        >
          <p className="detail-summary">{aiNotice || '将基于当前标题和描述创建二创请求。'}</p>
          {error && <p className="form-error">{error}</p>}
        </Modal>
      )}
    </>
  )
}

function SupplyPlanModal({ api, mode, material, onClose }: { api: UserApiClient; mode: 'demo' | 'api'; material: SupplyMaterial; onClose: () => void }): ReactNode {
  const [scheduleMode, setScheduleMode] = useState<SupplyPublishSchedule['mode']>('immediate')
  const [scheduledAt, setScheduledAt] = useState('')
  const [windowStart, setWindowStart] = useState('')
  const [windowEnd, setWindowEnd] = useState('')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<SupplyPublishPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const randomAddressCount = Array.isArray(material.attributes.publishAddressPool) ? material.attributes.publishAddressPool.filter((item): item is string => typeof item === 'string').length : 0
  const addressLabel = material.attributes.publishAddressMode === 'random' && randomAddressCount > 0 ? `随机地址（${randomAddressCount} 个）` : '使用本机默认地址'
  const submit = async () => {
    let schedule: SupplyPublishSchedule = { mode: 'immediate' }
    try {
      if (scheduleMode === 'scheduled') {
        if (!scheduledAt) throw new Error('请选择发布时间')
        schedule = {
          mode: 'scheduled',
          scheduledAt: new Date(scheduledAt).toISOString()
        }
      }
      if (scheduleMode === 'random_window') {
        if (!windowStart || !windowEnd) throw new Error('请选择随机发布时间范围')
        schedule = {
          mode: 'random_window',
          windowStart: new Date(windowStart).toISOString(),
          windowEnd: new Date(windowEnd).toISOString()
        }
      }
      setSaving(true)
      setError(null)
      const plan =
        mode === 'demo'
          ? {
              id: `demo-plan-${newSupplyKey()}`,
              materialId: material.id,
              materialVersionId: 'demo-version',
              materialVersion: material.currentVersion,
              materialSnapshot: {},
              scheduleMode: schedule.mode,
              scheduledAt: schedule.mode === 'scheduled' ? schedule.scheduledAt : schedule.mode === 'random_window' ? schedule.windowStart : new Date().toISOString(),
              status: 'planned',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          : await api.createSupplyPublishPlan({
              schemaVersion: 1,
              materialId: material.id,
              idempotencyKey: newSupplyKey(),
              schedule
            })
      setResult(plan)
    } catch (caught) {
      setError(caught instanceof UserApiError ? caught.message : caught instanceof Error ? caught.message : '创建计划失败')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      title="创建咸鱼发布计划"
      onClose={onClose}
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            关闭
          </button>
          <button className="primary" disabled={saving || Boolean(result)} onClick={() => void submit()}>
            {saving ? '正在创建…' : '创建计划'}
          </button>
        </>
      }
    >
      <div className="supply-plan-material">
        <strong>{material.title}</strong>
        <span>
          ¥{Number(material.price).toFixed(2)} · v{material.currentVersion}
        </span>
      </div>
      <label className="modal-field">
        <span>发布时间</span>
        <select value={scheduleMode} onChange={(event) => setScheduleMode(event.target.value as SupplyPublishSchedule['mode'])}>
          <option value="immediate">立即</option>
          <option value="scheduled">定时</option>
          <option value="random_window">随机时间窗口</option>
        </select>
      </label>
      <label className="modal-field">
        <span>发布地址</span>
        <input value={addressLabel} disabled />
      </label>
      {scheduleMode === 'scheduled' && (
        <label className="modal-field">
          <span>计划时间</span>
          <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />
        </label>
      )}
      {scheduleMode === 'random_window' && (
        <div className="supply-time-grid">
          <label className="modal-field">
            <span>开始时间</span>
            <input type="datetime-local" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} />
          </label>
          <label className="modal-field">
            <span>结束时间</span>
            <input type="datetime-local" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} />
          </label>
        </div>
      )}
      <p className="supply-hint">地址策略取自素材当前版本；创建计划不会立即打开浏览器或发布商品。</p>
      {error && <p className="form-error">{error}</p>}
      {result && (
        <div className="supply-result">
          <strong>计划已创建</strong>
          <span>
            {result.status} · {supplyDate(result.scheduledAt)}
          </span>
        </div>
      )}
    </Modal>
  )
}

function Modal({ title, children, footer, onClose }: { title: string; children: ReactNode; footer: ReactNode; onClose: () => void }): ReactNode {
  return (
    <div className="modal-layer">
      <button className="modal-backdrop" aria-label="关闭" onClick={onClose} />
      <section className="modal-shell supply-modal" role="dialog" aria-modal="true">
        <header>
          <h2>{title}</h2>
          <button className="icon-button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <footer>{footer}</footer>
      </section>
    </div>
  )
}

function SettingsPage(): ReactNode {
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">账户</p>
          <h1>账户设置</h1>
          <p>管理个人工作台的显示与提醒偏好。</p>
        </div>
      </div>
      <div className="settings-grid">
        <section className="panel setting">
          <div className="panel-head">
            <div>
              <h2>提醒偏好</h2>
              <p>提醒仅用于当前账户。</p>
            </div>
          </div>
          <Toggle title="价格变化提醒" subtitle="价格达到关注阈值时生成事件" enabled />
          <Toggle title="竞品商家动态" subtitle="商家公开商品发生变化时生成事件" enabled />
          <Toggle title="日报摘要" subtitle="每天汇总工作台的市场变化" />
        </section>
        <section className="panel setting">
          <div className="panel-head">
            <div>
              <h2>界面偏好</h2>
              <p>修改后立即生效。</p>
            </div>
          </div>
          <label className="setting-select">
            <span>默认市场范围</span>
            <select>
              <option>全国</option>
              <option>常用地区</option>
            </select>
          </label>
          <label className="setting-select">
            <span>列表默认排序</span>
            <select>
              <option>最近更新</option>
              <option>优先级</option>
            </select>
          </label>
        </section>
      </div>
    </>
  )
}

function Toggle({ title, subtitle, enabled = false }: { title: string; subtitle: string; enabled?: boolean }): ReactNode {
  const [checked, setChecked] = useState(enabled)
  return (
    <div className="toggle-row">
      <div>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      <button className={`toggle ${checked ? 'on' : ''}`} onClick={() => setChecked(!checked)} aria-label={title}>
        <i />
      </button>
    </div>
  )
}

export default App
