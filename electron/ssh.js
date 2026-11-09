// Gestione connessioni SSH, terminali, screen e SFTP (lato main process).
const { Client, utils } = require('ssh2');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const store = require('./store');

const MAX_EDIT_SIZE = 10 * 1024 * 1024;
const SCREEN_NAME = /^[A-Za-z0-9._-]{1,48}$/;

// Quoting POSIX sicuro per argomenti passati alla shell remota.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const posix = path.posix;

function fingerprint(key) {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function defaultKeyPath() {
  const dir = path.join(os.homedir(), '.ssh');
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(dir, 'id_ed25519');
}

// Cerca l'host in ~/.ssh/known_hosts di OpenSSH (anche nelle righe con nome cifrato).
// Restituisce 'match' se la chiave coincide, 'mismatch' se l'host c'è con una chiave
// dello stesso tipo ma diversa, altrimenti null.
function checkOpenSshKnownHosts(host, port, key) {
  let text;
  try {
    text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'known_hosts'), 'utf8');
  } catch {
    return null;
  }
  const name = port === 22 ? host : `[${host}]:${port}`;
  const blob = key.toString('base64');
  const type = key.subarray(4, 4 + key.readUInt32BE(0)).toString();
  let result = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('@')) continue;
    const [hosts, keyType, keyData] = line.trim().split(/\s+/);
    if (!keyData) continue;
    const matchesHost = hosts.split(',').some((h) => {
      if (h.startsWith('|1|')) {
        const [, , salt, hash] = h.split('|');
        return crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64') === hash;
      }
      return h === name;
    });
    if (!matchesHost) continue;
    if (keyData === blob) return 'match';
    if (keyType === type) result = 'mismatch';
  }
  return result;
}

// Messaggi di errore comprensibili, con il suggerimento su cosa controllare.
function friendlyError(err, server) {
  const where = `${server.host}:${server.port}`;
  if (err.level === 'client-authentication') {
    return server.auth === 'key' || !server.auth
      ? 'Autenticazione rifiutata: la chiave pubblica non è in ~/.ssh/authorized_keys sul server, oppure l’utente è sbagliato.'
      : 'Autenticazione rifiutata: l’agent non ha una chiave accettata dal server.';
  }
  switch (err.code) {
    case 'ECONNREFUSED': return `${where} rifiuta la connessione: SSH non è attivo o la porta è sbagliata.`;
    case 'ENOTFOUND': case 'EAI_AGAIN': return `Host "${server.host}" non trovato: controlla il nome o la connessione a Internet.`;
    case 'ETIMEDOUT': return `${where} non risponde: il server è spento, irraggiungibile o bloccato da un firewall.`;
    case 'EHOSTUNREACH': case 'ENETUNREACH': return `${where} non è raggiungibile dalla tua rete.`;
    case 'ECONNRESET': return `${where} ha chiuso la connessione all'improvviso.`;
    default: break;
  }
  if (/timed out while waiting for handshake/i.test(err.message)) return `${where} non ha completato la connessione SSH in tempo.`;
  return err.message;
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function createManager({ send, prompt }) {
  const conns = new Map(); // serverId -> { client, sftp, home, streams:Set, tunnels }
  const connecting = new Map(); // serverId -> Promise (connessione in corso)
  const terms = new Map(); // termId -> { stream, serverId }
  const watchers = new Map(); // localPath -> { watcher, timer }

  function getConn(serverId) {
    const c = conns.get(serverId);
    if (!c) throw new Error('Non connesso a questo server');
    return c;
  }

  async function loadKey(server) {
    const keyPath = expandHome(server.keyPath || defaultKeyPath());
    let keyData;
    try {
      keyData = await fsp.readFile(keyPath);
    } catch {
      throw new Error(`Chiave non trovata: ${keyPath}`);
    }
    const parsed = utils.parseKey(keyData);
    if (!(parsed instanceof Error)) return { privateKey: keyData };
    if (!/passphrase|encrypted/i.test(parsed.message)) {
      throw new Error(`Chiave non valida (${keyPath}): ${parsed.message}`);
    }
    // Chiave cifrata: prima prova la passphrase salvata, poi chiedi.
    const saved = await store.getPassphrase(server.id);
    if (saved && !(utils.parseKey(keyData, saved) instanceof Error)) {
      return { privateKey: keyData, passphrase: saved };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await prompt({
        kind: 'passphrase',
        server: server.name,
        keyPath,
        retry: attempt > 0,
      });
      if (!answer) throw new Error('Connessione annullata');
      if (!(utils.parseKey(keyData, answer.passphrase) instanceof Error)) {
        if (answer.remember) await store.setPassphrase(server.id, answer.passphrase);
        return { privateKey: keyData, passphrase: answer.passphrase };
      }
    }
    throw new Error('Passphrase errata');
  }

  // Chiave privata, agent di OpenSSH (Windows: servizio "ssh-agent") o Pageant.
  async function buildAuth(server) {
    if (server.auth === 'pageant') return { agent: 'pageant', agentForward: !!server.agentForward };
    if (server.auth === 'agent') {
      const agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK;
      if (!agent) throw new Error('Agent SSH non trovato: avvia ssh-agent oppure usa una chiave');
      return { agent, agentForward: !!server.agentForward };
    }
    return loadKey(server);
  }

  // Jump host: prima ci si collega al server intermedio, poi si apre un canale verso la destinazione.
  async function jumpSocket(server, depth) {
    if (!server.jump) return null;
    if (depth > 3) throw new Error('Troppi jump host concatenati');
    const via = store.getServer(server.jump);
    if (!via) throw new Error('Il jump host di questo server non esiste più');
    await connect(via.id, depth + 1);
    const { client } = getConn(via.id);
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, server.host, server.port, (err, stream) => {
        if (err) reject(new Error(`Il jump host "${via.name}" non raggiunge ${server.host}:${server.port} (${err.message})`));
        else resolve(stream);
      });
    });
  }

  // Tunnel locali: 127.0.0.1:porta locale → host:porta visti dal server.
  function startTunnels(conn, server) {
    conn.tunnels = (server.tunnels || []).map((t) => {
      const entry = { ...t, ok: false, error: '' };
      const srv = net.createServer((sock) => {
        conn.client.forwardOut('127.0.0.1', sock.remotePort || 0, t.remoteHost, t.remotePort, (err, stream) => {
          if (err) return sock.destroy();
          sock.pipe(stream).pipe(sock);
          sock.on('error', () => stream.close());
          stream.on('error', () => sock.destroy());
        });
      });
      srv.on('error', (e) => {
        entry.ok = false;
        entry.error = e.code === 'EADDRINUSE' ? `porta ${t.localPort} già in uso` : e.message;
        send('tunnels', server.id, publicTunnels(conn));
      });
      srv.listen(t.localPort, '127.0.0.1', () => {
        entry.ok = true;
        send('tunnels', server.id, publicTunnels(conn));
      });
      entry.server = srv;
      return entry;
    });
  }
  const publicTunnels = (conn) => (conn.tunnels || []).map(({ server: _s, ...t }) => t);
  const stopTunnels = (conn) => { for (const t of conn.tunnels || []) t.server?.close(); conn.tunnels = []; };

  async function connect(serverId, depth = 0) {
    if (conns.has(serverId)) return { home: conns.get(serverId).home, tunnels: publicTunnels(conns.get(serverId)) };
    if (connecting.has(serverId)) return connecting.get(serverId);
    const p = doConnect(serverId, depth).finally(() => connecting.delete(serverId));
    connecting.set(serverId, p);
    return p;
  }

  async function doConnect(serverId, depth) {
    const server = store.getServer(serverId);
    if (!server) throw new Error('Server sconosciuto');
    const auth = await buildAuth(server);
    const sock = await jumpSocket(server, depth);
    const hostPort = `${server.host}:${server.port}`;
    const client = new Client();

    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };
      client.once('ready', () => done());
      client.once('error', (err) => done(new Error(friendlyError(err, server))));
      client.connect({
        ...(sock ? { sock } : {}),
        host: server.host,
        port: server.port,
        username: server.username,
        ...auth,
        readyTimeout: 60000, // include il tempo per confermare l'host key
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        // Verifica dell'host key: trust-on-first-use, blocco se cambia.
        hostVerifier: (key, verify) => {
          const fp = fingerprint(key);
          const known = store.getKnownHost(hostPort);
          if (known === fp) return verify(true);
          // Mai visto da Screenie: se OpenSSH lo conosce già con questa chiave, fidati.
          const openssh = known ? null : checkOpenSshKnownHosts(server.host, server.port, key);
          if (openssh === 'match') {
            store.setKnownHost(hostPort, fp);
            return verify(true);
          }
          const kind = known || openssh === 'mismatch' ? 'hostkey-changed' : 'hostkey-new';
          prompt({ kind, host: hostPort, fingerprint: fp, previous: known || 'quella registrata in ~/.ssh/known_hosts' })
            .then((ok) => {
              if (ok) store.setKnownHost(hostPort, fp);
              verify(Boolean(ok));
            })
            .catch(() => verify(false));
        },
      });
    });

    const conn = { client, sftp: null, home: '/', streams: new Set(), tunnels: [] };
    conns.set(serverId, conn);
    client.on('close', () => {
      stopTunnels(conn);
      if (conns.get(serverId) !== conn) return;
      conns.delete(serverId);
      for (const [id, t] of terms) if (t.serverId === serverId) terms.delete(id);
      send('conn:closed', serverId);
    });
    client.on('error', () => {});

    const sftp = await getSftp(serverId);
    conn.home = await new Promise((res) => sftp.realpath('.', (err, p) => res(err ? '/' : p)));
    startTunnels(conn, server);
    return { home: server.startPath || conn.home, tunnels: publicTunnels(conn) };
  }

  // Latenza approssimativa: apertura ed esecuzione di un comando vuoto.
  async function ping(serverId) {
    const t = Date.now();
    await exec(serverId, ':');
    return Date.now() - t;
  }

  function disconnect(serverId) {
    const c = conns.get(serverId);
    if (c) c.client.end();
  }

  function getSftp(serverId) {
    const c = getConn(serverId);
    if (c.sftp) return c.sftp;
    c.sftp = new Promise((resolve, reject) => {
      c.client.sftp((err, sftp) => {
        if (err) {
          c.sftp = null;
          return reject(err);
        }
        sftp.on('close', () => { c.sftp = null; });
        resolve(sftp);
      });
    });
    return c.sftp;
  }

  function exec(serverId, cmd) {
    const { client } = getConn(serverId);
    return new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        stream.on('data', (d) => { stdout += d; });
        stream.stderr.on('data', (d) => { stderr += d; });
        stream.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    });
  }

  // ---------- Terminali ----------

  function openTerm(serverId, termId, { cols, rows, command }) {
    const { client } = getConn(serverId);
    const pty = { term: 'xterm-256color', cols, rows };
    return new Promise((resolve, reject) => {
      const cb = (err, stream) => {
        if (err) return reject(err);
        terms.set(termId, { stream, serverId });
        stream.on('data', (d) => send('term:data', termId, new Uint8Array(d)));
        stream.stderr?.on('data', (d) => send('term:data', termId, new Uint8Array(d)));
        stream.on('close', () => {
          terms.delete(termId);
          send('term:exit', termId);
        });
        resolve();
      };
      if (command) client.exec(command, { pty }, cb);
      else client.shell(pty, cb);
    });
  }

  function writeTerm(termId, data) {
    terms.get(termId)?.stream.write(data);
  }

  function resizeTerm(termId, cols, rows) {
    terms.get(termId)?.stream.setWindow(rows, cols, 0, 0);
  }

  function closeTerm(termId) {
    const t = terms.get(termId);
    if (t) {
      t.stream.close();
      terms.delete(termId);
    }
  }

  // ---------- Screen ----------

  async function screenList(serverId) {
    const { stdout } = await exec(serverId,
      'command -v screen >/dev/null 2>&1 || { echo __NOSCREEN__; exit 0; }; screen -ls 2>&1; true');
    if (stdout.includes('__NOSCREEN__')) return { installed: false, sessions: [] };
    const sessions = [];
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s+(\d+)\.(\S+)\s+(.*)$/);
      if (!m) continue;
      const rest = m[3];
      const parens = [...rest.matchAll(/\(([^)]*)\)/g)].map((x) => x[1]);
      const state = parens.find((p) => /attached|detached|dead/i.test(p)) || '';
      const created = parens.find((p) => /\d/.test(p) && p !== state) || '';
      sessions.push({
        id: `${m[1]}.${m[2]}`,
        pid: Number(m[1]),
        name: m[2],
        attached: /attached/i.test(state) && !/detached/i.test(state),
        dead: /dead/i.test(state),
        created,
      });
    }
    sessions.sort((a, b) => a.name.localeCompare(b.name));
    return { installed: true, sessions };
  }

  async function screenCreate(serverId, name, command) {
    if (!SCREEN_NAME.test(name)) throw new Error('Nome non valido: usa lettere, numeri, punto, trattino o underscore');
    const list = await screenList(serverId);
    if (list.sessions.some((s) => s.name === name)) throw new Error(`Esiste già uno screen "${name}"`);
    const cmd = command
      ? `screen -U -dmS ${q(name)} bash -lc ${q(command + '; exec bash')}`
      : `screen -U -dmS ${q(name)}`;
    const r = await exec(serverId, cmd);
    if (r.code !== 0) throw new Error(r.stderr || r.stdout || 'screen non è partito');
  }

  async function screenKill(serverId, id) {
    const r = await exec(serverId, `screen -S ${q(id)} -X quit`);
    if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim() || 'Impossibile terminare lo screen');
  }

  async function screenRename(serverId, id, name) {
    if (!SCREEN_NAME.test(name)) throw new Error('Nome non valido');
    const r = await exec(serverId, `screen -S ${q(id)} -X sessionname ${q(name)}`);
    if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim() || 'Impossibile rinominare');
  }

  async function screenWipe(serverId) {
    await exec(serverId, 'screen -wipe >/dev/null 2>&1; true');
  }

  const screenAttachCommand = (id) => `screen -U -d -r ${q(id)}`;

  // ---------- Stato del server (sola lettura) ----------

  async function stats(serverId) {
    const { stdout } = await exec(serverId, [
      'cat /proc/loadavg', 'nproc',
      "free -b | awk 'NR==2{print $2, $7}'",
      "df -B1 -P / | awk 'NR==2{print $2, $3}'",
      'cat /proc/uptime', 'hostname',
    ].join('; '));
    const [load, cpus, mem, disk, up, hostname] = stdout.trim().split('\n');
    const num = (s, i) => Number((s || '').trim().split(/\s+/)[i]) || 0;
    const memTotal = num(mem, 0);
    return {
      hostname: (hostname || '').trim(),
      load: num(load, 0),
      cpus: num(cpus, 0) || 1,
      memTotal,
      memUsed: memTotal - num(mem, 1),
      diskTotal: num(disk, 0),
      diskUsed: num(disk, 1),
      uptime: num(up, 0),
    };
  }

  // Campione per la macchina del tempo: stato + i processi che consumano di più.
  async function sample(serverId) {
    const st = await stats(serverId);
    const { stdout } = await exec(serverId, 'ps -eo comm=,pcpu=,rss= --sort=-pcpu 2>/dev/null | head -6');
    const procs = stdout.trim().split('\n').filter(Boolean).map((l) => {
      const m = l.trim().match(/^(.*?)\s+([\d.]+)\s+(\d+)$/);
      return m ? { name: m[1].slice(0, 40), cpu: Number(m[2]), rss: Number(m[3]) * 1024 } : null;
    }).filter(Boolean).slice(0, 5);
    return {
      t: Date.now(),
      cpu: Math.min(100, Math.round((st.load / st.cpus) * 100)),
      mem: st.memTotal ? Math.round((st.memUsed / st.memTotal) * 100) : 0,
      disk: st.diskTotal ? Math.round((st.diskUsed / st.diskTotal) * 100) : 0,
      diskUsed: st.diskUsed,
      uptime: st.uptime,
      procs,
    };
  }

  // "Cosa è cambiato?": accessi, pacchetti, file di configurazione e servizi dall'ultima visita.
  async function changes(serverId, sinceMs) {
    const since = Math.floor(sinceMs / 1000);
    const sep = (n) => `echo __SCREENIE_${n}__`;
    const { stdout } = await exec(serverId, [
      sep('LOGIN'), `last -w -s "$(date -d @${since} '+%Y-%m-%d %H:%M:%S' 2>/dev/null)" 2>/dev/null | grep -v '^$' | grep -v '^wtmp' | grep -v '^reboot' | head -20`,
      sep('PKG'), `cat /var/log/dpkg.log 2>/dev/null | grep -E ' (install|upgrade|remove) ' | tail -n 400`,
      sep('ETC'), `find /etc -xdev -type f -newermt @${since} 2>/dev/null | head -40`,
      sep('FAILED'), 'systemctl list-units --type=service --state=failed --no-legend --plain 2>/dev/null | head -20',
      sep('UPTIME'), 'cat /proc/uptime',
      sep('DISK'), "df -B1 -P / | awk 'NR==2{print $3}'",
      sep('END'),
    ].join('; '));
    const part = (name) => {
      const m = stdout.split(`__SCREENIE_${name}__`)[1];
      return (m ? m.split(/__SCREENIE_\w+__/)[0] : '').split('\n').map((l) => l.trim()).filter(Boolean);
    };
    const packages = part('PKG').map((l) => {
      const m = l.match(/^(\S+ \S+) (install|upgrade|remove) (\S+)/);
      if (!m) return null;
      const t = Date.parse(m[1].replace(' ', 'T'));
      return t && t >= sinceMs ? { action: m[2], name: m[3].replace(/:\w+$/, '') } : null;
    }).filter(Boolean);
    return {
      logins: part('LOGIN'),
      packages,
      etc: part('ETC'),
      failed: part('FAILED').map((l) => l.split(/\s+/)[0]),
      uptime: Number((part('UPTIME')[0] || '').split(/\s+/)[0]) || 0,
      diskUsed: Number(part('DISK')[0]) || 0,
    };
  }

  // Mappa dei servizi: porte in ascolto (con il processo), container Docker, servizi systemd.
  async function services(serverId) {
    const sep = (n) => `echo __SCREENIE_${n}__`;
    const { stdout } = await exec(serverId, [
      sep('LISTEN'), '(ss -tlnpH 2>/dev/null || ss -tlnp 2>/dev/null | tail -n +2)',
      sep('EST'), "ss -tnH state established 2>/dev/null | awk '{print $3}'",
      sep('DOCKER'), "docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}' 2>/dev/null",
      sep('UNITS'), 'systemctl list-units --type=service --state=running --no-legend --plain 2>/dev/null | head -60',
      sep('END'),
    ].join('; '));
    const part = (name) => {
      const m = stdout.split(`__SCREENIE_${name}__`)[1];
      return (m ? m.split(/__SCREENIE_\w+__/)[0] : '').split('\n').map((l) => l.trim()).filter(Boolean);
    };
    const portOf = (addr) => Number((addr || '').split(':').pop()) || 0;
    const est = new Map();
    for (const a of part('EST')) est.set(portOf(a), (est.get(portOf(a)) || 0) + 1);
    const seen = new Set();
    const listening = [];
    for (const l of part('LISTEN')) {
      const cols = l.split(/\s+/);
      const local = cols.find((c, i) => i >= 2 && /:\d+$/.test(c)) || '';
      const port = portOf(local);
      if (!port || seen.has(port)) continue;
      seen.add(port);
      const proc = (l.match(/users:\(\("([^"]+)"/) || [])[1] || '';
      const scope = /^(127\.|\[::1\]|::1)/.test(local) ? 'locale' : 'pubblica';
      listening.push({ port, process: proc, scope, connections: est.get(port) || 0 });
    }
    listening.sort((a, b) => a.port - b.port);
    const docker = part('DOCKER').map((l) => {
      const [name, image, ports, status] = l.split('\t');
      return { name, image, ports: ports || '', status: status || '' };
    });
    const units = part('UNITS').map((l) => {
      const cols = l.split(/\s+/);
      return { name: cols[0].replace(/\.service$/, ''), description: cols.slice(4).join(' ') };
    });
    return { listening, docker, units };
  }

  // Ricette: un passo alla volta, mantenendo la cartella di lavoro tra un passo e l'altro.
  const runs = new Map(); // runId -> stream
  function runStep(serverId, runId, command, cwd) {
    const { client } = getConn(serverId);
    const marker = '__SCREENIE_PWD__';
    const script = `${cwd ? `cd ${q(cwd)} 2>/dev/null; ` : ''}${command}\n__s=$?; printf '\\n${marker}%s\\n' "$PWD"; exit $__s`;
    return new Promise((resolve, reject) => {
      client.exec(`bash -lc ${q(script)}`, (err, stream) => {
        if (err) return reject(err);
        runs.set(runId, stream);
        let out = '';
        const add = (d) => { out += d; if (out.length > 200000) out = out.slice(-200000); };
        stream.on('data', add);
        stream.stderr.on('data', add);
        stream.on('close', (code, signal) => {
          if (stream.cancelled) signal = signal || 'INT';
          runs.delete(runId);
          const i = out.lastIndexOf(marker);
          const newCwd = i >= 0 ? out.slice(i + marker.length).trim().split('\n')[0] : cwd;
          resolve({ code: signal ? 130 : code ?? 0, out: (i >= 0 ? out.slice(0, i) : out).replace(/\s+$/, ''), cwd: newCwd });
        });
      });
    });
  }
  function cancelStep(runId) {
    const s = runs.get(runId);
    if (!s) return;
    s.cancelled = true;
    try { s.signal('INT'); } catch { /* */ }
    setTimeout(() => { try { s.close(); } catch { /* */ } }, 800);
  }

  // ---------- SFTP ----------

  const sftpCall = async (serverId, method, ...args) => {
    const sftp = await getSftp(serverId);
    return new Promise((resolve, reject) => {
      sftp[method](...args, (err, res) => (err ? reject(err) : resolve(res)));
    });
  };

  async function list(serverId, dir) {
    const entries = await sftpCall(serverId, 'readdir', dir);
    const items = await Promise.all(entries.map(async (e) => {
      const a = e.attrs;
      let isDir = a.isDirectory();
      const isLink = a.isSymbolicLink();
      if (isLink) {
        try {
          isDir = (await sftpCall(serverId, 'stat', posix.join(dir, e.filename))).isDirectory();
        } catch { /* link rotto */ }
      }
      return { name: e.filename, isDir, isLink, size: a.size, mtime: a.mtime, mode: a.mode };
    }));
    items.sort((x, y) => (y.isDir - x.isDir) || x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' }));
    return items;
  }

  async function readFile(serverId, file) {
    const st = await sftpCall(serverId, 'stat', file);
    if (st.size > MAX_EDIT_SIZE) throw new Error('File troppo grande per l\'editor (oltre 10 MB): usa "Apri con editor esterno" o scaricalo');
    const buf = await sftpCall(serverId, 'readFile', file);
    if (buf.subarray(0, 8192).includes(0)) throw new Error('Sembra un file binario: scaricalo invece di aprirlo');
    return { content: buf.toString('utf8'), mtime: st.mtime };
  }

  async function writeFile(serverId, file, content, expectedMtime, force) {
    if (!force && expectedMtime != null) {
      try {
        const st = await sftpCall(serverId, 'stat', file);
        if (st.mtime !== expectedMtime) return { conflict: true, mtime: st.mtime };
      } catch { /* file rimosso: lo ricreiamo */ }
    }
    await sftpCall(serverId, 'writeFile', file, Buffer.from(content, 'utf8'));
    const st = await sftpCall(serverId, 'stat', file);
    return { ok: true, mtime: st.mtime };
  }

  async function mkdir(serverId, dir) {
    await sftpCall(serverId, 'mkdir', dir);
  }

  async function createFile(serverId, file) {
    try {
      await sftpCall(serverId, 'stat', file);
      throw new Error('Esiste già un file con questo nome');
    } catch (e) {
      if (e.message.startsWith('Esiste')) throw e;
    }
    await sftpCall(serverId, 'writeFile', file, Buffer.alloc(0));
  }

  async function rename(serverId, from, to) {
    await sftpCall(serverId, 'rename', from, to);
  }

  async function remove(serverId, target) {
    const norm = posix.normalize(String(target)).replace(/\/+$/, '') || '/';
    const { home } = getConn(serverId);
    // Mai eliminare la radice, la home o una cartella di primo livello (/etc, /var, /home…).
    if (!norm.startsWith('/') || norm === home || norm.split('/').length <= 2) {
      throw new Error('Percorso protetto, non lo elimino');
    }
    const r = await exec(serverId, `rm -rf -- ${q(norm)}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'Eliminazione fallita');
  }

  // Trasferimenti: fastPut/fastGet usano richieste parallele, molto più veloci
  // di un trasferimento a blocchi singoli.
  let transferSeq = 0;

  async function collectLocal(p, remoteBase, out) {
    const st = await fsp.stat(p);
    const remote = posix.join(remoteBase, path.basename(p));
    if (st.isDirectory()) {
      out.push({ dir: true, remote });
      for (const child of await fsp.readdir(p)) await collectLocal(path.join(p, child), remote, out);
    } else {
      out.push({ local: p, remote, size: st.size });
    }
  }

  async function collectRemote(serverId, remote, localBase, out) {
    const st = await sftpCall(serverId, 'stat', remote);
    const local = path.join(localBase, posix.basename(remote));
    if (st.isDirectory()) {
      out.push({ dir: true, local });
      for (const e of await sftpCall(serverId, 'readdir', remote)) {
        await collectRemote(serverId, posix.join(remote, e.filename), local, out);
      }
    } else {
      out.push({ remote, local, size: st.size });
    }
  }

  async function runTransfer(kind, label, items, step) {
    const id = ++transferSeq;
    const total = items.reduce((n, i) => n + (i.size || 0), 0);
    let done = 0;
    let last = 0;
    const report = (state, extra = {}) => send('transfer', { id, kind, label, total, done, state, ...extra });
    report('running');
    try {
      for (const item of items) {
        let base = done;
        await step(item, (transferred) => {
          done = base + transferred;
          const now = Date.now();
          if (now - last > 120) {
            last = now;
            report('running', { file: path.basename(item.remote || item.local || '') });
          }
        });
        done = base + (item.size || 0);
      }
      report('done');
    } catch (e) {
      report('error', { error: e.message });
      throw e;
    }
  }

  async function upload(serverId, localPaths, remoteDir) {
    const sftp = await getSftp(serverId);
    const items = [];
    for (const p of localPaths) await collectLocal(p, remoteDir, items);
    const label = localPaths.length === 1 ? path.basename(localPaths[0]) : `${localPaths.length} elementi`;
    await runTransfer('upload', label, items, (item, progress) => new Promise((resolve, reject) => {
      if (item.dir) {
        return sftp.mkdir(item.remote, () => resolve()); // ignora "esiste già"
      }
      sftp.fastPut(item.local, item.remote, { concurrency: 64, chunkSize: 64 * 1024, step: (t) => progress(t) },
        (err) => (err ? reject(err) : resolve()));
    }));
  }

  async function download(serverId, remotePaths, localDir) {
    const sftp = await getSftp(serverId);
    const items = [];
    for (const p of remotePaths) await collectRemote(serverId, p, localDir, items);
    const label = remotePaths.length === 1 ? posix.basename(remotePaths[0]) : `${remotePaths.length} elementi`;
    await runTransfer('download', label, items, (item, progress) => {
      if (item.dir) return fsp.mkdir(item.local, { recursive: true });
      return new Promise((resolve, reject) => {
        sftp.fastGet(item.remote, item.local, { concurrency: 64, chunkSize: 64 * 1024, step: (t) => progress(t) },
          (err) => (err ? reject(err) : resolve()));
      });
    });
  }

  // ---------- Editor esterno (stile MobaXterm): scarica, apri, ricarica a ogni salvataggio ----------

  async function editExternally(serverId, remote, openPath) {
    const sftp = await getSftp(serverId);
    const dir = path.join(os.tmpdir(), 'screenie', crypto.createHash('sha1').update(serverId + remote).digest('hex').slice(0, 12));
    await fsp.mkdir(dir, { recursive: true });
    const local = path.join(dir, posix.basename(remote));
    await new Promise((res, rej) => sftp.fastGet(remote, local, (e) => (e ? rej(e) : res())));

    watchers.get(local)?.watcher.close();
    let lastHash = crypto.createHash('sha1').update(await fsp.readFile(local)).digest('hex');
    const entry = { timer: null, serverId };
    entry.watcher = fs.watch(local, () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(async () => {
        try {
          const buf = await fsp.readFile(local);
          const h = crypto.createHash('sha1').update(buf).digest('hex');
          if (h === lastHash) return;
          lastHash = h;
          const s = await getSftp(serverId);
          await new Promise((res, rej) => s.fastPut(local, remote, (e) => (e ? rej(e) : res())));
          send('external:saved', { serverId, remote, ok: true });
        } catch (e) {
          send('external:saved', { serverId, remote, ok: false, error: e.message });
        }
      }, 400);
    });
    watchers.set(local, entry);
    const err = await openPath(local);
    if (err) throw new Error(err);
  }

  function stopWatchers(serverId) {
    for (const [p, w] of watchers) {
      if (!serverId || w.serverId === serverId) {
        w.watcher.close();
        clearTimeout(w.timer);
        watchers.delete(p);
      }
    }
  }

  function shutdown() {
    stopWatchers();
    for (const c of conns.values()) { stopTunnels(c); c.client.end(); }
  }

  return {
    connect, disconnect, exec, ping,
    tunnels: (id) => (conns.has(id) ? publicTunnels(conns.get(id)) : []),
    openTerm, writeTerm, resizeTerm, closeTerm,
    screenList, screenCreate, screenKill, screenRename, screenWipe, screenAttachCommand, stats,
    sample, changes, services, runStep, cancelStep,
    list, readFile, writeFile, mkdir, createFile, rename, remove, upload, download,
    editExternally, stopWatchers, shutdown,
    isConnected: (id) => conns.has(id),
    defaultKeyPath,
  };
}

module.exports = { createManager };
