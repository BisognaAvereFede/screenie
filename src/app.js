import '@fontsource-variable/plus-jakarta-sans';
import './style.css';
import './features.css';
import { h, icon, iconButton, toast, fail, modal, confirmDialog, contextMenu, menuAnchor, isMenuKey, formatSize, enter, leave, motionOK } from './dom.js';
import { createTerminalTab, configureTerminals, setBroadcast, isBroadcasting, restoreSplits } from './terminal.js';
import { createEditorTab } from './editor.js';
import { createScreensPanel } from './screens.js';
import { createFilesPanel } from './files.js';
import { createHomePage } from './home.js';
import { createSettingsPage } from './settings.js';
import { applyAppearance, effectiveTheme } from './theme.js';
import { actionFor, bindings, display, showShortcuts } from './keys.js';
import { openPalette } from './palette.js';
import { SERVER_COLORS, colorOf, glyphOf, serverBadge, dangerReason, confirmDanger } from './identity.js';
import { createHistoryTab } from './history.js';
import { createRecipesTab } from './recipes.js';
import { createTimelineTab } from './timeline.js';
import { createServicesTab } from './services.js';
import { createNotesTab } from './notes.js';
import logoUrl from './logo-mark.svg';

const api = window.api;
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const app = {
  servers: [],
  current: null, // server selezionato
  conn: new Map(), // serverId -> 'connecting' | 'on'
  errors: new Map(), // serverId -> ultimo errore di connessione
  stats: new Map(), // serverId -> ultimo stato letto (CPU, RAM, disco…)
  history: new Map(), // serverId -> [{ cpu, mem }] ultimi 30 campioni
  latency: new Map(), // serverId -> ms
  tunnels: new Map(), // serverId -> [{ localPort, remoteHost, remotePort, ok, error }]
  changes: new Map(), // serverId -> riepilogo "mentre eri via"
  shares: new Map(), // termId -> { url, viewers, allowInput }
  closing: new Set(), // disconnessioni volute (niente riconnessione)
  reconnect: new Map(), // serverId -> { tries, timer }
  inspectorPeek: false, // pannello aperto a mano anche senza connessione
  filter: '',
  tabs: [],
  active: null,
  settings: await api.invoke('settings:get'),
};

document.body.classList.add(`platform-${api.platform}`);
applyAppearance(app.settings);

let closeConfirmed = false; // chiusura già confermata (file non salvati)
const serverName = (id) => app.servers.find((s) => s.id === id)?.name || '?';
const serverOf = (id) => app.servers.find((s) => s.id === id);
const isOn = (id) => app.conn.get(id) === 'on';

// ---------- Layout ----------

function inspectorHidden() {
  if (app.settings.hideInspector) return true;
  if (!app.settings.autoInspector || app.inspectorPeek) return false;
  const id = app.current;
  return !id || (!app.conn.has(id) && !app.errors.has(id) && !app.reconnect.has(id));
}

function applyLayout() {
  const root = document.documentElement;
  root.style.setProperty('--sidebar-size', `${app.settings.sidebarW || 268}px`);
  root.style.setProperty('--inspector-size', `${app.settings.inspectorW || 330}px`);
  document.body.classList.toggle('no-sidebar', !!app.settings.hideSidebar);
  document.body.classList.toggle('no-inspector', inspectorHidden());
  document.body.classList.toggle('compact-term', !!app.settings.compactTerm);
  inspectorToggle?.setAttribute('aria-pressed', String(!inspectorHidden()));
}

// Aggiorna un'impostazione: la salva e applica subito l'effetto.
async function changeSettings(patch) {
  try {
    Object.assign(app.settings, await api.invoke('settings:set', patch));
  } catch (e) {
    fail(e);
    return;
  }
  const keys = Object.keys(patch);
  if (keys.some((k) => ['theme', 'zoom', 'accent', 'termFont', 'termTheme'].includes(k))) applyAppearance(app.settings);
  if ('fontSize' in patch) for (const t of app.tabs) t.setFontSize?.(app.settings.fontSize);
  if ('showHidden' in patch) files.refresh();
  if (keys.some((k) => ['hideSidebar', 'hideInspector', 'autoInspector', 'compactTerm', 'sidebarW', 'inspectorW'].includes(k))) applyLayout();
  if (!keys.every((k) => k === 'session')) settingsTab?.refresh();
}

// ---------- Struttura ----------

const serverList = h('div', { class: 'server-list', role: 'list' });
const serverSearch = h('input', { type: 'search', class: 'server-search', placeholder: 'Cerca server…', spellcheck: false, 'aria-label': 'Cerca tra i server' });
serverSearch.addEventListener('input', () => { app.filter = serverSearch.value.trim().toLowerCase(); renderServers(); });
const tabBar = h('div', { class: 'tab-bar', role: 'tablist', 'aria-label': 'Schede aperte' });
const tabArea = h('div', { class: 'tab-area' });
const serverCard = h('div', { class: 'server-card' });
const panelBody = h('div', { class: 'panel-content' });
const statsGrid = h('div', { class: 'stats' });
const tunnelList = h('div', { class: 'tunnel-list' });
const pageTitle = h('h1', { class: 'page-title' });
const transfers = h('div', { class: 'transfers' });
const broadcastBar = h('div', { class: 'broadcast-bar hidden', role: 'status' });
const updateBar = h('div', { class: 'update-bar hidden', role: 'status' });

const screens = createScreensPanel({
  getServerId: () => (isOn(app.current) ? app.current : null),
  openScreen: (s) => openScreenTab(app.current, s),
  openCommand: (cmd) => openTerminal(app.current, { command: cmd ? `${cmd}; exec bash -l` : undefined }),
  onGone: (name, id) => notify('Screen terminato', `Lo screen "${name}" su ${serverName(id)} non è più attivo.`),
});
const files = createFilesPanel({
  getServerId: () => (isOn(app.current) ? app.current : null),
  settings: app.settings,
  openEditor: (p) => openEditor(app.current, p),
  openCommand: (_cmd, dir) => openTerminal(app.current, { cwd: dir }),
});
const filesSection = h('div', { class: 'files-section' }, h('div', { class: 'group-label' }, 'File'), files.el);

const keyHint = (id) => display(bindings(app.settings.keys)[id]);
const sidebarToggle = iconButton('sidebarLeft', 'Mostra la barra laterale', () => commands.toggleSidebar(), 'round panel-toggle sidebar-show');
const sidebarCollapse = iconButton('chevronLeft', 'Nascondi la barra laterale', () => commands.toggleSidebar(), 'collapse-btn');
const inspectorToggle = iconButton('sidebarRight', 'Pannello server', () => commands.toggleInspector(), 'round panel-toggle');
const paletteBtn = h('button', { class: 'palette-btn', type: 'button', onclick: () => commands.palette() },
  icon('search', 15), h('span', {}, 'Cerca o esegui un comando'), h('kbd', {}, keyHint('palette')));
const settingsBtn = h('button', { class: 'nav-item sidebar-settings', type: 'button', onclick: () => openSettings() }, icon('settings', 18), h('span', {}, 'Impostazioni'));
const recipesBtn = h('button', { class: 'nav-item', type: 'button', onclick: () => openRecipes() }, icon('snippet', 18), h('span', {}, 'Ricette'));
const historyBtn = h('button', { class: 'nav-item', type: 'button', onclick: () => openHistory() }, icon('clock', 18), h('span', {}, 'Cronologia'));
const focusExit = h('button', { class: 'focus-exit', type: 'button', onclick: () => commands.focus() }, 'Esci dalla modalità focus');

function resizer(side) {
  const handle = h('div', { class: `resizer resizer-${side}`, role: 'separator', 'aria-orientation': 'vertical', 'aria-label': side === 'left' ? 'Larghezza barra laterale' : 'Larghezza pannello server', tabindex: 0 });
  const key = side === 'left' ? 'sidebarW' : 'inspectorW';
  const cssVar = side === 'left' ? '--sidebar-size' : '--inspector-size';
  const [min, max] = side === 'left' ? [200, 480] : [240, 520];
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const start = app.settings[key];
    let w = start;
    const move = (ev) => {
      w = Math.round(Math.min(max, Math.max(min, start + (side === 'left' ? ev.clientX - startX : startX - ev.clientX))));
      document.documentElement.style.setProperty(cssVar, `${w}px`);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing');
      if (w !== start) changeSettings({ [key]: w });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
  handle.addEventListener('keydown', (e) => {
    const d = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
    if (!d) return;
    e.preventDefault();
    changeSettings({ [key]: app.settings[key] + (side === 'left' ? d : -d) });
  });
  handle.addEventListener('dblclick', () => changeSettings({ [key]: side === 'left' ? 268 : 330 }));
  return handle;
}

document.getElementById('app').append(
  h('aside', { class: 'sidebar', 'aria-label': 'Server e file' },
    h('div', { class: 'brand' },
      h('span', { class: 'brand-lockup' },
        h('img', { class: 'brand-logo', src: logoUrl, alt: '' }),
        h('span', { class: 'brand-name' }, 'Screenie')),
      sidebarCollapse),
    h('div', { class: 'group-label with-action' },
      h('span', {}, 'Server'),
      h('span', { class: 'group-actions' },
        iconButton('import', 'Importa da ~/.ssh/config', () => importSshConfig()),
        iconButton('plus', 'Aggiungi server', () => editServer()))),
    h('div', { class: 'server-search-wrap' }, serverSearch),
    serverList,
    filesSection,
    transfers,
    h('div', { class: 'sidebar-foot' }, recipesBtn, historyBtn, settingsBtn),
    resizer('left')),
  h('main', { class: 'workspace' },
    h('header', { class: 'topbar' },
      sidebarToggle,
      h('div', { class: 'title-block' }, pageTitle),
      h('span', { class: 'spacer' }),
      paletteBtn,
      iconButton('help', 'Scorciatoie da tastiera', () => commands.shortcuts(), 'round'),
      iconButton('terminal', 'Nuovo terminale', () => commands.newTerminal(), 'round'),
      inspectorToggle),
    updateBar,
    broadcastBar,
    tabBar,
    h('div', { class: 'tab-card' }, tabArea),
    focusExit),
  h('aside', { class: 'side-panel', 'aria-label': 'Stato del server e screen' },
    resizer('right'),
    h('div', { class: 'window-drag' }),
    serverCard,
    panelBody),
);

const statsSection = [h('div', { class: 'section-head' }, h('span', {}, 'Stato')), statsGrid];
const tunnelSection = h('div', { class: 'tunnel-section' }, h('div', { class: 'section-head' }, h('span', {}, 'Tunnel')), tunnelList);
const screensSection = [
  h('div', { class: 'section-head' }, h('span', {}, 'Screen'), iconButton('refresh', 'Aggiorna', () => screens.refresh(true))),
  screens.el,
];

// ---------- Notifiche di sistema ----------

function notify(title, body) {
  if (!app.settings.notifications) return;
  try {
    const n = new Notification(title, { body, silent: false });
    n.onclick = () => window.focus();
  } catch { /* notifiche non disponibili */ }
}

configureTerminals({
  isOn: (id) => isOn(id),
  notify,
  snippets: () => app.settings.snippets || [],
  onCommand: (id, cmd) => api.invoke('data:addHistory', id, cmd).catch(() => {}),
  needsConfirm: (id, cmd) => !!serverOf(id)?.production && !!dangerReason(cmd),
  confirm: (id, cmd) => confirmDanger(serverOf(id), cmd),
  share: (tab) => shareDialog(tab),
  onBroadcastChange: (on, n) => {
    broadcastBar.classList.toggle('hidden', !on);
    broadcastBar.replaceChildren(
      icon('broadcast', 15),
      h('span', {}, `Quello che scrivi va a tutti i terminali aperti (${n}).`),
      h('button', { class: 'btn small', onclick: () => setBroadcast(false) }, 'Interrompi'));
  },
});

// ---------- Aggiornamenti ----------

let updateDismissed = null;
function renderUpdate(st) {
  app.update = st;
  settingsTab?.refresh();
  const ready = st?.status === 'ready' && updateDismissed !== st.version;
  updateBar.classList.toggle('hidden', !ready);
  if (!ready) return;
  updateBar.replaceChildren(
    icon('download', 15),
    h('span', {}, `Screenie ${st.version} è pronto. Riavvia per aggiornare: server e impostazioni restano.`),
    h('button', { class: 'btn small', onclick: () => { updateDismissed = st.version; renderUpdate(st); } }, 'Più tardi'),
    h('button', { class: 'btn small primary', onclick: () => installUpdate() }, 'Riavvia e aggiorna'));
}
async function installUpdate() {
  const dirty = app.tabs.filter((t) => t.isDirty?.());
  if (dirty.length && !(await confirmDialog('File non salvati', `${dirty.map((t) => t.title).join(', ')} hanno modifiche non salvate. Aggiornare comunque?`, { ok: 'Aggiorna' }))) return;
  closeConfirmed = true;
  api.invoke('app:installUpdate').catch(fail);
}
api.onUpdate?.(renderUpdate);
api.invoke('app:updateState').then(renderUpdate).catch(() => {});

// ---------- Home e Impostazioni (schede speciali, senza server) ----------

let settingsTab = null;

const homeTab = createHomePage({
  servers: () => app.servers,
  status: (id) => app.conn.get(id) || 'off',
  stats: (id) => app.stats.get(id),
  latency: (id) => app.latency.get(id),
  error: (id) => app.errors.get(id),
  current: () => app.current,
  addServer: () => editServer(),
  importSshConfig: () => importSshConfig(),
  connect: (id) => connect(id),
  disconnect: (id) => disconnect(id),
  openTerminal: (id) => openTerminal(id),
  newScreen: async (id) => {
    if (!(await connect(id))) return;
    selectServer(id);
    app.inspectorPeek = true;
    applyLayout();
    screens.focusNew();
  },
  openFiles: async (id) => {
    if (!(await connect(id))) return;
    selectServer(id);
    if (app.settings.hideSidebar) changeSettings({ hideSidebar: false });
  },
  openFavorite: async (id, path) => {
    if (!(await connect(id))) return;
    selectServer(id);
    files.go(path);
  },
});

function openSettings() {
  if (settingsTab) return activate(settingsTab.uid);
  settingsTab = createSettingsPage({
    settings: app.settings,
    change: changeSettings,
    onImported: () => loadServers(),
    update: () => app.update,
    checkUpdates: () => api.invoke('app:checkUpdates').then(renderUpdate).catch(fail),
    installUpdate: () => installUpdate(),
  });
  const dispose = settingsTab.dispose;
  settingsTab.dispose = () => { dispose(); settingsTab = null; };
  addTab(settingsTab);
}

function updateTitle() {
  const tab = app.tabs.find((t) => t.uid === app.active);
  let title = 'Home';
  if (tab?.kind === 'settings') title = 'Impostazioni';
  else if (tab && PAGE_KINDS.has(tab.kind) && tab.kind !== 'home') title = tab.title;
  else if (tab?.kind === 'editor') title = tab.path || tab.title;
  else if (tab?.serverId) {
    const s = serverOf(tab.serverId);
    title = tab.termTitle || (s ? `${s.username}@${s.host}` : serverName(tab.serverId));
  }
  if (pageTitle.textContent !== title) {
    pageTitle.textContent = title;
    pageTitle.title = title;
    if (motionOK()) pageTitle.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
  }
  settingsBtn.classList.toggle('active', tab?.kind === 'settings');
  if (tab?.kind === 'settings') settingsBtn.setAttribute('aria-current', 'page');
  else settingsBtn.removeAttribute('aria-current');
  document.body.classList.toggle('compact-top', !!tab && !PAGE_KINDS.has(tab.kind));
  recipesBtn.classList.toggle('active', tab?.kind === 'recipes');
  historyBtn.classList.toggle('active', tab?.kind === 'history');
}

// ---------- Server ----------

async function loadServers() {
  app.servers = await api.invoke('servers:list');
  renderServers();
  homeTab.refresh();
  enter(serverList);
}

const collapsed = new Set(JSON.parse((() => { try { return localStorage.getItem('collapsedGroups') || '[]'; } catch { return '[]'; } })()));
const saveCollapsed = () => { try { localStorage.setItem('collapsedGroups', JSON.stringify([...collapsed])); } catch { /* */ } };

// Sigla colorata del server con il "battito": il pallino pulsa più veloce quando il server è sotto sforzo.
function heartbeat(id) {
  const st = app.stats.get(id);
  if (!st || !isOn(id)) return { dur: '2.4s', hot: false };
  const cpu = pct(st.load, st.cpus);
  return { dur: `${(2.6 - Math.min(100, cpu) / 100 * 2).toFixed(2)}s`, hot: cpu >= 85 };
}
function serverAvatar(s, status, error) {
  const beat = heartbeat(s.id);
  const label = status === 'on' ? (beat.hot ? 'connesso, sotto sforzo' : 'connesso') : status === 'connecting' ? 'connessione in corso' : error ? 'errore' : 'non connesso';
  return h('span', { class: 'server-avatar', title: label },
    serverBadge(s),
    h('span', { class: `status-dot beat ${status} ${error ? 'error' : ''} ${beat.hot ? 'hot' : ''}`, style: { '--beat': beat.dur } }));
}

function serverItem(s) {
  const status = app.conn.get(s.id) || 'off';
  const err = app.errors.get(s.id);
  const reconnecting = app.reconnect.has(s.id);
  const stateText = status === 'on' ? 'connesso' : status === 'connecting' || reconnecting ? 'connessione in corso' : err ? `errore: ${err}` : 'non connesso';
  return h('div', {
    class: `server-item ${s.id === app.current ? 'current' : ''} ${status} ${err && status !== 'on' ? 'error' : ''}`,
    tabindex: 0,
    role: 'listitem',
    style: { '--server-color': colorOf(s) },
    'data-id': s.id,
    ondragover: (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
    ondragleave: (e) => e.currentTarget.classList.remove('drop'),
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove('drop');
      const paths = [...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
      if (paths.length) publishDialog(s.id, paths);
    },
    title: err && status !== 'on' ? err : `${s.username}@${s.host}`,
    'aria-label': `${s.name}, ${stateText}. Invio per connettere, tasto Menu per altre azioni`,
    onkeydown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (isMenuKey(e)) { e.preventDefault(); e.currentTarget.dispatchEvent(new MouseEvent('contextmenu', menuAnchor(e.currentTarget))); }
      else if (e.key === 'Enter') connectAndOpen(s.id);
      else if (e.key === ' ') { e.preventDefault(); selectServer(s.id); }
    },
    onclick: () => selectServer(s.id),
    ondblclick: () => connectAndOpen(s.id),
    oncontextmenu: (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        status === 'on'
          ? { label: 'Nuovo terminale', icon: 'terminal', action: () => openTerminal(s.id) }
          : { label: 'Connetti', icon: 'power', action: () => connectAndOpen(s.id) },
        status === 'on' && { label: 'Disconnetti', icon: 'logout', action: () => disconnect(s.id) },
        '-',
        { label: 'Diario', icon: 'edit', action: () => openNotes(s.id) },
        { label: 'Macchina del tempo', icon: 'clock', action: () => openTimeline(s.id) },
        status === 'on' && { label: 'Mappa dei servizi', icon: 'activity', action: () => openServices(s.id) },
        '-',
        { label: 'Modifica', icon: 'edit', action: () => editServer(s) },
        { label: 'Duplica', icon: 'filePlus', action: () => editServer({ ...s, id: undefined, name: `${s.name} (copia)` }) },
        s.hasSavedPassphrase && { label: 'Dimentica passphrase salvata', icon: 'key', action: async () => { await api.invoke('servers:forgetPassphrase', s.id); loadServers(); } },
        { label: 'Elimina', icon: 'trash', danger: true, action: () => deleteServer(s) },
      ]);
    },
  },
  serverAvatar(s, reconnecting ? 'connecting' : status, err && status !== 'on'),
  h('div', { class: 'server-text' },
    h('div', { class: 'server-name' }, s.name, s.production && h('span', { class: 'prod-chip', title: 'Server di produzione: i comandi pericolosi chiedono conferma' }, 'prod')),
    h('div', { class: 'server-addr' }, `${s.username}@${s.host}${s.port !== 22 ? `:${s.port}` : ''}`)),
  status === 'on'
    ? iconButton('logout', 'Disconnetti', (e) => { e.stopPropagation(); disconnect(s.id); }, 'hover-only')
    : status === 'connecting' || reconnecting ? h('span', { class: 'spinner' }) : iconButton('power', 'Connetti', (e) => { e.stopPropagation(); connectAndOpen(s.id); }, 'hover-only'));
}

function renderServers() {
  serverSearch.parentElement.classList.toggle('hidden', app.servers.length <= 5);
  if (!app.servers.length) {
    serverList.replaceChildren(h('div', { class: 'empty small' },
      h('p', {}, 'Nessun server salvato.'),
      h('button', { class: 'btn primary small', onclick: () => editServer() }, icon('plus', 14), 'Aggiungi server')));
    homeTab.redraw();
    return;
  }
  const f = app.filter;
  const shown = app.servers.filter((s) => !f || `${s.name} ${s.host} ${s.username} ${s.group || ''}`.toLowerCase().includes(f));
  const groups = new Map();
  for (const s of shown) {
    const g = s.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  const nodes = [];
  for (const g of names) {
    if (g) {
      const isCollapsed = collapsed.has(g) && !f;
      nodes.push(h('button', {
        class: `server-group ${isCollapsed ? 'collapsed' : ''}`,
        type: 'button',
        'aria-expanded': String(!isCollapsed),
        onclick: () => { if (collapsed.has(g)) collapsed.delete(g); else collapsed.add(g); saveCollapsed(); renderServers(); },
      }, icon('chevronDown', 14), h('span', {}, g), h('span', { class: 'server-group-count' }, String(groups.get(g).length))));
      if (isCollapsed) continue;
    }
    nodes.push(...groups.get(g).map(serverItem));
  }
  if (!shown.length) nodes.push(h('div', { class: 'empty small' }, h('p', {}, 'Nessun server corrisponde alla ricerca.')));
  serverList.replaceChildren(...nodes);
  homeTab.redraw();
}

function selectServer(id) {
  if (app.current === id) return;
  app.current = id;
  app.inspectorPeek = false;
  renderServers();
  updatePanel();
  enter(serverCard);
  enter(statsGrid);
}

function updatePanel() {
  const id = app.current;
  const s = serverOf(id);
  const status = app.conn.get(id) || 'off';
  const err = status !== 'on' ? app.errors.get(id) : null;
  const ms = app.latency.get(id);
  updateTitle();
  applyLayout();
  serverCard.replaceChildren(s
    ? h('div', { class: 'server-card-row' },
      serverAvatar(s, app.reconnect.has(id) ? 'connecting' : status, !!err),
      h('div', { class: 'server-text' },
        h('div', { class: 'server-name' }, s.name),
        h('div', { class: 'server-addr' },
          status === 'on' ? (app.stats.get(id)?.hostname || 'connesso') : status === 'connecting' || app.reconnect.has(id) ? 'connessione…' : 'non connesso',
          status === 'on' && ms != null && h('span', { class: 'latency-chip', title: 'Latenza' }, `${ms} ms`))),
      status === 'on'
        ? iconButton('logout', 'Disconnetti', () => disconnect(id), 'round')
        : iconButton('power', 'Connetti', () => connectAndOpen(id), 'round'))
    : h('div', { class: 'muted' }, 'Nessun server selezionato'));

  // Un solo messaggio quando non sei connesso, invece di uno per sezione.
  filesSection.classList.toggle('hidden', !isOn(id));
  const tools = s && h('div', { class: 'tool-row' },
    h('button', { class: 'tool-btn', type: 'button', onclick: () => openTimeline(id) }, icon('clock', 16), h('span', {}, 'Storia')),
    h('button', { class: 'tool-btn', type: 'button', disabled: status !== 'on', onclick: () => openServices(id) }, icon('activity', 16), h('span', {}, 'Servizi')),
    h('button', { class: 'tool-btn', type: 'button', onclick: () => openNotes(id) }, icon('edit', 16), h('span', {}, 'Diario')));
  if (status === 'on') {
    panelBody.replaceChildren(changesCard(id) || '', tools, ...statsSection, tunnelSection, ...screensSection);
    renderTunnels();
  } else {
    panelBody.replaceChildren(h('div', { class: `panel-empty ${err ? 'error' : ''}` },
      err
        ? [h('strong', {}, 'Connessione non riuscita'), h('p', {}, err)]
        : [h('strong', {}, status === 'connecting' || app.reconnect.has(id) ? 'Connessione in corso…' : 'Non connesso'),
          h('p', {}, 'Connettiti per vedere stato, screen e file del server.')],
      s && status !== 'connecting' && !app.reconnect.has(id) && h('div', { class: 'panel-empty-actions' },
        h('button', { class: 'btn primary', onclick: () => connectAndOpen(id) }, err ? 'Riprova' : 'Connetti'),
        err && h('button', { class: 'btn', onclick: () => editServer(s) }, 'Modifica server'))), tools || '');
  }
  files.show(isOn(id) ? id : null);
  screens.refresh(true);
  refreshStats();
}

// ---------- "Mentre eri via": cosa è cambiato sul server dall'ultima visita ----------

function changesCard(id) {
  const c = app.changes.get(id);
  if (!c) return null;
  const ago = (() => {
    const m = Math.round((Date.now() - c.since) / 60000);
    if (m < 60) return `${m} minuti`;
    if (m < 48 * 60) return `${Math.round(m / 60)} ore`;
    return `${Math.round(m / 1440)} giorni`;
  })();
  const items = [];
  if (c.rebooted) items.push(['power', 'Il server è stato riavviato']);
  if (c.logins.length) items.push(['key', `${c.logins.length} access${c.logins.length === 1 ? 'o' : 'i'}`, c.logins.slice(0, 6).map((l) => l.split(/\s+/).slice(0, 3).join(' '))]);
  if (c.packages.length) items.push(['download', `${c.packages.length} pacchett${c.packages.length === 1 ? 'o' : 'i'} installat${c.packages.length === 1 ? 'o' : 'i'} o aggiornat${c.packages.length === 1 ? 'o' : 'i'}`, [...new Set(c.packages.map((p) => p.name))].slice(0, 8)]);
  if (c.etc.length) items.push(['file', `${c.etc.length} file di configurazione modificat${c.etc.length === 1 ? 'o' : 'i'}`, c.etc.slice(0, 8)]);
  if (c.failed.length) items.push(['x', `${c.failed.length} serviz${c.failed.length === 1 ? 'io' : 'i'} in errore`, c.failed]);
  if (Math.abs(c.diskDelta) > 100 * 1024 * 1024) items.push(['activity', `Disco: ${c.diskDelta > 0 ? '+' : '−'}${formatSize(Math.abs(c.diskDelta))}`]);
  const dismiss = () => { app.changes.delete(id); updatePanel(); };
  return h('div', { class: 'changes-card' },
    h('div', { class: 'changes-head' }, h('strong', {}, `Mentre eri via (${ago})`), iconButton('x', 'Chiudi il riepilogo', dismiss)),
    items.length
      ? h('ul', {}, items.map(([ic, text, detail]) => h('li', {},
        icon(ic, 14),
        detail?.length ? h('details', {}, h('summary', {}, text), h('div', { class: 'changes-detail' }, detail.map((d) => h('code', {}, d)))) : h('span', {}, text))))
      : h('p', { class: 'muted' }, 'Nessun cambiamento rilevante.'));
}
api.onChanges?.((id, c) => {
  const interesting = c.rebooted || c.logins.length || c.packages.length || c.etc.length || c.failed.length;
  if (!interesting) return;
  app.changes.set(id, c);
  if (app.current === id) updatePanel();
  else toast(`Ci sono novità su "${serverName(id)}" da quando l'hai lasciato`, 'info', 4000);
});

function renderTunnels() {
  const list = app.tunnels.get(app.current) || [];
  tunnelSection.classList.toggle('hidden', !list.length);
  tunnelList.replaceChildren(...list.map((t) => h('div', { class: `tunnel ${t.ok ? 'ok' : 'bad'}`, title: t.error || 'Attivo' },
    h('span', { class: `status-dot ${t.ok ? 'on' : 'error'}` }),
    h('span', { class: 'tunnel-text' }, h('strong', {}, `localhost:${t.localPort}`), ` → ${t.remoteHost}:${t.remotePort}`),
    t.ok
      ? iconButton('external', `Apri http://localhost:${t.localPort} nel browser`, () => window.open(`http://localhost:${t.localPort}`))
      : h('span', { class: 'tunnel-err' }, t.error))));
}
api.onTunnels?.((id, list) => {
  app.tunnels.set(id, list);
  if (id === app.current) renderTunnels();
});

// ---------- Stato del server ----------

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h2 = Math.floor((sec % 86400) / 3600);
  return d ? `${d}g ${h2}h` : `${h2}h ${Math.floor((sec % 3600) / 60)}m`;
}

// Traguardi di uptime: un piccolo riconoscimento per chi tiene il server acceso a lungo.
const UPTIME_MILESTONES = [[1000, '1000 giorni senza riavvii'], [730, '2 anni senza riavvii'], [365, '1 anno senza riavvii'], [180, '6 mesi senza riavvii'], [100, '100 giorni senza riavvii']];
function uptimeBadge(sec) {
  const days = sec / 86400;
  const m = UPTIME_MILESTONES.find(([d]) => days >= d);
  return m ? h('span', { class: 'uptime-badge', title: 'Traguardo di uptime' }, icon('star', 12), m[1]) : null;
}

// Piccolo grafico degli ultimi minuti.
function sparkline(values) {
  if (!values || values.length < 2) return null;
  const w = 120;
  const hgt = 26;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(hgt - (Math.min(100, v) / 100) * (hgt - 2) - 1).toFixed(1)}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<polyline points="0,${hgt} ${pts} ${w},${hgt}" class="spark-fill"/><polyline points="${pts}" class="spark-line"/>`;
  return svg;
}

function statCard({ label, value, sub, ratio, tone, spark }) {
  const level = ratio == null ? '' : ratio >= 90 ? 'crit' : ratio >= 80 ? 'warn' : '';
  return h('div', { class: `stat ${tone || ''} ${level}` },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
    spark ? sparkline(spark) : ratio != null && h('div', { class: 'stat-bar' }, h('div', { style: { width: `${Math.min(100, ratio)}%` } })),
    h('div', { class: 'stat-sub' }, sub));
}

function renderStats() {
  const st = isOn(app.current) ? app.stats.get(app.current) : null;
  if (!st) {
    statsGrid.replaceChildren(h('div', { class: 'stats-empty' }, 'Caricamento…'));
    return;
  }
  const cpu = pct(st.load, st.cpus);
  const mem = pct(st.memUsed, st.memTotal);
  const hist = app.history.get(app.current) || [];
  const fresh = !statsGrid.querySelector('.stat');
  if (fresh) requestAnimationFrame(() => enter(statsGrid));
  statsGrid.replaceChildren(
    statCard({ label: 'CPU', value: `${cpu}%`, sub: `${st.cpus} core, carico ${st.load.toFixed(2)}`, ratio: cpu, tone: 'accent', spark: hist.length > 1 && hist.map((x) => x.cpu) }),
    statCard({ label: 'Memoria', value: `${mem}%`, sub: `${formatSize(st.memUsed)} di ${formatSize(st.memTotal)}`, ratio: mem, tone: 'blue', spark: hist.length > 1 && hist.map((x) => x.mem) }),
    statCard({ label: 'Disco', value: `${pct(st.diskUsed, st.diskTotal)}%`, sub: `${formatSize(st.diskUsed)} di ${formatSize(st.diskTotal)}`, ratio: pct(st.diskUsed, st.diskTotal), tone: 'green' }),
    statCard({ label: 'Attivo da', value: formatUptime(st.uptime), sub: uptimeBadge(st.uptime) || st.hostname, tone: 'purple' }),
  );
}

async function fetchStats(id) {
  try {
    const [st, ms] = await Promise.all([api.invoke('server:stats', id), api.invoke('ssh:ping', id).catch(() => null)]);
    const hostChanged = app.stats.get(id)?.hostname !== st.hostname;
    app.stats.set(id, st);
    if (ms != null) app.latency.set(id, ms);
    const hist = app.history.get(id) || [];
    hist.push({ cpu: pct(st.load, st.cpus), mem: pct(st.memUsed, st.memTotal) });
    if (hist.length > 30) hist.shift();
    app.history.set(id, hist);
    if (app.current === id) {
      renderStats();
      const addr = serverCard.querySelector('.server-addr');
      if (addr && (hostChanged || ms != null)) {
        addr.replaceChildren(st.hostname, ms != null ? h('span', { class: 'latency-chip', title: 'Latenza' }, `${ms} ms`) : '');
      }
    }
  } catch { /* connessione caduta: lo segnala onConnClosed */ }
}

async function refreshStats() {
  renderStats();
  if (isOn(app.current)) await fetchStats(app.current);
}

// Ogni 10 s: tutti i server connessi (stato, latenza, grafico).
setInterval(async () => {
  if (document.hidden) return;
  const ids = [...app.conn.keys()].filter(isOn);
  await Promise.all(ids.map(fetchStats));
  homeTab.redraw();
  // Aggiorna il battito senza ridisegnare l'elenco (non perde il focus né riavvia le animazioni).
  for (const el of document.querySelectorAll('[data-id] .status-dot.beat, .server-card .status-dot.beat')) {
    const id = el.closest('[data-id]')?.dataset.id || app.current;
    const b = heartbeat(id);
    el.style.setProperty('--beat', b.dur);
    el.classList.toggle('hot', b.hot);
  }
}, 10000);

// ---------- Aggiungi / modifica server ----------

async function editServer(server) {
  const defaultKey = await api.invoke('servers:defaultKey');
  const groups = [...new Set(app.servers.map((s) => s.group).filter(Boolean))];
  const f = {
    name: h('input', { type: 'text', value: server?.name || '', placeholder: 'es. VPS produzione' }),
    host: h('input', { type: 'text', value: server?.host || '', placeholder: 'es. 203.0.113.10 o server.miodominio.it', spellcheck: false }),
    port: h('input', { type: 'number', value: server?.port || 22, min: 1, max: 65535 }),
    username: h('input', { type: 'text', value: server?.username || '', placeholder: 'es. ubuntu', spellcheck: false }),
    group: h('input', { type: 'text', value: server?.group || '', placeholder: 'es. Clienti (facoltativo)', list: 'server-groups', spellcheck: false }),
    auth: h('select', { class: 'select' },
      h('option', { value: 'key' }, 'Chiave privata'),
      h('option', { value: 'agent' }, api.platform === 'win32' ? 'Agent SSH di Windows (OpenSSH)' : 'Agent SSH'),
      api.platform === 'win32' && h('option', { value: 'pageant' }, 'Pageant (PuTTY)')),
    keyPath: h('input', { type: 'text', value: server?.keyPath || '', placeholder: defaultKey, spellcheck: false }),
    agentForward: h('input', { type: 'checkbox', checked: !!server?.agentForward }),
    jump: h('select', { class: 'select' },
      h('option', { value: '' }, 'Nessuno (connessione diretta)'),
      app.servers.filter((s) => s.id !== server?.id).map((s) => h('option', { value: s.id }, `${s.name} (${s.host})`))),
    startPath: h('input', { type: 'text', value: server?.startPath || '', placeholder: 'cartella home', spellcheck: false }),
    tunnels: h('textarea', { class: 'textarea', rows: 3, spellcheck: false, placeholder: 'una riga per tunnel, es.\n8080:localhost:80\n5433:db.interno:5432' }),
  };
  // Identità: colore e sigla, ripresi in barra laterale, schede e bordo del terminale.
  let color = server?.color || '';
  f.glyph = h('input', { type: 'text', value: server?.glyph || '', maxlength: 2, placeholder: glyphOf(server || { name: '' }), spellcheck: false, class: 'glyph-input', 'aria-label': 'Sigla (2 lettere)' });
  f.production = h('input', { type: 'checkbox', checked: !!server?.production });
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colore del server' });
  const preview = h('span', { class: 'identity-preview' });
  const syncIdentity = () => {
    const tmp = { id: server?.id || f.name.value, name: f.name.value || f.host.value, color, glyph: f.glyph.value };
    preview.replaceChildren(serverBadge(tmp, 'large'));
    f.glyph.placeholder = glyphOf({ name: tmp.name });
    swatches.replaceChildren(...SERVER_COLORS.map((c, i) => h('button', {
      type: 'button', class: `swatch ${colorOf(tmp) === c ? 'active' : ''}`, role: 'radio', 'aria-checked': String(colorOf(tmp) === c), 'aria-label': `Colore ${i + 1}`,
      style: { '--swatch': c }, onclick: () => { color = c; syncIdentity(); },
    })));
  };
  f.name.addEventListener('input', syncIdentity);
  f.glyph.addEventListener('input', syncIdentity);
  syncIdentity();
  f.auth.value = server?.auth || 'key';
  f.jump.value = server?.jump || '';
  f.tunnels.value = (server?.tunnels || []).map((t) => `${t.localPort}:${t.remoteHost}:${t.remotePort}`).join('\n');
  const field = (label, input, extra) => h('label', { class: 'field' }, h('span', {}, label), extra ? h('div', { class: 'row' }, input, extra) : input);
  const keyField = field('Chiave privata', f.keyPath, h('button', {
    class: 'btn', type: 'button',
    onclick: async () => { const p = await api.invoke('dialog:pickKey'); if (p) f.keyPath.value = p; },
  }, 'Sfoglia…'));
  const forwardField = h('label', { class: 'check' }, f.agentForward, h('span', {}, 'Inoltra l\'agent al server (agent forwarding)'));
  const syncAuth = () => {
    keyField.classList.toggle('hidden', f.auth.value !== 'key');
    forwardField.classList.toggle('hidden', f.auth.value === 'key');
  };
  f.auth.addEventListener('change', syncAuth);
  syncAuth();
  const advanced = h('details', { class: 'advanced', open: !!(server?.jump || server?.tunnels?.length || server?.startPath) },
    h('summary', {}, 'Avanzate'),
    field('Jump host (passa da un altro server)', f.jump),
    field('Tunnel locali', f.tunnels),
    field('Cartella iniziale dei file', f.startPath));
  const body = h('div', { class: 'form-grid' },
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Nome', f.name)), h('div', { class: 'grow' }, field('Gruppo', f.group))),
    h('datalist', { id: 'server-groups' }, groups.map((g) => h('option', { value: g }))),
    h('div', { class: 'identity-row' }, preview,
      h('div', { class: 'field grow' }, h('span', {}, 'Colore'), swatches),
      h('label', { class: 'field' }, h('span', {}, 'Sigla'), f.glyph)),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Host', f.host)), h('div', { class: 'port' }, field('Porta', f.port))),
    field('Utente', f.username),
    field('Autenticazione', f.auth),
    keyField,
    forwardField,
    h('label', { class: 'check' }, f.production, h('span', {}, 'Server di produzione: chiedi conferma prima dei comandi pericolosi (rm -rf, reboot, DROP TABLE…)')),
    advanced,
    h('p', { class: 'hint' }, icon('shield', 14), 'La chiave resta sul tuo PC. Se è protetta da passphrase te la chiedo alla connessione e, se vuoi, la salvo cifrata con il sistema.'));

  const saved = await modal({
    title: server?.id ? 'Modifica server' : 'Nuovo server',
    body,
    wide: true,
    actions: [
      { label: 'Annulla', result: null },
      {
        label: 'Salva',
        kind: 'primary',
        value: async () => {
          const data = {
            name: f.name.value.trim(),
            host: f.host.value.trim(),
            port: f.port.value,
            username: f.username.value.trim(),
            group: f.group.value.trim(),
            auth: f.auth.value,
            keyPath: f.keyPath.value.trim(),
            agentForward: f.agentForward.checked,
            jump: f.jump.value,
            startPath: f.startPath.value.trim(),
            tunnels: f.tunnels.value.split('\n').map((l) => l.trim()).filter(Boolean),
            color,
            glyph: f.glyph.value.trim(),
            production: f.production.checked,
          };
          const missing = ['host', 'username'].filter((k) => !data[k]);
          for (const k of ['host', 'username']) f[k].setAttribute('aria-invalid', String(missing.includes(k)));
          if (missing.length) {
            toast('Host e utente sono obbligatori', 'warn');
            f[missing[0]].focus();
            return undefined;
          }
          const bad = data.tunnels.filter((l) => !/^\d{1,5}:[^:\s]+:\d{1,5}$/.test(l));
          if (bad.length) {
            toast(`Tunnel non valido: "${bad[0]}". Usa porta-locale:host:porta`, 'warn');
            advanced.open = true;
            f.tunnels.focus();
            return undefined;
          }
          try {
            return await api.invoke('servers:save', { ...data, id: server?.id });
          } catch (e) {
            fail(e);
            return undefined;
          }
        },
      },
    ],
  });
  if (saved) {
    await loadServers();
    selectServer(saved.id);
  }
}

async function deleteServer(s) {
  if (!(await confirmDialog(`Eliminare "${s.name}"?`, 'Viene rimosso solo dall\'elenco di Screenie. Il server e la chiave non vengono toccati.', { ok: 'Elimina' }))) return;
  closeServerTabs(s.id, true);
  app.closing.add(s.id);
  await api.invoke('servers:delete', s.id);
  app.conn.delete(s.id);
  app.errors.delete(s.id);
  files.forget(s.id);
  if (app.current === s.id) app.current = null;
  await loadServers();
  updatePanel();
}

// ---------- Importa da ~/.ssh/config ----------

async function importSshConfig() {
  let cfg;
  try { cfg = await api.invoke('servers:readSshConfig'); } catch (e) { fail(e); return; }
  const exists = (h2) => app.servers.some((s) => s.host === h2.host && s.username === (h2.username || 'root') && Number(s.port) === Number(h2.port));
  const fresh = cfg.hosts.filter((x) => !exists(x));
  if (!cfg.hosts.length) {
    await modal({ title: 'Importa da ~/.ssh/config', body: h('p', {}, `Non ho trovato server in ${cfg.path}.`), actions: [{ label: 'OK', kind: 'primary', result: null }] });
    return;
  }
  if (!fresh.length) { toast('Tutti i server di ~/.ssh/config sono già in Screenie', 'ok'); return; }
  const checks = fresh.map((x) => ({ x, box: h('input', { type: 'checkbox', checked: true }) }));
  const ok = await modal({
    title: 'Importa da ~/.ssh/config',
    wide: true,
    body: h('div', {},
      h('p', {}, `Ho trovato ${fresh.length} server da aggiungere:`),
      h('div', { class: 'import-list' }, checks.map(({ x, box }) => h('label', { class: 'import-row' }, box,
        h('span', { class: 'import-name' }, x.alias),
        h('span', { class: 'import-addr' }, `${x.username || 'root'}@${x.host}${x.port !== 22 ? `:${x.port}` : ''}${x.jumpAlias ? ` · via ${x.jumpAlias}` : ''}`)))),
      fresh.some((x) => !x.username) && h('p', { class: 'muted' }, 'Dove l\'utente non è indicato uso "root": puoi cambiarlo dopo.')),
    actions: [
      { label: 'Annulla', result: null },
      { label: 'Importa', kind: 'primary', result: true },
    ],
  });
  if (!ok) return;
  const chosen = checks.filter((c) => c.box.checked).map((c) => c.x);
  const ids = new Map(app.servers.map((s) => [s.name, s.id]));
  let n = 0;
  for (const x of chosen) {
    try {
      const s = await api.invoke('servers:save', { name: x.alias, host: x.host, port: x.port, username: x.username || 'root', keyPath: x.keyPath, group: 'ssh config' });
      ids.set(x.alias, s.id);
      n++;
    } catch { /* saltato */ }
  }
  // Secondo giro: collega i jump host ora che hanno un id.
  for (const x of chosen.filter((c) => c.jumpAlias && ids.has(c.jumpAlias))) {
    const s = (await api.invoke('servers:list')).find((y) => y.id === ids.get(x.alias));
    if (s) await api.invoke('servers:save', { ...s, jump: ids.get(x.jumpAlias) }).catch(() => {});
  }
  toast(`${n} server importati`, 'ok');
  await loadServers();
}

// ---------- Connessione ----------

async function connect(id, { quiet = false } = {}) {
  if (isOn(id)) return true;
  if (app.conn.get(id) === 'connecting') return false;
  app.conn.set(id, 'connecting');
  app.errors.delete(id);
  if (!quiet) selectServer(id);
  renderServers();
  updatePanel();
  try {
    const { home, tunnels } = await api.invoke('ssh:connect', id);
    app.conn.set(id, 'on');
    app.tunnels.set(id, tunnels || []);
    files.forget(id);
    if (app.current === id) files.show(id, home);
    screens.start();
    fetchStats(id);
    return true;
  } catch (e) {
    app.conn.delete(id);
    // L'errore resta visibile sul server (barra laterale, pannello, Home) con "Riprova".
    if (e.message !== 'Connessione annullata') app.errors.set(id, e.message);
    if (quiet) throw e;
    return false;
  } finally {
    renderServers();
    updatePanel();
  }
}

async function connectAndOpen(id) {
  selectServer(id);
  if (isOn(id)) {
    if (!app.tabs.some((t) => t.serverId === id)) openTerminal(id);
    else activate(app.tabs.find((t) => t.serverId === id).uid);
    return;
  }
  if (await connect(id)) openTerminal(id);
}

async function disconnect(id) {
  const dirty = app.tabs.filter((t) => t.serverId === id && t.isDirty?.());
  if (dirty.length && !(await confirmDialog('Ci sono file non salvati', `${dirty.map((t) => t.title).join(', ')} hanno modifiche non salvate. Disconnettere comunque?`, { ok: 'Disconnetti' }))) return;
  stopReconnect(id);
  app.closing.add(id);
  closeServerTabs(id, true);
  await api.invoke('ssh:disconnect', id).catch(() => {});
}

// Riconnessione automatica quando la connessione cade da sola.
const RETRY = [1000, 2000, 4000, 8000, 15000, 30000];
function stopReconnect(id) {
  clearTimeout(app.reconnect.get(id)?.timer);
  app.reconnect.delete(id);
}
function scheduleReconnect(id, tries = 0) {
  if (tries >= RETRY.length) {
    stopReconnect(id);
    app.errors.set(id, 'Connessione persa e non ripristinata. Riprova quando il server è di nuovo raggiungibile.');
    toast(`Non riesco a riconnettermi a "${serverName(id)}"`, 'error', 6000);
    renderServers();
    updatePanel();
    return;
  }
  const timer = setTimeout(async () => {
    try {
      await connect(id, { quiet: true });
      stopReconnect(id);
      for (const t of app.tabs.filter((x) => x.serverId === id)) t.restart?.();
      toast(`Riconnesso a "${serverName(id)}"`, 'ok', 2500);
      renderServers();
      updatePanel();
    } catch (e) {
      if (e.message === 'Connessione annullata') { stopReconnect(id); renderServers(); updatePanel(); return; }
      app.errors.delete(id);
      scheduleReconnect(id, tries + 1);
    }
  }, RETRY[tries]);
  app.reconnect.set(id, { tries, timer });
}

api.onConnClosed((id) => {
  const wasOn = app.conn.get(id) === 'on';
  const wanted = app.closing.delete(id);
  app.conn.delete(id);
  app.tunnels.delete(id);
  files.forget(id);
  for (const t of app.tabs.filter((x) => x.serverId === id)) t.setState?.('off');
  if (wasOn && !wanted && serverOf(id)) {
    scheduleReconnect(id);
    toast(`Connessione a "${serverName(id)}" persa: riconnessione…`, 'warn');
  }
  renderServers();
  updatePanel();
});

// ---------- Schede ----------

let tabSeq = 0;
let dragging = null;
const TAB_ICONS = { editor: 'file', screen: 'layers', home: 'home', settings: 'settings', history: 'clock', recipes: 'snippet', timeline: 'clock', services: 'activity', notes: 'edit' };

function addTab(tab, { background = false } = {}) {
  tab.uid = `tab${++tabSeq}`;
  const label = h('span', { class: 'tab-label' }, tab.title);
  const dot = h('span', { class: 'tab-state' });
  const btn = h('div', {
    class: `tab kind-${tab.kind}`,
    role: 'tab',
    tabindex: 0,
    draggable: tab.kind !== 'home' ? 'true' : null,
    'aria-selected': 'false',
    onkeydown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(tab.uid); }
      else if (e.key === 'Delete') closeTab(tab.uid);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const i = app.tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
        const next = app.tabs[(i + app.tabs.length) % app.tabs.length];
        activate(next.uid);
        next.btn.focus();
      }
    },
    title: tab.serverId ? `${serverName(tab.serverId)} · ${tab.path || tab.title}` : tab.title,
    onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.uid); } },
    onclick: () => activate(tab.uid),
    // Riordino trascinando le schede (la Home resta prima).
    ondragstart: (e) => { dragging = btn; btn.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; },
    ondragend: () => {
      btn.classList.remove('dragging');
      dragging = null;
      const order = [...tabBar.children];
      app.tabs.sort((a, b) => order.indexOf(a.btn) - order.indexOf(b.btn));
      saveSession();
    },
    ondragover: (e) => {
      if (!dragging || dragging === btn || tab.kind === 'home') return;
      e.preventDefault();
      const r = btn.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      tabBar.insertBefore(dragging, after ? btn.nextSibling : btn);
    },
  },
  dot,
  icon(TAB_ICONS[tab.kind] || 'terminal', 14),
  label,
  tab.kind !== 'home' && h('button', {
    class: 'tab-close',
    type: 'button',
    tabindex: -1, // da tastiera si chiude con Canc sulla scheda
    title: tab.kind === 'screen' ? 'Chiudi scheda (lo screen resta attivo)' : 'Chiudi',
    'aria-label': `Chiudi ${tab.title}`,
    onclick: (e) => { e.stopPropagation(); closeTab(tab.uid); },
  }, icon('x', 12)));
  if (tab.serverId) {
    const color = colorOf(serverOf(tab.serverId));
    btn.classList.add('has-server');
    btn.style.setProperty('--server-color', color);
    tab.el.style.setProperty('--server-color', color);
  }
  tab.btn = btn;
  tab.label = label;
  tab.setState = (s) => btn.classList.toggle('dead', s === 'off');
  tab.setDirty = (d) => btn.classList.toggle('dirty', d);
  tab.setActivity = (a) => btn.classList.toggle('activity', a && app.active !== tab.uid);
  tab.close = (opts) => closeTab(tab.uid, opts?.force);
  app.tabs.push(tab);
  tabBar.append(btn);
  tab.el.classList.add('hidden');
  tabArea.append(tab.el);
  if (!background) activate(tab.uid);
  saveSession();
  return tab;
}

const PAGE_KINDS = new Set(['home', 'settings', 'history', 'recipes', 'timeline', 'services', 'notes']);

function activate(uid) {
  const tab = app.tabs.find((t) => t.uid === uid);
  if (!tab) return;
  if (app.active !== uid) enter(tab.el, 1600);
  app.active = uid;
  for (const t of app.tabs) {
    t.btn.classList.toggle('active', t === tab);
    t.btn.setAttribute('aria-selected', String(t === tab));
    t.el.classList.toggle('hidden', t !== tab);
  }
  tab.btn.classList.remove('activity');
  tab.btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  tabArea.parentElement.classList.toggle('is-page', PAGE_KINDS.has(tab.kind));
  // Il bordo dell'area terminale prende il colore del server della scheda attiva.
  const sv = tab.serverId && (tab.kind === 'term' || tab.kind === 'screen') ? serverOf(tab.serverId) : null;
  tabArea.parentElement.classList.toggle('server-tinted', !!sv);
  if (sv) tabArea.parentElement.style.setProperty('--server-color', colorOf(sv));
  if (tab.serverId && tab.serverId !== app.current) selectServer(tab.serverId);
  updateTitle();
  tab.show();
  saveSession();
}

async function closeTab(uid, force = false) {
  const i = app.tabs.findIndex((t) => t.uid === uid);
  if (i < 0) return;
  const tab = app.tabs[i];
  if (tab.kind === 'home') return;
  if (!force && tab.isDirty?.()) {
    const r = await modal({
      title: `Salvare "${tab.title}"?`,
      body: h('p', {}, 'Ci sono modifiche non ancora salvate sul server.'),
      actions: [
        { label: 'Annulla', result: null },
        { label: 'Non salvare', kind: 'danger-ghost', result: 'discard' },
        { label: 'Salva', kind: 'primary', result: 'save' },
      ],
    });
    if (!r) return;
    if (r === 'save' && !(await tab.save())) return;
  }
  tab.dispose();
  leave(tab.btn, [
    { opacity: 1, maxWidth: `${tab.btn.offsetWidth}px` },
    { opacity: 0, maxWidth: '0px', paddingLeft: '0px', paddingRight: '0px', marginRight: '-8px' },
  ], 160);
  tab.el.remove();
  app.tabs.splice(i, 1);
  if (app.active === uid) {
    const next = app.tabs[i] || app.tabs[i - 1] || homeTab;
    activate(next.uid);
  }
  if (tab.kind === 'screen') setTimeout(() => screens.refresh(true), 300);
  saveSession();
}

function closeServerTabs(id, force) {
  for (const t of app.tabs.filter((x) => x.serverId === id)) closeTab(t.uid, force);
}

// Etichetta delle schede terminale: "VPS · 1", "VPS · 2"… (il titolo della shell va in alto).
function termLabel(serverId) {
  const used = new Set(app.tabs.filter((t) => t.serverId === serverId && t.kind === 'term').map((t) => t.n));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function onTermTitle(tab) {
  if (tab.uid === app.active) updateTitle();
}

async function openTerminal(serverId, { command, cwd, background = false } = {}) {
  if (!serverId || !(await connect(serverId))) return null;
  const cmd = cwd ? `cd ${q(cwd)} && exec bash -l` : command;
  const n = termLabel(serverId);
  const tab = createTerminalTab({
    serverId,
    title: cwd ? `${serverName(serverId)} · ${cwd.split('/').pop() || '/'}` : `${serverName(serverId)} · ${n}`,
    command: cmd,
    fontSize: app.settings.fontSize,
    onTitle: onTermTitle,
  });
  tab.n = n;
  return addTab(tab, { background });
}

async function openScreenTab(serverId, s, { background = false } = {}) {
  const existing = app.tabs.find((t) => t.serverId === serverId && t.screen?.id === s.id);
  if (existing) return background ? existing : activate(existing.uid);
  const command = await api.invoke('screen:attachCommand', s.id);
  const tab = createTerminalTab({
    serverId,
    title: s.name,
    command,
    screen: s,
    fontSize: app.settings.fontSize,
    onScreenGone: () => setTimeout(() => screens.refresh(true), 300),
    onTitle: onTermTitle,
  });
  tab.killScreen = async () => {
    if (!(await confirmDialog(`Terminare lo screen "${s.name}"?`, 'Lo screen e i programmi che ci girano dentro verranno chiusi.', { ok: 'Termina' }))) return;
    try {
      await api.invoke('screen:kill', serverId, s.id);
    } catch (e) {
      fail(e);
    }
  };
  return addTab(tab, { background });
}

async function openEditor(serverId, path, { background = false } = {}) {
  const existing = app.tabs.find((t) => t.serverId === serverId && t.path === path);
  if (existing) return background ? existing : activate(existing.uid);
  const tab = await createEditorTab({
    serverId,
    path,
    settings: app.settings,
    onDirtyChange: (d) => tab.setDirty?.(d),
  });
  return addTab(tab, { background });
}

// ---------- Schede speciali: cronologia, ricette, storia, servizi, diario ----------

function openSingle(find, make) {
  const existing = app.tabs.find(find);
  if (existing) { activate(existing.uid); return existing; }
  return addTab(make());
}

let recipesTab = null;
function openRecipes(steps) {
  const tab = openSingle((t) => t.kind === 'recipes', () => {
    recipesTab = createRecipesTab({
      settings: app.settings,
      change: changeSettings,
      servers: () => app.servers,
      serverOf,
      current: () => app.current,
      connect: (id) => connect(id, { quiet: true }).catch(() => false),
      onCommand: (id, cmd) => api.invoke('data:addHistory', id, cmd).catch(() => {}),
    });
    const dispose = recipesTab.dispose;
    recipesTab.dispose = () => { dispose(); recipesTab = null; };
    return recipesTab;
  });
  if (steps) tab.newFrom(steps);
  return tab;
}

// Scrive un comando nel terminale del server (aprendone uno se serve), con o senza Invio.
async function sendToServer(serverId, cmd, run) {
  if (!(await connect(serverId))) return;
  let t = app.tabs.find((x) => x.serverId === serverId && x.kind === 'term' && x.uid === app.active)
    || app.tabs.find((x) => x.serverId === serverId && x.kind === 'term');
  if (!t) {
    t = await openTerminal(serverId);
    await new Promise((r) => setTimeout(r, 900)); // tempo per far comparire il prompt
  } else activate(t.uid);
  if (!t) return;
  // Più righe: le esegue una alla volta come se le scrivessi.
  const text = cmd.replace(/\r?\n/g, '\r');
  if (run) await t.send(`${text}\r`);
  else await t.send(text);
}

function openHistory() {
  return openSingle((t) => t.kind === 'history', () => createHistoryTab({
    servers: () => app.servers,
    serverOf,
    run: (id, cmd) => sendToServer(id, cmd, true),
    insert: (id, cmd) => sendToServer(id, cmd, false),
    newRecipe: (steps) => openRecipes(steps),
  }));
}

function openTimeline(id) {
  return openSingle((t) => t.kind === 'timeline' && t.serverId === id, () => createTimelineTab(id, {
    serverOf,
    openTerminal: (sid, command) => openTerminal(sid, { command }),
  }));
}

function openServices(id) {
  return openSingle((t) => t.kind === 'services' && t.serverId === id, () => createServicesTab(id, {
    serverOf,
    isOn,
    openTerminal: (sid, command) => openTerminal(sid, { command }),
  }));
}

function openNotes(id) {
  return openSingle((t) => t.kind === 'notes' && t.serverId === id, () => createNotesTab(id, {
    serverOf,
    run: (sid, cmd) => sendToServer(sid, cmd, true),
  }));
}

// ---------- Trascina e pubblica: una cartella dal desktop su un server ----------

async function publishDialog(serverId, paths) {
  const s = serverOf(serverId);
  if (!s) return;
  const base = (paths.length === 1 ? paths[0].split(/[\\/]/).pop() : '') || '';
  const dirInput = h('input', { type: 'text', class: 'mono', spellcheck: false, value: files.currentDir?.(serverId) || s.startPath || `/home/${s.username}`, 'aria-label': 'Cartella sul server' });
  const reload = h('input', { type: 'checkbox' });
  const names = paths.map((p) => p.split(/[\\/]/).pop());
  const r = await modal({
    title: `Pubblica su ${s.name}`,
    body: h('div', { class: 'form-grid' },
      h('div', { class: 'publish-files' }, serverBadge(s), h('div', {}, h('strong', {}, names.length === 1 ? base : `${names.length} elementi`), h('span', { class: 'muted' }, names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : '')))),
      h('label', { class: 'field' }, h('span', {}, 'Cartella di destinazione sul server'), dirInput, h('small', {}, 'File e cartelle vengono copiati dentro questa cartella; quelli con lo stesso nome vengono sovrascritti.')),
      h('label', { class: 'check' }, reload, h('span', {}, 'Dopo il caricamento ricarica nginx (controlla prima la configurazione)')),
      s.production && h('p', { class: 'hint warn' }, icon('shield', 14), 'È un server di produzione: controlla bene la cartella.')),
    actions: [{ label: 'Annulla', result: null }, { label: 'Pubblica', kind: 'primary', value: () => dirInput.value.trim() || undefined }],
  });
  if (!r) return;
  if (!(await connect(serverId))) return;
  try {
    await api.invoke('sftp:mkdir', serverId, r).catch(() => {});
    await api.invoke('sftp:upload', serverId, paths, r);
    toast(`Pubblicato in ${r}`, 'ok');
    if (reload.checked) {
      const out = await api.invoke('recipe:step', serverId, `pub${Date.now()}`, 'if [ "$(id -u)" = 0 ]; then nginx -t && (systemctl reload nginx || nginx -s reload); else sudo -n nginx -t && (sudo -n systemctl reload nginx || sudo -n nginx -s reload); fi', '');
      if (out.code === 0) toast('nginx ricaricato', 'ok');
      else toast(`nginx non ricaricato: ${out.out.split('\n').pop() || 'serve sudo senza password'}`, 'error', 7000);
    }
    if (app.current === serverId) files.refresh();
  } catch (e) { fail(e); }
}

// ---------- Condivisione in rete locale ----------

async function shareDialog(tab) {
  const p = tab.activePane;
  if (!p?.alive) { toast('La sessione non è attiva', 'warn'); return; }
  let info = app.shares.get(p.id);
  if (!info) {
    try {
      const r = await api.invoke('share:start', p.id, { cols: p.cols, rows: p.rows, title: `${serverName(tab.serverId)} · ${tab.termTitle || tab.title}` });
      info = { url: r.url, viewers: 0, allowInput: false };
      app.shares.set(p.id, info);
      tab.btn.classList.add('shared');
    } catch (e) { fail(e); return; }
  }
  const viewers = h('span', { class: 'muted' });
  const syncViewers = () => { viewers.textContent = info.viewers ? `${info.viewers} person${info.viewers === 1 ? 'a sta' : 'e stanno'} guardando` : 'Ancora nessuno sta guardando'; };
  syncViewers();
  const off = api.onShare?.((e) => { if (e.termId === p.id) { info.viewers = e.viewers; syncViewers(); } });
  const allow = h('input', { type: 'checkbox', checked: info.allowInput, onchange: (e) => { info.allowInput = e.target.checked; api.invoke('share:setInput', p.id, info.allowInput); } });
  const link = h('input', { type: 'text', class: 'mono', readonly: true, value: info.url, 'aria-label': 'Link della sessione', onfocus: (e) => e.target.select() });
  const r = await modal({
    title: 'Condividi questo terminale',
    body: h('div', { class: 'form-grid' },
      h('p', {}, 'Chi è sulla tua stessa rete (stesso Wi-Fi o ufficio) può aprire questo link nel browser e vedere il terminale in diretta.'),
      h('div', { class: 'row' }, link, h('button', { class: 'btn', onclick: () => { navigator.clipboard.writeText(info.url); toast('Link copiato', 'ok', 1500); } }, 'Copia')),
      viewers,
      h('label', { class: 'check' }, allow, h('span', {}, 'Permetti di scrivere nel terminale')),
      h('p', { class: 'hint' }, icon('shield', 14), 'Il link contiene un codice casuale e smette di funzionare quando interrompi o chiudi il terminale. Windows potrebbe chiederti di consentire Screenie nel firewall.')),
    actions: [{ label: 'Interrompi condivisione', kind: 'danger-ghost', result: 'stop' }, { label: 'Chiudi', kind: 'primary', result: null }],
  });
  off?.();
  if (r === 'stop') {
    await api.invoke('share:stop', p.id).catch(() => {});
    app.shares.delete(p.id);
    tab.btn.classList.remove('shared');
    toast('Condivisione interrotta', 'ok', 2000);
  }
}

// ---------- Sessione: riapre le schede all'avvio ----------

let sessionTimer = null;
let restoring = false;
function saveSession() {
  if (restoring) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    const session = app.tabs.filter((t) => t.serverId && ['term', 'screen', 'editor'].includes(t.kind)).map((t) => ({
      ...(t.kind === 'editor' ? { kind: 'editor', serverId: t.serverId, path: t.path } : t.sessionInfo?.() || { kind: t.kind, serverId: t.serverId }),
      active: t.uid === app.active,
    }));
    if (JSON.stringify(session) !== JSON.stringify(app.settings.session || [])) changeSettings({ session });
  }, 600);
}

async function restoreSession() {
  const list = (app.settings.session || []).filter((t) => serverOf(t.serverId));
  if (!app.settings.restoreSession || !list.length) return;
  restoring = true;
  let toActivate = null;
  try {
    const servers = [...new Set(list.map((t) => t.serverId))];
    for (const id of servers) {
      if (!(await connect(id))) continue;
      let screenList = null;
      for (const t of list.filter((x) => x.serverId === id)) {
        let tab = null;
        if (t.kind === 'term') {
          tab = await openTerminal(id, { background: true });
          if (tab) restoreSplits(tab, t);
        } else if (t.kind === 'screen' && t.screen) {
          screenList ||= await api.invoke('screen:list', id).catch(() => ({ sessions: [] }));
          const s = screenList.sessions.find((x) => x.name === t.screen && !x.dead);
          if (s) tab = await openScreenTab(id, s, { background: true });
        } else if (t.kind === 'editor' && t.path) {
          tab = await openEditor(id, t.path, { background: true }).catch(() => null);
        }
        if (tab && t.active) toActivate = tab;
      }
    }
  } finally {
    restoring = false;
  }
  if (toActivate?.uid) activate(toActivate.uid);
  saveSession();
}

// ---------- Richieste dal main process (host key, passphrase) ----------

api.onPrompt(async (req) => {
  let value = null;
  if (req.kind === 'hostkey-new') {
    value = await modal({
      title: 'Nuovo server: verifica l\'identità',
      body: h('div', {},
        h('p', {}, `È la prima connessione a ${req.host}. L'impronta della sua chiave è:`),
        h('code', { class: 'fingerprint' }, req.fingerprint),
        h('p', { class: 'muted' }, 'Se vuoi esserne certo, confrontala sul server con: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub. Screenie la ricorderà e ti avviserà se dovesse cambiare.')),
      actions: [
        { label: 'Annulla', result: false },
        { label: 'Mi fido, connetti', kind: 'primary', result: true },
      ],
    });
  } else if (req.kind === 'hostkey-changed') {
    value = await modal({
      title: '⚠ L\'identità del server è cambiata',
      body: h('div', {},
        h('p', {}, `La chiave di ${req.host} non corrisponde a quella salvata. Può succedere se hai reinstallato il server, ma può anche indicare un attacco (qualcuno che si spaccia per il tuo server).`),
        h('p', { class: 'muted' }, 'Prima:'), h('code', { class: 'fingerprint' }, req.previous),
        h('p', { class: 'muted' }, 'Ora:'), h('code', { class: 'fingerprint bad' }, req.fingerprint),
        h('p', {}, 'Accetta solo se sai perché è cambiata.')),
      actions: [
        { label: 'Non connettere', kind: 'primary', result: false },
        { label: 'Accetta la nuova chiave', kind: 'danger-ghost', result: true },
      ],
    });
  } else if (req.kind === 'passphrase') {
    const input = h('input', { type: 'password', autocomplete: 'off' });
    const remember = h('input', { type: 'checkbox' });
    value = await modal({
      title: `Passphrase per ${req.server}`,
      body: h('div', {},
        req.retry && h('p', { class: 'error-text' }, 'Passphrase errata, riprova.'),
        h('label', { class: 'field' }, h('span', {}, `Chiave ${req.keyPath}`), input),
        h('label', { class: 'check' }, remember, h('span', {}, 'Ricorda (cifrata con il sistema operativo)'))),
      actions: [
        { label: 'Annulla', result: null },
        { label: 'Sblocca', kind: 'primary', value: () => (input.value ? { passphrase: input.value, remember: remember.checked } : undefined) },
      ],
    });
  }
  api.invoke('prompt:answer', req.id, value);
});

// ---------- Trasferimenti ----------

const transferEls = new Map();
api.onTransfer((t) => {
  let el = transferEls.get(t.id);
  if (!el) {
    el = {
      root: h('div', { class: 'transfer' }),
      label: h('div', { class: 'transfer-label' }),
      bar: h('div', { class: 'transfer-bar-fill' }),
      info: h('div', { class: 'transfer-info' }),
    };
    el.root.append(el.label, h('div', { class: 'transfer-bar' }, el.bar), el.info);
    transfers.prepend(el.root);
    transferEls.set(t.id, el);
  }
  const p = t.total ? Math.min(100, (t.done / t.total) * 100) : t.state === 'done' ? 100 : 0;
  el.label.replaceChildren(icon(t.kind === 'upload' ? 'upload' : 'download', 13), h('span', {}, t.label));
  el.bar.style.width = `${p}%`;
  el.root.className = `transfer ${t.state}`;
  if (!el.started) el.started = Date.now();
  const secs = (Date.now() - el.started) / 1000;
  const speed = secs > 0.5 ? `${formatSize(t.done / secs)}/s` : '';
  el.info.textContent = t.state === 'error'
    ? t.error
    : t.state === 'done'
      ? `Completato · ${formatSize(t.total)}`
      : `${formatSize(t.done)} di ${formatSize(t.total)} ${speed && `· ${speed}`}`;
  if (t.state !== 'running') {
    setTimeout(() => {
      el.root.classList.add('leaving');
      setTimeout(() => { el.root.remove(); transferEls.delete(t.id); }, 300);
    }, t.state === 'error' ? 8000 : 3000);
  }
});

api.onExternalSaved((r) => {
  const name = r.remote.split('/').pop();
  if (r.ok) toast(`${name} caricato sul server`, 'ok', 2000);
  else toast(`Errore caricando ${name}: ${r.error}`, 'error', 6000);
});

// ---------- Comandi ----------

const fontStep = (d) => changeSettings({ fontSize: d === 0 ? 14 : Math.max(9, Math.min(28, app.settings.fontSize + d)) });
const cycleTab = (d) => {
  if (!app.tabs.length) return;
  const i = app.tabs.findIndex((t) => t.uid === app.active);
  activate(app.tabs[(i + d + app.tabs.length) % app.tabs.length].uid);
};
const activeTab = () => app.tabs.find((t) => t.uid === app.active);
const activeTerm = () => {
  const t = activeTab();
  return t && (t.kind === 'term' || t.kind === 'screen') ? t : null;
};

const commands = {
  palette: () => openPalette(paletteItems),
  newTerminal: () => { if (app.current) openTerminal(app.current); else toast('Seleziona prima un server', 'warn'); },
  newScreen: () => { app.inspectorPeek = true; applyLayout(); screens.focusNew(); },
  closeTab: () => { if (app.active) closeTab(app.active); },
  save: () => activeTab()?.save?.(),
  settings: () => openSettings(),
  shortcuts: () => showShortcuts(app.settings.keys),
  addServer: () => editServer(),
  importSshConfig: () => importSshConfig(),
  disconnect: () => { if (isOn(app.current)) disconnect(app.current); },
  toggleSidebar: () => changeSettings({ hideSidebar: !app.settings.hideSidebar }),
  toggleInspector: () => {
    if (inspectorHidden()) {
      app.inspectorPeek = true;
      if (app.settings.hideInspector) changeSettings({ hideInspector: false });
      else applyLayout();
    } else {
      app.inspectorPeek = false;
      changeSettings({ hideInspector: true });
    }
  },
  search: () => { const t = activeTerm(); if (t) t.openSearch(); else toast('Apri un terminale per cercare', 'warn'); },
  splitRight: () => { const t = activeTerm(); if (t?.kind === 'term') { t.split('row'); saveSession(); } else toast('Si possono dividere solo le schede terminale', 'warn'); },
  splitDown: () => { const t = activeTerm(); if (t?.kind === 'term') { t.split('col'); saveSession(); } else toast('Si possono dividere solo le schede terminale', 'warn'); },
  broadcast: () => setBroadcast(!isBroadcasting()),
  nextTab: () => cycleTab(1),
  prevTab: () => cycleTab(-1),
  fontBigger: () => fontStep(1),
  fontSmaller: () => fontStep(-1),
  fontReset: () => fontStep(0),
  recipes: () => openRecipes(),
  history: () => openHistory(),
  // Modalità focus: resta solo il terminale, con il bordo nel colore del server.
  focus: () => {
    const on = !document.body.classList.contains('focus-mode');
    document.body.classList.toggle('focus-mode', on);
    if (on) toast(`Modalità focus: ${keyHint('focus') || 'lo stesso tasto'} o il pulsante in basso per uscire`, 'info', 2500);
    requestAnimationFrame(() => activeTab()?.show?.());
  },
};

async function paletteItems() {
  const keys = bindings(app.settings.keys);
  const items = [];
  for (const s of app.servers) {
    const on = isOn(s.id);
    items.push({
      group: 'Server', icon: 'server', label: s.name, detail: `${s.username}@${s.host}${on ? ' · connesso' : ''}`,
      run: () => connectAndOpen(s.id),
    });
  }
  for (const t of app.tabs) {
    items.push({ group: 'Schede aperte', icon: { editor: 'file', screen: 'layers', home: 'home', settings: 'settings' }[t.kind] || 'terminal', label: t.title, detail: t.serverId ? serverName(t.serverId) : '', run: () => activate(t.uid) });
  }
  if (isOn(app.current)) {
    try {
      const { sessions } = await api.invoke('screen:list', app.current);
      for (const s of sessions.filter((x) => !x.dead)) {
        items.push({ group: `Screen su ${serverName(app.current)}`, icon: 'layers', label: s.name, detail: s.attached ? 'agganciato' : 'staccato', run: () => openScreenTab(app.current, s) });
      }
    } catch { /* */ }
  }
  for (const s of app.settings.snippets || []) {
    items.push({ group: 'Comandi salvati', icon: 'snippet', label: s.name, detail: s.command, run: () => { const t = activeTerm(); if (t) t.send(`${s.command}\r`); else toast('Apri un terminale per eseguire il comando', 'warn'); } });
  }
  const cmd = (label, id, iconName, run = commands[id]) => items.push({ group: 'Azioni', icon: iconName, label, hint: keys[id] ? display(keys[id]) : undefined, run });
  cmd('Nuovo terminale', 'newTerminal', 'terminal');
  cmd('Nuovo screen', 'newScreen', 'layers');
  cmd('Cerca nel terminale', 'search', 'search');
  cmd('Dividi il terminale a destra', 'splitRight', 'splitRight');
  cmd('Dividi il terminale sotto', 'splitDown', 'splitDown');
  cmd(isBroadcasting() ? 'Interrompi la scrittura in tutti i terminali' : 'Scrivi in tutti i terminali', 'broadcast', 'broadcast');
  cmd('Ricette', 'recipes', 'snippet');
  cmd('Cronologia comandi', 'history', 'clock');
  cmd(document.body.classList.contains('focus-mode') ? 'Esci dalla modalità focus' : 'Modalità focus (solo il terminale)', 'focus', 'eye');
  if (app.current) {
    const n = serverName(app.current);
    items.push({ group: 'Azioni', icon: 'clock', label: `Macchina del tempo di ${n}`, run: () => openTimeline(app.current) });
    items.push({ group: 'Azioni', icon: 'edit', label: `Diario di ${n}`, run: () => openNotes(app.current) });
    if (isOn(app.current)) items.push({ group: 'Azioni', icon: 'activity', label: `Mappa dei servizi di ${n}`, run: () => openServices(app.current) });
  }
  for (const r of app.settings.recipes || []) {
    items.push({ group: 'Ricette', icon: 'snippet', label: r.name, detail: r.steps.join(' · '), run: () => { const t = openRecipes(); t.select?.(r.id); } });
  }
  cmd('Aggiungi server', 'addServer', 'plus');
  cmd('Importa server da ~/.ssh/config', 'importSshConfig', 'import');
  cmd('Mostra/nascondi barra laterale', 'toggleSidebar', 'sidebarLeft');
  cmd('Mostra/nascondi pannello server', 'toggleInspector', 'sidebarRight');
  items.push({ group: 'Azioni', icon: 'eye', label: effectiveTheme(app.settings.theme) === 'dark' ? 'Passa al tema chiaro' : 'Passa al tema scuro', run: () => changeSettings({ theme: effectiveTheme(app.settings.theme) === 'dark' ? 'light' : 'dark' }) });
  cmd('Impostazioni', 'settings', 'settings');
  cmd('Scorciatoie da tastiera', 'shortcuts', 'keyboard');
  if (isOn(app.current)) cmd(`Disconnetti ${serverName(app.current)}`, 'disconnect', 'logout');
  return items;
}

api.onMenu?.((name) => {
  if (name.startsWith('openServer:')) connectAndOpen(name.slice(11));
  else commands[name]?.();
});

// Scorciatoie: quelle configurabili (Impostazioni → Scorciatoie) più alcune fisse.
window.addEventListener('keydown', (e) => {
  if (document.querySelector('.record-kbd')) return; // si sta registrando una scorciatoia
  const name = actionFor(e, app.settings.keys);
  if (name) {
    e.preventDefault();
    e.stopPropagation();
    commands[name]();
    return;
  }
  if (api.platform === 'darwin' || !e.ctrlKey || e.shiftKey || e.altKey) return;
  let fixed = null;
  if (e.key === '=' || e.key === '+') fixed = 'fontBigger';
  else if (e.key === '-') fixed = 'fontSmaller';
  else if (e.key === '0') fixed = 'fontReset';
  if (!fixed) return;
  e.preventDefault();
  commands[fixed]();
}, true);

// Chiusura della finestra con file non salvati: chiedi prima di perdere le modifiche.
window.addEventListener('beforeunload', (e) => {
  const dirty = app.tabs.filter((t) => t.isDirty?.());
  if (closeConfirmed || !dirty.length) return;
  e.preventDefault();
  e.returnValue = false;
  modal({
    title: 'File non salvati',
    body: h('p', {}, `${dirty.map((t) => t.title).join(', ')} ha${dirty.length > 1 ? 'nno' : ''} modifiche non salvate.`),
    actions: [
      { label: 'Annulla', result: null },
      { label: 'Esci senza salvare', kind: 'danger-ghost', result: 'discard' },
      { label: 'Salva ed esci', kind: 'primary', result: 'save' },
    ],
  }).then(async (r) => {
    if (!r) return;
    if (r === 'save') {
      const results = await Promise.all(dirty.map((t) => t.save()));
      if (results.includes(false)) return;
    }
    closeConfirmed = true;
    window.close();
  });
});

applyLayout();
addTab(homeTab);
await loadServers();
if (app.servers.length === 1) selectServer(app.servers[0].id);
else updatePanel();
restoreSession();
