// Pagina "Home": i server salvati, con stato e azioni, e le cartelle preferite.
import { h, icon, formatSize } from './dom.js';
import logoUrl from './logo-mark.svg';
import { serverBadge, colorOf } from './identity.js';

const api = window.api;

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function summary(online, total) {
  if (!total) return '';
  if (!online) return `${plural(total, 'server salvato', 'server salvati')}, nessuno connesso.`;
  return `${online} di ${total} connessi.`;
}

/**
 * ctx: { servers(), status(id), stats(id), latency(id), error(id), current(),
 *        addServer(), importSshConfig(), connect(id), disconnect(id), openTerminal(id),
 *        newScreen(id), openFavorite(id, path), openFiles(id) }
 */
export function createHomePage(ctx) {
  const body = h('div', { class: 'page-inner home' });
  const el = h('div', { class: 'tab-pane page' }, body);
  const screens = new Map(); // serverId -> numero di screen
  const favorites = new Map(); // serverId -> [{ path, name }]

  // Barra "Apri" (solo con molti server): server, azione, via.
  let pick = null;
  let action = 'terminal';
  const target = () => {
    const ids = ctx.servers().map((s) => s.id);
    if (ids.includes(pick)) return pick;
    return ids.includes(ctx.current()) ? ctx.current() : ids[0];
  };
  const statusLabel = (st) => (st === 'on' ? 'Connesso' : st === 'connecting' ? 'Connessione…' : 'Non connesso');

  function select(label, value, options, onchange) {
    const sel = h('select', { 'aria-label': label, onchange: (e) => onchange(e.target.value) },
      options.map(([v, text]) => h('option', { value: v }, text)));
    sel.value = value;
    return h('label', { class: 'finder-field' },
      h('span', { class: 'finder-label' }, label),
      h('span', { class: 'finder-select' }, sel, icon('chevronDown', 16)));
  }

  function finder(servers) {
    const id = target();
    const status = ctx.status(id);
    const run = () => {
      if (action === 'terminal') ctx.openTerminal(id);
      else if (action === 'screen') ctx.newScreen(id);
      else ctx.openFiles(id);
    };
    return h('div', { class: 'finder' },
      select('Server', id, servers.map((s) => [s.id, s.name]), (v) => { pick = v; render(); }),
      h('span', { class: 'finder-sep' }),
      select('Azione', action, [['terminal', 'Nuovo terminale'], ['screen', 'Nuovo screen'], ['files', 'File']], (v) => { action = v; }),
      h('span', { class: 'finder-sep' }),
      h('div', { class: 'finder-field' },
        h('span', { class: 'finder-label' }, 'Stato'),
        h('span', { class: 'finder-value' }, h('span', { class: `status-dot ${status}` }), statusLabel(status))),
      h('button', { class: 'finder-go', type: 'button', title: 'Vai', 'aria-label': 'Vai', onclick: run }, icon('arrowRight', 18)));
  }

  function serverCard(s) {
    const status = ctx.status(s.id);
    const st = ctx.stats(s.id);
    const on = status === 'on';
    const err = !on && status !== 'connecting' ? ctx.error(s.id) : null;
    const ms = on ? ctx.latency(s.id) : null;
    const count = screens.get(s.id) || 0;
    const addr = `${s.username}@${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ''}`;
    const cpu = on && st ? pct(st.load, st.cpus) : 0;
    const days = on && st ? st.uptime / 86400 : 0;
    return h('article', { class: `card server-tile ${status} ${err ? 'has-error' : ''}`, style: { '--server-color': colorOf(s) } },
      h('div', { class: 'tile-head' },
        h('span', { class: 'server-avatar large' }, serverBadge(s, 'large'),
          h('span', { class: `status-dot beat ${status} ${cpu >= 85 ? 'hot' : ''}`, style: { '--beat': `${(2.6 - Math.min(100, cpu) / 100 * 2).toFixed(2)}s` } })),
        h('div', { class: 'tile-title' },
          h('h3', { class: 'tile-name' }, s.name),
          h('div', { class: 'tile-sub' }, addr)),
        on && h('button', { class: 'icon-btn', type: 'button', title: 'Disconnetti', 'aria-label': `Disconnetti ${s.name}`, onclick: () => ctx.disconnect(s.id) }, icon('logout', 16))),
      h('div', { class: 'tile-meta' },
        h('span', { class: `badge ${status}` }, h('span', { class: 'badge-dot' }), statusLabel(status)),
        s.production && h('span', { class: 'prod-chip' }, 'produzione'),
        s.group && h('span', { class: 'tile-group' }, s.group),
        days >= 100 && h('span', { class: 'uptime-badge' }, icon('star', 12), days >= 365 ? `${Math.floor(days / 365)} ann${days >= 730 ? 'i' : 'o'} accesi` : `${Math.floor(days)} giorni accesi`),
        ms != null && h('span', { class: 'tile-latency', title: 'Latenza' }, `${ms} ms`)),
      err && h('p', { class: 'tile-error', role: 'alert' }, err),
      on && st && h('div', { class: 'tags' },
        [['CPU', pct(st.load, st.cpus)], ['RAM', pct(st.memUsed, st.memTotal)], ['Disco', pct(st.diskUsed, st.diskTotal)]]
          .map(([k, v]) => h('span', { class: `tag ${v >= 90 ? 'hot' : v >= 80 ? 'warm' : ''}` }, `${k} ${v}%`))),
      h('div', { class: 'tile-foot' },
        h('div', { class: 'tile-figure' }, on
          ? [h('strong', {}, plural(count, 'screen', 'screen')), h('small', {}, st ? `${st.cpus} core · ${formatSize(st.memTotal)} RAM` : 'attivi')]
          : null),
        on
          ? h('button', { class: 'btn primary', onclick: () => ctx.openTerminal(s.id) }, icon('terminal', 15), 'Nuovo terminale')
          : h('button', { class: 'btn primary', disabled: status === 'connecting', onclick: () => ctx.connect(s.id) },
            status === 'connecting' ? 'Connessione…' : err ? 'Riprova' : 'Connetti')));
  }

  function welcome() {
    return h('section', { class: 'welcome' },
      h('img', { class: 'welcome-logo', src: logoUrl, alt: '' }),
      h('h2', {}, 'Benvenuto in Screenie'),
      h('p', { class: 'muted' }, 'Terminali, screen e file dei tuoi server in un unico posto. Per iniziare aggiungi un server o importa quelli che usi già con OpenSSH.'),
      h('div', { class: 'welcome-actions' },
        h('button', { class: 'btn primary large', onclick: ctx.addServer }, icon('plus', 16), 'Aggiungi server'),
        h('button', { class: 'btn large', onclick: ctx.importSshConfig }, icon('import', 16), 'Importa da ~/.ssh/config')));
  }

  function render() {
    const servers = ctx.servers();
    if (!servers.length) {
      body.replaceChildren(welcome());
      return;
    }
    const online = servers.filter((s) => ctx.status(s.id) === 'on');
    const favRows = servers.flatMap((s) => (favorites.get(s.id) || []).map((f) => ({ server: s, fav: f })));

    body.replaceChildren(...[
      h('div', { class: 'section-title' },
        h('div', {},
          h('h2', {}, 'I tuoi server'),
          h('p', { class: 'section-sub' }, summary(online.length, servers.length))),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', onclick: ctx.importSshConfig, title: 'Importa i server da ~/.ssh/config' }, icon('import', 15), 'Importa'),
        h('button', { class: 'btn primary', type: 'button', onclick: ctx.addServer }, icon('plus', 15), 'Aggiungi server')),
      servers.length >= 5 && finder(servers),
      h('div', { class: 'server-grid' }, servers.map(serverCard)),
      favRows.length > 0 && h('section', { class: 'card list-card' },
        h('h2', { class: 'card-title' }, 'Cartelle preferite'),
        favRows.map(({ server, fav }) => h('div', { class: 'list-row', ondblclick: () => ctx.openFavorite(server.id, fav.path) },
          h('span', { class: 'tile orange' }, icon('star', 16)),
          h('div', { class: 'list-text' },
            h('div', { class: 'list-title' }, fav.name),
            h('div', { class: 'list-sub' },
              h('span', { class: 'mono' }, fav.path),
              servers.length > 1 && h('span', {}, server.name))),
          h('button', { class: 'btn small', 'aria-label': `Apri la cartella ${fav.name}`, onclick: () => ctx.openFavorite(server.id, fav.path) }, 'Apri')))),
    ].filter(Boolean));
  }

  // Carica numero di screen (dei server connessi) e preferiti, poi ridisegna.
  async function load() {
    render();
    const servers = ctx.servers();
    await Promise.all(servers.map(async (s) => {
      try { favorites.set(s.id, await api.invoke('servers:getFavorites', s.id)); } catch { /* */ }
      if (ctx.status(s.id) === 'on') {
        try { screens.set(s.id, (await api.invoke('screen:list', s.id)).sessions.length); } catch { /* */ }
      } else screens.delete(s.id);
    }));
    if (el.isConnected) render();
  }

  return {
    kind: 'home',
    serverId: null,
    title: 'Home',
    el,
    show: load,
    refresh: () => { if (el.offsetParent) load(); },
    redraw: () => { if (el.offsetParent) render(); },
    focus() {},
    dispose() {},
  };
}
