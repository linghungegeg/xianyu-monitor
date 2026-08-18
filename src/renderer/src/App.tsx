import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react'
import { Chrome, CircleAlert, CircleCheck, Eye, EyeOff, KeyRound, LoaderCircle, LogIn, LogOut, Pause, Play, ShieldCheck } from 'lucide-react'
import type { LauncherLog, LauncherStatus } from '../../shared/types'

const initialStatus: LauncherStatus = {
  session: 'checking',
  browser: 'idle',
  entitled: false,
  message: '正在读取本机授权状态'
}

const rememberedAccountKey = 'xianyu.launcher.remembered-account.v2'
const legacyRememberedCredentialsKey = 'xianyu.launcher.remembered-credentials'

function readRememberedAccount(): string {
  try {
    localStorage.removeItem(legacyRememberedCredentialsKey)
    const value = JSON.parse(localStorage.getItem(rememberedAccountKey) ?? '{}') as Partial<{ email: string }>
    return typeof value.email === 'string' ? value.email : ''
  } catch {
    localStorage.removeItem(rememberedAccountKey)
    return ''
  }
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
  return status.session === 'signed-out' || status.session === 'revoked' || (status.session === 'error' && !status.entitled)
}

export default function App(): JSX.Element {
  const [rememberedAccount] = useState(readRememberedAccount)
  const [status, setStatus] = useState<LauncherStatus>(initialStatus)
  const [logs, setLogs] = useState<LauncherLog[]>([])
  const [email, setEmail] = useState(rememberedAccount)
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberAccount, setRememberAccount] = useState(Boolean(rememberedAccount))
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
    const account = email.trim()
    if (!account) return setNotice('请输入账号')
    if (account.length < 3) return setNotice('账号不低于3位')
    if (account.length > 20) return setNotice('账号不超过20位')
    if (!password) return setNotice('请输入密码')
    if (password.length < 6) return setNotice('密码不低于6位')
    if (password.length > 20) return setNotice('密码不超过20位')

    setBusy(true)
    setNotice(null)
    try {
      await (authMode === 'register' ? window.xianyu.launcher.register(account, password) : window.xianyu.launcher.login(account, password))
      if (rememberAccount) {
        localStorage.setItem(rememberedAccountKey, JSON.stringify({ email: account }))
      } else {
        localStorage.removeItem(rememberedAccountKey)
        setPassword('')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '登录失败，请稍后重试')
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const running = status.session === 'running'
  const canStart = status.entitled || status.session === 'offline'

  if (status.session === 'checking') {
    return <main className="launcher-auth-shell" aria-busy="true">
      <section className="launcher-auth-card launcher-status-card"><LoaderCircle className="spin" size={24} /></section>
    </main>
  }

  if (isSignedOut(status)) {
    return <main className="launcher-auth-shell">
      <form className="launcher-auth-card" noValidate onSubmit={(event) => void login(event)}>
        {notice ? <div className="notice" role="alert"><CircleAlert size={17} /><span>{notice}</span></div> : null}
        <div className="panel-icon"><KeyRound size={22} /></div>
        <h1>{authMode === 'register' ? '注册账号' : '登录'}</h1>
        <label>账号<input type="text" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="请输入账号" /></label>
        <label>密码<div className="password-field"><input type={showPassword ? 'text' : 'password'} autoComplete={authMode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" /><button className="password-toggle" type="button" title={showPassword ? '隐藏密码' : '显示密码'} aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
        <label className="launcher-remember"><input type="checkbox" aria-label="保存登录" checked={rememberAccount} onChange={(event) => setRememberAccount(event.target.checked)} />记住账号</label>
        <button className="primary-button" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <LogIn size={17} />}{busy ? (authMode === 'register' ? '正在注册' : '正在登录') : authMode === 'register' ? '注册' : '登录'}</button>
        <p className="auth-switch">{authMode === 'register' ? '已有账号？' : '还没有账号？'}<button type="button" onClick={() => { setAuthMode((value) => value === 'login' ? 'register' : 'login'); setNotice(null); setPassword('') }}>{authMode === 'register' ? '返回登录' : '注册账号'}</button></p>
      </form>
    </main>
  }

  return <main className="launcher-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><ShieldCheck size={20} /></span><strong>懒人闲鱼监控</strong></div>
      <div className={`status-chip status-${status.session}`}><span /><strong>{statusLabel(status)}</strong></div>
    </header>

    <section className="launcher-content">
      {notice ? <div className="notice" role="alert"><CircleAlert size={17} /><span>{notice}</span></div> : null}

      <><section className="welcome-heading"><p>欢迎您的使用，<strong>{status.account ?? '当前账户'}</strong></p><span>{status.browser === 'open' ? <><Chrome size={15} />Chrome 已打开</> : '本机 Chrome 待打开'}</span></section><section className="control-panel">
        <div className="control-summary"><span className={`state-icon state-${status.session}`}>{status.session === 'running' ? <Play size={22} /> : <CircleCheck size={22} />}</span><div><h2>本机设备</h2><p>{running ? '采集器正在运行' : status.entitled ? '设备已绑定，账号权益有效' : '正在确认账号状态'}</p></div></div>
        <div className="control-actions">
          <button className="secondary-button" type="button" disabled={busy || !status.entitled} onClick={() => void run(() => window.xianyu.launcher.openChrome())}><Chrome size={17} />打开 Chrome</button>
          {running
            ? <button className="primary-button" type="button" disabled={busy} onClick={() => void run(() => window.xianyu.launcher.pause())}><Pause size={17} />暂停采集</button>
            : <button className="primary-button" type="button" disabled={busy || !canStart} onClick={() => void run(() => window.xianyu.launcher.start())}>{busy ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}启动采集</button>}
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void run(() => window.xianyu.launcher.logout())}><LogOut size={17} />退出登录</button>
        </div>
      </section></>

      <section className="logs-panel" aria-label="运行日志">
        <div className="panel-heading"><div><h2>运行日志</h2><p>最近活动</p></div><CircleCheck size={18} /></div>
        <div className="log-list">
          {logs.length === 0 ? <p className="empty-log">尚无运行记录</p> : logs.map((log) => <div className={`log-row log-${log.level}`} key={log.id}><time>{formatTime(log.createdAt)}</time><span>{log.level === 'error' ? <CircleAlert size={15} /> : <span className="log-dot" />}</span><p>{log.message}</p></div>)}
        </div>
      </section>
    </section>
  </main>
}
