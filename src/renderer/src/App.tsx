import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react'
import { Chrome, CircleAlert, CircleCheck, KeyRound, LoaderCircle, LogIn, Pause, Play, ShieldCheck, Unplug } from 'lucide-react'
import type { LauncherLog, LauncherStatus } from '../../shared/types'

const initialStatus: LauncherStatus = {
  session: 'checking',
  browser: 'idle',
  entitled: false,
  message: '正在读取本机授权状态'
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}

function statusLabel(status: LauncherStatus): string {
  if (status.session === 'running') return '运行中'
  if (status.session === 'ready') return '待启动'
  if (status.session === 'paused') return '已暂停'
  if (status.session === 'offline') return '网络异常'
  if (status.session === 'revoked') return '授权失效'
  if (status.session === 'error') return '需要处理'
  if (status.session === 'checking') return '校验中'
  return '未登录'
}

function isSignedOut(status: LauncherStatus): boolean {
  return status.session === 'signed-out' || status.session === 'revoked' || status.session === 'error'
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<LauncherStatus>(initialStatus)
  const [logs, setLogs] = useState<LauncherLog[]>([])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const [nextStatus, nextLogs] = await Promise.all([window.xianyu.launcher.status(), window.xianyu.launcher.logs()])
    if (nextStatus) setStatus(nextStatus)
    setLogs(nextLogs)
  }, [])

  useEffect(() => {
    void refresh()
    return window.xianyu.launcher.onStatus((nextStatus) => {
      setStatus(nextStatus)
      void window.xianyu.launcher.logs().then(setLogs)
    })
  }, [refresh])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      await action()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败，请稍后重试')
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const login = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    await run(async () => window.xianyu.launcher.login(email, password))
    setPassword('')
  }

  const running = status.session === 'running'
  const canStart = status.entitled || status.session === 'offline'

  return <main className="launcher-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><ShieldCheck size={20} /></span><div><strong>闲鱼采集器</strong><small>本机采集工具</small></div></div>
      <div className={`status-chip status-${status.session}`}><span /><strong>{statusLabel(status)}</strong></div>
    </header>

    <section className="launcher-content">
      <div className="status-heading">
        <div><p className="eyebrow">采集状态</p><h1>{status.message}</h1></div>
        {status.browser === 'open' ? <span className="browser-state"><Chrome size={16} /> Chrome 已打开</span> : null}
      </div>

      {notice ? <div className="notice" role="alert"><CircleAlert size={17} /><span>{notice}</span></div> : null}

      {isSignedOut(status) ? <form className="login-panel" onSubmit={(event) => void login(event)}>
        <div className="panel-icon"><KeyRound size={22} /></div>
        <div><h2>登录并绑定设备</h2><p>使用本系统用户账号</p></div>
        <label>账号<input type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" required /></label>
        <label>密码<input type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <button className="primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}登录并绑定</button>
      </form> : <section className="control-panel">
        <div className="control-summary"><span className={`state-icon state-${status.session}`}>{status.session === 'running' ? <Play size={22} /> : <CircleCheck size={22} />}</span><div><h2>{running ? '采集器正在运行' : '设备已就绪'}</h2><p>{status.entitled ? '账号权益有效' : '正在确认账号状态'}</p></div></div>
        <div className="control-actions">
          <button className="secondary-button" type="button" disabled={busy || !status.entitled} onClick={() => void run(() => window.xianyu.launcher.openChrome())}><Chrome size={17} />打开 Chrome</button>
          {running
            ? <button className="primary-button" type="button" disabled={busy} onClick={() => void run(() => window.xianyu.launcher.pause())}><Pause size={17} />暂停采集</button>
            : <button className="primary-button" type="button" disabled={busy || !canStart} onClick={() => void run(() => window.xianyu.launcher.start())}>{busy ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}启动采集</button>}
          <button className="icon-button danger" title="解绑本机设备" type="button" disabled={busy} onClick={() => void run(() => window.xianyu.launcher.unbind())}><Unplug size={18} /></button>
        </div>
      </section>}

      <section className="logs-panel" aria-label="运行日志">
        <div className="panel-heading"><div><h2>活动记录</h2><p>最近活动</p></div><CircleCheck size={18} /></div>
        <div className="log-list">
          {logs.length === 0 ? <p className="empty-log">尚无运行记录</p> : logs.map((log) => <div className={`log-row log-${log.level}`} key={log.id}><time>{formatTime(log.createdAt)}</time><span>{log.level === 'error' ? <CircleAlert size={15} /> : <span className="log-dot" />}</span><p>{log.message}</p></div>)}
        </div>
      </section>
    </section>
  </main>
}
