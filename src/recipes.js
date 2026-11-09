// Ricette: sequenze di comandi con parametri, eseguibili su più server insieme.
import { h, icon, toast, fail, confirmDialog } from './dom.js';
import { serverBadge, colorOf, confirmDanger, dangerReason } from './identity.js';

const api = window.api;
let runSeq = 0;

const paramsOf = (steps) => [...new Set(steps.join('\n').match(/\{(\w+)\}/g) || [])].map((p) => p.slice(1, -1));
const fill = (cmd, values) => cmd.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '');
const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);

/**
 * hooks: settings, change(patch), servers(), serverOf(id), current(), connect(id) -> bool, onCommand(id, cmd)
 */
export function createRecipesTab(hooks) {
  let selectedId = null;
  let draft = null; // { name, steps } in modifica
  let running = []; // runId in corso
  const listEl = h('div', { class: 'recipe-list', role: 'list' });
  const detail = h('div', { class: 'recipe-detail' });
  const runsEl = h('div', { class: 'recipe-runs' });

  const recipes = () => hooks.settings.recipes || [];
  const save = (list) => hooks.change({ recipes: list });

  function renderList() {
    const items = recipes().map((r) => h('button', {
      class: `recipe-item ${r.id === selectedId && !draft?.isNew ? 'active' : ''}`,
      type: 'button',
      role: 'listitem',
      onclick: () => { selectedId = r.id; draft = null; renderAll(); },
    }, h('strong', {}, r.name), h('span', {}, `${r.steps.length} ${r.steps.length === 1 ? 'passo' : 'passi'}${paramsOf(r.steps).length ? ` · ${paramsOf(r.steps).map((p) => `{${p}}`).join(' ')}` : ''}`)));
    listEl.replaceChildren(...items, ...(items.length ? [] : [h('p', { class: 'muted small-pad' }, 'Nessuna ricetta ancora.')]));
  }

  function editor(r) {
    const name = h('input', { type: 'text', class: 'input', value: r.name || '', placeholder: 'es. Deploy sito', 'aria-label': 'Nome della ricetta' });
    const steps = h('textarea', { class: 'textarea mono', rows: 8, spellcheck: false, placeholder: 'Un comando per riga, es.\ncd /var/www/{app}\ngit pull\nnpm ci\npm2 restart {app}' });
    steps.value = (r.steps || []).join('\n');
    const hint = h('p', { class: 'muted' });
    const syncHint = () => {
      const p = paramsOf(steps.value.split('\n'));
      hint.textContent = p.length ? `Parametri: ${p.map((x) => `{${x}}`).join(', ')}. Te li chiedo prima di eseguire.` : 'Scrivi {nome} in un comando per renderlo un parametro da compilare a ogni esecuzione.';
    };
    steps.addEventListener('input', syncHint);
    syncHint();
    return h('div', { class: 'recipe-edit' },
      h('label', { class: 'field' }, h('span', {}, 'Nome'), name),
      h('label', { class: 'field' }, h('span', {}, 'Passi'), steps),
      hint,
      h('div', { class: 'row' },
        r.id && h('button', {
          class: 'btn ghost danger-ghost',
          onclick: async () => {
            if (!(await confirmDialog(`Eliminare "${r.name}"?`, 'La ricetta viene rimossa da Screenie.', { ok: 'Elimina' }))) return;
            await save(recipes().filter((x) => x.id !== r.id));
            selectedId = null; draft = null; renderAll();
          },
        }, 'Elimina'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => { draft = null; if (!selectedId) selectedId = recipes()[0]?.id || null; renderAll(); } }, 'Annulla'),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            const data = { id: r.id || crypto.randomUUID(), name: name.value.trim(), steps: steps.value.split('\n').map((x) => x.trim()).filter(Boolean) };
            if (!data.name || !data.steps.length) { toast('Servono un nome e almeno un comando', 'warn'); return; }
            const list = recipes().slice();
            const i = list.findIndex((x) => x.id === data.id);
            if (i >= 0) list[i] = data; else list.push(data);
            await save(list);
            selectedId = data.id; draft = null; renderAll();
          },
        }, 'Salva ricetta')));
  }

  function runner(r) {
    const params = paramsOf(r.steps);
    const inputs = Object.fromEntries(params.map((p) => [p, h('input', { type: 'text', class: 'input mono', placeholder: p, 'aria-label': `Parametro ${p}`, spellcheck: false })]));
    const cur = hooks.current();
    const boxes = hooks.servers().map((s) => ({ s, box: h('input', { type: 'checkbox', checked: s.id === cur }) }));
    return h('div', { class: 'recipe-run-setup' },
      h('div', { class: 'recipe-head' },
        h('h3', {}, r.name),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small ghost', onclick: () => { draft = { ...r }; renderAll(); } }, 'Modifica')),
      h('ol', { class: 'recipe-steps-preview' }, r.steps.map((st) => h('li', {}, h('code', {}, st)))),
      params.length > 0 && h('div', { class: 'recipe-params' }, params.map((p) => h('label', { class: 'field' }, h('span', {}, `{${p}}`), inputs[p]))),
      h('div', { class: 'field' }, h('span', {}, 'Su quali server'),
        h('div', { class: 'recipe-servers' }, boxes.map(({ s, box }) => h('label', { class: 'check recipe-server' }, box, serverBadge(s, 'small'), h('span', {}, s.name), s.production && h('span', { class: 'prod-chip' }, 'produzione'))))),
      h('div', { class: 'row' },
        h('span', { class: 'spacer' }),
        running.length > 0 && h('button', { class: 'btn danger-ghost', onclick: stopAll }, 'Ferma'),
        h('button', {
          class: 'btn primary',
          disabled: running.length > 0,
          onclick: () => {
            const values = Object.fromEntries(params.map((p) => [p, inputs[p].value.trim()]));
            const missing = params.filter((p) => !values[p]);
            if (missing.length) { toast(`Compila {${missing[0]}}`, 'warn'); inputs[missing[0]].focus(); return; }
            const ids = boxes.filter((b) => b.box.checked).map((b) => b.s.id);
            if (!ids.length) { toast('Scegli almeno un server', 'warn'); return; }
            run(r, ids, values);
          },
        }, icon('terminal', 14), 'Esegui')));
  }

  async function run(r, ids, values) {
    const steps = r.steps.map((st) => fill(st, values));
    // Server di produzione: conferma per ogni comando pericoloso.
    for (const id of ids) {
      const s = hooks.serverOf(id);
      for (const st of steps) if (s?.production && dangerReason(st) && !(await confirmDanger(s, st))) return;
    }
    runsEl.replaceChildren();
    const columns = ids.map((id) => runColumn(hooks.serverOf(id), steps));
    runsEl.append(...columns.map((c) => c.el));
    renderAll();
    await Promise.all(ids.map((id, i) => runOn(id, steps, columns[i])));
    renderAll();
  }

  function runColumn(s, steps) {
    const rows = steps.map((st) => {
      const state = h('span', { class: 'step-state wait', 'aria-label': 'In attesa' });
      const out = h('pre', { class: 'step-out hidden' });
      const time = h('span', { class: 'step-time' });
      const row = h('li', { class: 'step' }, state, h('div', { class: 'step-main' }, h('code', {}, st), out), time);
      return { row, state, out, time };
    });
    const elapsed = h('span', { class: 'step-time' });
    const summary = h('div', { class: 'run-summary muted' });
    const el = h('section', { class: 'run-col', style: { '--server-color': colorOf(s) } },
      h('header', {}, serverBadge(s, 'small'), h('strong', {}, s?.name || '?'), h('span', { class: 'spacer' }), elapsed),
      h('ol', { class: 'steps' }, rows.map((x) => x.row)),
      summary);
    return { el, rows, elapsed, summary };
  }

  function setState(row, st, label) {
    row.state.className = `step-state ${st}`;
    row.state.setAttribute('aria-label', label);
  }

  async function runOn(id, steps, col) {
    const t0 = Date.now();
    const tick = setInterval(() => { col.elapsed.textContent = fmtMs(Date.now() - t0); }, 500);
    try {
      if (!(await hooks.connect(id))) { col.summary.textContent = 'Connessione non riuscita.'; col.el.classList.add('failed'); return; }
      let cwd = '';
      for (let i = 0; i < steps.length; i++) {
        const row = col.rows[i];
        setState(row, 'run', 'In corso');
        const runId = `r${++runSeq}`;
        running.push(runId);
        const s0 = Date.now();
        let res;
        try {
          res = await api.invoke('recipe:step', id, runId, steps[i], cwd);
        } catch (e) {
          res = { code: 1, out: e.message, cwd };
        } finally {
          running = running.filter((x) => x !== runId);
        }
        hooks.onCommand(id, steps[i]);
        cwd = res.cwd || cwd;
        row.time.textContent = fmtMs(Date.now() - s0);
        const tail = res.out.split('\n').slice(-6).join('\n');
        if (tail) { row.out.textContent = tail; row.out.classList.remove('hidden'); }
        if (res.code !== 0) {
          setState(row, 'fail', res.code === 130 ? 'Fermato' : `Errore (codice ${res.code})`);
          for (const rest of col.rows.slice(i + 1)) setState(rest, 'skip', 'Saltato');
          col.summary.textContent = res.code === 130 ? 'Fermato.' : `Fermato al passo ${i + 1}: il comando è uscito con codice ${res.code}.`;
          col.el.classList.add('failed');
          return;
        }
        setState(row, 'done', 'Completato');
      }
      col.summary.textContent = `Tutti i passi completati in ${fmtMs(Date.now() - t0)}.`;
      col.el.classList.add('ok');
    } finally {
      clearInterval(tick);
      col.elapsed.textContent = fmtMs(Date.now() - t0);
    }
  }

  function stopAll() {
    for (const id of running) api.invoke('recipe:cancel', id).catch(() => {});
  }

  function renderAll() {
    renderList();
    const r = recipes().find((x) => x.id === selectedId);
    if (draft) detail.replaceChildren(editor(draft));
    else if (r) detail.replaceChildren(runner(r));
    else {
      detail.replaceChildren(h('div', { class: 'empty' },
        icon('snippet', 28),
        h('p', {}, 'Una ricetta è una sequenza di comandi da lanciare con un clic, anche su più server insieme. Ogni passo mostra il suo esito.'),
        h('button', { class: 'btn primary', onclick: () => { draft = { isNew: true, name: '', steps: [] }; renderAll(); } }, icon('plus', 14), 'Crea la prima ricetta')));
    }
  }

  const el = h('div', { class: 'tab-pane page' },
    h('div', { class: 'page-inner' },
      h('div', { class: 'page-head' },
        h('div', {}, h('h2', { class: 'page-h' }, 'Ricette'), h('p', { class: 'muted' }, 'Comandi in sequenza, con parametri, su uno o più server.')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary small', onclick: () => { draft = { isNew: true, name: '', steps: [] }; renderAll(); } }, icon('plus', 14), 'Nuova ricetta')),
      h('div', { class: 'recipes-layout' }, listEl, h('div', { class: 'recipe-main' }, detail, runsEl))));

  return {
    kind: 'recipes',
    title: 'Ricette',
    el,
    show() { if (!selectedId && !draft) selectedId = recipes()[0]?.id || null; renderAll(); },
    newFrom(steps) { draft = { isNew: true, name: '', steps }; renderAll(); },
    select(id) { selectedId = id; draft = null; renderAll(); },
    dispose() { stopAll(); },
  };
}
