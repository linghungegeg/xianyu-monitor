import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { BellRing, Chrome, CircleAlert, Clock3, ExternalLink, LoaderCircle, Pause, Play, Plus, Search, Trash2 } from 'lucide-react'
import type { MonitorStatus, MonitorTask, NewTask, ScanLog, SearchItem } from '../../shared/types'

const defaultStatus: MonitorStatus = { chrome: 'idle', message: '正在读取本地状态', nextScanAt: null }

function formatTime(value: string | null): string {
  if (!value) return '--'
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

function formatPrice(value: number | null): string {
  return value === null ? '价格待解析' : `¥ ${value.toLocaleString('zh-CN')}`
}

export default function App(): JSX.Element {
  const [tasks, setTasks] = useState<MonitorTask[]>([])
  const [items, setItems] = useState<SearchItem[]>([])
  const [logs, setLogs] = useState<ScanLog[]>([])
  const [status, setStatus] = useState<MonitorStatus>(defaultStatus)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [region, setRegion] = useState('')
  const [interval, setIntervalValue] = useState('30')
  const [busy, setBusy] = useState(false)

  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId) ?? null, [tasks, selectedTaskId])

  const refresh = useCallback(async (): Promise<void> => {
    const [nextTasks, nextLogs, nextStatus] = await Promise.all([
      window.xianyu.tasks.list(),
      window.xianyu.logs.list(),
      window.xianyu.monitor.status()
    ])
    setTasks(nextTasks)
    setLogs(nextLogs)
    setStatus(nextStatus)
    if (!selectedTaskId && nextTasks[0]) setSelectedTaskId(nextTasks[0].id)
  }, [selectedTaskId])

  const refreshItems = useCallback(async (): Promise<void> => {
    setItems(await window.xianyu.items.list(selectedTaskId ?? undefined))
  }, [selectedTaskId])

  useEffect(() => {
    void refresh()
    const unsubscribe = window.xianyu.monitor.onStatus((nextStatus) => {
      setStatus(nextStatus)
      void refresh()
      void refreshItems()
    })
    return unsubscribe
  }, [refresh, refreshItems])

  useEffect(() => {
    void refreshItems()
  }, [refreshItems])

  const createTask = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const normalizedKeyword = keyword.trim()
    if (!normalizedKeyword) return
    const input: NewTask = {
      keyword: normalizedKeyword,
      minPrice: minPrice ? Number(minPrice) : null,
      maxPrice: maxPrice ? Number(maxPrice) : null,
      region: region.trim() || null,
      intervalMinutes: Math.max(10, Number(interval) || 30),
      enabled: true
    }
    const task = await window.xianyu.tasks.create(input)
    setKeyword('')
    setMinPrice('')
    setMaxPrice('')
    setRegion('')
    setSelectedTaskId(task.id)
    await refresh()
  }

  const scan = async (): Promise<void> => {
    if (!selectedTask) return
    setBusy(true)
    try {
      await window.xianyu.monitor.scan(selectedTask.id)
    } finally {
      setBusy(false)
      await refresh()
      await refreshItems()
    }
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">鱼</span><span>闲鱼监控</span></div>
      <button className="login-button" type="button" onClick={() => void window.xianyu.monitor.login()}>
        <Chrome size={17} /> 扫码登录
      </button>
      <div className={`connection connection-${status.chrome}`}>
        <span className="status-dot" />
        <div><strong>{status.chrome === 'running' ? '正在扫描' : status.chrome === 'login-required' ? '需要登录' : status.chrome === 'error' ? '浏览器异常' : '监控待命'}</strong><small>{status.message}</small></div>
      </div>

      <section className="task-section">
        <div className="section-title"><span>监控任务</span><span>{tasks.length}</span></div>
        <div className="task-list">
          {tasks.length === 0 && <p className="empty-note">创建任务后，商品会在这里持续更新。</p>}
          {tasks.map((task) => <button key={task.id} type="button" className={`task-row ${task.id === selectedTaskId ? 'selected' : ''}`} onClick={() => setSelectedTaskId(task.id)}>
            <span className={`task-dot ${task.enabled ? '' : 'paused'}`} /><span>{task.keyword}</span><small>{task.enabled ? `${task.intervalMinutes} 分钟` : '已暂停'}</small>
          </button>)}
        </div>
      </section>

      <form className="task-form" onSubmit={(event) => void createTask(event)}>
        <div className="section-title"><span>新建任务</span></div>
        <label>关键词<input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="例如 MacBook Air M2" /></label>
        <div className="form-grid"><label>最低价<input inputMode="decimal" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} placeholder="不限" /></label><label>最高价<input inputMode="decimal" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} placeholder="不限" /></label></div>
        <div className="form-grid"><label>地区<input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="全国" /></label><label>间隔(分钟)<input inputMode="numeric" value={interval} onChange={(event) => setIntervalValue(event.target.value)} /></label></div>
        <button className="primary-button" type="submit"><Plus size={16} /> 添加监控</button>
      </form>
    </aside>

    <section className="workspace">
      <header className="toolbar">
        <div><p className="eyebrow">LOCAL SEARCH MONITOR</p><h1>{selectedTask ? selectedTask.keyword : '新增商品'}</h1><p className="subhead">{selectedTask ? `每 ${selectedTask.intervalMinutes} 分钟搜索一次，结果按商品 ID 本地去重。` : '选择或创建一个监控任务开始。'}</p></div>
        <div className="toolbar-actions">
          <button className="icon-button" title="打开专用 Chrome 扫码登录" type="button" onClick={() => void window.xianyu.monitor.login()}><Chrome size={18} /></button>
          <button className="scan-button" type="button" disabled={!selectedTask || busy} onClick={() => void scan()}>{busy ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}{busy ? '扫描中' : '立即扫描'}</button>
        </div>
      </header>

      <section className="results-panel">
        <div className="panel-heading"><div><h2>发现商品</h2><span>{items.length} 条本地记录</span></div>{selectedTask && <div className="task-actions"><button type="button" title={selectedTask.enabled ? '暂停监控' : '恢复监控'} onClick={() => void window.xianyu.tasks.toggle(selectedTask.id, !selectedTask.enabled).then(refresh)}>{selectedTask.enabled ? <Pause size={16} /> : <Play size={16} />}</button><button type="button" title="删除任务" onClick={() => void window.xianyu.tasks.delete(selectedTask.id).then(() => { setSelectedTaskId(null); return refresh() })}><Trash2 size={16} /></button></div>}</div>
        <div className="result-list">
          {items.length === 0 && <div className="result-empty"><BellRing size={26} /><p>还没有发现商品</p><small>扫码登录后，点击“立即扫描”验证该任务。</small></div>}
          {items.map((item) => <article className="item-row" key={`${item.taskId}-${item.itemId}`}>
            <div className="item-price">{formatPrice(item.price)}</div><div className="item-content"><h3>{item.title}</h3><div className="item-meta"><span>{item.region ?? '地区待解析'}</span>{item.publishedText && <span>{item.publishedText}</span>}{item.wantCount !== null && <span>{item.wantCount} 人想要</span>}<span>首次发现 {formatTime(item.firstSeenAt)}</span></div></div><button type="button" title="在浏览器打开商品" onClick={() => void window.xianyu.monitor.openItem(item.url)}><ExternalLink size={17} /></button>
          </article>)}
        </div>
      </section>

      <section className="log-panel">
        <div className="panel-heading"><div><h2>运行记录</h2><span>下次调度检查 {formatTime(status.nextScanAt)}</span></div><Clock3 size={18} /></div>
        <div className="log-list">{logs.length === 0 ? <p className="empty-note">尚无扫描记录。</p> : logs.map((log) => <div className={`log-row log-${log.level}`} key={log.id}><span>{log.level === 'error' ? <CircleAlert size={15} /> : <span className="log-dot" />}</span><time>{formatTime(log.createdAt)}</time><p>{log.message}</p></div>)}</div>
      </section>
    </section>
  </main>
}
