import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  Activity, Bot, Boxes, ChevronLeft, ChevronRight, Database, FileCheck2, Gauge, LogOut,
  Menu, MoreHorizontal, PackageSearch, RefreshCw, Search, ShieldCheck, Users, Wallet, X
} from 'lucide-react'
import {
  AdminApiError, adminApi, adminWebConfig, type AdminIdentity, type AdminResource,
  type CursorListQuery, type CursorPage
} from './admin-api'

type Page = 'overview' | AdminResource
type RowStatus = '正常' | '关注' | '待处理'
type Row = { id: string; title: string; detail: string; metric: string; updatedAt: string; status: RowStatus; tag: string }
type SortKey = 'updated_at' | 'status' | 'title'

const pages: Array<{ key: Page; label: string; icon: typeof Gauge; group?: string }> = [
  { key: 'overview', label: '运营概览', icon: Gauge },
  { key: 'users', label: '用户与设备', icon: Users, group: '运营' },
  { key: 'billing', label: '套餐、订单与用量', icon: Wallet, group: '运营' },
  { key: 'market', label: '市场商品与卖家', icon: PackageSearch, group: '数据' },
  { key: 'quality', label: '类目与数据质量', icon: FileCheck2, group: '数据' },
  { key: 'uploads', label: '上传批次与事件', icon: Boxes, group: '数据' },
  { key: 'ai', label: 'AI 配置与任务', icon: Bot, group: '系统' },
  { key: 'capacity', label: '队列、存储与容量', icon: Database, group: '系统' },
  { key: 'audit', label: '审计与系统设置', icon: ShieldCheck, group: '系统' }
]

const copy: Record<AdminResource, { title: string; description: string; columns: [string, string, string, string] }> = {
  users: { title: '用户与设备', description: '查看账号状态、已绑定设备与会话风险。', columns: ['主体', '设备或套餐', '最近活动', '状态'] },
  billing: { title: '套餐、订单与用量', description: '套餐、订单与不可变用量账本的运营视图。', columns: ['账务对象', '金额或额度', '记账时间', '状态'] },
  market: { title: '市场商品与卖家', description: '按公开市场实体检查规范化数据与关联关系。', columns: ['市场实体', '当前信号', '最近更新', '状态'] },
  quality: { title: '类目与数据质量', description: '监控类目覆盖、字段完整度与异常样本。', columns: ['质量规则', '覆盖范围', '最近检查', '状态'] },
  uploads: { title: '上传批次与事件', description: '仅运营侧可见的批次、去重和失败处理记录。', columns: ['批次或事件', '处理结果', '发生时间', '状态'] },
  ai: { title: 'AI 配置与任务', description: '管理已发布能力、任务队列与版本结果。', columns: ['配置或任务', '范围或版本', '最近执行', '状态'] },
  capacity: { title: '队列、存储与容量', description: '检查服务端队列、水位、存储与容量合同。', columns: ['资源', '当前水位', '最近检查', '状态'] },
  audit: { title: '审计与系统设置', description: '追溯后台操作与安全配置的变更记录。', columns: ['审计事件', '操作者', '发生时间', '状态'] }
}

const samples: Record<AdminResource, Omit<Row, 'id' | 'updatedAt'>[]> = {
  users: [{ title: 'user_1024', detail: '专业版 · 2 台设备', metric: '最近活跃 8 分钟前', status: '正常', tag: '用户' }, { title: 'collector-win-01', detail: 'user_1024 · Windows', metric: '设备密钥有效', status: '正常', tag: '设备' }, { title: 'user_2048', detail: '基础版 · 待复核', metric: '设备绑定请求', status: '关注', tag: '用户' }],
  billing: [{ title: 'ORD-20260817-001', detail: '专业版月付 · user_1024', metric: '¥99.00', status: '正常', tag: '订单' }, { title: 'LED-000203', detail: 'AI 分析扣费 · 幂等命中', metric: '1 次调用', status: '正常', tag: '账本' }, { title: '权益调整待审核', detail: '人工授权', metric: '增加 1 个设备位', status: '待处理', tag: '权益' }],
  market: [{ title: 'MacBook Air M2 16G 512G', detail: '杭州 · 平台商品 ID 1071216800602', metric: '价格下降 6.5%', status: '关注', tag: '商品' }, { title: '海风数码回收店', detail: '杭州 · 1,284 个公开商品', metric: '今天上新 6 件', status: '正常', tag: '卖家' }, { title: 'Sony A7M4 机身', detail: '上海 · 公开快照', metric: '最近 38 分钟', status: '正常', tag: '商品' }],
  quality: [{ title: '数码类目字段完整度', detail: '手机 / 电脑 / 相机', metric: '98.6%', status: '正常', tag: '规则' }, { title: '价格异常样本', detail: '笔记本电脑 · 全国', metric: '12 条待复核', status: '关注', tag: '异常' }, { title: '图片引用可用性', detail: '过去 24 小时', metric: '99.2%', status: '正常', tag: '媒体' }],
  uploads: [{ title: 'UPL-20260817-00821', detail: 'collector-win-01 · 250 条', metric: '去重 239，新增 11', status: '正常', tag: '批次' }, { title: '价格下调事件', detail: '商品版本比较', metric: '已写入事件链', status: '正常', tag: '事件' }, { title: 'UPL-20260817-00820', detail: '断网恢复补传', metric: '等待复核', status: '待处理', tag: '批次' }],
  ai: [{ title: '竞品价格带分析', detail: '版本 2026.08.17-1', metric: '已发布', status: '正常', tag: '能力' }, { title: 'AI-TSK-00812', detail: '轻薄本市场周报', metric: '队列等待 2 分钟', status: '关注', tag: '任务' }, { title: '同款聚类规则', detail: '结构化结果', metric: '昨日执行成功', status: '正常', tag: '配置' }],
  capacity: [{ title: '采集事件队列', detail: 'consumer-market', metric: '水位 4.2%', status: '正常', tag: '队列' }, { title: '对象存储', detail: '公开图片媒体', metric: '容量 18.7%', status: '正常', tag: '存储' }, { title: 'PostgreSQL 分区', detail: 'market_item_versions', metric: '今日写入 468k', status: '正常', tag: '数据库' }],
  audit: [{ title: '套餐策略已发布', detail: 'owner · policy_20260817', metric: '请求 A7F1', status: '正常', tag: '审计' }, { title: '设备已解绑', detail: 'operator · collector-win-03', metric: '请求 3CD8', status: '关注', tag: '审计' }, { title: 'MFA 状态更新', detail: 'admin-owner', metric: '请求 E128', status: '正常', tag: '安全' }]
}

function rowsFor(resource: AdminResource): Row[] {
  return Array.from({ length: 137 }, (_, index) => {
    const base = samples[resource][index % samples[resource].length]
    return {
      ...base,
      id: `${resource}-${index + 1}`,
      title: index < 3 ? base.title : `${base.title} · ${index + 1}`,
      updatedAt: `今天 ${String(9 + index % 10).padStart(2, '0')}:${String(index * 9 % 60).padStart(2, '0')}`
    }
  })
}

function demoPage(resource: AdminResource, request: CursorListQuery): CursorPage<Row> {
  const start = request.cursor?.startsWith('demo:') ? Number(request.cursor.slice(5)) : 0
  const offset = Number.isSafeInteger(start) && start >= 0 ? start : 0
  const query = request.filters?.q?.toLowerCase() ?? ''
  const status = request.filters?.status
  const rows = rowsFor(resource)
    .filter((row) => (!status || row.status === status) && `${row.title}${row.detail}${row.metric}`.toLowerCase().includes(query))
    .sort((left, right) => {
      const a = request.sort === 'status' ? left.status : request.sort === 'title' ? left.title : left.updatedAt
      const b = request.sort === 'status' ? right.status : request.sort === 'title' ? right.title : right.updatedAt
      const compared = a.localeCompare(b, 'zh-CN') || left.id.localeCompare(right.id)
      return request.order === 'asc' ? compared : -compared
    })
  const items = rows.slice(offset, offset + request.limit)
  const nextOffset = offset + items.length
  return {
    items,
    page: {
      limit: request.limit,
      nextCursor: nextOffset < rows.length ? `demo:${nextOffset}` : null,
      hasMore: nextOffset < rows.length,
      total: rows.length,
      snapshot: 'demo-fixture-20260817'
    }
  }
}

export default function App(): ReactNode {
  const [ready, setReady] = useState(adminWebConfig.demoMode)
  const [identity, setIdentity] = useState<AdminIdentity | null>(null)
  const [bootstrapError, setBootstrapError] = useState<string | null>(null)

  useEffect(() => {
    if (adminWebConfig.demoMode) return
    let cancelled = false
    void adminApi.restore().then((session) => {
      if (!cancelled) setIdentity(session?.identity ?? null)
    }).catch((error: unknown) => {
      if (!cancelled) setBootstrapError(error instanceof Error ? error.message : '无法验证管理员会话')
    }).finally(() => {
      if (!cancelled) setReady(true)
    })
    return () => { cancelled = true }
  }, [])

  if (!ready) return <AuthFrame title="正在验证管理员会话" detail="仅检查独立 Admin API，会话不会转交给用户域。" />
  if (!identity) return <LoginPage error={bootstrapError} onAuthenticated={setIdentity} onEnterDemo={() => setIdentity({ id: 'demo-admin', role: 'demo' })} />
  return <Workbench identity={identity} onLogout={() => { adminApi.logout(); setIdentity(null); setBootstrapError(null) }} />
}

function LoginPage({ error, onAuthenticated, onEnterDemo }: { error: string | null; onAuthenticated: (identity: AdminIdentity) => void; onEnterDemo: () => void }): ReactNode {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState(error)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setMessage(null)
    try {
      const session = await adminApi.login(email, password)
      onAuthenticated(session.identity)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '管理员登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  return <AuthFrame title="闲鱼数据台" detail={adminWebConfig.demoMode ? '本地演示模式：不会请求 Admin API，也不需要管理员凭据。' : '使用独立 Admin 账号登录；普通用户账号无法进入此工作台。'}>
    {adminWebConfig.demoMode ? <button className="primary auth-submit" onClick={onEnterDemo}><Gauge size={16} />进入本地演示</button> : <form className="auth-form" onSubmit={submit}>
      <label>管理员邮箱<input autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required type="email" /></label>
      <label>管理员密码<input autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required type="password" /></label>
      {message && <p className="auth-error" role="alert">{message}</p>}
      <button className="primary auth-submit" disabled={submitting} type="submit"><ShieldCheck size={16} />{submitting ? '正在验证' : '管理员登录'}</button>
    </form>}
  </AuthFrame>
}

function AuthFrame({ title, detail, children }: { title: string; detail: string; children?: ReactNode }): ReactNode {
  return <main className="auth-shell"><section className="auth-card"><div className="auth-mark"><ShieldCheck size={24} /></div><i>ADMIN ONLY</i><h1>{title}</h1><p>{detail}</p>{children}</section></main>
}

function Workbench({ identity, onLogout }: { identity: AdminIdentity; onLogout: () => void }): ReactNode {
  const [active, setActive] = useState<Page>('overview')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState<SortKey>('updated_at')
  const [limit, setLimit] = useState<20 | 50 | 100>(50)
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([undefined])
  const [cursorIndex, setCursorIndex] = useState(0)
  const [page, setPage] = useState<CursorPage<Row> | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [demoFailure, setDemoFailure] = useState(false)
  const [drawer, setDrawer] = useState<Row | null>(null)
  const current = pages.find((item) => item.key === active)!
  const resource = active === 'overview' ? null : active
  const cursor = cursorHistory[cursorIndex]

  const resetCursor = useCallback(() => {
    setCursorHistory([undefined])
    setCursorIndex(0)
  }, [])

  useEffect(() => {
    if (!resource) {
      setPage(null)
      setFailure(null)
      return
    }
    let cancelled = false
    const request: CursorListQuery = {
      limit,
      cursor,
      sort,
      order: 'desc',
      filters: { q: query.trim() || undefined, status: status || undefined }
    }
    setLoading(true)
    setFailure(null)
    setPage(null)
    const load = adminWebConfig.demoMode
      ? demoFailure ? Promise.reject(new Error('本地演示请求被中断')) : Promise.resolve(demoPage(resource, request))
      : adminApi.list<Row>(resource, request)
    void load.then((result) => {
      if (!cancelled) setPage(result)
    }).catch((cause: unknown) => {
      if (cancelled) return
      if (cause instanceof AdminApiError && cause.code === 'CURSOR_EXPIRED' && cursor) {
        setNotice('服务端游标已过期，已保留筛选条件并回到第一页。')
        resetCursor()
        return
      }
      setFailure(cause instanceof Error ? cause.message : '列表加载失败')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [cursor, demoFailure, limit, query, refreshVersion, resetCursor, resource, sort, status])

  const switchPage = (next: Page) => {
    setActive(next)
    setQuery('')
    setStatus('')
    setDrawer(null)
    setNotice(null)
    resetCursor()
    setMobileOpen(false)
  }
  const changeFilter = (callback: () => void) => {
    callback()
    setNotice(null)
    resetCursor()
  }
  const refresh = () => {
    setDemoFailure(false)
    setNotice(null)
    setRefreshVersion((value) => value + 1)
  }
  const moveNext = () => {
    if (!page?.page.nextCursor || loading) return
    setCursorHistory((history) => [...history.slice(0, cursorIndex + 1), page.page.nextCursor ?? undefined])
    setCursorIndex((index) => index + 1)
  }

  return <div className={`app ${collapsed ? 'collapsed' : ''}`}>
    <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
      <div className="brand"><span>管</span>{!collapsed && <strong>闲鱼数据台</strong>}</div>
      <nav>{pages.map((item, index) => <div key={item.key}>{item.group && item.group !== pages[index - 1]?.group && !collapsed && <p>{item.group}</p>}<button className={active === item.key ? 'active' : ''} onClick={() => switchPage(item.key)} title={collapsed ? item.label : undefined}><item.icon size={18} /><span>{item.label}</span></button></div>)}</nav>
      <div className="side-foot"><button onClick={() => setCollapsed(!collapsed)} title="收起导航"><Menu size={18} /><span>{collapsed ? '展开导航' : '收起导航'}</span></button><div className="admin-avatar"><b>管</b>{!collapsed && <div><strong>{identity.role ?? '平台运营'}</strong><small>{adminWebConfig.demoMode ? '演示管理员' : `Admin · ${identity.id.slice(0, 8)}`}</small></div>}<button className="logout" onClick={onLogout} title="退出管理员会话"><LogOut size={16} /></button></div></div>
    </aside>
    {mobileOpen && <button className="backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
    <section className="main"><header><button className="mobile-menu" title="打开导航" onClick={() => setMobileOpen(true)}><Menu size={18} /></button><div className="crumb"><span>Admin 工作台</span><ChevronRight size={14} /><strong>{current.label}</strong></div><div className="right"><span>{adminWebConfig.demoMode ? '本地演示数据' : '独立 Admin API'}</span><Activity size={18} /><button title="审计中心" className="icon" onClick={() => switchPage('audit')}><ShieldCheck size={18} /></button></div></header><main className="content">{active === 'overview' ? <Overview onNavigate={switchPage} /> : <List view={copy[resource!]} page={page} cursorIndex={cursorIndex} query={query} status={status} sort={sort} limit={limit} loading={loading} failure={failure} notice={notice} demoMode={adminWebConfig.demoMode} onQuery={(value) => changeFilter(() => setQuery(value))} onStatus={(value) => changeFilter(() => setStatus(value))} onSort={(value) => changeFilter(() => setSort(value))} onLimit={(value) => changeFilter(() => setLimit(value))} onPrev={() => setCursorIndex((index) => Math.max(0, index - 1))} onNext={moveNext} onRefresh={refresh} onFailure={() => { setDemoFailure(true); setRefreshVersion((value) => value + 1) }} onOpen={setDrawer} />}</main></section>
    {drawer && <Drawer row={drawer} demoMode={adminWebConfig.demoMode} onClose={() => setDrawer(null)} />}
  </div>
}

function Overview({ onNavigate }: { onNavigate: (page: Page) => void }): ReactNode {
  const stats = [['活跃用户', '1,024', '过去 24 小时 +86', Users, 'blue'], ['在线采集器', '1,746', '设备健康 98.6%', Activity, 'mint'], ['待处理批次', '21', '失败重试 3', Boxes, 'amber'], ['AI 任务队列', '87', '平均等待 1.8 分钟', Bot, 'rose']] as const
  return <><div className="heading"><div><i>OPERATIONS</i><h1>运营概览</h1><p>用户、市场数据与基础设施的运营总览。</p></div><button className="primary" onClick={() => onNavigate('users')}><Users size={16} />用户与设备</button></div><section className="stats">{stats.map(([label, value, note, Icon, tone]) => <article key={label}><div className={tone}><Icon size={20} /></div><section><span>{label}</span><strong>{value}</strong><small>{note}</small></section></article>)}</section><section className="grid"><article className="panel wide"><div className="panel-head"><div><h2>运营待办</h2><p>需要人工处理的当前事项</p></div><button onClick={() => onNavigate('audit')}>查看审计 <ChevronRight size={15} /></button></div>{['3 个上传批次等待复核', '1 条设备解绑申请待处理', 'AI 竞品分析队列等待超过 2 分钟'].map((item, index) => <button className="feed" key={item} onClick={() => onNavigate(index === 0 ? 'uploads' : index === 1 ? 'users' : 'ai')}><b className={`dot d${index}`} /><div><strong>{item}</strong><small>今天 {10 + index}:2{index} · 系统运营</small></div><ChevronRight size={16} /></button>)}</article><article className="panel"><div className="panel-head"><div><h2>数据质量</h2><p>公开市场实体</p></div><button onClick={() => onNavigate('quality')}>详情</button></div><div className="numbers"><div><span>字段完整度</span><strong>98.6%</strong></div><div><span>去重命中率</span><strong>93.4%</strong></div><div><span>异常样本</span><strong>12</strong></div></div></article><article className="panel"><div className="panel-head"><div><h2>容量水位</h2><p>阶段 0 容量合同</p></div><button onClick={() => onNavigate('capacity')}>查看</button></div><div className="numbers"><div><span>事件队列</span><strong>4.2%</strong></div><div><span>对象存储</span><strong>18.7%</strong></div><div><span>数据库写入</span><strong>55/s</strong></div></div></article></section></>
}

function List(props: { view: { title: string; description: string; columns: [string, string, string, string] }; page: CursorPage<Row> | null; cursorIndex: number; query: string; status: string; sort: SortKey; limit: 20 | 50 | 100; loading: boolean; failure: string | null; notice: string | null; demoMode: boolean; onQuery: (value: string) => void; onStatus: (value: string) => void; onSort: (value: SortKey) => void; onLimit: (value: 20 | 50 | 100) => void; onPrev: () => void; onNext: () => void; onRefresh: () => void; onFailure: () => void; onOpen: (row: Row) => void }): ReactNode {
  const { view, page, cursorIndex, query, status, sort, limit, loading, failure, notice } = props
  const rows = page?.items ?? []
  return <><div className="heading"><div><i>ADMIN</i><h1>{view.title}</h1><p>{view.description}</p></div><button className="primary" onClick={props.onRefresh}><RefreshCw className={loading ? 'spin' : ''} size={16} />刷新列表</button></div><section className="filters"><label><Search size={16} /><input value={query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索当前范围" /></label><select aria-label="状态" value={status} onChange={(event) => props.onStatus(event.target.value)}><option value="">全部状态</option><option>正常</option><option>关注</option><option>待处理</option></select><select aria-label="排序" value={sort} onChange={(event) => props.onSort(event.target.value as SortKey)}><option value="updated_at">最近更新</option><option value="status">状态优先</option><option value="title">名称</option></select><span /><button className="icon" title="刷新当前页" onClick={props.onRefresh}><RefreshCw className={loading ? 'spin' : ''} size={17} /></button></section><section className="table-panel"><div className="summary"><strong>{page?.page.total ?? 0}</strong><span> 条符合当前筛选的记录 · {props.demoMode ? '本地夹具模拟 cursor 合同' : '仅请求当前 cursor 窗口'}</span>{props.demoMode && <button onClick={props.onFailure}>演示失败态</button>}</div>{notice && <p className="table-notice" role="status">{notice}</p>}{failure ? <State title="列表加载失败" text={failure} onRetry={props.onRefresh} /> : loading && !page ? <State title="正在加载当前窗口" text="筛选、排序和 cursor 保持不变。" /> : rows.length === 0 ? <State title="没有匹配的数据" text="调整筛选条件后重试。" /> : <div className="table-wrap"><table><thead><tr>{view.columns.map((column) => <th key={column}>{column}</th>)}<th aria-label="详情" /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><em>{row.tag}</em><strong>{row.title}</strong><small>{row.detail}</small></td><td>{row.metric}</td><td>{row.updatedAt}</td><td><b className={row.status === '正常' ? 'ok' : row.status === '关注' ? 'watch' : 'pending'}>{row.status}</b></td><td><button className="row-icon" title="查看详情" onClick={() => props.onOpen(row)}><MoreHorizontal size={18} /></button></td></tr>)}</tbody></table></div>}<Pager page={page} cursorIndex={cursorIndex} limit={limit} loading={loading} onPrev={props.onPrev} onNext={props.onNext} onLimit={props.onLimit} /></section></>
}

function State({ title, text, onRetry }: { title: string; text: string; onRetry?: () => void }): ReactNode { return <div className="state"><Activity size={27} /><strong>{title}</strong><p>{text}</p>{onRetry && <button className="primary small" onClick={onRetry}><RefreshCw size={15} />重试</button>}</div> }
function Pager({ page, cursorIndex, limit, loading, onPrev, onNext, onLimit }: { page: CursorPage<Row> | null; cursorIndex: number; limit: 20 | 50 | 100; loading: boolean; onPrev: () => void; onNext: () => void; onLimit: (value: 20 | 50 | 100) => void }): ReactNode { const total = page?.page.total ?? 0; return <footer className="pager"><span>{total === 0 ? '无记录' : `第 ${cursorIndex + 1} 个游标窗口 · 共 ${total} 条`}</span><select aria-label="每页条数" value={limit} onChange={(event) => onLimit(Number(event.target.value) as 20 | 50 | 100)}><option value={20}>20 / 页</option><option value={50}>50 / 页</option><option value={100}>100 / 页</option></select><button disabled={cursorIndex === 0 || loading} onClick={onPrev} title="上一页"><ChevronLeft size={17} /></button><button disabled={!page?.page.hasMore || loading} onClick={onNext} title="下一页"><ChevronRight size={17} /></button></footer> }
function Drawer({ row, demoMode, onClose }: { row: Row; demoMode: boolean; onClose: () => void }): ReactNode { return <><button className="drawer-cover" aria-label="关闭详情" onClick={onClose} /><aside className="drawer"><header><div><i>DETAIL</i><h2>运营详情</h2></div><button className="icon" title="关闭" onClick={onClose}><X size={19} /></button></header><main><em>{row.tag}</em><h3>{row.title}</h3><p>{row.detail}</p><dl><div><dt>当前信息</dt><dd>{row.metric}</dd></div><div><dt>最近更新</dt><dd>{row.updatedAt}</dd></div><div><dt>状态</dt><dd>{row.status}</dd></div></dl><section><ShieldCheck size={18} /><span>{demoMode ? '演示模式仅展示本地夹具字段，不会请求或保存管理员凭据。' : '完整详情通过独立 Admin API 按需读取，不随增长列表全量传输。'}</span></section></main><footer><button onClick={onClose}>关闭</button></footer></aside></> }
