// Palette comandi: cerca server, schede, screen, comandi salvati e azioni da tastiera.
import { h, icon } from './dom.js';

// Punteggio di corrispondenza: tutte le lettere della ricerca, in ordine; meglio se vicine e all'inizio.
function score(text, query) {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx;
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    gaps += found - ti;
    ti = found + 1;
  }
  return 500 - gaps;
}

let open = null;

/**
 * items: [{ label, detail?, group, icon, hint?, run }]
 */
export function openPalette(getItems, placeholder = 'Cerca server, schede, comandi…') {
  if (open) { open.input.focus(); return; }
  const opener = document.activeElement;
  const input = h('input', { type: 'text', class: 'palette-input', placeholder, spellcheck: false, 'aria-label': 'Cerca un comando', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list' });
  const listEl = h('div', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
  const box = h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Palette comandi' },
    h('div', { class: 'palette-search' }, icon('search', 16), input, h('kbd', {}, 'Esc')), listEl);
  const backdrop = h('div', { class: 'backdrop palette-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, box);
  let items = [];
  let shown = [];
  let sel = 0;

  function close() {
    backdrop.remove();
    open = null;
    if (opener?.isConnected) opener.focus();
  }

  function render() {
    const q = input.value;
    shown = items.map((it) => ({ it, s: score(`${it.label} ${it.detail || ''} ${it.group}`, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (q ? b.s - a.s : 0))
      .slice(0, 60)
      .map((x) => x.it);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    let lastGroup = null;
    listEl.replaceChildren(...(shown.length ? shown.flatMap((it, i) => {
      const nodes = [];
      if (!q && it.group !== lastGroup) {
        lastGroup = it.group;
        nodes.push(h('div', { class: 'palette-group' }, it.group));
      }
      nodes.push(h('div', {
        class: `palette-item ${i === sel ? 'selected' : ''}`,
        role: 'option',
        id: `pal-${i}`,
        'aria-selected': String(i === sel),
        onmousemove: () => { if (sel !== i) { sel = i; render(); } },
        onclick: () => runAt(i),
      }, icon(it.icon || 'command', 15), h('span', { class: 'palette-label' }, it.label),
      it.detail && h('span', { class: 'palette-detail' }, it.detail),
      it.hint && h('kbd', {}, it.hint)));
      return nodes;
    }) : [h('div', { class: 'palette-empty' }, 'Nessun risultato')]));
    input.setAttribute('aria-activedescendant', shown.length ? `pal-${sel}` : '');
    listEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function runAt(i) {
    const it = shown[i];
    if (!it) return;
    close();
    it.run();
  }

  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });

  document.getElementById('modals').append(backdrop);
  open = { input };
  input.focus();
  Promise.resolve(getItems()).then((list) => { items = list; render(); });
  render();
}
