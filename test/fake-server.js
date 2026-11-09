// Server SSH finto per i test: SFTP reale su una cartella locale,
// "screen" simulato in memoria, shell che fa eco.
const { Server, utils } = require('ssh2');
const fs = require('fs');
const path = require('path');

const { OPEN_MODE, STATUS_CODE } = utils.sftp;

function startFakeServer({ root, clientPublicKey, hostKey, port = 0 }) {
  const allowed = utils.parseKey(clientPublicKey);
  const screens = new Map([['1234.esistente', { attached: false }]]);
  let pid = 2000;
  const HOME = '/home/test';
  fs.mkdirSync(path.join(root, HOME), { recursive: true });
  const local = (p) => path.join(root, path.posix.resolve(HOME, p));
  const unq = (s) => s.replace(/^'|'$/g, '').replace(/'\\''/g, "'");

  const toAttrs = (st) => ({
    mode: st.mode, uid: 1000, gid: 1000, size: st.size,
    atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000),
  });

  function handleExec(cmd, stream, pty) {
    const out = (s) => stream.write(s);
    const end = (code = 0) => { stream.exit(code); stream.end(); };
    let m;
    if (cmd.includes('screen -ls')) {
      if (!screens.size) out('No Sockets found in /run/screen/S-test.\n\n');
      else {
        out('There are screens on:\n');
        for (const [id, s] of screens) out(`\t${id}\t(31/10/2026 10:00:00)\t(${s.attached ? 'Attached' : 'Detached'})\n`);
        out(`${screens.size} Sockets in /run/screen/S-test.\n\n`);
      }
      return end(0);
    }
    if ((m = cmd.match(/^screen -U -dmS ('(?:[^']|'\\'')*')/))) {
      screens.set(`${++pid}.${unq(m[1])}`, { attached: false });
      return end(0);
    }
    if ((m = cmd.match(/^screen -S ('(?:[^']|'\\'')*') -X quit/))) {
      const ok = screens.delete(unq(m[1]));
      if (!ok) out('No screen session found.\n');
      return end(ok ? 0 : 1);
    }
    if ((m = cmd.match(/^screen -S ('(?:[^']|'\\'')*') -X sessionname ('(?:[^']|'\\'')*')/))) {
      const id = unq(m[1]);
      if (!screens.has(id)) return end(1);
      screens.delete(id);
      screens.set(`${id.split('.')[0]}.${unq(m[2])}`, { attached: false });
      return end(0);
    }
    if (cmd.startsWith('screen -wipe')) return end(0);
    // Processi più pesanti (macchina del tempo).
    if (cmd.startsWith('ps -eo comm=')) {
      out('node            71.5 624000\npostgres        19.0 1200000\nnginx            4.0 38000\n');
      return end(0);
    }
    // "Cosa è cambiato?"
    if (cmd.includes('__SCREENIE_LOGIN__')) {
      const now = new Date();
      const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      out(['__SCREENIE_LOGIN__', 'mario    pts/0        10.0.0.9         Mon Nov  9 03:10   still logged in',
        '__SCREENIE_PKG__', `2001-01-01 10:00:00 upgrade vecchio:amd64 1 2`, `${d} 00:00:01 upgrade openssl:amd64 3.0.1 3.0.2`, `${d} 00:00:02 install htop:amd64 <none> 3.2`,
        '__SCREENIE_ETC__', '/etc/nginx/sites-enabled/sito',
        '__SCREENIE_FAILED__', 'redis.service loaded failed failed Redis',
        '__SCREENIE_UPTIME__', '120.5 300.1',
        '__SCREENIE_DISK__', '31876546560', '__SCREENIE_END__', ''].join('\n'));
      return end(0);
    }
    // Mappa dei servizi.
    if (cmd.includes('__SCREENIE_LISTEN__')) {
      out(['__SCREENIE_LISTEN__',
        'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6))',
        'LISTEN 0 511 [::]:80 [::]:* users:(("nginx",pid=1,fd=7))',
        'LISTEN 0 244 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=2,fd=5))',
        '__SCREENIE_EST__', '10.0.0.5:80', '10.0.0.5:80', '127.0.0.1:5432',
        '__SCREENIE_DOCKER__', 'web\tnginx:alpine\t0.0.0.0:8080->80/tcp\tUp 2 hours',
        '__SCREENIE_UNITS__', 'nginx.service loaded active running A high performance web server',
        '__SCREENIE_END__', ''].join('\n'));
      return end(0);
    }
    // Ricette: bash -lc '<script>' con la cartella di lavoro restituita alla fine.
    if ((m = cmd.match(/^bash -lc ('(?:[^']|'\\'')*')$/s))) {
      const script = unq(m[1]);
      const cdm = script.match(/^cd '([^']*)'/);
      let cwd = cdm ? cdm[1] : HOME;
      const body = script.replace(/^cd '[^']*' 2>\/dev\/null; /, '').split('\n')[0];
      let code = 0;
      if ((m = body.match(/^cd (\S+)$/))) cwd = path.posix.resolve(cwd, m[1]);
      else if (body === 'pwd') out(`${cwd}\n`);
      else if ((m = body.match(/^echo (.*)$/))) out(`${m[1]}\n`);
      else if ((m = body.match(/^exit (\d+)$/))) { out('uscita voluta\n'); code = Number(m[1]); }
      else if (body === 'sleep 30') { stream.on('signal', () => end(130)); return; }
      else { out(`comando sconosciuto: ${body}\n`); code = 127; }
      out(`\n__SCREENIE_PWD__${cwd}\n`);
      return end(code);
    }
    if (cmd.startsWith('cat /proc/loadavg')) {
      out('0.84 0.61 0.52 2/311 4242\n4\n8233017344 5164826624\n84278861824 31876546560\n361234.12 1200000.00\nfake-vps\n');
      return end(0);
    }
    if ((m = cmd.match(/^rm -rf -- ('(?:[^']|'\\'')*')/))) {
      fs.rmSync(local(unq(m[1])), { recursive: true, force: true });
      return end(0);
    }
    if ((m = cmd.match(/^screen -U -d -r ('(?:[^']|'\\'')*')/))) {
      const id = unq(m[1]);
      const s = screens.get(id);
      if (!s) { out(`There is no screen to be resumed matching ${id}.\r\n`); return end(1); }
      s.attached = true;
      out(`[dentro lo screen ${id}, pty ${pty?.cols}x${pty?.rows}]\r\n`);
      stream.on('data', (d) => {
        if (d.toString().includes('\x01d')) {
          s.attached = false;
          out('[detached]\r\n');
          end(0);
        } else out(d);
      });
      return;
    }
    out(`comando sconosciuto: ${cmd}\n`);
    end(127);
  }

  function handleSftp(sftp) {
    const handles = new Map();
    let next = 0;
    const newHandle = (v) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(++next);
      handles.set(next, v);
      return b;
    };
    const getH = (b) => handles.get(b.readUInt32BE(0));
    const fail = (id, e) => sftp.status(id, e?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, e?.message);

    sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: path.posix.resolve(HOME, p), longname: '', attrs: {} }]));
    sftp.on('STAT', (id, p) => { try { sftp.attrs(id, toAttrs(fs.statSync(local(p)))); } catch (e) { fail(id, e); } });
    sftp.on('LSTAT', (id, p) => { try { sftp.attrs(id, toAttrs(fs.lstatSync(local(p)))); } catch (e) { fail(id, e); } });
    sftp.on('FSTAT', (id, hb) => { try { sftp.attrs(id, toAttrs(fs.fstatSync(getH(hb).fd))); } catch (e) { fail(id, e); } });
    sftp.on('OPEN', (id, p, flags) => {
      try {
        const fd = fs.openSync(local(p), utils.sftp.flagsToString(flags));
        sftp.handle(id, newHandle({ fd }));
      } catch (e) { fail(id, e); }
    });
    sftp.on('READ', (id, hb, offset, len) => {
      const h = getH(hb);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(h.fd, buf, 0, len, offset);
      if (!n) return sftp.status(id, STATUS_CODE.EOF);
      sftp.data(id, buf.subarray(0, n));
    });
    sftp.on('WRITE', (id, hb, offset, data) => {
      fs.writeSync(getH(hb).fd, data, 0, data.length, offset);
      sftp.status(id, STATUS_CODE.OK);
    });
    sftp.on('CLOSE', (id, hb) => {
      const h = getH(hb);
      if (h?.fd != null) fs.closeSync(h.fd);
      handles.delete(hb.readUInt32BE(0));
      sftp.status(id, STATUS_CODE.OK);
    });
    sftp.on('OPENDIR', (id, p) => {
      try {
        const names = fs.readdirSync(local(p));
        sftp.handle(id, newHandle({ dir: local(p), names, sent: false }));
      } catch (e) { fail(id, e); }
    });
    sftp.on('READDIR', (id, hb) => {
      const h = getH(hb);
      if (h.sent) return sftp.status(id, STATUS_CODE.EOF);
      h.sent = true;
      sftp.name(id, h.names.map((n) => ({ filename: n, longname: n, attrs: toAttrs(fs.lstatSync(path.join(h.dir, n))) })));
    });
    sftp.on('MKDIR', (id, p) => { try { fs.mkdirSync(local(p)); sftp.status(id, STATUS_CODE.OK); } catch (e) { fail(id, e); } });
    sftp.on('RENAME', (id, a, b) => { try { fs.renameSync(local(a), local(b)); sftp.status(id, STATUS_CODE.OK); } catch (e) { fail(id, e); } });
    sftp.on('REMOVE', (id, p) => { try { fs.unlinkSync(local(p)); sftp.status(id, STATUS_CODE.OK); } catch (e) { fail(id, e); } });
    sftp.on('RMDIR', (id, p) => { try { fs.rmdirSync(local(p)); sftp.status(id, STATUS_CODE.OK); } catch (e) { fail(id, e); } });
    sftp.on('SETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
    sftp.on('FSETSTAT', (id) => sftp.status(id, STATUS_CODE.OK));
  }

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey' && ctx.key.algo === allowed.type
        && Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0
        && (!ctx.signature || allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) {
        return ctx.accept();
      }
      ctx.reject(['publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        let pty = null;
        session.on('pty', (a, _r, info) => { pty = info; a?.(); });
        session.on('window-change', (a) => a?.());
        session.on('exec', (a, _r, info) => handleExec(info.command, a(), pty));
        session.on('shell', (a) => {
          const s = a();
          s.write('test@fake:~$ ');
          s.on('data', (d) => s.write(d.toString() === '\r' ? '\r\ntest@fake:~$ ' : d));
        });
        session.on('sftp', (a) => handleSftp(a()));
      });
      // Canali direct-tcpip: servono a tunnel locali e jump host.
      client.on('tcpip', (accept, reject, info) => {
        const sock = require('net').connect(info.destPort, info.destIP);
        sock.once('error', () => reject?.());
        sock.once('connect', () => {
          const stream = accept();
          stream.pipe(sock).pipe(stream);
          stream.on('error', () => sock.destroy());
        });
      });
    });
    client.on('error', () => {});
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, screens })));
}

module.exports = { startFakeServer };

// Avvio diretto: node test/fake-server.js <cartella> <porta>
if (require.main === module) {
  const os = require('os');
  const root = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'screenie-fake-'));
  const keyDir = path.join(root, 'keys');
  fs.mkdirSync(keyDir, { recursive: true });
  const ensure = (name) => {
    const p = path.join(keyDir, name);
    if (!fs.existsSync(p)) {
      const k = utils.generateKeyPairSync('ed25519');
      fs.writeFileSync(p, k.private);
      fs.writeFileSync(`${p}.pub`, k.public);
    }
    return p;
  };
  const clientKey = ensure('client');
  const hostKeyPath = ensure('host');
  startFakeServer({
    root: path.join(root, 'fs'),
    clientPublicKey: fs.readFileSync(`${clientKey}.pub`),
    hostKey: fs.readFileSync(hostKeyPath),
    port: Number(process.argv[3]) || 2222,
  }).then(({ port }) => console.log(`fake ssh on 127.0.0.1:${port} key=${clientKey}`));
}
