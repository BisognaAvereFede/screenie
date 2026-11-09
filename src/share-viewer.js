// Pagina aperta nel browser di chi guarda una sessione condivisa da Screenie.
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

const style = document.createElement('style');
style.textContent = `
  html, body { margin: 0; height: 100%; background: #0e0f11; color: #ece9e2; font: 14px system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #222327; }
  .title { color: #8c8a85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .spacer { flex: 1; }
  .chip { font-size: 12px; padding: 2px 8px; border-radius: 6px; background: #1d1e22; color: #b9b6ae; }
  .chip.on { background: #2a2245; color: #c9b8ff; }
  .state { font-size: 12px; color: #8c8a85; }
  main { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
`;
document.head.append(style);

const token = location.pathname.split('/').filter(Boolean)[1];
const term = new Terminal({ fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace', fontSize: 14, cursorBlink: true, disableStdin: true, theme: { background: '#0e0f11' } });
term.open(document.getElementById('term'));
const stateEl = document.getElementById('state');
const modeEl = document.getElementById('mode');
let allowInput = false;

const setMode = (on) => {
  allowInput = on;
  term.options.disableStdin = !on;
  modeEl.textContent = on ? 'puoi scrivere' : 'sola lettura';
  modeEl.classList.toggle('on', on);
};

const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const es = new EventSource(`/events/${token}`);
es.addEventListener('hello', (e) => {
  const d = JSON.parse(e.data);
  term.resize(d.cols, d.rows);
  document.getElementById('title').textContent = d.title || '';
  setMode(d.allowInput);
  stateEl.textContent = 'in diretta';
});
es.addEventListener('data', (e) => term.write(decode(JSON.parse(e.data))));
es.addEventListener('size', (e) => { const d = JSON.parse(e.data); term.resize(d.cols, d.rows); });
es.addEventListener('input', (e) => setMode(JSON.parse(e.data)));
es.addEventListener('end', () => { stateEl.textContent = 'condivisione terminata'; es.close(); setMode(false); });
es.onerror = () => { if (es.readyState === EventSource.CLOSED) stateEl.textContent = 'disconnesso'; else stateEl.textContent = 'riconnessione…'; };

term.onData((d) => {
  if (!allowInput) return;
  fetch(`/input/${token}`, { method: 'POST', body: d }).catch(() => {});
});
