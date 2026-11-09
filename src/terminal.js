import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { h, icon, iconButton, fail, toast, contextMenu } from './dom.js';
import { terminalTheme, terminalBackground, monoFamily, onThemeChange } from './theme.js';

const api = window.api;
const handlers = new Map(); // termId -> { data, exit }
const panes = new Set(); // tutti i riquadri aperti, per la trasmissione a più terminali

api.onTermData((id, data) => handlers.get(id)?.data(data));
api.onTermExit((id) => handlers.get(id)?.exit());

let seq = 0;

// Collegamenti con il resto dell'app (impostati da app.js).
const hooks = {
  isOn: () => true, // il server è ancora connesso?
  notify: () => {}, // notifica di sistema
  snippets: () => [],
  onBroadcastChange: () => {},
  onCommand: () => {}, // comando eseguito (per la cronologia)
  needsConfirm: () => false, // il comando va confermato su questo server?
  confirm: async () => true,
  share: () => {}, // condividi il riquadro in rete locale
};

// Il comando sulla riga del cursore, senza il prompt ("utente@host:~$ ").
// Se non c'è un prompt riconoscibile (password, programmi interattivi) non registra nulla.
function currentCommand(term) {
  const b = term.buffer.active;
  if (b.type !== 'normal') return '';
  let y = b.baseY + b.cursorY;
  let line = b.getLine(y);
  if (!line) return '';
  let text = line.translateToString(true);
  while (line?.isWrapped && y > 0) {
    y--;
    line = b.getLine(y);
    text = (line?.translateToString(true) || '') + text;
  }
  for (let y2 = b.baseY + b.cursorY + 1; b.getLine(y2)?.isWrapped; y2++) text += b.getLine(y2).translateToString(true);
  const m = text.match(/^[^$#]{0,200}?[$#] (.*)$/);
  return m ? m[1].trim() : '';
}
export function configureTerminals(h2) { Object.assign(hooks, h2); }

// ---------- Trasmissione: quello che scrivi va a tutti i terminali aperti ----------
let broadcast = false;
export const isBroadcasting = () => broadcast;
export function setBroadcast(on) {
  broadcast = !!on;
  document.body.classList.toggle('broadcasting', broadcast);
  hooks.onBroadcastChange(broadcast, livePanes().length);
}
const livePanes = () => [...panes].filter((p) => p.alive);

const SEARCH_OPTS = { decorations: { matchOverviewRuler: '#888', activeMatchColorOverviewRuler: '#fff', matchBackground: '#7652e855', activeMatchBackground: '#f5c45c99' } };

/**
 * Crea una scheda terminale. `command` (opzionale) viene eseguito al posto della shell,
 * ad esempio per agganciarsi a uno screen. Le schede shell si possono dividere in più riquadri.
 */
export function createTerminalTab({ serverId, title, command, screen, fontSize = 14, onScreenGone, onTitle }) {
  let size = fontSize;
  let dir = 'row';
  let focused = null;
  const list = []; // riquadri di questa scheda

  const grid = h('div', { class: 'term-grid' });
  const searchInput = h('input', { type: 'search', placeholder: 'Cerca nel terminale', spellcheck: false, 'aria-label': 'Cerca nel terminale' });
  const searchInfo = h('span', { class: 'term-search-info', 'aria-live': 'polite' });
  const search = h('form', { class: 'term-search hidden', onsubmit: (e) => { e.preventDefault(); find(1); } },
    icon('search', 14), searchInput, searchInfo,
    iconButton('chevronLeft', 'Risultato precedente (Maiusc+Invio)', () => find(-1)),
    iconButton('chevronRight', 'Risultato successivo (Invio)', () => find(1)),
    iconButton('x', 'Chiudi la ricerca (Esc)', () => closeSearch()));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); find(-1); }
  });
  searchInput.addEventListener('input', () => find(1, true));

  const tools = h('div', { class: 'term-tools' },
    iconButton('search', 'Cerca (Ctrl+Shift+F)', () => openSearch()),
    !screen && iconButton('splitRight', 'Dividi a destra (Ctrl+Shift+E)', () => tab.split('row')),
    !screen && iconButton('splitDown', 'Dividi sotto (Ctrl+Shift+O)', () => tab.split('col')),
    iconButton('snippet', 'Comandi salvati', (e) => snippetMenu(e.currentTarget)),
    iconButton('broadcast', 'Scrivi in tutti i terminali', () => setBroadcast(!broadcast), 'broadcast-btn'),
    iconButton('globe', 'Condividi in rete locale', () => hooks.share(tab), 'share-btn'));

  const toolbar = screen ? h('div', { class: 'term-toolbar' },
    h('span', { class: 'chip screen-chip' }, 'screen'),
    h('span', { class: 'term-toolbar-name' }, screen.name),
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn small',
      title: 'Lo screen resta attivo sul server (come Ctrl+A poi D)',
      onclick: () => list[0] && api.termWrite(list[0].id, '\x01d'),
    }, 'Stacca'),
    h('button', {
      class: 'btn small danger-ghost',
      title: 'Chiude lo screen e tutto quello che ci gira dentro',
      onclick: () => tab.killScreen?.(),
    }, 'Termina'),
  ) : null;
  const body = h('div', { class: 'term-body' }, grid, tools, search);
  const el = h('div', { class: 'tab-pane term-pane' }, toolbar, body);

  function snippetMenu(anchor) {
    const items = hooks.snippets();
    const r = anchor.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, items.length
      ? items.map((s) => ({ label: s.name, icon: 'terminal', action: () => tab.send(`${s.command}\r`) }))
      : [{ label: 'Nessun comando salvato: aggiungili nelle Impostazioni', icon: 'snippet', action: () => {} }]);
  }

  function layout() {
    grid.dataset.count = String(list.length);
    grid.dataset.dir = dir;
    for (const p of list) p.cell.classList.toggle('focused', list.length > 1 && p === focused);
    requestAnimationFrame(() => list.forEach((p) => p.fit()));
  }

  function createPane(cmd) {
    const id = `t${++seq}`;
    const host = h('div', { class: 'term-host' });
    const closeBtn = iconButton('x', 'Chiudi questo riquadro', () => removePane(pane, true), 'pane-close');
    const cell = h('div', { class: 'term-cell' }, host, closeBtn);
    const term = new Terminal({
      fontFamily: monoFamily(),
      fontSize: size,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 20000,
      allowProposedApi: true,
      allowTransparency: true,
      theme: terminalTheme(),
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon((e, uri) => window.open(uri)));

    const pane = {
      id, term, host, cell, searchAddon, serverId, alive: false, opened: false, title: '',
      fit: () => { if (pane.opened && cell.offsetParent) { try { fitAddon.fit(); } catch { /* nascosto */ } } },
      write: (d) => api.termWrite(id, d),
    };

    // Copia alla selezione e incolla col tasto destro, come PuTTY/MobaXterm.
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    });
    host.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const text = await navigator.clipboard.readText().catch(() => '');
      if (text && pane.alive) term.paste(text);
    });
    host.addEventListener('focusin', () => { focused = pane; layout(); onTitle?.(tab); });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const mod = api.platform === 'darwin' ? e.metaKey : e.ctrlKey && e.shiftKey;
      if (mod && e.code === 'KeyC') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
        return false;
      }
      if (mod && e.code === 'KeyV') {
        navigator.clipboard.readText().then((t) => t && term.paste(t));
        return false;
      }
      if (!pane.alive && e.key === 'Enter' && !screen) {
        start(pane);
        return false;
      }
      return true;
    });

    term.onData((d) => {
      if (!pane.alive) return;
      const targets = broadcast ? livePanes() : [pane];
      if (d === '\r') {
        const cmd = currentCommand(term);
        if (cmd) {
          const servers = [...new Set(targets.map((p) => p.serverId))];
          if (servers.some((id) => hooks.needsConfirm(id, cmd))) {
            hooks.confirm(servers.find((id) => hooks.needsConfirm(id, cmd)), cmd).then((ok) => {
              if (ok) { for (const p of targets) if (p.alive) p.write('\r'); servers.forEach((id) => hooks.onCommand(id, cmd)); }
              term.focus();
            });
            return;
          }
          servers.forEach((id) => hooks.onCommand(id, cmd));
        }
      }
      for (const p of targets) p.write(d);
    });
    term.onResize(({ cols, rows }) => pane.alive && api.termResize(id, cols, rows));
    // Il prompt di bash su Ubuntu/Debian imposta il titolo a "utente@host: cartella".
    term.onTitleChange((t) => { pane.title = t; onTitle?.(tab); });

    // Avviso quando un comando lungo finisce in una scheda che non stai guardando.
    let burst = 0;
    let quiet = null;
    function activity() {
      const now = Date.now();
      if (!burst) burst = now;
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        const long = Date.now() - burst > 20000;
        burst = 0;
        if (long && (!tab.isVisible() || !document.hasFocus())) {
          hooks.notify('Comando terminato', `Nessun nuovo output in "${tab.title}" da qualche secondo.`);
        }
      }, 5000);
      if (!tab.isVisible()) tab.setActivity?.(true);
    }

    handlers.set(id, {
      data: (d) => { term.write(d); activity(); },
      exit: () => {
        pane.alive = false;
        // Se è caduta la connessione il riquadro resta, in attesa della riconnessione.
        setTimeout(() => {
          if (!hooks.isOn(serverId)) {
            term.write('\r\n\x1b[2m── connessione persa · riconnessione… ──\x1b[0m\r\n');
            tab.setState?.('off');
            return;
          }
          if (screen) {
            onScreenGone?.();
            tab.close?.({ force: true });
          } else if (list.length > 1) {
            removePane(pane, false);
          } else {
            tab.setState?.('off');
            term.write('\r\n\x1b[2m── sessione chiusa · premi Invio per riaprirla ──\x1b[0m\r\n');
          }
        }, 400);
      },
    });
    pane.cmd = cmd;
    pane.dispose = () => {
      clearTimeout(quiet);
      handlers.delete(id);
      panes.delete(pane);
      api.invoke('term:close', id).catch(() => {});
      term.dispose();
    };
    panes.add(pane);
    return pane;
  }

  async function start(pane) {
    try {
      pane.fit();
      await api.invoke('term:open', serverId, pane.id, { cols: pane.term.cols, rows: pane.term.rows, command: pane.cmd });
      pane.alive = true;
      tab.setState?.('on');
    } catch (e) {
      pane.term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`);
      if (!screen) pane.term.write('\x1b[2mpremi Invio per riprovare\x1b[0m\r\n');
      fail(e);
    }
  }

  function openPane(pane) {
    if (pane.opened) return;
    pane.opened = true;
    pane.term.open(pane.host);
    applyTheme();
    start(pane);
  }

  function removePane(pane, kill) {
    const i = list.indexOf(pane);
    if (i < 0) return;
    if (list.length === 1) { tab.close?.(); return; }
    list.splice(i, 1);
    pane.cell.remove();
    if (kill) pane.dispose(); else { handlers.delete(pane.id); panes.delete(pane); pane.term.dispose(); }
    focused = list[Math.max(0, i - 1)];
    layout();
    focused?.term.focus();
  }

  function addPane(cmd) {
    const pane = createPane(cmd);
    list.push(pane);
    grid.append(pane.cell);
    if (tab.isVisible()) openPane(pane);
    focused = pane;
    layout();
    return pane;
  }

  // ---------- Ricerca ----------
  function openSearch() {
    search.classList.remove('hidden');
    const sel = focused?.term.getSelection();
    if (sel && !sel.includes('\n')) searchInput.value = sel;
    searchInput.focus();
    searchInput.select();
  }
  function closeSearch() {
    search.classList.add('hidden');
    searchInfo.textContent = '';
    for (const p of list) p.searchAddon.clearDecorations();
    focused?.term.focus();
  }
  function find(step, incremental = false) {
    const p = focused || list[0];
    const q = searchInput.value;
    if (!p || !q) { searchInfo.textContent = ''; return; }
    const opts = { ...SEARCH_OPTS, incremental };
    const ok = step > 0 ? p.searchAddon.findNext(q, opts) : p.searchAddon.findPrevious(q, opts);
    searchInfo.textContent = ok ? '' : 'nessun risultato';
  }

  // ---------- Tema ----------
  function applyTheme() {
    const bg = terminalBackground();
    el.classList.toggle('custom-theme', !!bg);
    el.style.setProperty('--term-custom', bg || 'transparent');
    for (const p of list) {
      p.term.options.theme = terminalTheme();
      p.term.options.fontFamily = monoFamily();
    }
    requestAnimationFrame(() => list.forEach((p) => p.fit()));
  }

  const ro = new ResizeObserver(() => list.forEach((p) => p.fit()));
  ro.observe(grid);

  const tab = {
    id: `term-tab-${seq + 1}`,
    serverId,
    kind: screen ? 'screen' : 'term',
    title,
    screen,
    el,
    get termTitle() { return (focused || list[0])?.title || ''; },
    isVisible: () => !el.classList.contains('hidden') && !!el.offsetParent,
    show() {
      for (const p of list) openPane(p);
      requestAnimationFrame(() => {
        list.forEach((p) => p.fit());
        (focused || list[0])?.term.focus();
      });
      tab.setActivity?.(false);
    },
    focus: () => (focused || list[0])?.term.focus(),
    setFontSize(n) {
      size = n;
      for (const p of list) { p.term.options.fontSize = n; p.fit(); }
    },
    async send(text) {
      const p = focused || list[0];
      if (!p?.alive) { toast('La sessione non è attiva', 'warn'); return false; }
      const cmd = text.replace(/\r$/, '').trim();
      if (text.endsWith('\r') && cmd) {
        if (hooks.needsConfirm(serverId, cmd) && !(await hooks.confirm(serverId, cmd))) { p.term.focus(); return false; }
        hooks.onCommand(serverId, cmd);
      }
      p.write(text);
      p.term.focus();
      return true;
    },
    // Riquadro attivo, per la condivisione in rete locale.
    get activePane() { const p = focused || list[0]; return p ? { id: p.id, cols: p.term.cols, rows: p.term.rows, alive: p.alive } : null; },
    split(direction = 'row') {
      if (screen) return;
      if (list.length >= 4) { toast('Al massimo 4 riquadri per scheda', 'warn'); return; }
      if (list.length === 1) dir = direction;
      addPane(undefined);
    },
    openSearch,
    get paneCount() { return list.length; },
    get dir() { return dir; },
    // Dopo una riconnessione: riapre le sessioni dei riquadri rimasti.
    restart() {
      for (const p of list) {
        if (p.alive || !p.opened) continue;
        p.term.write('\x1b[2m── riconnesso ──\x1b[0m\r\n');
        start(p);
      }
    },
    sessionInfo: () => ({ kind: tab.kind, serverId, screen: screen?.name, panes: list.length, dir }),
    dispose() {
      offTheme();
      ro.disconnect();
      for (const p of list) p.dispose();
      list.length = 0;
    },
  };
  const offTheme = onThemeChange(applyTheme);
  addPane(command);
  return tab;
}

/** Riapre una scheda divisa come era nella sessione precedente. */
export function restoreSplits(tab, { panes: n = 1, dir = 'row' } = {}) {
  for (let i = 1; i < n; i++) tab.split(dir);
}
