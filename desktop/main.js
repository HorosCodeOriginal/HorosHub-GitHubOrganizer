// HorosHub desktop host (Electron main process).
// Boots the local backend (server.js) on 127.0.0.1:4676, reuses an already
// running instance, and shows the app in a native window with tray + menu.
const { app, BrowserWindow, Menu, Tray, shell, dialog, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 4676;
const BASE = `http://127.0.0.1:${PORT}`;
const RUNTIME = app.isPackaged ? path.join(app.getPath('userData'), '.horoshub') : path.join(ROOT, '.horoshub');
const WIN_STATE = path.join(RUNTIME, 'window.json');
const ICON = path.join(ROOT, 'build', 'icon.ico');

let win = null;
let tray = null;
let serverChild = null;
let ownsServer = false;
let quitting = false;
let minimizeToTray = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function backendUp() {
  try {
    const r = await fetch(BASE + '/api/status', { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

async function ensureBackend() {
  if (await backendUp()) return; // reuse a server the user already started
  serverChild = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOROS_NO_OPEN: '1', HOROS_RUNTIME_DIR: RUNTIME },
    stdio: 'ignore',
    windowsHide: true,
  });
  ownsServer = true;
  serverChild.on('exit', () => { serverChild = null; });
  for (let i = 0; i < 50; i++) {
    if (await backendUp()) return;
    await sleep(300);
  }
  throw new Error('Backend antwortet nicht auf ' + BASE);
}

function readWinState() {
  try { return JSON.parse(fs.readFileSync(WIN_STATE, 'utf8')); } catch { return null; }
}
function saveWinState() {
  if (!win) return;
  try {
    fs.mkdirSync(RUNTIME, { recursive: true });
    const b = win.getBounds();
    fs.writeFileSync(WIN_STATE, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {}
}

function createWindow() {
  const st = readWinState() || {};
  win = new BrowserWindow({
    x: st.x, y: st.y,
    width: st.width || 1440,
    height: st.height || 900,
    minWidth: 1024, minHeight: 700,
    backgroundColor: '#0b0e14',
    title: 'HorosHub',
    icon: ICON,
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(BASE);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(BASE)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(BASE)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });

  win.on('close', (e) => {
    saveWinState();
    if (!quitting && minimizeToTray) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const template = [
    {
      label: 'Datei',
      submenu: [
        { label: 'Neu laden', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.reload() },
        { label: 'Hard-Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => win && win.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { label: 'Backend-Ordner öffnen', click: () => shell.openPath(RUNTIME) },
        { type: 'separator' },
        { label: 'Beenden', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Ansicht',
      submenu: [
        { role: 'resetZoom', label: 'Normalgröße' },
        { role: 'zoomIn', label: 'Vergrößern' },
        { role: 'zoomOut', label: 'Verkleinern' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
        { role: 'toggleDevTools', label: 'Entwicklertools' },
      ],
    },
    {
      label: 'Fenster',
      submenu: [
        { role: 'minimize', label: 'Minimieren' },
        { label: 'In Tray minimieren beim Schließen', type: 'checkbox', checked: minimizeToTray, click: (mi) => { minimizeToTray = mi.checked; } },
        { role: 'close', label: 'Schließen' },
      ],
    },
    {
      label: 'Hilfe',
      submenu: [
        { label: 'GitHub-Profil öffnen', click: () => shell.openExternal('https://github.com/HorosCodeOriginal') },
        { label: 'Über HorosHub', click: () => {
          dialog.showMessageBox(win, {
            type: 'info', title: 'Über HorosHub', message: 'HorosHub 1.0.0',
            detail: 'GitHub-Kommandozentrale für HorosCodeOriginal.\nLokales Backend auf 127.0.0.1:4676 · Electron ' + process.versions.electron + ' · Node ' + process.versions.node,
            buttons: ['OK'],
          });
        } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTray() {
  tray = new Tray(ICON);
  tray.setToolTip('HorosHub — GitHub-Kommandozentrale');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'HorosHub öffnen', click: () => { if (win) { win.show(); win.focus(); } } },
    { type: 'separator' },
    { label: 'Beenden', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
}

ipcMain.handle('horos:open-external', (_e, url) => { if (/^https?:/i.test(url)) shell.openExternal(url); });
ipcMain.handle('horos:show-item', (_e, p) => { if (typeof p === 'string' && p) shell.showItemInFolder(p); });
ipcMain.handle('horos:open-path', (_e, p) => { if (typeof p === 'string' && p) shell.openPath(p); });
ipcMain.handle('horos:notify', (_e, title, body) => {
  if (process.platform === 'win32') app.setAppUserModelId('com.horoscode.horoshub');
  const { Notification } = require('electron');
  if (Notification.isSupported()) new Notification({ title: String(title), body: String(body || ''), icon: ICON }).show();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    app.setName('HorosHub');
    if (process.platform === 'win32') app.setAppUserModelId('com.horoscode.horoshub');
    try { await ensureBackend(); }
    catch (e) {
      dialog.showErrorBox('HorosHub — Backend-Fehler', String(e.message || e));
    }
    buildMenu();
    createWindow();
    buildTray();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && quitting) app.quit(); });
app.on('before-quit', () => {
  quitting = true;
  saveWinState();
  if (ownsServer && serverChild) { try { serverChild.kill(); } catch {} }
});