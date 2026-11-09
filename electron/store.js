// Persistenza locale: server salvati, impostazioni, host key conosciute.
// Nessun segreto in chiaro: le passphrase delle chiavi passano da safeStorage
// (DPAPI su Windows, Portachiavi su macOS).
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = () => path.join(app.getPath('userData'), 'config.json');

const ACCENT = '#7652e8'; // il viola del logo

const defaults = {
  servers: [],
  knownHosts: {}, // "host:port" -> "SHA256:..."
  secrets: {}, // serverId -> passphrase cifrata (base64)
  settings: {
    autosave: true, autosaveDelay: 800, fontSize: 14, showHidden: false,
    // Aspetto
    theme: 'system', // 'dark' | 'light' | 'system'
    zoom: 1,
    accent: ACCENT,
    termFont: '',
    termTheme: 'auto',
    compactTerm: false,
    // Pannelli
    hideSidebar: false,
    hideInspector: false,
    autoInspector: true, // il pannello destro si chiude da solo quando non sei connesso
    sidebarW: 268,
    inspectorW: 330,
    // Sessione e avvio
    restoreSession: true,
    session: [],
    splash: true,
    splashSound: true,
    notifications: true,
    // Comandi salvati e scorciatoie
    snippets: [],
    recipes: [],
    keys: {},
  },
  notes: {}, // serverId -> diario in markdown
};

const KEY_ACTIONS = ['palette', 'newTerminal', 'newScreen', 'closeTab', 'nextTab', 'prevTab', 'toggleSidebar',
  'toggleInspector', 'settings', 'search', 'splitRight', 'splitDown', 'broadcast', 'shortcuts', 'focus', 'recipes', 'history'];

// Scarta valori non validi prima di salvarli.
function cleanSettings(patch) {
  const out = { ...patch };
  if ('theme' in out && !['dark', 'light', 'system'].includes(out.theme)) delete out.theme;
  for (const k of ['hideSidebar', 'hideInspector', 'showHidden', 'autosave', 'compactTerm', 'autoInspector',
    'restoreSession', 'splash', 'splashSound', 'notifications']) if (k in out) out[k] = !!out[k];
  if ('zoom' in out) out.zoom = Math.min(3, Math.max(0.5, Number(out.zoom) || 1));
  if ('accent' in out && !/^#[0-9a-f]{6}$/i.test(out.accent)) delete out.accent;
  if ('fontSize' in out) out.fontSize = Math.min(32, Math.max(8, Number(out.fontSize) || 14));
  if ('autosaveDelay' in out) out.autosaveDelay = Math.min(10000, Math.max(200, Number(out.autosaveDelay) || 800));
  if ('sidebarW' in out) out.sidebarW = Math.round(Math.min(480, Math.max(200, Number(out.sidebarW) || 268)));
  if ('inspectorW' in out) out.inspectorW = Math.round(Math.min(520, Math.max(240, Number(out.inspectorW) || 330)));
  if ('termFont' in out) out.termFont = String(out.termFont).replace(/[^\w\s\-.,"']/g, '').slice(0, 80);
  if ('termTheme' in out) out.termTheme = String(out.termTheme).replace(/[^\w-]/g, '').slice(0, 40) || 'auto';
  if ('session' in out) {
    out.session = (Array.isArray(out.session) ? out.session : []).slice(0, 40).map((t) => ({
      kind: ['term', 'screen', 'editor'].includes(t?.kind) ? t.kind : 'term',
      serverId: String(t?.serverId || ''),
      path: t?.path ? String(t.path).slice(0, 1024) : undefined,
      screen: t?.screen ? String(t.screen).slice(0, 64) : undefined,
      panes: Math.min(4, Math.max(1, Number(t?.panes) || 1)),
      dir: t?.dir === 'col' ? 'col' : 'row',
      active: !!t?.active,
    })).filter((t) => t.serverId);
  }
  if ('snippets' in out) {
    out.snippets = (Array.isArray(out.snippets) ? out.snippets : []).slice(0, 200)
      .map((s) => ({ id: String(s?.id || crypto.randomUUID()), name: String(s?.name || '').trim().slice(0, 80), command: String(s?.command || '').slice(0, 4000) }))
      .filter((s) => s.name && s.command);
  }
  if ('recipes' in out) {
    out.recipes = (Array.isArray(out.recipes) ? out.recipes : []).slice(0, 200).map((r) => ({
      id: String(r?.id || crypto.randomUUID()).slice(0, 64),
      name: String(r?.name || '').trim().slice(0, 80),
      steps: (Array.isArray(r?.steps) ? r.steps : []).map((x) => String(x).slice(0, 4000)).filter((x) => x.trim()).slice(0, 50),
    })).filter((r) => r.name && r.steps.length);
  }
  if ('keys' in out) {
    const keys = {};
    for (const [k, v] of Object.entries(out.keys || {})) {
      if (KEY_ACTIONS.includes(k) && typeof v === 'string' && /^[\w+\-=,.;'/\\[\]`]{1,40}$/.test(v)) keys[k] = v;
    }
    out.keys = keys;
  }
  delete out.uiFont; // non più usato
  return out;
}


let data = null;

function load() {
  if (data) return data;
  try {
    // Il BOM compare se il file è stato salvato da alcuni editor di Windows.
    data = { ...structuredClone(defaults), ...JSON.parse(fs.readFileSync(file(), 'utf8').replace(/^﻿/, '')) };
    data.settings = { ...defaults.settings, ...data.settings };
    // Nuovo design (blu): chi aveva ancora il rosa predefinito passa al nuovo colore.
    if (!data.settings.design2) {
      if (data.settings.accent === '#ff5c7a') data.settings.accent = '#3f5fe8';
      data.settings.design2 = true;
    }
    // Screenie: il colore predefinito diventa il viola del logo.
    if (!data.settings.design3) {
      if (['#3f5fe8', '#4f7cff'].includes(data.settings.accent)) data.settings.accent = ACCENT;
      delete data.settings.uiFont;
      data.settings.design3 = true;
    }
  } catch (e) {
    data = structuredClone(defaults);
    if (e.code === 'ENOENT') {
      save(); // primo avvio: la Home mostra il benvenuto
    } else {
      // File illeggibile: mettilo da parte invece di sovrascriverlo al prossimo salvataggio.
      try { fs.renameSync(file(), `${file()}.danneggiato-${Date.now()}`); } catch { /* */ }
    }
  }
  return data;
}

function save() {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function listServers() {
  return load().servers.map((s) => ({ ...s, hasSavedPassphrase: Boolean(load().secrets[s.id]) }));
}

// Tunnel locali: "8080:localhost:80" oppure oggetti { localPort, remoteHost, remotePort }.
function cleanTunnels(list) {
  return (Array.isArray(list) ? list : []).map((t) => {
    if (typeof t === 'string') {
      const m = t.trim().match(/^(\d{1,5}):([^:\s]+):(\d{1,5})$/);
      if (!m) return null;
      t = { localPort: m[1], remoteHost: m[2], remotePort: m[3] };
    }
    const localPort = Number(t?.localPort);
    const remotePort = Number(t?.remotePort);
    const remoteHost = String(t?.remoteHost || '').trim();
    if (!(localPort > 0 && localPort < 65536 && remotePort > 0 && remotePort < 65536 && /^[\w.-]+$/.test(remoteHost))) return null;
    return { localPort, remoteHost, remotePort };
  }).filter(Boolean).slice(0, 20);
}

function saveServer(server) {
  const d = load();
  const id = server.id || crypto.randomUUID();
  const clean = {
    id,
    name: String(server.name || server.host).trim(),
    host: String(server.host).trim(),
    port: Number(server.port) || 22,
    username: String(server.username).trim(),
    keyPath: String(server.keyPath || '').trim(),
    startPath: String(server.startPath || '').trim(),
    group: String(server.group || '').trim().slice(0, 40),
    auth: ['key', 'agent', 'pageant'].includes(server.auth) ? server.auth : 'key',
    agentForward: !!server.agentForward,
    jump: server.jump && server.jump !== id ? String(server.jump) : '',
    tunnels: cleanTunnels(server.tunnels),
    color: /^#[0-9a-f]{6}$/i.test(server.color || '') ? server.color : '',
    glyph: String(server.glyph || '').trim().slice(0, 2),
    production: !!server.production,
  };
  if (!clean.host || !clean.username) throw new Error('Host e utente sono obbligatori');
  const i = d.servers.findIndex((s) => s.id === clean.id);
  if (i >= 0) d.servers[i] = clean;
  else d.servers.push(clean);
  save();
  return clean;
}

function deleteServer(id) {
  const d = load();
  d.servers = d.servers.filter((s) => s.id !== id);
  for (const s of d.servers) if (s.jump === id) s.jump = '';
  delete d.secrets[id];
  delete d.favorites?.[id];
  delete d.notes?.[id];
  save();
}

function getServer(id) {
  return load().servers.find((s) => s.id === id);
}

async function setPassphrase(id, passphrase) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  load().secrets[id] = (await safeStorage.encryptStringAsync(passphrase)).toString('base64');
  save();
  return true;
}

async function getPassphrase(id) {
  const enc = load().secrets[id];
  if (!enc || !(await safeStorage.isAsyncEncryptionAvailable())) return undefined;
  try {
    const r = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'));
    return typeof r === 'string' ? r : r?.result;
  } catch {
    return undefined;
  }
}

function forgetPassphrase(id) {
  delete load().secrets[id];
  save();
}

function getKnownHost(hostPort) {
  return load().knownHosts[hostPort];
}

function setKnownHost(hostPort, fingerprint) {
  load().knownHosts[hostPort] = fingerprint;
  save();
}

// Cartelle preferite del browser file, per server: [{ path, name }]
function getFavorites(serverId) {
  return load().favorites?.[serverId] || [];
}

function setFavorites(serverId, list) {
  const d = load();
  d.favorites ||= {};
  d.favorites[serverId] = list
    .filter((f) => typeof f?.path === 'string' && f.path.startsWith('/'))
    .map((f) => ({ path: f.path, name: String(f.name || '').trim() || f.path.split('/').pop() || '/' }));
  save();
  return d.favorites[serverId];
}

function getNote(serverId) {
  return load().notes?.[serverId] || '';
}

function setNote(serverId, text) {
  const d = load();
  d.notes ||= {};
  if (text) d.notes[serverId] = String(text).slice(0, 200000);
  else delete d.notes[serverId];
  save();
}

function getSettings() {
  return load().settings;
}

function setSettings(patch) {
  const d = load();
  d.settings = { ...d.settings, ...cleanSettings(patch) };
  save();
  return d.settings;
}

// ---------- Backup ----------
// Le passphrase non escono mai dal PC: il backup contiene server, preferiti,
// impostazioni e host key, ma non i segreti.
function exportConfig() {
  const d = load();
  const { session, ...settings } = d.settings;
  return {
    app: 'Screenie',
    version: 1,
    exportedAt: new Date().toISOString(),
    servers: d.servers,
    favorites: d.favorites || {},
    knownHosts: d.knownHosts,
    notes: d.notes || {},
    settings,
  };
}

function importConfig(obj) {
  if (!obj || obj.app !== 'Screenie' || !Array.isArray(obj.servers)) throw new Error('Il file non è un backup di Screenie');
  const d = load();
  let added = 0;
  for (const s of obj.servers) {
    try {
      const exists = d.servers.some((x) => x.id === s.id);
      saveServer(s);
      if (!exists) added++;
    } catch { /* server non valido: saltato */ }
  }
  d.favorites = { ...(d.favorites || {}), ...(obj.favorites || {}) };
  d.knownHosts = { ...d.knownHosts, ...(obj.knownHosts || {}) };
  if (obj.notes && typeof obj.notes === 'object') d.notes = { ...(d.notes || {}), ...obj.notes };
  if (obj.settings) d.settings = { ...d.settings, ...cleanSettings(obj.settings) };
  save();
  return { added, total: obj.servers.length };
}

module.exports = {
  listServers, saveServer, deleteServer, getServer,
  setPassphrase, getPassphrase, forgetPassphrase,
  getKnownHost, setKnownHost, getSettings, setSettings, getFavorites, setFavorites,
  exportConfig, importConfig, cleanTunnels, KEY_ACTIONS, getNote, setNote,
};
