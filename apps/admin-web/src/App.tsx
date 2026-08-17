import { useMemo, useState, type ReactNode } from 'react'
import {
  Activity, Bot, Boxes, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Database,
  FileCheck2, Gauge, Menu, MoreHorizontal, PackageSearch, RefreshCw, Search, Settings,
  ShieldCheck, SlidersHorizontal, Users, Wallet, X
} from 'lucide-react'

type Page = 'overview' | 'users' | 'billing' | 'market' | 'quality' | 'uploads' | 'ai' | 'capacity' | 'audit'
type ListPage = Exclude<Page, 'overview'>
type Row = { id: string; title: string; detail: string; metric: string; updatedAt: string; status: '正常' | '关注' | '待处理'; tag: string }

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

const copy: Record<ListPage, { title: string; description: string; action: string; columns: [string, string, string, string] }> = {
  users: { title: '用户与设备', description: '查看账号状态、已绑定设备与会话风险。', action: '添加用户', columns: ['主体', '设备或套餐', '最近活动', '状态'] },
  billing: { title: '套餐、订单与用量', description: '套餐、订单与不可变用量账本的运营视图。', action: '创建套餐', columns: ['账务对象', '金额或额度', '记账时间', '状态'] },
  market: { title: '市场商品与卖家', description: '按公开市场实体检查规范化数据与关联关系。', action: '查看规则', columns: ['市场实体', '当前信号', '最近更新', '状态'] },
  quality: { title: '类目与数据质量', description: '监控类目覆盖、字段完整度与异常样本。', action: '新建规则', columns: ['质量规则', '覆盖范围', '最近检查', '状态'] },
  uploads: { title: '上传批次与事件', description: '仅运营侧可见的批次、去重和失败处理记录。', action: '导出当前页', columns: ['批次或事件', '处理结果', '发生时间', '状态'] },
  ai: { title: 'AI 配置与任务', description: '管理已发布能力、任务队列与版本结果。', action: '发布配置', columns: ['配置或任务', '范围或版本', '最近执行', '状态'] },
  capacity: { title: '队列、存储与容量', description: '检查服务端队列、水位、存储与容量合同。', action: '查看容量合同', columns: ['资源', '当前水位', '最近检查', '状态'] },
  audit: { title: '审计与系统设置', description: '追溯后台操作与安全配置的变更记录。', action: '系统设置', columns: ['审计事件', '操作者', '发生时间', '状态'] }
}

const samples: Record<ListPage, Omit<Row, 'id' | 'updatedAt'>[]> = {
  users: [{ title: 'user_1024', detail: '专业版 · 2 台设备', metric: '最近活跃 8 分钟前', status: '正常', tag: '用户' }, { title: 'collector-win-01', detail: 'user_1024 · Windows', metric: '设备密钥有效', status: '正常', tag: '设备' }, { title: 'user_2048', detail: '基础版 · 待复核', metric: '设备绑定请求', status: '关注', tag: '用户' }],
  billing: [{ title: 'ORD-20260817-001', detail: '专业版月付 · user_1024', metric: '¥99.00', status: '正常', tag: '订单' }, { title: 'LED-000203', detail: 'AI 分析扣费 · 幂等命中', metric: '1 次调用', status: '正常', tag: '账本' }, { title: '权益调整待审核', detail: '人工授权', metric: '增加 1 个设备位', status: '待处理', tag: '权益' }],
  market: [{ title: 'MacBook Air M2 16G 512G', detail: '杭州 · 平台商品 ID 1071216800602', metric: '价格下降 6.5%', status: '关注', tag: '商品' }, { title: '海风数码回收店', detail: '杭州 · 1,284 个公开商品', metric: '今天上新 6 件', status: '正常', tag: '卖家' }, { title: 'Sony A7M4 机身', detail: '上海 · 公开快照', metric: '最近 38 分钟', status: '正常', tag: '商品' }],
  quality: [{ title: '数码类目字段完整度', detail: '手机 / 电脑 / 相机', metric: '98.6%', status: '正常', tag: '规则' }, { title: '价格异常样本', detail: '笔记本电脑 · 全国', metric: '12 条待复核', status: '关注', tag: '异常' }, { title: '图片引用可用性', detail: '过去 24 小时', metric: '99.2%', status: '正常', tag: '媒体' }],
  uploads: [{ title: 'UPL-20260817-00821', detail: 'collector-win-01 · 250 条', metric: '去重 239，新增 11', status: '正常', tag: '批次' }, { title: '价格下调事件', detail: '商品版本比较', metric: '已写入事件链', status: '正常', tag: '事件' }, { title: 'UPL-20260817-00820', detail: '断网恢复补传', metric: '等待复核', status: '待处理', tag: '批次' }],
  ai: [{ title: '竞品价格带分析', detail: '版本 2026.08.17-1', metric: '已发布', status: '正常', tag: '能力' }, { title: 'AI-TSK-00812', detail: '轻薄本市场周报', metric: '队列等待 2 分钟', status: '关注', tag: '任务' }, { title: '同款聚类规则', detail: '结构化结果', metric: '昨日执行成功', status: '正常', tag: '配置' }],
  capacity: [{ title: '采集事件队列', detail: 'consumer-market', metric: '水位 4.2%', status: '正常', tag: '队列' }, { title: '对象存储', detail: '公开图片媒体', metric: '容量 18.7%', status: '正常', tag: '存储' }, { title: 'PostgreSQL 分区', detail: 'market_item_versions', metric: '今日写入 468k', status: '正常', tag: '数据库' }],
  audit: [{ title: '套餐策略已发布', detail: 'owner · policy_20260817', metric: '请求 A7F1', status: '正常', tag: '审计' }, { title: '设备已解绑', detail: 'operator · collector-win-03', metric: '请求 3CD8', status: '关注', tag: '审计' }, { title: 'MFA 状态更新', detail: 'admin-owner', metric: '请求 E128', status: '正常', tag: '安全' }]
}

function rowsFor(page: ListPage): Row[] {
  return Array.from({ length: 37 }, (_, index) => {
    const base = samples[page][index % samples[page].length]
    return { ...base, id: `${page}-${index + 1}`, title: index < 3 ? base.title : `${base.title} · ${index + 1}`, updatedAt: `今天 ${String(9 + index % 10).padStart(2, '0')}:${String(index * 9 % 60).padStart(2, '0')}` }
  })
}

export default function App(): ReactNode {
  const [active, setActive] = useState<Page>('overview')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [state, setState] = useState('全部状态')
  const [sort, setSort] = useState('最近更新')
  const [offset, setOffset] = useState(0)
  const [limit, setLimit] = useState(20)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [drawer, setDrawer] = useState<Row | null>(null)
  const current = pages.find((page) => page.key === active)!
  const list = active === 'overview' ? null : active
  const filtered = useMemo(() => list ? rowsFor(list).filter((row) => (state === '全部状态' || row.status === state) && `${row.title}${row.detail}${row.metric}`.toLowerCase().includes(query.toLowerCase())) : [], [list, state, query])
  const pageRows = filtered.slice(offset, offset + limit)
  const switchPage = (page: Page) => { setActive(page); setOffset(0); setQuery(''); setState('全部状态'); setMobileOpen(false) }
  const refresh = () => { setLoading(true); setFailed(false); window.setTimeout(() => setLoading(false), 420) }
  return <div className={`app ${collapsed ? 'collapsed' : ''}`}>
    <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}><div className="brand"><span>管</span>{!collapsed && <strong>闲鱼数据台</strong>}</div><nav>{pages.map((page, index) => <div key={page.key}>{page.group && page.group !== pages[index - 1]?.group && !collapsed && <p>{page.group}</p>}<button className={active === page.key ? 'active' : ''} onClick={() => switchPage(page.key)} title={collapsed ? page.label : undefined}><page.icon size={18} /><span>{page.label}</span></button></div>)}</nav><div className="side-foot"><button onClick={() => setCollapsed(!collapsed)} title="收起导航"><Menu size={18} /><span>{collapsed ? '展开导航' : '收起导航'}</span></button><div className="admin-avatar"><b>管</b>{!collapsed && <div><strong>平台运营</strong><small>Owner · MFA 已验证</small></div>}<ChevronDown size={14} /></div></div></aside>
    {mobileOpen && <button className="backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
    <section className="main"><header><button className="mobile-menu" title="打开导航" onClick={() => setMobileOpen(true)}><Menu size={18} /></button><div className="crumb"><span>Admin 工作台</span><ChevronRight size={14} /><strong>{current.label}</strong></div><div className="right"><span>独立 Admin 演示数据</span><button title="系统状态" className="icon"><Activity size={18} /></button><button title="审计中心" className="icon" onClick={() => switchPage('audit')}><ShieldCheck size={18} /></button></div></header><main className="content">{active === 'overview' ? <Overview onNavigate={switchPage} /> : <List view={copy[list!]} rows={pageRows} total={filtered.length} offset={offset} limit={limit} query={query} state={state} sort={sort} loading={loading} failed={failed} onQuery={(value) => { setQuery(value); setOffset(0) }} onState={(value) => { setState(value); setOffset(0) }} onSort={(value) => { setSort(value); setOffset(0) }} onLimit={(value) => { setLimit(value); setOffset(0) }} onPrev={() => setOffset(Math.max(0, offset - limit))} onNext={() => setOffset(offset + limit)} onRefresh={refresh} onFailure={() => { setLoading(false); setFailed(true) }} onOpen={setDrawer} />}</main></section>{drawer && <Drawer row={drawer} onClose={() => setDrawer(null)} />}</div>
}

function Overview({ onNavigate }: { onNavigate: (page: Page) => void }): ReactNode {
  const stats = [['活跃用户', '1,024', '过去 24 小时 +86', Users, 'blue'], ['在线采集器', '1,746', '设备健康 98.6%', Activity, 'mint'], ['待处理批次', '21', '失败重试 3', Boxes, 'amber'], ['AI 任务队列', '87', '平均等待 1.8 分钟', Bot, 'rose']] as const
  return <><div className="heading"><div><i>OPERATIONS</i><h1>运营概览</h1><p>用户、市场数据与基础设施的运营总览。</p></div><button className="primary" onClick={() => onNavigate('users')}><Users size={16} />用户与设备</button></div><section className="stats">{stats.map(([label, value, note, Icon, tone]) => <article key={label}><div className={tone}><Icon size={20} /></div><section><span>{label}</span><strong>{value}</strong><small>{note}</small></section></article>)}</section><section className="grid"><article className="panel wide"><div className="panel-head"><div><h2>运营待办</h2><p>需要人工处理的当前事项</p></div><button onClick={() => onNavigate('audit')}>查看审计 <ChevronRight size={15} /></button></div>{['3 个上传批次等待复核', '1 条设备解绑申请待处理', 'AI 竞品分析队列等待超过 2 分钟'].map((item, index) => <button className="feed" key={item} onClick={() => onNavigate(index === 0 ? 'uploads' : index === 1 ? 'users' : 'ai')}><b className={`dot d${index}`} /><div><strong>{item}</strong><small>今天 {10 + index}:2{index} · 系统运营</small></div><ChevronRight size={16} /></button>)}</article><article className="panel"><div className="panel-head"><div><h2>数据质量</h2><p>公开市场实体</p></div><button onClick={() => onNavigate('quality')}>详情</button></div><div className="numbers"><div><span>字段完整度</span><strong>98.6%</strong></div><div><span>去重命中率</span><strong>93.4%</strong></div><div><span>异常样本</span><strong>12</strong></div></div></article><article className="panel"><div className="panel-head"><div><h2>容量水位</h2><p>阶段 0 容量合同</p></div><button onClick={() => onNavigate('capacity')}>查看</button></div><div className="numbers"><div><span>事件队列</span><strong>4.2%</strong></div><div><span>对象存储</span><strong>18.7%</strong></div><div><span>数据库写入</span><strong>55/s</strong></div></div></article></section></>
}

function List(props: { view: { title: string; description: string; action: string; columns: [string, string, string, string] }; rows: Row[]; total: number; offset: number; limit: number; query: string; state: string; sort: string; loading: boolean; failed: boolean; onQuery: (value: string) => void; onState: (value: string) => void; onSort: (value: string) => void; onLimit: (value: number) => void; onPrev: () => void; onNext: () => void; onRefresh: () => void; onFailure: () => void; onOpen: (row: Row) => void }): ReactNode {
  const { view, rows, total, offset, limit, query, state, sort, loading, failed } = props
  return <><div className="heading"><div><i>ADMIN</i><h1>{view.title}</h1><p>{view.description}</p></div><button className="primary"><SlidersHorizontal size={16} />{view.action}</button></div><section className="filters"><label><Search size={16} /><input value={query} onChange={(event) => props.onQuery(event.target.value)} placeholder="搜索当前范围" /></label><select value={state} onChange={(event) => props.onState(event.target.value)}><option>全部状态</option><option>正常</option><option>关注</option><option>待处理</option></select><select value={sort} onChange={(event) => props.onSort(event.target.value)}><option>最近更新</option><option>状态优先</option></select><span /><button className="icon" title="刷新当前页" onClick={props.onRefresh}><RefreshCw className={loading ? 'spin' : ''} size={17} /></button></section><section className="table-panel"><div className="summary"><strong>{total}</strong><span> 条符合当前筛选的记录 · 服务端 cursor 接入前使用本地夹具</span><button onClick={props.onFailure}>演示失败态</button></div>{failed ? <State title="列表加载失败" text="保留当前筛选条件后可重试。" onRetry={props.onRefresh} /> : loading ? <State title="正在加载当前窗口" text="筛选、排序和 cursor 保持不变。" /> : rows.length === 0 ? <State title="没有匹配的数据" text="调整筛选条件后重试。" /> : <div className="table-wrap"><table><thead><tr>{view.columns.map((column) => <th key={column}>{column}</th>)}<th aria-label="详情" /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><em>{row.tag}</em><strong>{row.title}</strong><small>{row.detail}</small></td><td>{row.metric}</td><td>{row.updatedAt}</td><td><b className={row.status === '正常' ? 'ok' : row.status === '关注' ? 'watch' : 'pending'}>{row.status}</b></td><td><button className="row-icon" title="查看详情" onClick={() => props.onOpen(row)}><MoreHorizontal size={18} /></button></td></tr>)}</tbody></table></div>}<Pager total={total} offset={offset} limit={limit} onPrev={props.onPrev} onNext={props.onNext} onLimit={props.onLimit} /></section></>
}

function State({ title, text, onRetry }: { title: string; text: string; onRetry?: () => void }): ReactNode { return <div className="state"><Activity size={27} /><strong>{title}</strong><p>{text}</p>{onRetry && <button className="primary small" onClick={onRetry}><RefreshCw size={15} />重试</button>}</div> }
function Pager({ total, offset, limit, onPrev, onNext, onLimit }: { total: number; offset: number; limit: number; onPrev: () => void; onNext: () => void; onLimit: (value: number) => void }): ReactNode { const start = total ? offset + 1 : 0; const end = Math.min(offset + limit, total); return <footer className="pager"><span>{start}-{end} / {total}</span><select aria-label="每页条数" value={limit} onChange={(event) => onLimit(Number(event.target.value))}><option value={20}>20 / 页</option><option value={50}>50 / 页</option><option value={100}>100 / 页</option></select><button disabled={offset === 0} onClick={onPrev} title="上一页"><ChevronLeft size={17} /></button><button disabled={offset + limit >= total} onClick={onNext} title="下一页"><ChevronRight size={17} /></button></footer> }
function Drawer({ row, onClose }: { row: Row; onClose: () => void }): ReactNode { return <><button className="drawer-cover" aria-label="关闭详情" onClick={onClose} /><aside className="drawer"><header><div><i>DETAIL</i><h2>运营详情</h2></div><button className="icon" title="关闭" onClick={onClose}><X size={19} /></button></header><main><em>{row.tag}</em><h3>{row.title}</h3><p>{row.detail}</p><dl><div><dt>当前信息</dt><dd>{row.metric}</dd></div><div><dt>最近更新</dt><dd>{row.updatedAt}</dd></div><div><dt>状态</dt><dd>{row.status}</dd></div></dl><section><ShieldCheck size={18} /><span>详情字段将在独立 Admin API 接入后按权限按需获取。</span></section></main><footer><button onClick={onClose}>关闭</button></footer></aside></> }
