// Sessione condivisa in rete locale: un link che mostra il tuo terminale in diretta
// nel browser di chi è sulla stessa rete. Sola lettura, oppure con il permesso di scrivere.
// Il link contiene un codice casuale lungo e smette di funzionare quando interrompi.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUFFER_MAX = 256 * 1024;
const distDir = path.join(__dirname, '..', 'dist');

function createShare({ writeTerm, notify }) {
  const sessions = new Map(); // token -> sessione
  const byTerm = new Map(); // termId -> token
  let server = null;
  let port = 0;

  function lanAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
      }
    }
    return '127.0.0.1';
  }

  function sendEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(s, event, data) {
    for (const res of s.clients) sendEvent(res, event, data);
  }

  function serveFile(res, rel) {
    const file = path.join(distDir, rel);
    if (!file.startsWith(distDir)) { res.writeHead(404).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
    });
  }

  function onRequest(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (!sessions.size) { res.writeHead(404).end(); return; }
    // La pagina è in /v/<codice> e carica i file da ./assets, cioè /v/assets/…
    if (parts[0] === 'v' && parts[1] === 'assets' && parts.length === 3 && /^[\w.-]+$/.test(parts[2])) return serveFile(res, path.join('assets', parts[2]));
    const s = sessions.get(parts[1]);
    if (!s) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Questa sessione non è più condivisa.'); return; }
    if (parts[0] === 'v' && req.method === 'GET') return serveFile(res, 'share.html');
    if (parts[0] === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      sendEvent(res, 'hello', { cols: s.cols, rows: s.rows, allowInput: s.allowInput, title: s.title });
      if (s.buffer) sendEvent(res, 'data', s.buffer.toString('base64'));
      s.clients.add(res);
      notify(s.termId, s.clients.size);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); s.clients.delete(res); notify(s.termId, s.clients.size); });
      return;
    }
    if (parts[0] === 'input' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        if (s.allowInput && body) writeTerm(s.termId, body);
        res.writeHead(s.allowInput ? 204 : 403).end();
      });
      return;
    }
    res.writeHead(404).end();
  }

  async function ensureServer() {
    if (server) return;
    server = http.createServer(onRequest);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => { port = server.address().port; resolve(); });
    });
  }

  async function start(termId, { cols = 80, rows = 24, title = '', allowInput = false } = {}) {
    if (byTerm.has(termId)) stop(termId);
    await ensureServer();
    const token = crypto.randomBytes(18).toString('base64url');
    sessions.set(token, { token, termId, cols, rows, title, allowInput: !!allowInput, clients: new Set(), buffer: Buffer.alloc(0) });
    byTerm.set(termId, token);
    return { url: `http://${lanAddress()}:${port}/v/${token}`, local: `http://127.0.0.1:${port}/v/${token}` };
  }

  function setInput(termId, allow) {
    const s = sessions.get(byTerm.get(termId));
    if (!s) return;
    s.allowInput = !!allow;
    broadcast(s, 'input', s.allowInput);
  }

  function stop(termId) {
    const token = byTerm.get(termId);
    const s = sessions.get(token);
    byTerm.delete(termId);
    if (!s) return;
    broadcast(s, 'end', true);
    for (const res of s.clients) res.end();
    sessions.delete(token);
    if (!sessions.size && server) { server.close(); server = null; }
  }

  function feed(termId, data) {
    const s = sessions.get(byTerm.get(termId));
    if (!s) return;
    const buf = Buffer.from(data);
    s.buffer = Buffer.concat([s.buffer, buf]);
    if (s.buffer.length > BUFFER_MAX) s.buffer = s.buffer.subarray(s.buffer.length - BUFFER_MAX);
    broadcast(s, 'data', buf.toString('base64'));
  }

  function resize(termId, cols, rows) {
    const s = sessions.get(byTerm.get(termId));
    if (!s) return;
    s.cols = cols;
    s.rows = rows;
    broadcast(s, 'size', { cols, rows });
  }

  return {
    start, stop, setInput, feed, resize,
    stopAll: () => { for (const id of [...byTerm.keys()]) stop(id); },
    isShared: (termId) => byTerm.has(termId),
  };
}

module.exports = { createShare };
