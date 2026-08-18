import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  Activity, Bot, Boxes, ChevronLeft, ChevronRight, Database, FileCheck2, Fish, Gauge, LogOut,
  Menu, Megaphone, MoreHorizontal, PackageSearch, PanelLeft, PanelLeftClose, RefreshCw, Search, Settings, ShieldCheck, Users, X
} from 'lucide-react'
import {
  AdminApiError, adminApi, adminWebConfig, type AdminIdentity, type AdminResource,
  type CursorListQuery, type CursorPage
} from './admin-api'

type Page = 'overview' | 'settings' | AdminResource
type RowStatus = '正常' | '关注' | '待处理'
type Row = { id: string; title: string; detail: string; metric: string; updatedAt: string; status: RowStatus; tag: string; userId?: string; enabled?: boolean; points?: number; userData?: Record<string, number> }
type SortKey = 'updated_at' | 'status' | 'title'

const pages: Array<{ key: Page; label: string; icon: typeof Gauge }> = [
  { key: 'overview', label: '实测', icon: Gauge },
  { key: 'market', label: '商品', icon: PackageSearch },
  { key: 'quality', label: '数据质量', icon: FileCheck2 },
  { key: 'uploads', label: '上传记录', icon: Boxes },
  { key: 'ai', label: 'AI任务', icon: Bot },
  { key: 'capacity', label: '服务状态', icon: Database },
  { key: 'audit', label: '操作审计', icon: ShieldCheck },
  { key: 'settings', label: '设置中心', icon: Settings }
]

const rememberedCredentialsKey = 'xianyu-admin-web.remembered-credentials.v1'

function readRememberedCredentials(): { account: string; password: string } {
  try {
    const value = JSON.parse(localStorage.getItem(rememberedCredentialsKey) ?? '{}') as Partial<{ account: string; password: string }>
    if (typeof value.account === 'string' && typeof value.password === 'string') return { account: value.account, password: value.password }
  } catch {
    localStorage.removeItem(rememberedCredentialsKey)
  }
  return { account: '', password: '' }
}

const copy: Record<AdminResource, { title: string; description: string; columns: [string, string, string, string] }> = {
  users: { title: '用户管理', description: '查看账号、积分、状态与用户数据。', columns: ['账号 / ID', '积分 / 数据', '注册时间', '状态'] },
  billing: { title: '套餐、订单与用量', description: '查看订单、可用额度与使用记录。', columns: ['账务对象', '金额或额度', '记账时间', '状态'] },
  market: { title: '市场商品与卖家', description: '查看公开商品、卖家与近期变化。', columns: ['市场实体', '当前信号', '最近更新', '状态'] },
  quality: { title: '类目与数据质量', description: '监控类目覆盖、字段完整度与异常样本。', columns: ['质量规则', '覆盖范围', '最近检查', '状态'] },
  uploads: { title: '上传批次与事件', description: '仅运营侧可见的批次、去重和失败处理记录。', columns: ['批次或事件', '处理结果', '发生时间', '状态'] },
  ai: { title: '洞察任务', description: '管理已发布能力、任务与结果版本。', columns: ['能力或任务', '范围或版本', '最近执行', '状态'] },
  capacity: { title: '服务状态', description: '查看数据处理、媒体与存储状态。', columns: ['项目', '当前状态', '最近检查', '状态'] },
  audit: { title: '操作审计', description: '追溯管理操作与账号变更。', columns: ['操作记录', '操作者', '发生时间', '状态'] }
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

function normalizeAdminRows(resource: AdminResource, page: CursorPage<Record<string, unknown>>): CursorPage<Row> {
  if (resource === 'users') {
    return {
      ...page,
      items: page.items.map((item) => {
        const enabled = Boolean(item.enabled ?? (item.status === 'active' || item.status === '正常'))
        const userData = (item.userData && typeof item.userData === 'object' ? item.userData : {}) as Record<string, number>
        return {
          id: String(item.id), userId: String(item.id), title: String(item.account ?? item.email ?? item.title ?? item.id),
          detail: item.detail ? String(item.detail) : `ID ${String(item.id)}`,
          metric: item.metric ? String(item.metric) : `${Number(item.points ?? 0)} 积分 · 监控 ${Number(userData.monitorCount ?? 0)} · 设备 ${Number(userData.deviceCount ?? 0)}`,
          updatedAt: String(item.createdAt ?? ''), status: enabled ? '正常' : '待处理', tag: '用户', enabled, points: Number(item.points ?? 0), userData
        }
      })
    }
  }
  if (resource !== 'uploads') return page as CursorPage<Row>
  return {
    ...page,
    items: page.items.map((item) => {
      const status = String(item.qualityStatus ?? item.status ?? 'pending')
      const rowStatus: RowStatus = status === 'passed' || status === 'completed' ? '正常' : status === 'failed' || status === 'rejected' ? '待处理' : '关注'
      return { id: String(item.id), title: String(item.id), detail: `设备 ${String(item.clientId ?? '')} · 用户 ${String(item.userId ?? '')}`, metric: `接收 ${String(item.receivedCount ?? 0)}，新增 ${String(item.insertedCount ?? 0)}，去重 ${String(item.deduplicatedCount ?? 0)}，失败 ${String(item.failedCount ?? 0)}`, updatedAt: String(item.completedAt ?? item.receivedAt ?? ''), status: rowStatus, tag: '批次' }
    })
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

  if (!ready) return <AuthFrame title="正在检查登录状态" detail="请稍候。" />
  if (!identity) return <LoginPage error={bootstrapError} onAuthenticated={setIdentity} onEnterDemo={() => setIdentity({ id: 'demo-admin', role: '平台运营' })} />
  return <Workbench identity={identity} onLogout={() => { adminApi.logout(); setIdentity(null); setBootstrapError(null) }} />
}

function LoginPage({ error, onAuthenticated, onEnterDemo }: { error: string | null; onAuthenticated: (identity: AdminIdentity) => void; onEnterDemo: () => void }): ReactNode {
  const [remembered] = useState(readRememberedCredentials)
  const [account, setAccount] = useState(remembered.account)
  const [password, setPassword] = useState(remembered.password)
  const [rememberPassword, setRememberPassword] = useState(Boolean(remembered.account && remembered.password))
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState(error)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (account.trim().length < 6 || account.trim().length > 20 || password.length < 6 || password.length > 20) {
      setMessage('账号和密码均需为 6-20 个字符')
      return
    }
    setSubmitting(true)
    setMessage(null)
    try {
      if (adminWebConfig.demoMode) onEnterDemo()
      else onAuthenticated((await adminApi.login(account.trim(), password)).identity)
      if (rememberPassword) localStorage.setItem(rememberedCredentialsKey, JSON.stringify({ account: account.trim(), password }))
      else localStorage.removeItem(rememberedCredentialsKey)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '管理员登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  return <AuthFrame title="管理员登录" detail="使用管理账号继续。">
    <form className="auth-form" onSubmit={submit}>
      <label>账号<input autoComplete="username" value={account} onChange={(event) => setAccount(event.target.value)} required minLength={6} maxLength={20} /></label>
      <label>密码<input autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={6} maxLength={20} type="password" /></label>
      <label className="remember-password"><input checked={rememberPassword} onChange={(event) => setRememberPassword(event.target.checked)} type="checkbox" /><span>记住账号和密码</span></label>
      {message && <p className="auth-error" role="alert">{message}</p>}
      <button className="primary auth-submit" disabled={submitting} type="submit"><ShieldCheck size={16} />{submitting ? '正在登录' : '登录'}</button>
    </form>
  </AuthFrame>
}

function AuthFrame({ title, detail, children }: { title: string; detail: string; children?: ReactNode }): ReactNode {
  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span><Fish size={18} /></span><strong>闲鱼数据台</strong></div><div className="auth-copy"><h1>{title}</h1><p>{detail}</p></div>{children}</section></main>
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
  const [drawer, setDrawer] = useState<Row | null>(null)
  const resource = active === 'overview' || active === 'settings' ? null : active
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
    const load = adminWebConfig.demoMode ? Promise.resolve(resource === 'users' ? normalizeAdminRows(resource, demoPage(resource, request) as CursorPage<Record<string, unknown>>) : demoPage(resource, request)) : adminApi.list<Record<string, unknown>>(resource, request).then((result) => normalizeAdminRows(resource, result))
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
  }, [cursor, limit, query, refreshVersion, resetCursor, resource, sort, status])

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
      <div className="brand"><span><Fish size={18} /></span>{!collapsed && <strong>闲鱼数据台</strong>}</div>
      <nav>{pages.map((item) => <button key={item.key} className={active === item.key ? 'active' : ''} onClick={() => switchPage(item.key)} title={collapsed ? item.label : undefined}><item.icon size={18} /><span>{item.label}</span></button>)}</nav>
      <div className="side-foot"><div className="side-account"><span>管</span>{!collapsed && <div><strong>{identity.role ?? '管理员'}</strong><small>{identity.id}</small></div>}</div><button className="collapse-button" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开导航' : '收起导航'}>{collapsed ? <PanelLeft size={17} /> : <PanelLeftClose size={17} />}</button></div>
    </aside>
    {mobileOpen && <button className="backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
    <section className="main"><header className="workspace-header"><button className="mobile-menu" title="打开导航" onClick={() => setMobileOpen(true)}><Menu size={18} /></button><div className="header-tools"><span>{identity.role ?? '管理员'}</span><button className="header-logout" title="退出登录" onClick={onLogout}><LogOut size={17} /></button></div></header><main className="content">{active === 'overview' ? <Overview onNavigate={switchPage} /> : active === 'settings' ? <SettingsCenterLive /> : <List resource={resource!} view={copy[resource!]} page={page} cursorIndex={cursorIndex} query={query} status={status} sort={sort} limit={limit} loading={loading} failure={failure} notice={notice} onQuery={(value) => changeFilter(() => setQuery(value))} onStatus={(value) => changeFilter(() => setStatus(value))} onSort={(value) => changeFilter(() => setSort(value))} onLimit={(value) => changeFilter(() => setLimit(value))} onPrev={() => setCursorIndex((index) => Math.max(0, index - 1))} onNext={moveNext} onRefresh={refresh} onOpen={setDrawer} />}</main></section>
    {drawer && <DetailModal row={drawer} onClose={() => setDrawer(null)} onToggleUser={async (enabled) => { if (adminWebConfig.demoMode) { setDrawer({ ...drawer, enabled, status: enabled ? '正常' : '待处理' }); return }; await adminApi.updateUserStatus(drawer.userId ?? drawer.id, enabled); setDrawer({ ...drawer, enabled, status: enabled ? '正常' : '待处理' }); setRefreshVersion((value) => value + 1) }} onAdjustPoints={async (delta) => { if (adminWebConfig.demoMode) { setDrawer({ ...drawer, points: (drawer.points ?? 0) + delta, metric: `${(drawer.points ?? 0) + delta} 积分 · ${drawer.metric.split(' · ').slice(1).join(' · ')}` }); return }; const result = await adminApi.adjustUserPoints(drawer.userId ?? drawer.id, delta); setDrawer({ ...drawer, points: result.points, metric: `${result.points} 积分 · ${drawer.metric.split(' · ').slice(1).join(' · ')}` }); setRefreshVersion((value) => value + 1) }} />}
  </div>
}

function Overview({ onNavigate }: { onNavigate: (page: Page) => void }): ReactNode {
  const stats = [['活跃用户', '1,024', '过去 24 小时 +86', Users, 'blue'], ['在线采集器', '1,746', '设备健康 98.6%', Activity, 'mint'], ['待处理批次', '21', '失败重试 3', Boxes, 'amber'], ['洞察任务', '87', '平均等待 1.8 分钟', Bot, 'rose']] as const
  return <><div className="heading"><div><h1>实时概览</h1><p>市场数据与待处理事项。</p></div><div className="heading-actions"><button className="secondary" onClick={() => onNavigate('users')}><Users size={16} />用户管理</button><button className="primary" onClick={() => onNavigate('uploads')}><Boxes size={16} />上传记录</button></div></div><section className="stats">{stats.map(([label, value, note, Icon, tone]) => <article key={label}><div className={tone}><Icon size={20} /></div><section><span>{label}</span><strong>{value}</strong><small>{note}</small></section></article>)}</section><section className="grid"><article className="panel wide"><div className="panel-head"><div><h2>待处理事项</h2><p>需要跟进的当前记录</p></div><button onClick={() => onNavigate('audit')}>查看记录 <ChevronRight size={15} /></button></div>{['3 个上传批次等待复核', '1 条设备解绑申请待处理', 'AI 竞品分析等待超过 2 分钟'].map((item, index) => <button className="feed" key={item} onClick={() => onNavigate(index === 0 ? 'uploads' : index === 1 ? 'audit' : 'ai')}><b className={`dot d${index}`} /><div><strong>{item}</strong><small>今天 {10 + index}:2{index}</small></div><ChevronRight size={16} /></button>)}</article><article className="panel"><div className="panel-head"><div><h2>数据质量</h2><p>公开市场实体</p></div><button onClick={() => onNavigate('quality')}>详情</button></div><div className="numbers"><div><span>字段完整度</span><strong>98.6%</strong></div><div><span>去重命中率</span><strong>93.4%</strong></div><div><span>异常样本</span><strong>12</strong></div></div></article><article className="panel"><div className="panel-head"><div><h2>服务状态</h2><p>当前处理情况</p></div><button onClick={() => onNavigate('capacity')}>查看</button></div><div className="numbers"><div><span>数据处理</span><strong>4.2%</strong></div><div><span>媒体空间</span><strong>18.7%</strong></div><div><span>数据更新</span><strong>55/s</strong></div></div></article></section></>
}

function List(props: { resource: AdminResource; view: { title: string; description: string; columns: [string, string, string, string] }; page: CursorPage<Row> | null; cursorIndex: number; query: string; status: string; sort: SortKey; limit: 20 | 50 | 100; loading: boolean; failure: string | null; notice: string | null; onQuery: (value: string) => void; onStatus: (value: string) => void; onSort: (value: SortKey) => void; onLimit: (value: 20 | 50 | 100) => void; onPrev: () => void; onNext: () => void; onRefresh: () => void; onOpen: (row: Row) => void }): ReactNode {
  const { view, page, cursorIndex, query, status, sort, limit, loading, failure, notice } = props
  const rows = page?.items ?? []
  return <>
    <div className="heading"><div><h1>{view.title}</h1><p>{view.description}</p></div><button className="primary" onClick={props.onRefresh}><RefreshCw className={loading ? 'spin' : ''} size={16} />刷新列表</button></div>
    <section className="filters"><label><Search size={16} /><input value={query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索当前范围" /></label><select aria-label="状态" value={status} onChange={(event) => props.onStatus(event.target.value)}><option value="">全部状态</option><option>正常</option><option>关注</option><option>待处理</option></select><select aria-label="排序" value={sort} onChange={(event) => props.onSort(event.target.value as SortKey)}><option value="updated_at">最近更新</option><option value="status">状态优先</option><option value="title">名称</option></select><span /><button className="icon" title="刷新当前页" onClick={props.onRefresh}><RefreshCw className={loading ? 'spin' : ''} size={17} /></button></section>
    <section className="table-panel"><div className="summary"><strong>{page?.page.total ?? 0}</strong><span> 条符合当前筛选的记录</span></div>{notice && <p className="table-notice" role="status">{notice}</p>}{failure ? <State title="列表加载失败" text={failure} onRetry={props.onRefresh} /> : loading && !page ? <State title="正在加载数据" text="请稍候。" /> : rows.length === 0 ? <State title="没有匹配的数据" text="调整筛选条件后重试。" /> : <div className="table-wrap"><table><thead><tr>{view.columns.map((column) => <th key={column}>{column}</th>)}<th aria-label="详情" /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><em>{row.tag}</em><strong>{row.title}</strong><small>{row.detail}</small></td><td>{row.metric}</td><td>{row.updatedAt}</td><td><b className={row.status === '正常' ? 'ok' : row.status === '关注' ? 'watch' : 'pending'}>{row.status}</b></td><td><button className="row-icon" title="查看详情" onClick={() => props.onOpen(row)}><MoreHorizontal size={18} /></button></td></tr>)}</tbody></table></div>}<Pager page={page} cursorIndex={cursorIndex} limit={limit} loading={loading} onPrev={props.onPrev} onNext={props.onNext} onLimit={props.onLimit} /></section>
  </>
}

function State({ title, text, onRetry }: { title: string; text: string; onRetry?: () => void }): ReactNode { return <div className="state"><Activity size={27} /><strong>{title}</strong><p>{text}</p>{onRetry && <button className="primary small" onClick={onRetry}><RefreshCw size={15} />重试</button>}</div> }
function Pager({ page, cursorIndex, limit, loading, onPrev, onNext, onLimit }: { page: CursorPage<Row> | null; cursorIndex: number; limit: 20 | 50 | 100; loading: boolean; onPrev: () => void; onNext: () => void; onLimit: (value: 20 | 50 | 100) => void }): ReactNode { const total = page?.page.total ?? 0; return <footer className="pager"><span>{total === 0 ? '无记录' : `第 ${cursorIndex + 1} 页 · 共 ${total} 条`}</span><select aria-label="每页条数" value={limit} onChange={(event) => onLimit(Number(event.target.value) as 20 | 50 | 100)}><option value={20}>20 / 页</option><option value={50}>50 / 页</option><option value={100}>100 / 页</option></select><button disabled={cursorIndex === 0 || loading} onClick={onPrev} title="上一页"><ChevronLeft size={17} /></button><button disabled={!page?.page.hasMore || loading} onClick={onNext} title="下一页"><ChevronRight size={17} /></button></footer> }
function DetailModal({ row, onClose, onToggleUser, onAdjustPoints }: { row: Row; onClose: () => void; onToggleUser?: (enabled: boolean) => Promise<void>; onAdjustPoints?: (delta: number) => Promise<void> }): ReactNode {
  const [delta, setDelta] = useState('')
  const [busy, setBusy] = useState(false)
  const submitPoints = async () => { const value = Number(delta); if (!Number.isInteger(value) || value === 0 || busy || !onAdjustPoints) return; setBusy(true); try { await onAdjustPoints(value); setDelta('') } finally { setBusy(false) } }
  const isUser = Boolean(onToggleUser)
  return <div className="modal-overlay" role="presentation"><section className="modal-content" role="dialog" aria-modal="true" aria-labelledby="detail-modal-title"><header className="modal-header"><div><span className="modal-kicker">详情</span><h2 id="detail-modal-title">{isUser ? '用户数据' : '运营详情'}</h2></div><button className="icon" title="关闭" onClick={onClose}><X size={19} /></button></header><main className="modal-body"><em>{row.tag}</em><h3>{row.title}</h3><p>{row.detail}</p><dl><div><dt>当前信息</dt><dd>{row.metric}</dd></div><div><dt>最近更新</dt><dd>{row.updatedAt}</dd></div><div><dt>状态</dt><dd>{row.enabled === false ? '停用' : row.status}</dd></div>{isUser && <><div><dt>用户 ID</dt><dd>{row.userId ?? row.id}</dd></div><div><dt>积分</dt><dd>{row.points ?? 0}</dd></div><div><dt>用户数据</dt><dd>监控 {row.userData?.monitorCount ?? 0} · 商家监控 {row.userData?.sellerMonitorCount ?? 0} · 设备 {row.userData?.deviceCount ?? 0} · 上传批次 {row.userData?.uploadBatchCount ?? 0}</dd></div></>}</dl>{isUser && <section className="user-actions"><label>调整积分<input type="number" value={delta} onChange={(event) => setDelta(event.target.value)} placeholder="正数增加，负数扣减" /></label><button className="secondary" disabled={busy || !delta || Number(delta) === 0} onClick={() => void submitPoints()}>保存调整</button><button className="secondary" disabled={busy} onClick={() => void onToggleUser?.(row.enabled === false)}>{row.enabled === false ? '启用' : '停用'}</button></section>}</main><footer className="modal-footer"><button onClick={onClose}>关闭</button></footer></section></div> }

function SettingsCenter(): ReactNode {
  const [tab, setTab] = useState<'model' | 'announcements'>('model')
  return <><div className="heading"><div><h1>设置中心</h1><p>管理模型能力与公告内容。</p></div></div><section className="settings-panel"><div className="settings-tabs" role="tablist"><button className={tab === 'model' ? 'active' : ''} role="tab" aria-selected={tab === 'model'} onClick={() => setTab('model')}>模型配置</button><button className={tab === 'announcements' ? 'active' : ''} role="tab" aria-selected={tab === 'announcements'} onClick={() => setTab('announcements')}>公告管理</button></div>{tab === 'model' ? <div className="settings-content"><div className="settings-section-title"><div><h2>模型配置</h2><p>当前配置仅供管理员查看。</p></div><span className="settings-badge">待接入</span></div><div className="settings-fields"><label>服务商<select disabled><option>尚未配置</option></select></label><label>模型名称<input disabled placeholder="尚未配置" /></label><label>调用额度<input disabled placeholder="尚未配置" /></label></div></div> : <div className="settings-content"><div className="settings-section-title"><div><h2>公告管理</h2><p>公告将在用户登录后展示。</p></div><button className="secondary" disabled>新建公告</button></div><div className="settings-empty"><span className="settings-empty-icon" aria-hidden="true"><Megaphone size={22} /></span><strong>暂无公告</strong><span>公告编辑能力待接入后开放。</span></div></div>}</section></>
}

function SettingsCenterLive(): ReactNode {
  const [tab, setTab] = useState<'model' | 'announcements'>('model')
  const [form, setForm] = useState({ providerCode: 'openai-compatible', modelReference: '', baseUrl: '', apiKey: '', stream: true, reasoningLevel: 'standard' })
  const [providerId, setProviderId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState({ title: '', body: '', enabled: true })
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!adminWebConfig.demoMode) void adminApi.providers().then((items) => { const item = items[0]; if (item) { const settings = item.settings && typeof item.settings === 'object' ? item.settings as { reasoningLevel?: string } : {}; setProviderId(item.id); setForm((current) => ({ ...current, providerCode: item.providerCode, modelReference: item.modelReference, baseUrl: item.baseUrl, stream: item.stream, reasoningLevel: settings.reasoningLevel ?? (item.reasoning ? 'standard' : 'off') })) } }).catch(() => undefined) }, [])
  const saveProvider = async () => {
    setBusy(true); setMessage(null)
    try {
      if (adminWebConfig.demoMode) setMessage('模型配置已保存')
      else { const input = { modelReference: form.modelReference.trim(), baseUrl: form.baseUrl.trim(), ...(form.apiKey ? { apiKey: form.apiKey } : {}), stream: form.stream, reasoning: form.reasoningLevel !== 'off', settings: { reasoningLevel: form.reasoningLevel }, status: 'active' as const }; const saved = providerId ? await adminApi.updateProvider(providerId, input) : await adminApi.createProvider({ providerCode: form.providerCode.trim(), ...input }); setProviderId(saved.id); setForm((current) => ({ ...current, apiKey: '' })); setMessage('模型配置已保存') }
    } catch (error) { setMessage(error instanceof Error ? error.message : '模型配置保存失败') } finally { setBusy(false) }
  }
  const saveAnnouncement = async () => {
    setBusy(true); setMessage(null)
    try { if (adminWebConfig.demoMode) setMessage('公告已保存'); else { await adminApi.createAnnouncement(announcement); setAnnouncement({ title: '', body: '', enabled: true }); setMessage('公告已保存') } } catch (error) { setMessage(error instanceof Error ? error.message : '公告保存失败') } finally { setBusy(false) }
  }
  const testProvider = async () => { if (!providerId) { setMessage('请先保存配置'); return }; setBusy(true); try { const models = await adminApi.fetchProviderModels(providerId); setMessage(`连接成功，获取到 ${models.length} 个模型`) } catch (error) { setMessage(error instanceof Error ? error.message : '连接失败') } finally { setBusy(false) } }
  return <><div className="heading"><div><h1>设置中心</h1><p>管理模型能力与公告内容。</p></div></div><section className="settings-panel"><div className="settings-tabs" role="tablist"><button className={tab === 'model' ? 'active' : ''} role="tab" aria-selected={tab === 'model'} onClick={() => setTab('model')}>模型配置</button><button className={tab === 'announcements' ? 'active' : ''} role="tab" aria-selected={tab === 'announcements'} onClick={() => setTab('announcements')}>公告管理</button></div>{message && <p className="table-notice" role="status">{message}</p>}{tab === 'model' ? <div className="settings-content"><div className="settings-section-title"><div><h2>OpenAI 兼容模型</h2><p>密钥只写入服务端加密字段，列表不会返回密钥。</p></div></div><div className="settings-fields"><label>服务商<input value={form.providerCode} onChange={(event) => setForm({ ...form, providerCode: event.target.value })} /></label><label>接口地址<input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label><label>模型名称<input value={form.modelReference} onChange={(event) => setForm({ ...form, modelReference: event.target.value })} placeholder="gpt-4o-mini" /></label><label>API Key<input type="password" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} placeholder="留空表示不更换" /></label><label className="remember-password"><input type="checkbox" checked={form.stream} onChange={(event) => setForm({ ...form, stream: event.target.checked })} /><span>支持流式输入</span></label><label>推理等级<select value={form.reasoningLevel} onChange={(event) => setForm({ ...form, reasoningLevel: event.target.value })}><option value="off">关闭</option><option value="standard">标准</option><option value="deep">深度</option></select></label></div><div className="settings-actions"><button className="primary" onClick={() => void saveProvider()} disabled={busy}>保存配置</button><button className="secondary" onClick={() => void testProvider()} disabled={busy}>测试链接并获取模型</button></div></div> : <div className="settings-content"><div className="settings-section-title"><div><h2>公告管理</h2><p>公告将在用户登录后展示。</p></div></div><div className="settings-fields"><label>公告标题<input value={announcement.title} onChange={(event) => setAnnouncement({ ...announcement, title: event.target.value })} maxLength={160} /></label><label>公告内容<textarea value={announcement.body} onChange={(event) => setAnnouncement({ ...announcement, body: event.target.value })} maxLength={8000} rows={8} /></label><label className="remember-password"><input type="checkbox" checked={announcement.enabled} onChange={(event) => setAnnouncement({ ...announcement, enabled: event.target.checked })} /><span>立即展示</span></label></div><div className="settings-actions"><button className="primary" onClick={() => void saveAnnouncement()} disabled={busy || !announcement.title.trim() || !announcement.body.trim()}>保存公告</button></div></div>}</section></>
}
