import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Activity, Bell, Bot, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ClipboardList,
  ExternalLink, FileSearch, Filter, Gauge, LayoutDashboard, LogOut, Menu, MoreHorizontal,
  PackageSearch, Plus, RefreshCw, Search, Settings, ShieldCheck, SlidersHorizontal, Store, X
} from 'lucide-react'
import {
  UserApiClient, UserApiError, readUserRuntimeConfig, type UserIdentity, type UserListRequest,
  type UserListResource, type UserPage
} from './api'

type PageKey = 'dashboard' | 'monitors' | 'sellers' | 'pool' | 'discoveries' | 'events' | 'logs' | 'ai' | 'settings'
type RowKind = Exclude<PageKey, 'dashboard' | 'settings'>
type Status = '正常' | '关注' | '已暂停' | '已处理' | '待处理'
type SortKey = 'updated_at_desc' | 'priority_desc' | 'title_asc'

type TableRow = {
  id: string
  title: string
  subtitle: string
  metric: string
  updatedAt: string
  status: Status
  tag: string
}

const runtime = readUserRuntimeConfig()

const pages: Array<{ key: PageKey; label: string; icon: typeof Gauge; group?: string }> = [
  { key: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
  { key: 'monitors', label: '我的监控', icon: Gauge, group: '监控' },
  { key: 'sellers', label: '竞品商家', icon: Store, group: '监控' },
  { key: 'pool', label: '市场商品池', icon: PackageSearch, group: '市场' },
  { key: 'discoveries', label: '市场发现', icon: FileSearch, group: '市场' },
  { key: 'events', label: '事件中心', icon: Bell, group: '分析' },
  { key: 'logs', label: '动态日志', icon: ClipboardList, group: '分析' },
  { key: 'ai', label: 'AI 分析', icon: Bot, group: '分析' },
  { key: 'settings', label: '账户设置', icon: Settings, group: '账户' }
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
    { title: 'MacBook Air 13 M2 16G 512G', subtitle: '杭州 · 个人闲置 · 2 小时前', metric: '¥4,280 · 26 人想要', status: '关注', tag: '笔记本' },
    { title: 'Sony A7M4 全画幅微单机身', subtitle: '上海 · 验货宝 · 38 分钟前', metric: '¥12,480 · 8 人想要', status: '正常', tag: '相机' },
    { title: 'Switch OLED 白色国行', subtitle: '广州 · 包邮 · 1 小时前', metric: '¥1,365 · 17 人想要', status: '正常', tag: '游戏机' }
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
  return {
    id,
    title: recordValue(record, ['title', 'name', 'subject'], id),
    subtitle: recordValue(record, ['subtitle', 'description', 'scope', 'region'], 'User API 返回的公开字段'),
    metric: recordValue(record, ['metric', 'summary', 'value', 'detail'], '暂无摘要'),
    updatedAt: recordValue(record, ['updatedAt', 'updated_at', 'occurredAt', 'occurred_at'], '最近更新未知'),
    status: normalizeStatus(recordValue(record, ['status', 'state'], '正常')),
    tag: recordValue(record, ['tag', 'type', 'eventType', 'event_type'], kind)
  }
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
    try { onAuthenticated(await api.login(email.trim(), password)) } catch (caught) { setError(caught instanceof UserApiError ? caught.message : 'User API 登录失败，请稍后重试') } finally { setSubmitting(false) }
  }
  return <main className="auth-shell"><section className="auth-panel"><div className="auth-brand"><span className="brand-mark">鱼</span><strong>闲鱼数据台</strong></div><p className="eyebrow">USER API</p><h1>登录用户工作台</h1><p className="auth-copy">仅通过独立 User API 验证用户账号，不使用 Admin 入口。</p>{!api.configured && <div className="auth-alert"><strong>未配置 User API</strong><span>请设置 VITE_USER_API_BASE_URL 后以 API 模式启动。</span></div>}<form onSubmit={(event) => void submit(event)}><label><span>邮箱</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></label><label><span>密码</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" minLength={12} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary auth-submit" type="submit" disabled={submitting || !api.configured}>{submitting ? '正在登录…' : '使用 User API 登录'}</button></form><p className="auth-foot">本地预览请使用 `VITE_USER_WEB_MODE=demo`，不会请求云端。</p></section></main>
}

function Workbench({ api, user, onLogout }: { api: UserApiClient; user: UserIdentity; onLogout: () => void }): ReactNode {
  const [active, setActive] = useState<PageKey>('dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [drawer, setDrawer] = useState<TableRow | null>(null)
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
  const listKind = active === 'dashboard' || active === 'settings' ? null : active
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
  const changeFilter = (callback: () => void) => { callback(); setCursor(null); setCursorHistory([]) }
  const nextPage = () => { if (!page.nextCursor) return; setCursorHistory((history) => [...history, cursor]); setCursor(page.nextCursor) }
  const previousPage = () => { if (!cursorHistory.length) return; setCursor(cursorHistory[cursorHistory.length - 1] ?? null); setCursorHistory(cursorHistory.slice(0, -1)) }
  const accountName = runtime.mode === 'demo' ? '本地预览' : `用户 ${user.id.slice(0, 8)}`

  return <div className={`app ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><span className="brand-mark">鱼</span>{!collapsed && <span>闲鱼数据台</span>}</div>
      <nav>{pages.map((pageItem, index) => <div key={pageItem.key}>{pageItem.group && pageItem.group !== pages[index - 1]?.group && !collapsed && <p className="nav-group">{pageItem.group}</p>}<button className={`nav-item ${active === pageItem.key ? 'active' : ''}`} onClick={() => switchPage(pageItem.key)} title={collapsed ? pageItem.label : undefined}><pageItem.icon size={18} /><span>{pageItem.label}</span></button></div>)}</nav>
      <div className="sidebar-foot"><button className="nav-item" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开导航' : '收起导航'}><Menu size={18} /><span>{collapsed ? '展开' : '收起导航'}</span></button><div className="account"><div className="avatar">{runtime.mode === 'demo' ? '演' : '用'}</div>{!collapsed && <div><strong>{accountName}</strong><span>{runtime.mode === 'demo' ? '仅本地数据' : 'User API 会话'}</span></div>}{runtime.mode === 'api' && <button className="account-logout" title="退出 User API" onClick={onLogout}><LogOut size={15} /></button>}</div></div>
    </aside>
    {menuOpen && <button className="backdrop" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
    <section className="main-shell"><header className="topbar"><button className="mobile-menu" title="打开导航" onClick={() => setMenuOpen(true)}><Menu size={19} /></button><div className="crumb"><span>用户工作台</span><ChevronRight size={14} /><strong>{activePage.label}</strong></div><div className="topbar-right"><span className={`mode-badge ${runtime.mode}`}>{runtime.mode === 'demo' ? '本地演示数据 · 未同步' : 'User API 会话'}</span><button className="icon-button" title="帮助"><CircleHelp size={18} /></button><button className="icon-button notification" title="事件中心" onClick={() => switchPage('events')}><Bell size={18} /><i>3</i></button></div></header>
      <main className="content">{active === 'dashboard' && <Dashboard mode={runtime.mode} onNavigate={switchPage} />}{active === 'settings' && <SettingsPage />}{listKind && <ListPage copy={pageCopy[listKind]} rows={page.items} total={page.total} pageIndex={cursorHistory.length + 1} pageSize={pageSize} query={query} status={status} sort={sort} loading={loading} error={error} demoMode={runtime.mode === 'demo'} canGoBack={cursorHistory.length > 0} canGoForward={page.hasMore && Boolean(page.nextCursor)} onQuery={(value) => changeFilter(() => setQuery(value))} onStatus={(value) => changeFilter(() => setStatus(value))} onSort={(value) => changeFilter(() => setSort(value as SortKey))} onPageSize={(value) => { setPageSize(value); setCursor(null); setCursorHistory([]) }} onPrev={previousPage} onNext={nextPage} onReload={() => setReloadKey((value) => value + 1)} onRetry={() => setReloadKey((value) => value + 1)} onOpen={setDrawer} onSimulateFailure={() => setError('本地演示请求被中断，可重试恢复当前游标。')} />}</main></section>
    {drawer && <DetailDrawer row={drawer} demoMode={runtime.mode === 'demo'} onClose={() => setDrawer(null)} />}
  </div>
}

function Dashboard({ mode, onNavigate }: { mode: 'demo' | 'api'; onNavigate: (key: PageKey) => void }): ReactNode {
  if (mode === 'api') return <ApiState title="User API 工作台汇总尚未提供" description="当前只显示已登录的 User API 边界；服务端提供汇总接口后，这里会读取真实数据。" />
  const stats = [['生效监控', '18', '较昨日 +2', Gauge, 'blue'], ['关注商家', '36', '公开商品变化 14', Store, 'mint'], ['待处理事件', '7', '3 条价格变化', Bell, 'amber'], ['市场机会', '12', '过去 24 小时', FileSearch, 'rose']] as const
  return <><div className="page-heading"><div><p className="eyebrow">OVERVIEW</p><h1>本地预览，林海</h1><p>以下内容来自内置演示数据，不代表已连接云端。</p></div><button className="primary" onClick={() => onNavigate('monitors')}><Plus size={16} />新建监控</button></div><section className="stats-grid">{stats.map(([label, value, note, Icon, tone]) => <article className="stat-card" key={label}><div className={`stat-icon ${tone}`}><Icon size={20} /></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>)}</section><section className="dashboard-grid"><section className="panel wide"><div className="panel-head"><div><h2>重点动态</h2><p>最近 24 小时 · 演示</p></div><button className="text-button" onClick={() => onNavigate('events')}>查看全部 <ChevronRight size={15} /></button></div><div className="feed-list">{['MacBook Air M2 16G 512G 价格下降 6.5%', '海风数码回收店新增 6 个公开商品', '轻薄本价格带的低价供给增加 18%'].map((item, index) => <button className="feed" key={item} onClick={() => onNavigate('events')}><span className={`feed-dot d${index}`} /><div><strong>{item}</strong><small>{index + 1} 小时前 · 本地演示</small></div><ChevronRight size={16} /></button>)}</div></section><section className="panel"><div className="panel-head"><div><h2>市场信号</h2><p>演示数据</p></div><button className="text-button" onClick={() => onNavigate('discoveries')}>全部</button></div><div className="signal"><div><span>价格下降商品</span><strong>42</strong></div><div><span>新增样本</span><strong>186</strong></div><div><span>商家上新</span><strong>29</strong></div></div></section><section className="panel"><div className="panel-head"><div><h2>最新 AI 解读</h2><p>演示结果</p></div><button className="text-button" onClick={() => onNavigate('ai')}>打开</button></div><div className="ai-preview"><Bot size={22} /><div><strong>轻薄本价格带周报</strong><p>低价供给增加，成交热度保持平稳。</p><span>本地演示</span></div></div></section></section></>
}

function ApiState({ title, description }: { title: string; description: string }): ReactNode {
  return <div className="state-box api-state"><Activity size={27} /><strong>{title}</strong><p>{description}</p></div>
}

function ListPage(props: { copy: { title: string; description: string; primary: string; columns: [string, string, string, string] }; rows: TableRow[]; total: number; pageIndex: number; pageSize: number; query: string; status: string; sort: SortKey; loading: boolean; error: string | null; demoMode: boolean; canGoBack: boolean; canGoForward: boolean; onQuery: (value: string) => void; onStatus: (value: string) => void; onSort: (value: string) => void; onPageSize: (value: number) => void; onPrev: () => void; onNext: () => void; onReload: () => void; onRetry: () => void; onOpen: (row: TableRow) => void; onSimulateFailure: () => void }): ReactNode {
  const { copy, rows, total, pageIndex, pageSize, query, status, sort, loading, error, demoMode } = props
  return <><div className="page-heading"><div><p className="eyebrow">DATA WORKBENCH</p><h1>{copy.title}</h1><p>{copy.description}</p></div><button className="primary"><Plus size={16} />{copy.primary}</button></div><section className="filter-bar"><label className="search-field"><Search size={17} /><input value={query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索名称、对象或变化内容" /></label><label><span>状态</span><select value={status} onChange={(event) => props.onStatus(event.target.value)}><option value="">全部状态</option><option value="正常">正常</option><option value="关注">关注</option><option value="待处理">待处理</option><option value="已处理">已处理</option></select></label><label><span>排序</span><select value={sort} onChange={(event) => props.onSort(event.target.value)}>{sortOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><button className="filter-button" title="更多筛选"><SlidersHorizontal size={17} />更多筛选</button><div className="filter-spacer" /><button className="icon-button" title="刷新" onClick={props.onReload}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></section><section className="table-panel"><div className="table-summary"><span>共 <strong>{total}</strong> 条</span><span>{demoMode ? '本地演示数据，不请求 User API。' : 'User API · limit / cursor / sort / filters'}</span>{demoMode && <button className="test-failure" onClick={props.onSimulateFailure}>演示失败状态</button>}</div>{error ? <div className="state-box"><Activity size={27} /><strong>列表加载失败</strong><p>{error}</p><button className="primary small" onClick={props.onRetry}><RefreshCw size={15} />重试</button></div> : loading ? <div className="state-box"><RefreshCw className="spin" size={27} /><strong>正在加载当前窗口</strong><p>{demoMode ? '读取本地演示数据。' : '正在请求 User API 当前窗口。'}</p></div> : rows.length === 0 ? <div className="state-box"><Filter size={27} /><strong>没有匹配的数据</strong><p>调整关键词或状态后重试。</p></div> : <div className="table-wrap"><table><thead><tr><th>{copy.columns[0]}</th><th>{copy.columns[1]}</th><th>{copy.columns[2]}</th><th>{copy.columns[3]}</th><th aria-label="操作" /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><span className="row-tag">{row.tag}</span><strong>{row.title}</strong><small>{row.subtitle}</small></td><td>{row.metric}</td><td><span className="time">{row.updatedAt}</span></td><td><span className={`status ${statusClass[row.status]}`}>{row.status}</span></td><td><button className="row-action" title="查看详情" onClick={() => props.onOpen(row)}><MoreHorizontal size={19} /></button></td></tr>)}</tbody></table></div>}<CursorPagination total={total} pageIndex={pageIndex} pageSize={pageSize} canGoBack={props.canGoBack} canGoForward={props.canGoForward} onPrev={props.onPrev} onNext={props.onNext} onPageSize={props.onPageSize} /></section></>
}

function CursorPagination({ total, pageIndex, pageSize, canGoBack, canGoForward, onPrev, onNext, onPageSize }: { total: number; pageIndex: number; pageSize: number; canGoBack: boolean; canGoForward: boolean; onPrev: () => void; onNext: () => void; onPageSize: (value: number) => void }): ReactNode {
  const start = total === 0 ? 0 : (pageIndex - 1) * pageSize + 1
  const end = Math.min(pageIndex * pageSize, total)
  return <div className="pagination"><span>{start}-{end} / {total}</span><select aria-label="每页条数" value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}><option value={20}>20 / 页</option><option value={50}>50 / 页</option><option value={100}>100 / 页</option></select><button disabled={!canGoBack} onClick={onPrev} title="上一页"><ChevronLeft size={17} /></button><button disabled={!canGoForward} onClick={onNext} title="下一页"><ChevronRight size={17} /></button></div>
}

function DetailDrawer({ row, demoMode, onClose }: { row: TableRow; demoMode: boolean; onClose: () => void }): ReactNode {
  return <><button className="drawer-backdrop" aria-label="关闭详情" onClick={onClose} /><aside className="drawer"><header><div><span className="eyebrow">DETAIL</span><h2>详情</h2></div><button className="icon-button" onClick={onClose} title="关闭"><X size={19} /></button></header><div className="drawer-body"><span className="row-tag">{row.tag}</span><h3>{row.title}</h3><p>{row.subtitle}</p><dl><div><dt>最新信息</dt><dd>{row.metric}</dd></div><div><dt>最近更新</dt><dd>{row.updatedAt}</dd></div><div><dt>状态</dt><dd><span className={`status ${statusClass[row.status]}`}>{row.status}</span></dd></div></dl><div className="drawer-note"><ShieldCheck size={18} /><span>{demoMode ? '此处仅展示本地演示字段，不包含浏览器会话或私有凭据。' : '此处仅展示 User API 授权返回的字段，不包含浏览器会话或私有凭据。'}</span></div></div><footer><button className="secondary" onClick={onClose}>关闭</button><button className="primary small"><ExternalLink size={15} />查看关联对象</button></footer></aside></>
}

function SettingsPage(): ReactNode {
  return <><div className="page-heading"><div><p className="eyebrow">ACCOUNT</p><h1>账户设置</h1><p>管理个人工作台的显示与提醒偏好。</p></div></div><div className="settings-grid"><section className="panel setting"><div className="panel-head"><div><h2>提醒偏好</h2><p>仅影响此浏览器中的工作台展示。</p></div></div><Toggle title="价格变化提醒" subtitle="价格达到关注阈值时生成事件" enabled /><Toggle title="竞品商家动态" subtitle="商家公开商品发生变化时生成事件" enabled /><Toggle title="日报摘要" subtitle="每天汇总工作台的市场变化" /></section><section className="panel setting"><div className="panel-head"><div><h2>界面偏好</h2><p>当前为本地界面设置，不修改 User API 或 Admin 配置。</p></div></div><label className="setting-select"><span>默认市场范围</span><select><option>全国</option><option>常用地区</option></select></label><label className="setting-select"><span>列表默认排序</span><select><option>最近更新</option><option>优先级</option></select></label></section></div></>
}

function Toggle({ title, subtitle, enabled = false }: { title: string; subtitle: string; enabled?: boolean }): ReactNode {
  const [checked, setChecked] = useState(enabled)
  return <div className="toggle-row"><div><strong>{title}</strong><span>{subtitle}</span></div><button className={`toggle ${checked ? 'on' : ''}`} onClick={() => setChecked(!checked)} aria-label={title}><i /></button></div>
}

export default App
