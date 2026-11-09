// Dati locali più voluminosi della configurazione, in file separati per server:
// cronologia dei comandi, metriche per la "macchina del tempo", versioni dei file
// salvati dall'editor e l'ultimo momento in cui il server è stato visto.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = () => path.join(app.getPath('userData'), 'data');
const safe = (s) => String(s).replace(/[^\w-]/g, '').slice(0, 80) || 'x';
const fileFor = (kind, serverId) => path.join(dir(), `${kind}-${safe(serverId)}.json`);

const cache = new Map(); // percorso -> dati
const dirty = new Map(); // percorso -> timer

function read(file, fallback) {
  if (cache.has(file)) return cache.get(file);
  let v = fallback;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* nuovo o illeggibile */ }
  cache.set(file, v);
  return v;
}

function write(file, value, delay = 1500) {
  cache.set(file, value);
  clearTimeout(dirty.get(file));
  dirty.set(file, setTimeout(() => flushOne(file), delay));
}

function flushOne(file) {
  clearTimeout(dirty.get(file));
  dirty.delete(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(cache.get(file)), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* disco pieno o permessi: riprova al prossimo salvataggio */ }
}

function flush() { for (const f of [...dirty.keys()]) flushOne(f); }

// ---------- Cronologia dei comandi ----------
const HISTORY_MAX = 5000;

function addHistory(serverId, command) {
  const cmd = String(command || '').trim().slice(0, 2000);
  if (!cmd) return;
  const file = fileFor('history', serverId);
  const list = read(file, []);
  const last = list[list.length - 1];
  if (last && last.c === cmd && Date.now() - last.t < 5000) return; // doppio Invio
  list.push({ c: cmd, t: Date.now() });
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  write(file, list);
}

// Cerca in tutti i server (o in uno): i più recenti prima.
function searchHistory({ query = '', serverIds = [], limit = 400 } = {}) {
  const q = String(query).toLowerCase().trim();
  const out = [];
  for (const id of serverIds) {
    for (const e of read(fileFor('history', id), []).slice().reverse()) { // a parità di orario, il più recente prima
      if (!q || e.c.toLowerCase().includes(q)) out.push({ serverId: id, command: e.c, time: e.t });
    }
  }
  out.sort((a, b) => b.time - a.time);
  return out.slice(0, limit);
}

function clearHistory(serverId) { write(fileFor('history', serverId), [], 0); }

// ---------- Metriche (macchina del tempo) ----------
// Un campione al minuto, ultimi 7 giorni.
const METRICS_MAX = 7 * 24 * 60;

function addMetric(serverId, sample) {
  const file = fileFor('metrics', serverId);
  const list = read(file, []);
  list.push(sample);
  if (list.length > METRICS_MAX) list.splice(0, list.length - METRICS_MAX);
  write(file, list, 10000);
  setLastSeen(serverId, { t: sample.t, diskUsed: sample.diskUsed, uptime: sample.uptime });
}

function getMetrics(serverId, sinceMs = 0) {
  return read(fileFor('metrics', serverId), []).filter((s) => s.t >= sinceMs);
}

// ---------- Ultima volta visto (per "Cosa è cambiato?") ----------
function lastSeenFile() { return path.join(dir(), 'last-seen.json'); }
function getLastSeen(serverId) { return read(lastSeenFile(), {})[serverId] || null; }
function setLastSeen(serverId, info) {
  const all = read(lastSeenFile(), {});
  all[serverId] = { ...(all[serverId] || {}), ...info };
  write(lastSeenFile(), all, 5000);
}

// ---------- Versioni dei file salvati dall'editor ----------
const VERSIONS_MAX = 10;
const VERSION_SIZE_MAX = 1024 * 1024;

function versionKey(remotePath) { return crypto.createHash('sha1').update(remotePath).digest('hex').slice(0, 16); }

function saveVersion(serverId, remotePath, content) {
  const text = String(content ?? '');
  if (text.length > VERSION_SIZE_MAX) return false;
  const file = path.join(dir(), 'versions', `${safe(serverId)}-${versionKey(remotePath)}.json`);
  const v = read(file, { path: remotePath, list: [] });
  if (v.list.length && v.list[v.list.length - 1].content === text) return false;
  v.list.push({ t: Date.now(), content: text });
  if (v.list.length > VERSIONS_MAX) v.list.splice(0, v.list.length - VERSIONS_MAX);
  write(file, v, 500);
  return true;
}

function listVersions(serverId, remotePath) {
  const file = path.join(dir(), 'versions', `${safe(serverId)}-${versionKey(remotePath)}.json`);
  return read(file, { list: [] }).list.slice().reverse();
}

function forgetServer(serverId) {
  for (const kind of ['history', 'metrics']) {
    const f = fileFor(kind, serverId);
    cache.delete(f);
    clearTimeout(dirty.get(f));
    dirty.delete(f);
    try { fs.unlinkSync(f); } catch { /* */ }
  }
  const all = read(lastSeenFile(), {});
  delete all[serverId];
  write(lastSeenFile(), all, 0);
}

module.exports = {
  addHistory, searchHistory, clearHistory,
  addMetric, getMetrics, getLastSeen, setLastSeen,
  saveVersion, listVersions, forgetServer, flush,
};
