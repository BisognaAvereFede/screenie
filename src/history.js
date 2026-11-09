// Cronologia dei comandi di tutti i server, cercabile.
import { h, icon, iconButton, toast, fail, confirmDialog } from './dom.js';
import { serverBadge } from './identity.js';

const api = window.api;

function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Oggi';
  if (d.toDateString() === yest.toDateString()) return 'Ieri';
  return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * hooks: servers(), serverOf(id), run(serverId, cmd), insert(serverId, cmd), newRecipe(steps)
 */
export function createHistoryTab(hooks) {
  const search = h('input', { type: 'search', class: 'input', placeholder: 'Cerca un comando… (es. "nginx" o "restart")', spellcheck: false, 'aria-label': 'Cerca nella cronologia' });
  const serverFilter = h('select', { class: 'select', 'aria-label': 'Server' });
  const list = h('div', { class: 'history-list', role: 'list' });
  const count = h('span', { class: 'muted' });
  let timer = null;
  let results = [];
  const selected = new Set();
  const recipeBtn = h('button', { class: 'btn small', disabled: true, onclick: () => hooks.newRecipe([...selected].map((i) => results[i].command)) }, icon('snippet', 14), 'Crea ricetta dai selezionati');

  function fillServers() {
    const cur = serverFilter.value;
    serverFilter.replaceChildren(h('option', { value: '' }, 'Tutti i server'), ...hooks.servers().map((s) => h('option', { value: s.id }, s.name)));
    serverFilter.value = cur;
  }

  async function load() {
    try {
      const all = await api.invoke('data:searchHistory', { query: search.value, limit: 500 });
      results = serverFilter.value ? all.filter((r) => r.serverId === serverFilter.value) : all;
    } catch (e) { fail(e); return; }
    selected.clear();
    render();
  }

  function render() {
    recipeBtn.disabled = !selected.size;
    count.textContent = results.length ? `${results.length} comandi${results.length >= 500 ? ' (i più recenti)' : ''}` : '';
    if (!results.length) {
      list.replaceChildren(h('div', { class: 'empty' },
        icon('clock', 28),
        h('p', {}, search.value ? 'Nessun comando trovato.' : 'Ancora nessun comando. Quelli che esegui nei terminali compaiono qui, server per server.')));
      return;
    }
    const nodes = [];
    let day = '';
    results.forEach((r, i) => {
      const d = dayLabel(r.time);
      if (d !== day) { day = d; nodes.push(h('div', { class: 'history-day' }, d)); }
      const s = hooks.serverOf(r.serverId);
      const box = h('input', { type: 'checkbox', checked: selected.has(i), 'aria-label': 'Seleziona per una ricetta', onchange: (e) => { if (e.target.checked) selected.add(i); else selected.delete(i); recipeBtn.disabled = !selected.size; } });
      nodes.push(h('div', { class: 'history-row', role: 'listitem' },
        box,
        s ? serverBadge(s, 'small') : h('span', { class: 'server-badge small' }, '?'),
        h('code', { class: 'history-cmd', title: r.command }, r.command),
        h('span', { class: 'history-time' }, new Date(r.time).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })),
        h('span', { class: 'history-actions' },
          iconButton('edit', 'Scrivi nel terminale (senza eseguire)', () => hooks.insert(r.serverId, r.command)),
          iconButton('terminal', 'Esegui di nuovo', () => hooks.run(r.serverId, r.command)),
          iconButton('link', 'Copia', () => { navigator.clipboard.writeText(r.command); toast('Comando copiato', 'ok', 1500); }))));
    });
    list.replaceChildren(...nodes);
  }

  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
  serverFilter.addEventListener('change', load);

  const el = h('div', { class: 'tab-pane page' },
    h('div', { class: 'page-inner' },
      h('div', { class: 'page-head' },
        h('div', {}, h('h2', { class: 'page-h' }, 'Cronologia comandi'), h('p', { class: 'muted' }, 'Tutti i comandi eseguiti nei terminali di Screenie, con data e server.')),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'btn small ghost',
          onclick: async () => {
            const id = serverFilter.value;
            const name = id ? hooks.serverOf(id)?.name : 'tutti i server';
            if (!(await confirmDialog('Cancellare la cronologia?', `Vengono eliminati i comandi salvati di ${name}. Non si può annullare.`, { ok: 'Cancella' }))) return;
            for (const s of id ? [{ id }] : hooks.servers()) await api.invoke('data:clearHistory', s.id).catch(() => {});
            load();
          },
        }, 'Cancella cronologia')),
      h('div', { class: 'history-toolbar' }, search, serverFilter, count, h('span', { class: 'spacer' }), recipeBtn),
      list));

  return {
    kind: 'history',
    title: 'Cronologia',
    el,
    show() { fillServers(); load(); setTimeout(() => search.focus(), 50); },
    focusSearch: () => search.focus(),
    dispose() { clearTimeout(timer); },
  };
}
