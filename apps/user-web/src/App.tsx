import { useMemo, useState, type ReactNode } from 'react'
import {
  Activity, Bell, Bot, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ClipboardList,
  ExternalLink, FileSearch, Filter, Gauge, LayoutDashboard, Menu, MoreHorizontal, PackageSearch,
  Plus, RefreshCw, Search, Settings, ShieldCheck, SlidersHorizontal, Store, Users, X
} from 'lucide-react'

type PageKey = 'dashboard' | 'monitors' | 'sellers' | 'pool' | 'discoveries' | 'events' | 'logs' | 'ai' | 'settings'
type RowKind = Exclude<PageKey, 'dashboard' | 'settings'>
type Status = '正常' | '关注' | '已暂停' | '已处理' | '待处理'

type TableRow = {
  id: string
  title: string
  subtitle: string
  metric: string
  updatedAt: string
  status: Status
  tag: string
}

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

function App(): ReactNode {
  const [active, setActive] = useState<PageKey>('dashboard')
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [drawer, setDrawer] = useState<TableRow | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('全部状态')
  const [sort, setSort] = useState('最近更新')
  const [cursor, setCursor] = useState(0)
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const activePage = pages.find((page) => page.key === active)!
  const listKind = active === 'dashboard' || active === 'settings' ? null : active
  const allRows = useMemo(() => listKind ? makeRows(listKind) : [], [listKind])
  const filtered = useMemo(() => allRows.filter((row) => {
    const matchesQuery = `${row.title}${row.subtitle}${row.metric}`.toLowerCase().includes(query.trim().toLowerCase())
    const matchesStatus = status === '全部状态' || row.status === status
    return matchesQuery && matchesStatus
  }), [allRows, query, status])
  const currentRows = filtered.slice(cursor, cursor + pageSize)
  const canGoBack = cursor > 0
  const canGoForward = cursor + pageSize < filtered.length

  const switchPage = (next: PageKey) => {
    setActive(next)
    setCursor(0)
    setQuery('')
    setStatus('全部状态')
    setMenuOpen(false)
  }

  const reload = () => {
    setLoading(true)
    setFailed(false)
    window.setTimeout(() => setLoading(false), 420)
  }

  const changeFilter = (callback: () => void) => {
    callback()
    setCursor(0)
  }

  return <div className={`app ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><span className="brand-mark">鱼</span>{!collapsed && <span>闲鱼数据台</span>}</div>
      <nav>
        {pages.map((page, index) => <div key={page.key}>
          {page.group && page.group !== pages[index - 1]?.group && !collapsed && <p className="nav-group">{page.group}</p>}
          <button className={`nav-item ${active === page.key ? 'active' : ''}`} onClick={() => switchPage(page.key)} title={collapsed ? page.label : undefined}>
            <page.icon size={18} /><span>{page.label}</span>
          </button>
        </div>)}
      </nav>
      <div className="sidebar-foot">
        <button className="nav-item" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开导航' : '收起导航'}><Menu size={18} /><span>{collapsed ? '展开' : '收起导航'}</span></button>
        <div className="account"><div className="avatar">林</div>{!collapsed && <div><strong>林海</strong><span>专业版 · 27 天</span></div>}<ChevronDown size={15} /></div>
      </div>
    </aside>
    {menuOpen && <button className="backdrop" aria-label="关闭导航" onClick={() => setMenuOpen(false)} />}
    <section className="main-shell">
      <header className="topbar">
        <button className="mobile-menu" title="打开导航" onClick={() => setMenuOpen(true)}><Menu size={19} /></button>
        <div className="crumb"><span>用户工作台</span><ChevronRight size={14} /><strong>{activePage.label}</strong></div>
        <div className="topbar-right"><span className="fixture-badge">本地演示数据</span><button className="icon-button" title="帮助"><CircleHelp size={18} /></button><button className="icon-button notification" title="事件中心" onClick={() => switchPage('events')}><Bell size={18} /><i>3</i></button></div>
      </header>
      <main className="content">
        {active === 'dashboard' && <Dashboard onNavigate={switchPage} />}
        {active === 'settings' && <SettingsPage />}
        {listKind && <ListPage
          copy={pageCopy[listKind]}
          rows={currentRows}
          total={filtered.length}
          cursor={cursor}
          pageSize={pageSize}
          query={query}
          status={status}
          sort={sort}
          loading={loading}
          failed={failed}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onQuery={(value) => changeFilter(() => setQuery(value))}
          onStatus={(value) => changeFilter(() => setStatus(value))}
          onSort={(value) => changeFilter(() => setSort(value))}
          onPageSize={(value) => { setPageSize(value); setCursor(0) }}
          onPrev={() => setCursor(Math.max(0, cursor - pageSize))}
          onNext={() => setCursor(cursor + pageSize)}
          onReload={reload}
          onRetry={reload}
          onOpen={setDrawer}
          onSimulateFailure={() => { setLoading(false); setFailed(true) }}
        />}
      </main>
    </section>
    {drawer && <DetailDrawer row={drawer} onClose={() => setDrawer(null)} />}
  </div>
}

function Dashboard({ onNavigate }: { onNavigate: (key: PageKey) => void }): ReactNode {
  const stats = [
    ['生效监控', '18', '较昨日 +2', Gauge, 'blue'],
    ['关注商家', '36', '公开商品变化 14', Store, 'mint'],
    ['待处理事件', '7', '3 条价格变化', Bell, 'amber'],
    ['市场机会', '12', '过去 24 小时', FileSearch, 'rose']
  ] as const
  return <>
    <div className="page-heading"><div><p className="eyebrow">OVERVIEW</p><h1>早上好，林海</h1><p>这里汇总你关心的市场变化与待处理事项。</p></div><button className="primary" onClick={() => onNavigate('monitors')}><Plus size={16} />新建监控</button></div>
    <section className="stats-grid">{stats.map(([label, value, note, Icon, tone]) => <article className="stat-card" key={label}><div className={`stat-icon ${tone}`}><Icon size={20} /></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>)}</section>
    <section className="dashboard-grid">
      <section className="panel wide"><div className="panel-head"><div><h2>重点动态</h2><p>最近 24 小时</p></div><button className="text-button" onClick={() => onNavigate('events')}>查看全部 <ChevronRight size={15} /></button></div><div className="feed-list">
        {['MacBook Air M2 16G 512G 价格下降 6.5%', '海风数码回收店新增 6 个公开商品', '轻薄本价格带的低价供给增加 18%'].map((item, index) => <button className="feed" key={item} onClick={() => onNavigate('events')}><span className={`feed-dot d${index}`} /><div><strong>{item}</strong><small>{index + 1} 小时前 · 来自市场变化</small></div><ChevronRight size={16} /></button>)}
      </div></section>
      <section className="panel"><div className="panel-head"><div><h2>市场信号</h2><p>今天</p></div><button className="text-button" onClick={() => onNavigate('discoveries')}>全部</button></div><div className="signal"><div><span>价格下降商品</span><strong>42</strong></div><div><span>新增样本</span><strong>186</strong></div><div><span>商家上新</span><strong>29</strong></div></div></section>
      <section className="panel"><div className="panel-head"><div><h2>最新 AI 解读</h2><p>已发布报告</p></div><button className="text-button" onClick={() => onNavigate('ai')}>打开</button></div><div className="ai-preview"><Bot size={22} /><div><strong>轻薄本价格带周报</strong><p>低价供给增加，成交热度保持平稳。</p><span>今天 09:30</span></div></div></section>
    </section>
  </>
}

function ListPage(props: {
  copy: { title: string; description: string; primary: string; columns: [string, string, string, string] }
  rows: TableRow[]; total: number; cursor: number; pageSize: number; query: string; status: string; sort: string; loading: boolean; failed: boolean; canGoBack: boolean; canGoForward: boolean
  onQuery: (value: string) => void; onStatus: (value: string) => void; onSort: (value: string) => void; onPageSize: (value: number) => void; onPrev: () => void; onNext: () => void; onReload: () => void; onRetry: () => void; onOpen: (row: TableRow) => void; onSimulateFailure: () => void
}): ReactNode {
  const { copy, rows, total, cursor, pageSize, query, status, sort, loading, failed } = props
  return <>
    <div className="page-heading"><div><p className="eyebrow">DATA WORKBENCH</p><h1>{copy.title}</h1><p>{copy.description}</p></div><button className="primary"><Plus size={16} />{copy.primary}</button></div>
    <section className="filter-bar"><label className="search-field"><Search size={17} /><input value={query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索名称、对象或变化内容" /></label><label><span>状态</span><select value={status} onChange={(event) => props.onStatus(event.target.value)}><option>全部状态</option><option>正常</option><option>关注</option><option>待处理</option><option>已处理</option></select></label><label><span>排序</span><select value={sort} onChange={(event) => props.onSort(event.target.value)}><option>最近更新</option><option>优先级</option><option>名称</option></select></label><button className="filter-button" title="更多筛选"><SlidersHorizontal size={17} />更多筛选</button><div className="filter-spacer" /><button className="icon-button" title="刷新" onClick={props.onReload}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></section>
    <section className="table-panel"><div className="table-summary"><span>共 <strong>{total}</strong> 条</span><span>筛选与翻页采用 cursor，示例数据不会请求云端。</span><button className="test-failure" onClick={props.onSimulateFailure}>演示失败状态</button></div>
      {failed ? <div className="state-box"><Activity size={27} /><strong>列表加载失败</strong><p>本地演示的请求被中断，可重试恢复当前筛选与 cursor。</p><button className="primary small" onClick={props.onRetry}><RefreshCw size={15} />重试</button></div> : loading ? <div className="state-box"><RefreshCw className="spin" size={27} /><strong>正在加载当前窗口</strong><p>保持筛选和游标不变。</p></div> : rows.length === 0 ? <div className="state-box"><Filter size={27} /><strong>没有匹配的数据</strong><p>调整关键词或状态后重试。</p></div> : <div className="table-wrap"><table><thead><tr><th>{copy.columns[0]}</th><th>{copy.columns[1]}</th><th>{copy.columns[2]}</th><th>{copy.columns[3]}</th><th aria-label="操作" /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><span className="row-tag">{row.tag}</span><strong>{row.title}</strong><small>{row.subtitle}</small></td><td>{row.metric}</td><td><span className="time">{row.updatedAt}</span></td><td><span className={`status ${statusClass[row.status]}`}>{row.status}</span></td><td><button className="row-action" title="查看详情" onClick={() => props.onOpen(row)}><MoreHorizontal size={19} /></button></td></tr>)}</tbody></table></div>}
      <CursorPagination total={total} cursor={cursor} pageSize={pageSize} canGoBack={props.canGoBack} canGoForward={props.canGoForward} onPrev={props.onPrev} onNext={props.onNext} onPageSize={props.onPageSize} />
    </section>
  </>
}

function CursorPagination({ total, cursor, pageSize, canGoBack, canGoForward, onPrev, onNext, onPageSize }: { total: number; cursor: number; pageSize: number; canGoBack: boolean; canGoForward: boolean; onPrev: () => void; onNext: () => void; onPageSize: (value: number) => void }): ReactNode {
  const start = total === 0 ? 0 : cursor + 1
  const end = Math.min(cursor + pageSize, total)
  return <div className="pagination"><span>{start}-{end} / {total}</span><select aria-label="每页条数" value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}><option value={20}>20 / 页</option><option value={50}>50 / 页</option><option value={100}>100 / 页</option></select><button disabled={!canGoBack} onClick={onPrev} title="上一页"><ChevronLeft size={17} /></button><button disabled={!canGoForward} onClick={onNext} title="下一页"><ChevronRight size={17} /></button></div>
}

function DetailDrawer({ row, onClose }: { row: TableRow; onClose: () => void }): ReactNode {
  return <><button className="drawer-backdrop" aria-label="关闭详情" onClick={onClose} /><aside className="drawer"><header><div><span className="eyebrow">DETAIL</span><h2>详情</h2></div><button className="icon-button" onClick={onClose} title="关闭"><X size={19} /></button></header><div className="drawer-body"><span className="row-tag">{row.tag}</span><h3>{row.title}</h3><p>{row.subtitle}</p><dl><div><dt>最新信息</dt><dd>{row.metric}</dd></div><div><dt>最近更新</dt><dd>{row.updatedAt}</dd></div><div><dt>状态</dt><dd><span className={`status ${statusClass[row.status]}`}>{row.status}</span></dd></div></dl><div className="drawer-note"><ShieldCheck size={18} /><span>此处仅展示工作台可见的演示字段，不包含本地浏览器会话或私有凭据。</span></div></div><footer><button className="secondary" onClick={onClose}>关闭</button><button className="primary small"><ExternalLink size={15} />查看关联对象</button></footer></aside></>
}

function SettingsPage(): ReactNode {
  return <><div className="page-heading"><div><p className="eyebrow">ACCOUNT</p><h1>账户设置</h1><p>管理个人工作台的显示与提醒偏好。</p></div></div><div className="settings-grid"><section className="panel setting"><div className="panel-head"><div><h2>提醒偏好</h2><p>仅影响你的工作台展示。</p></div></div><Toggle title="价格变化提醒" subtitle="价格达到关注阈值时生成事件" enabled /><Toggle title="竞品商家动态" subtitle="商家公开商品发生变化时生成事件" enabled /><Toggle title="日报摘要" subtitle="每天汇总工作台的市场变化" /></section><section className="panel setting"><div className="panel-head"><div><h2>界面偏好</h2><p>该设置保存在你的账户配置中。</p></div></div><label className="setting-select"><span>默认市场范围</span><select><option>全国</option><option>常用地区</option></select></label><label className="setting-select"><span>列表默认排序</span><select><option>最近更新</option><option>优先级</option></select></label></section></div></>
}

function Toggle({ title, subtitle, enabled = false }: { title: string; subtitle: string; enabled?: boolean }): ReactNode {
  const [checked, setChecked] = useState(enabled)
  return <div className="toggle-row"><div><strong>{title}</strong><span>{subtitle}</span></div><button className={`toggle ${checked ? 'on' : ''}`} onClick={() => setChecked(!checked)} aria-label={title}><i /></button></div>
}

export default App
