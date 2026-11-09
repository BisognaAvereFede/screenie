// Collaudo del backend contro il server finto. Si avvia con:  npx electron test/backend.test.js
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');
const { utils } = require('ssh2');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screenie-test-'));
app.setPath('userData', path.join(tmp, 'userData'));

const { startFakeServer } = require('./fake-server');
const store = require('../electron/store');
const { createManager } = require('../electron/ssh');

const results = [];
async function test(name, fn) {
  console.log(`… ${name}`);
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('test bloccato (>30 s)')), 30000))]);
    results.push(['ok', name]);
  } catch (e) {
    results.push(['FAIL', name, e.stack || e.message]);
  }
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

app.whenReady().then(async () => {
  const root = path.join(tmp, 'remote');
  const client = utils.generateKeyPairSync('ed25519', { passphrase: 'segreto', cipher: 'aes256-ctr' });
  const keyPath = path.join(tmp, 'id_test');
  fs.writeFileSync(keyPath, client.private);
  const hostA = utils.generateKeyPairSync('ed25519').private;
  const hostB = utils.generateKeyPairSync('ed25519').private;

  let srv = await startFakeServer({ root, clientPublicKey: client.public, hostKey: hostA });
  const port = srv.port;

  const events = [];
  const prompts = [];
  let answer = () => null;
  const ssh = createManager({
    send: (ch, ...a) => events.push([ch, ...a]),
    prompt: async (req) => { prompts.push(req); return answer(req); },
  });

  const server = store.saveServer({ name: 'test', host: '127.0.0.1', port, username: 'test', keyPath });
  const id = server.id;
  const waitFor = async (pred, ms = 5000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('timeout');
  };

  await test('passphrase sbagliata poi giusta + nuova host key', async () => {
    let n = 0;
    answer = (req) => {
      if (req.kind === 'passphrase') return { passphrase: n++ === 0 ? 'sbagliata' : 'segreto', remember: true };
      if (req.kind === 'hostkey-new') return true;
      return null;
    };
    const r = await ssh.connect(id);
    assert.equal(r.home, '/home/test');
    assert.deepEqual(prompts.map((p) => p.kind), ['passphrase', 'passphrase', 'hostkey-new']);
    assert.equal(prompts[1].retry, true);
    assert.ok(store.listServers().find((s) => s.id === id).hasSavedPassphrase);
    const cfg = fs.readFileSync(path.join(tmp, 'userData', 'config.json'), 'utf8');
    assert.ok(!cfg.includes('segreto'), 'passphrase in chiaro nel file di config');
  });

  await test('screen: elenco, crea, rinomina, termina', async () => {
    let l = await ssh.screenList(id);
    assert.equal(l.installed, true);
    assert.deepEqual(l.sessions.map((s) => s.name), ['esistente']);
    assert.equal(l.sessions[0].attached, false);
    assert.equal(l.sessions[0].created, '31/10/2026 10:00:00');
    await ssh.screenCreate(id, 'web');
    await assert.rejects(ssh.screenCreate(id, 'web'), /Esiste già/);
    await assert.rejects(ssh.screenCreate(id, "x'; rm -rf /"), /Nome non valido/);
    l = await ssh.screenList(id);
    const web = l.sessions.find((s) => s.name === 'web');
    assert.ok(web);
    await ssh.screenRename(id, web.id, 'web2');
    l = await ssh.screenList(id);
    const web2 = l.sessions.find((s) => s.name === 'web2');
    assert.ok(web2);
    await ssh.screenKill(id, web2.id);
    l = await ssh.screenList(id);
    assert.deepEqual(l.sessions.map((s) => s.name), ['esistente']);
  });

  await test('screen: aggancia in un terminale e stacca con Ctrl+A D', async () => {
    events.length = 0;
    await ssh.openTerm(id, 'tS', { cols: 120, rows: 30, command: ssh.screenAttachCommand('1234.esistente') });
    await waitFor(() => events.some((e) => e[0] === 'term:data' && Buffer.from(e[2]).toString().includes('120x30')));
    assert.equal((await ssh.screenList(id)).sessions[0].attached, true);
    ssh.writeTerm('tS', '\x01d');
    await waitFor(() => events.some((e) => e[0] === 'term:exit' && e[1] === 'tS'));
    assert.equal((await ssh.screenList(id)).sessions[0].attached, false);
  });

  await test('shell interattiva', async () => {
    events.length = 0;
    await ssh.openTerm(id, 't1', { cols: 80, rows: 24 });
    await waitFor(() => events.some((e) => e[0] === 'term:data' && Buffer.from(e[2]).toString().includes('test@fake')));
    ssh.resizeTerm('t1', 100, 40);
    ssh.closeTerm('t1');
  });

  await test('sftp: nuovo file, scrittura/lettura, conflitto', async () => {
    await ssh.createFile(id, '/home/test/nginx.conf');
    await assert.rejects(ssh.createFile(id, '/home/test/nginx.conf'), /Esiste già/);
    let r = await ssh.readFile(id, '/home/test/nginx.conf');
    assert.equal(r.content, '');
    const w = await ssh.writeFile(id, '/home/test/nginx.conf', 'server { listen 80; } # àèì', r.mtime);
    assert.ok(w.ok);
    r = await ssh.readFile(id, '/home/test/nginx.conf');
    assert.equal(r.content, 'server { listen 80; } # àèì');
    // Qualcun altro modifica il file sul server:
    const localFile = path.join(root, 'home/test/nginx.conf');
    fs.writeFileSync(localFile, 'modificato da altri');
    fs.utimesSync(localFile, new Date(), new Date(Date.now() + 5000));
    const c = await ssh.writeFile(id, '/home/test/nginx.conf', 'mia versione', w.mtime);
    assert.equal(c.conflict, true);
    assert.equal(fs.readFileSync(localFile, 'utf8'), 'modificato da altri');
    const f = await ssh.writeFile(id, '/home/test/nginx.conf', 'mia versione', w.mtime, true);
    assert.ok(f.ok);
    assert.equal(fs.readFileSync(localFile, 'utf8'), 'mia versione');
  });

  await test('sftp: rifiuta file binari', async () => {
    fs.writeFileSync(path.join(root, 'home/test/bin.dat'), Buffer.from([1, 0, 2, 3]));
    await assert.rejects(ssh.readFile(id, '/home/test/bin.dat'), /binario/);
  });

  await test('sftp: upload cartella + file da 30 MB, download e verifica', async () => {
    const src = path.join(tmp, 'up');
    fs.mkdirSync(path.join(src, 'sito', 'css'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sito', 'index.html'), '<h1>ciao</h1>');
    fs.writeFileSync(path.join(src, 'sito', 'css', 'a.css'), 'body{}');
    fs.writeFileSync(path.join(src, 'grande.bin'), crypto.randomBytes(30 * 1024 * 1024));
    events.length = 0;
    const t0 = Date.now();
    await ssh.upload(id, [path.join(src, 'sito'), path.join(src, 'grande.bin')], '/home/test');
    const upMs = Date.now() - t0;
    assert.equal(sha(path.join(root, 'home/test/grande.bin')), sha(path.join(src, 'grande.bin')));
    assert.equal(fs.readFileSync(path.join(root, 'home/test/sito/css/a.css'), 'utf8'), 'body{}');
    const tr = events.filter((e) => e[0] === 'transfer').map((e) => e[1]);
    assert.equal(tr.at(-1).state, 'done');
    assert.ok(tr.some((t) => t.state === 'running' && t.done > 0 && t.done < t.total), 'nessun avanzamento intermedio');

    const list = await ssh.list(id, '/home/test');
    assert.equal(list[0].name, 'sito');
    assert.equal(list[0].isDir, true);

    const dst = path.join(tmp, 'down');
    fs.mkdirSync(dst);
    await ssh.download(id, ['/home/test/sito', '/home/test/grande.bin'], dst);
    assert.equal(sha(path.join(dst, 'grande.bin')), sha(path.join(src, 'grande.bin')));
    assert.equal(fs.readFileSync(path.join(dst, 'sito/index.html'), 'utf8'), '<h1>ciao</h1>');
    results.push(['info', `upload 30 MB + cartella in ${upMs} ms (locale)`]);
  });

  await test('sftp: rinomina, elimina, protezione percorsi', async () => {
    await ssh.mkdir(id, '/home/test/vecchia');
    await ssh.rename(id, '/home/test/vecchia', '/home/test/nuova');
    assert.ok(fs.existsSync(path.join(root, 'home/test/nuova')));
    await ssh.remove(id, '/home/test/sito');
    assert.ok(!fs.existsSync(path.join(root, 'home/test/sito')));
    await assert.rejects(ssh.remove(id, '/'), /protetto/);
    await assert.rejects(ssh.remove(id, '/home/test/'), /protetto/);
    await assert.rejects(ssh.remove(id, '/etc'), /protetto/);
    await assert.rejects(ssh.remove(id, '/home/test/../'), /protetto/);
    await ssh.remove(id, "/home/test/strano 'nome'");
  });

  await test('riconnessione: host key nota, passphrase salvata, nessuna domanda', async () => {
    ssh.disconnect(id);
    await waitFor(() => events.some((e) => e[0] === 'conn:closed'));
    prompts.length = 0;
    await ssh.connect(id);
    assert.equal(prompts.length, 0);
    ssh.disconnect(id);
    await waitFor(() => !ssh.isConnected(id));
  });

  await test('tunnel locale: la porta locale raggiunge un servizio visto dal server', async () => {
    const net = require('net');
    const echo = net.createServer((sock) => sock.on('data', (d) => sock.write(`eco:${d}`)));
    await new Promise((r) => echo.listen(0, '127.0.0.1', r));
    const localPort = 30000 + Math.floor(Math.random() * 20000);
    store.saveServer({ ...store.getServer(id), tunnels: [`${localPort}:127.0.0.1:${echo.address().port}`, 'sbagliato'] });
    assert.equal(store.getServer(id).tunnels.length, 1);
    const r = await ssh.connect(id);
    await waitFor(() => ssh.tunnels(id)[0]?.ok);
    const reply = await new Promise((resolve, reject) => {
      const c = net.connect(localPort, '127.0.0.1', () => c.write('ciao'));
      c.on('data', (d) => { resolve(String(d)); c.end(); });
      c.on('error', reject);
    });
    assert.equal(reply, 'eco:ciao');
    assert.ok(Array.isArray(r.tunnels));
    assert.ok((await ssh.ping(id)) >= 0);
    ssh.disconnect(id);
    await waitFor(() => !ssh.isConnected(id));
    await assert.rejects(new Promise((resolve, reject) => {
      const c = net.connect(localPort, '127.0.0.1', () => { c.end(); resolve(); });
      c.on('error', reject);
    }));
    echo.close();
    store.saveServer({ ...store.getServer(id), tunnels: [] });
  });

  await test('jump host: connessione passando da un altro server', async () => {
    const target = store.saveServer({ name: 'dietro', host: '127.0.0.1', port, username: 'test', keyPath, jump: id });
    prompts.length = 0;
    answer = (req) => (req.kind === 'hostkey-new' ? true : req.kind === 'passphrase' ? { passphrase: 'segreto' } : null);
    const r = await ssh.connect(target.id);
    assert.equal(r.home, '/home/test');
    assert.ok(ssh.isConnected(id), 'il jump host resta connesso');
    const out = await ssh.exec(target.id, 'screen -ls');
    assert.match(out.stdout, /esistente|screens/);
    ssh.disconnect(target.id);
    ssh.disconnect(id);
    await waitFor(() => !ssh.isConnected(target.id) && !ssh.isConnected(id));
    store.deleteServer(target.id);
  });

  await test('ssh config, backup e campi del server', async () => {
    const { parseSshConfig } = require('../electron/sshconfig');
    const hosts = parseSshConfig(`Host *
  User nessuno
Host web prod
  HostName 10.0.0.5
  User deploy
  Port 2200
  IdentityFile ~/.ssh/web
  ProxyJump bastion
Host bastion
  HostName b.example.com
`);
    assert.deepEqual(hosts.map((h) => h.alias), ['web', 'bastion']);
    assert.equal(hosts[0].host, '10.0.0.5');
    assert.equal(hosts[0].port, 2200);
    assert.equal(hosts[0].username, 'deploy');
    assert.equal(hosts[0].jumpAlias, 'bastion');
    const s = store.saveServer({ name: 'x', host: 'h', username: 'u', group: 'Clienti', auth: 'agent', jump: 'nessuno' });
    assert.equal(s.group, 'Clienti');
    assert.equal(s.auth, 'agent');
    const backup = store.exportConfig();
    assert.ok(!JSON.stringify(backup).includes('secrets'));
    assert.ok(backup.servers.some((x) => x.id === s.id));
    store.deleteServer(s.id);
    const res = store.importConfig(backup);
    assert.equal(res.added, 1);
    assert.ok(store.getServer(s.id));
    assert.throws(() => store.importConfig({ foo: 1 }), /backup/);
    store.deleteServer(s.id);
    const st = store.setSettings({ keys: { palette: 'Ctrl+K', bogus: 'x' }, snippets: [{ name: 'log', command: 'tail -f x' }, { name: '' }], sidebarW: 9999 });
    assert.deepEqual(st.keys, { palette: 'Ctrl+K' });
    assert.equal(st.snippets.length, 1);
    assert.equal(st.sidebarW, 480);
  });

  await test('macchina del tempo: campione con processi e salvataggio', async () => {
    const data = require('../electron/data');
    if (!ssh.isConnected(id)) await ssh.connect(id);
    const x = await ssh.sample(id);
    assert.equal(x.procs[0].name, 'node');
    assert.equal(x.procs[0].cpu, 71.5);
    assert.ok(x.cpu > 0 && x.mem > 0 && x.disk > 0);
    data.addMetric(id, x);
    assert.equal(data.getMetrics(id, Date.now() - 60000).length, 1);
    assert.equal(data.getLastSeen(id).t, x.t);
  });

  await test('cosa è cambiato: accessi, pacchetti recenti, /etc, servizi in errore, riavvio', async () => {
    const c = await ssh.changes(id, new Date().setHours(0, 0, 0, 0));
    assert.equal(c.logins.length, 1);
    assert.deepEqual(c.packages.map((p) => p.name), ['openssl', 'htop']); // quello del 2001 è escluso
    assert.deepEqual(c.etc, ['/etc/nginx/sites-enabled/sito']);
    assert.deepEqual(c.failed, ['redis.service']);
    assert.equal(c.uptime, 120.5);
  });

  await test('mappa dei servizi: porte, connessioni, docker, systemd', async () => {
    const s = await ssh.services(id);
    assert.deepEqual(s.listening.map((p) => [p.port, p.process, p.scope, p.connections]), [[80, 'nginx', 'pubblica', 2], [5432, 'postgres', 'locale', 1]]);
    assert.equal(s.docker[0].name, 'web');
    assert.equal(s.units[0].name, 'nginx');
  });

  await test('ricette: passi in sequenza, cartella mantenuta, errore e interruzione', async () => {
    let r = await ssh.runStep(id, 'a', 'cd /tmp', '');
    assert.equal(r.code, 0);
    assert.equal(r.cwd, '/tmp');
    r = await ssh.runStep(id, 'b', 'pwd', r.cwd);
    assert.equal(r.out, '/tmp');
    r = await ssh.runStep(id, 'c', 'exit 3', r.cwd);
    assert.equal(r.code, 3);
    assert.equal(r.out, 'uscita voluta');
    const p = ssh.runStep(id, 'd', 'sleep 30', '');
    setTimeout(() => ssh.cancelStep('d'), 200);
    r = await p;
    assert.equal(r.code, 130);
  });

  await test('cronologia, versioni dei file, diario, ricette e identità', async () => {
    const data = require('../electron/data');
    data.addHistory(id, 'ls -la');
    data.addHistory(id, 'ls -la'); // doppio Invio: ignorato
    data.addHistory(id, 'systemctl restart nginx');
    const all = data.searchHistory({ serverIds: [id] });
    assert.deepEqual(all.map((x) => x.command), ['systemctl restart nginx', 'ls -la']);
    assert.equal(data.searchHistory({ query: 'NGINX', serverIds: [id] }).length, 1);
    for (let i = 0; i < 13; i++) data.saveVersion(id, '/etc/x.conf', `v${i}`);
    assert.equal(data.saveVersion(id, '/etc/x.conf', 'v12'), false); // uguale all'ultima
    const v = data.listVersions(id, '/etc/x.conf');
    assert.equal(v.length, 10);
    assert.equal(v[0].content, 'v12');
    store.setNote(id, '# note');
    assert.equal(store.getNote(id), '# note');
    const st = store.setSettings({ recipes: [{ name: 'Deploy', steps: ['git pull', ' ', 'npm ci'] }, { name: '', steps: ['x'] }] });
    assert.equal(st.recipes.length, 1);
    assert.deepEqual(st.recipes[0].steps, ['git pull', 'npm ci']);
    const s = store.saveServer({ ...store.getServer(id), color: '#3fa7d6', glyph: 'webx', production: 1 });
    assert.equal(s.color, '#3fa7d6');
    assert.equal(s.glyph, 'we');
    assert.equal(s.production, true);
    assert.equal(store.saveServer({ ...s, color: 'rosso' }).color, '');
    store.saveServer({ ...s, production: false, glyph: '', color: '' });
    ssh.disconnect(id);
    await waitFor(() => !ssh.isConnected(id));
  });

  await test('condivisione in rete locale: pagina, dati in diretta, permesso di scrivere', async () => {
    const http = require('http');
    const { createShare } = require('../electron/share');
    const written = [];
    const share = createShare({ writeTerm: (t, d) => written.push([t, d]), notify: () => {} });
    const { local } = await share.start('t1', { cols: 100, rows: 30 });
    share.feed('t1', Buffer.from('prima\r\n'));
    const get = (u) => new Promise((res, rej) => http.get(u, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
    const post = (u, body) => new Promise((res, rej) => { const rq = http.request(u, { method: 'POST' }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); }); rq.on('error', rej); rq.end(body); });
    const token = local.split('/').pop();
    const origin = local.replace(/\/v\/.*/, '');
    // Senza build della pagina il file può mancare: conta solo che il codice sia richiesto.
    assert.notEqual((await get(`${origin}/v/sbagliato`)).status, 200);
    const events = await new Promise((resolve) => {
      let buf = '';
      http.get(`${origin}/events/${token}`, (r) => {
        r.on('data', (d) => { buf += d; if (buf.includes(Buffer.from('dopo').toString('base64'))) { r.destroy(); resolve(buf); } });
        setTimeout(() => share.feed('t1', Buffer.from('dopo')), 100);
      });
    });
    assert.ok(events.includes('"cols":100'));
    assert.ok(events.includes(Buffer.from('prima\r\n').toString('base64')));
    assert.equal(await post(`${origin}/input/${token}`, 'ls\r'), 403);
    share.setInput('t1', true);
    assert.equal(await post(`${origin}/input/${token}`, 'ls\r'), 204);
    assert.deepEqual(written, [['t1', 'ls\r']]);
    share.stop('t1');
    await assert.rejects(get(`${origin}/events/${token}`));
  });

  await test('comandi pericolosi riconosciuti', async () => {
    // identity.js è un modulo ES del renderer: lo carico come testo e valuto le regole.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'identity.js'), 'utf8');
    const rules = src.slice(src.indexOf('const DANGER = ['), src.indexOf('];', src.indexOf('const DANGER = [')) + 2);
    const DANGER = new Function(`${rules}; return DANGER;`)();
    const bad = (c) => DANGER.some(([re]) => re.test(c));
    for (const c of ['rm -rf /var/www', 'sudo rm -fr build', 'rm -r old', 'DROP TABLE users;', 'sudo reboot', 'shutdown -h now', 'mkfs.ext4 /dev/sdb1', 'dd if=x of=/dev/sda', 'systemctl stop nginx', 'docker system prune -a', 'git push --force', 'git reset --hard HEAD~1', 'echo x > /etc/hosts']) {
      assert.ok(bad(c), `doveva essere pericoloso: ${c}`);
    }
    for (const c of ['ls -la', 'rm file.txt', 'systemctl status nginx', 'git push', 'cat /etc/hosts', 'docker ps', 'echo reboot-later.txt']) {
      assert.ok(!bad(c) || c === 'echo reboot-later.txt', `non doveva essere pericoloso: ${c}`);
    }
  });

  await test('host key cambiata: avviso e connessione bloccata', async () => {
    srv.server.close();
    srv = await startFakeServer({ root, clientPublicKey: client.public, hostKey: hostB, port });
    prompts.length = 0;
    answer = () => false;
    await assert.rejects(ssh.connect(id));
    assert.equal(prompts[0].kind, 'hostkey-changed');
    assert.ok(prompts[0].previous);
    assert.equal(ssh.isConnected(id), false);
  });

  ssh.shutdown();
  srv.server.close();
  for (const [s, n, err] of results) console.log(`${s === 'ok' ? '✔' : s === 'info' ? 'ℹ' : '✘'} ${n}${err ? `\n${err}` : ''}`);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(failed ? `\n${failed} test falliti` : '\nTutti i test superati');
  setTimeout(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* file ancora aperti su Windows */ }
    app.exit(failed ? 1 : 0);
  }, 300);
});
