const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeTheme, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { createManager } = require('./ssh');
const { readSshConfig } = require('./sshconfig');
const { autoUpdater } = require('electron-updater');

// Profilo separato per i test (non tocca la configurazione reale).
const testProfile = process.env.SCREENIE_USER_DATA || process.env.SCREENIEW_USER_DATA;
if (testProfile) app.setPath('userData', testProfile);
else migrateOldName();

// L'app si chiamava "Screeniew" e prima ancora "Approdo": al primo avvio porta con sé
// server, preferiti e impostazioni dalla cartella del nome precedente più recente.
function migrateOldName() {
  const target = path.join(app.getPath('userData'), 'config.json');
  try {
    if (fs.existsSync(target)) return;
    for (const name of ['Screeniew', 'Approdo']) {
      const old = path.join(app.getPath('appData'), name, 'config.json');
      if (!fs.existsSync(old)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(old, target);
      return;
    }
  } catch { /* si riparte da zero */ }
}

// Colori della barra con _ □ X, allineati al tema dell'interfaccia.
const chrome = {
  dark: { color: '#15161c', symbolColor: '#a3a9ba', background: '#0f1014' },
  light: { color: '#fbfbfe', symbolColor: '#5f6579', background: '#f3f4f9' },
};
function effectiveTheme(theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

let win = null;
const pending = new Map(); // id richiesta -> resolve
let promptSeq = 0;

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// Chiede qualcosa all'interfaccia (host key, passphrase) e attende la risposta.
function prompt(request) {
  return new Promise((resolve) => {
    const id = ++promptSeq;
    pending.set(id, resolve);
    send('prompt', { id, ...request });
  });
}

const ssh = createManager({ send, prompt });

// Finestra di avvio: logo grande con animazione e suono, poi lascia il posto all'app.
let splash = null;
function createSplash() {
  splash = new BrowserWindow({
    width: 520,
    height: 520,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    center: true,
    hasShadow: false,
    title: 'Screenie',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'), { query: { sound: store.getSettings().splashSound === false ? '0' : '1' } });
  splash.once('ready-to-show', () => splash?.show());
  splash.on('closed', () => { splash = null; });
}

// Chiude la finestra di avvio quando l'app è pronta, ma non prima che l'animazione si sia vista.
function revealMain(startedAt) {
  const MIN = 2100;
  const go = () => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    if (!splash) return;
    splash.webContents.executeJavaScript('document.body.classList.add("leaving")').catch(() => {});
    setTimeout(() => { if (splash && !splash.isDestroyed()) splash.close(); }, 380);
  };
  setTimeout(go, Math.max(0, MIN - (Date.now() - startedAt)));
}

function createWindow({ withSplash = false } = {}) {
  const { theme = 'system', zoom = 1 } = store.getSettings();
  nativeTheme.themeSource = theme;
  const c = chrome[effectiveTheme(theme)];
  const startedAt = Date.now();
  win = new BrowserWindow({
    show: !withSplash,
    width: 1400,
    height: 880,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: c.background,
    title: 'Screenie',
    autoHideMenuBar: true,
    // Niente barra del titolo di sistema: l'interfaccia arriva fino in cima e i pulsanti
    // _ □ X vengono disegnati sopra, con i colori dell'app (su macOS restano i semafori).
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarOverlay: { color: c.color, symbolColor: c.symbolColor, height: 44 } }),
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      zoomFactor: zoom,
    },
  });

  // L'interfaccia non deve mai navigare altrove: i link si aprono nel browser di sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('closed', () => { win = null; });
  if (withSplash) {
    win.once('ready-to-show', () => revealMain(startedAt));
    // Se qualcosa va storto, l'app si apre comunque.
    setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) revealMain(0); }, 8000);
  }
}

// Ogni handler restituisce { ok, value } oppure { ok:false, error } così gli
// errori arrivano all'interfaccia in italiano e senza stack trace.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

handle('prompt:answer', (id, value) => {
  const resolve = pending.get(id);
  pending.delete(id);
  resolve?.(value);
});

handle('servers:list', () => store.listServers());
handle('servers:save', (s) => { const r = store.saveServer(s); updateTray(); return r; });
handle('servers:delete', (id) => { ssh.disconnect(id); store.deleteServer(id); updateTray(); });
handle('servers:readSshConfig', () => readSshConfig());
handle('servers:forgetPassphrase', (id) => store.forgetPassphrase(id));
handle('servers:defaultKey', () => ssh.defaultKeyPath());
handle('servers:getFavorites', (id) => store.getFavorites(id));
handle('servers:setFavorites', (id, list) => store.setFavorites(id, list));
handle('settings:get', () => store.getSettings());
handle('settings:set', (patch) => store.setSettings(patch));

handle('dialog:pickKey', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Scegli la chiave privata',
    defaultPath: path.dirname(ssh.defaultKeyPath()),
    properties: ['openFile', 'showHiddenFiles'],
  });
  return r.canceled ? null : r.filePaths[0];
});
handle('dialog:pickUpload', async (dirs) => {
  const r = await dialog.showOpenDialog(win, {
    title: dirs ? 'Scegli cartelle da caricare' : 'Scegli file da caricare',
    properties: [dirs ? 'openDirectory' : 'openFile', 'multiSelections'],
  });
  return r.canceled ? [] : r.filePaths;
});
handle('dialog:pickDownloadDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Scarica in…',
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
handle('shell:showFolder', (p) => shell.openPath(p));

// Backup della configurazione (senza passphrase).
handle('config:export', async () => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Esporta configurazione',
    defaultPath: path.join(app.getPath('documents'), `screenie-backup-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'Backup di Screenie', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(store.exportConfig(), null, 2));
  return r.filePath;
});
handle('config:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Importa configurazione',
    filters: [{ name: 'Backup di Screenie', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8').replace(/^﻿/, ''));
  } catch {
    throw new Error('Il file non è un JSON valido');
  }
  const res = store.importConfig(obj);
  updateTray();
  return res;
});

// Tema e zoom: l'interfaccia li applica a sé, qui si aggiornano finestra e barra del titolo.
handle('window:appearance', ({ theme, zoom }) => {
  nativeTheme.themeSource = theme;
  const c = chrome[effectiveTheme(theme)];
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(c.background);
    if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor });
    if (zoom) win.webContents.setZoomFactor(zoom);
  }
  return effectiveTheme(theme);
});

handle('ssh:connect', (id) => ssh.connect(id));
handle('ssh:ping', (id) => ssh.ping(id));
handle('ssh:tunnels', (id) => ssh.tunnels(id));
handle('ssh:disconnect', (id) => { ssh.stopWatchers(id); ssh.disconnect(id); });

handle('term:open', (serverId, termId, opts) => ssh.openTerm(serverId, termId, opts));
handle('term:close', (termId) => ssh.closeTerm(termId));
ipcMain.on('term:write', (_e, termId, data) => ssh.writeTerm(termId, data));
ipcMain.on('term:resize', (_e, termId, cols, rows) => ssh.resizeTerm(termId, cols, rows));

handle('screen:list', (id) => ssh.screenList(id));
handle('screen:create', (id, name, cmd) => ssh.screenCreate(id, name, cmd));
handle('screen:kill', (id, sid) => ssh.screenKill(id, sid));
handle('screen:rename', (id, sid, name) => ssh.screenRename(id, sid, name));
handle('screen:wipe', (id) => ssh.screenWipe(id));
handle('screen:attachCommand', (sid) => ssh.screenAttachCommand(sid));
handle('server:stats', (id) => ssh.stats(id));

handle('sftp:list', (id, dir) => ssh.list(id, dir));
handle('sftp:read', (id, file) => ssh.readFile(id, file));
handle('sftp:write', (id, file, content, mtime, force) => ssh.writeFile(id, file, content, mtime, force));
handle('sftp:mkdir', (id, dir) => ssh.mkdir(id, dir));
handle('sftp:createFile', (id, file) => ssh.createFile(id, file));
handle('sftp:rename', (id, from, to) => ssh.rename(id, from, to));
handle('sftp:remove', (id, target) => ssh.remove(id, target));
handle('sftp:upload', (id, paths, dir) => ssh.upload(id, paths, dir));
handle('sftp:download', (id, paths, dir) => ssh.download(id, paths, dir));
handle('sftp:editExternal', (id, remote) => ssh.editExternally(id, remote, (p) => shell.openPath(p)));

// ---------- Aggiornamenti automatici (GitHub Releases, solo Windows per ora) ----------
// L'app controlla all'avvio e ogni 4 ore; scarica in background e chiede di riavviare.
let updateState = { status: 'idle' };
function setUpdate(patch) {
  updateState = { ...updateState, ...patch };
  send('update', updateState);
}
function initUpdates() {
  if (!app.isPackaged || process.platform !== 'win32' || testProfile) {
    updateState = { status: 'unsupported' };
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => setUpdate({ status: 'ready', version: i.version }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'none', checkedAt: Date.now() }));
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', error: e?.message || String(e) }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, 4 * 3600 * 1000);
}
handle('app:updateState', () => updateState);
handle('app:checkUpdates', async () => {
  if (updateState.status === 'unsupported') return updateState;
  try { await autoUpdater.checkForUpdates(); } catch (e) { setUpdate({ status: 'error', error: e.message }); }
  return updateState;
});
handle('app:installUpdate', () => {
  if (updateState.status !== 'ready') throw new Error('Nessun aggiornamento pronto');
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
});

// Su macOS la barra dei menu è obbligatoria: senza menu Modifica non funzionano nemmeno
// ⌘C/⌘V nei campi di testo. Le voci di Screenie vengono inoltrate all'interfaccia.
// Su Windows non c'è barra dei menu: le stesse azioni restano nell'interfaccia.
function buildMacMenu() {
  const cmd = (command) => () => send('menu', command);
  const item = (label, command, accelerator) => ({ label, accelerator, click: cmd(command) });
  return Menu.buildFromTemplate([
    {
      role: 'appMenu',
      submenu: [
        { role: 'about', label: 'Informazioni su Screenie' },
        { type: 'separator' },
        item('Impostazioni…', 'settings', 'Cmd+,'),
        { type: 'separator' },
        { role: 'services', label: 'Servizi' },
        { type: 'separator' },
        { role: 'hide', label: 'Nascondi Screenie' },
        { role: 'hideOthers', label: 'Nascondi altre' },
        { role: 'unhide', label: 'Mostra tutte' },
        { type: 'separator' },
        { role: 'quit', label: 'Esci da Screenie' },
      ],
    },
    {
      label: 'File',
      submenu: [
        item('Nuovo terminale', 'newTerminal', 'Cmd+Shift+T'),
        item('Nuovo screen', 'newScreen', 'Cmd+Shift+S'),
        { type: 'separator' },
        item('Salva', 'save', 'Cmd+S'),
        { type: 'separator' },
        item('Chiudi scheda', 'closeTab', 'Cmd+W'),
        { role: 'close', label: 'Chiudi finestra', accelerator: 'Cmd+Shift+W' },
      ],
    },
    {
      label: 'Modifica',
      submenu: [
        { role: 'undo', label: 'Annulla' },
        { role: 'redo', label: 'Ripeti' },
        { type: 'separator' },
        { role: 'cut', label: 'Taglia' },
        { role: 'copy', label: 'Copia' },
        { role: 'paste', label: 'Incolla' },
        { role: 'selectAll', label: 'Seleziona tutto' },
      ],
    },
    {
      label: 'Vista',
      submenu: [
        item('Mostra/nascondi barra laterale', 'toggleSidebar', 'Cmd+Ctrl+S'),
        item('Mostra/nascondi pannello server', 'toggleInspector', 'Cmd+Ctrl+I'),
        { type: 'separator' },
        item('Testo del terminale più grande', 'fontBigger', 'Cmd+='),
        item('Testo del terminale più piccolo', 'fontSmaller', 'Cmd+-'),
        item('Dimensione normale del testo', 'fontReset', 'Cmd+0'),
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Schermo intero' },
      ],
    },
    {
      label: 'Server',
      submenu: [
        item('Aggiungi server…', 'addServer'),
        item('Disconnetti', 'disconnect'),
        { type: 'separator' },
        item('Scheda successiva', 'nextTab', 'Ctrl+Tab'),
        item('Scheda precedente', 'prevTab', 'Ctrl+Shift+Tab'),
      ],
    },
    { role: 'windowMenu', label: 'Finestra' },
  ]);
}

// Icona nell'area di notifica: apre al volo un terminale su un server salvato.
let tray = null;
function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}
function updateTray() {
  if (!tray) return;
  const servers = store.listServers();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostra Screenie', click: showWindow },
    { type: 'separator' },
    ...(servers.length
      ? servers.slice(0, 15).map((s) => ({ label: `Terminale su ${s.name}`, click: () => { showWindow(); send('menu', `openServer:${s.id}`); } }))
      : [{ label: 'Nessun server salvato', enabled: false }]),
    { type: 'separator' },
    { label: 'Esci', role: 'quit' },
  ]));
}
function createTray() {
  if (process.platform === 'darwin' || testProfile) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Screenie');
  tray.on('click', showWindow);
  updateTray();
}

if (!testProfile && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  Menu.setApplicationMenu(process.platform === 'darwin' ? buildMacMenu() : null);
  createTray();
  initUpdates();
  // Niente finestra di avvio nei test automatici (profilo separato) o se disattivata.
  const withSplash = !testProfile && !process.env.SCREENIE_NO_SPLASH && store.getSettings().splash !== false;
  if (withSplash) createSplash();
  createWindow({ withSplash });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  ssh.shutdown();
  if (process.platform !== 'darwin') app.quit();
});
