import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from 'electron'
import { join, resolve } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { MonitorDatabase } from './database'
import { XianyuMonitor } from './monitor'

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let database: MonitorDatabase | undefined
let monitor: XianyuMonitor | undefined
let quitting = false
let shutdownPromise: Promise<void> | undefined

function trayIcon() {
  const width = 16
  const pixels = Buffer.alloc(width * width * 4)
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const edge = x < 2 || y < 2 || x > 13 || y > 13
      pixels[offset] = edge ? 39 : 83
      pixels[offset + 1] = edge ? 67 : 151
      pixels[offset + 2] = edge ? 28 : 215
      pixels[offset + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height: width, scaleFactor: 1 })
}

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function refreshTrayMenu(): void {
  if (!tray || !monitor) return
  const status = monitor.status()
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主界面', click: showMainWindow },
    { label: '开始采集', enabled: status.session !== 'running' && (status.entitled || status.session === 'offline'), click: () => void monitor?.start().catch(() => undefined) },
    { label: '暂停采集', enabled: status.session === 'running', click: () => monitor?.pause() },
    { type: 'separator' },
    { label: '退出', click: requestQuit }
  ]))
}

function createTray(): void {
  tray = new Tray(trayIcon())
  tray.setToolTip('闲鱼采集启动器')
  tray.on('click', showMainWindow)
  refreshTrayMenu()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f6f8',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
  })
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('launcher:status', () => monitor?.status())
  ipcMain.handle('launcher:login', (_event, email: string, password: string) => monitor?.login(email, password))
  ipcMain.handle('launcher:start', () => monitor?.start())
  ipcMain.handle('launcher:pause', () => monitor?.pause())
  ipcMain.handle('launcher:open-chrome', () => monitor?.openLogin())
  ipcMain.handle('launcher:unbind', () => monitor?.unbind())
  ipcMain.handle('launcher:logout', () => monitor?.logout())
  ipcMain.handle('launcher:logs', () => database?.listLogs() ?? [])
}

function shutdown(): Promise<void> {
  if (!shutdownPromise) shutdownPromise = monitor?.shutdown().catch(() => undefined) ?? Promise.resolve()
  return shutdownPromise
}

function requestQuit(): void {
  if (quitting) return
  quitting = true
  void shutdown().finally(() => app.quit())
}

app.setName('懒人闲鱼监控')
app.setPath('userData', process.env.XIANYU_MONITOR_USER_DATA ? resolve(process.env.XIANYU_MONITOR_USER_DATA) : join(app.getPath('appData'), 'XianyuMonitor'))

app.whenReady().then(() => {
  database = new MonitorDatabase()
  monitor = new XianyuMonitor(database, (status) => {
    mainWindow?.webContents.send('launcher:status', status)
    refreshTrayMenu()
  })
  registerIpc()
  createTray()
  createWindow()
  void monitor.restore()

  app.on('activate', showMainWindow)
})

app.on('before-quit', (event) => {
  if (shutdownPromise) return
  event.preventDefault()
  requestQuit()
})
