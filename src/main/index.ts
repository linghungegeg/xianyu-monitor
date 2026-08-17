import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import type { NewTask } from '../shared/types'
import { MonitorDatabase } from './database'
import { XianyuMonitor } from './monitor'

let mainWindow: BrowserWindow | undefined
let database: MonitorDatabase
let monitor: XianyuMonitor

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('tasks:list', () => database.listTasks())
  ipcMain.handle('tasks:create', (_event, task: NewTask) => database.saveTask(task))
  ipcMain.handle('tasks:toggle', (_event, id: string, enabled: boolean) => database.setTaskEnabled(id, enabled))
  ipcMain.handle('tasks:delete', (_event, id: string) => database.deleteTask(id))
  ipcMain.handle('items:list', (_event, taskId?: string) => database.listItems(taskId))
  ipcMain.handle('logs:list', () => database.listLogs())
  ipcMain.handle('monitor:status', () => monitor.status())
  ipcMain.handle('monitor:login', () => monitor.openLogin())
  ipcMain.handle('monitor:scan', async (_event, taskId: string) => {
    const task = database.listTasks().find((entry) => entry.id === taskId)
    if (!task) throw new Error('监控任务不存在')
    return monitor.scanTask(task)
  })
  ipcMain.handle('monitor:open-item', (_event, url: string) => shell.openExternal(url))
}

app.setName('XianyuMonitor')
app.setPath('userData', join(app.getPath('appData'), 'XianyuMonitor'))

app.whenReady().then(() => {
  database = new MonitorDatabase()
  monitor = new XianyuMonitor(database, (status) => mainWindow?.webContents.send('monitor:status', status))
  registerIpc()
  createWindow()
  monitor.startScheduler(() => database.listTasks())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
