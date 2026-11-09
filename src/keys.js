// Scorciatoie da tastiera personalizzabili: definizioni, riconoscimento, registrazione ed elenco.
import { h, modal } from './dom.js';

const api = window.api;
const mac = api.platform === 'darwin';

// Le combinazioni con Ctrl ma senza Maiusc le usa la shell (Ctrl+K, Ctrl+P, Ctrl+F…):
// quelle predefinite usano quasi tutte Ctrl+Maiusc.
export const ACTIONS = [
  { id: 'palette', label: 'Palette comandi', def: 'Ctrl+Shift+P' },
  { id: 'newTerminal', label: 'Nuovo terminale', def: 'Ctrl+Shift+T' },
  { id: 'newScreen', label: 'Nuovo screen', def: 'Ctrl+Shift+S' },
  { id: 'closeTab', label: 'Chiudi scheda', def: 'Ctrl+Shift+W' },
  { id: 'nextTab', label: 'Scheda successiva', def: 'Ctrl+Tab' },
  { id: 'prevTab', label: 'Scheda precedente', def: 'Ctrl+Shift+Tab' },
  { id: 'search', label: 'Cerca nel terminale', def: 'Ctrl+Shift+F' },
  { id: 'splitRight', label: 'Dividi il terminale a destra', def: 'Ctrl+Shift+E' },
  { id: 'splitDown', label: 'Dividi il terminale sotto', def: 'Ctrl+Shift+O' },
  { id: 'broadcast', label: 'Scrivi in tutti i terminali', def: 'Ctrl+Shift+A' },
  { id: 'toggleSidebar', label: 'Mostra/nascondi barra laterale', def: 'Ctrl+Shift+B' },
  { id: 'toggleInspector', label: 'Mostra/nascondi pannello server', def: 'Ctrl+Shift+D' },
  { id: 'settings', label: 'Impostazioni', def: 'Ctrl+,' },
  { id: 'shortcuts', label: 'Elenco scorciatoie', def: 'F1' },
];

// Fisse, non modificabili.
export const FIXED = [
  ['Ctrl+S', 'Salva il file nell\'editor'],
  ['Ctrl + / − / 0', 'Testo del terminale più grande, più piccolo, normale'],
  ['Selezione', 'Copia nel terminale'],
  ['Tasto destro', 'Incolla nel terminale'],
  ['Ctrl+Shift+C / V', 'Copia e incolla nel terminale'],
];

// Su macOS queste passano dalla barra dei menu (con ⌘).
const MAC_MENU = new Set(['newTerminal', 'newScreen', 'closeTab', 'toggleSidebar', 'toggleInspector', 'settings', 'nextTab', 'prevTab']);

/** Combinazione premuta, nel formato "Ctrl+Shift+T". */
export function comboFromEvent(e) {
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
  let key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(k)) key = k;
  else if (k === ' ') key = 'Space';
  else if (k.length === 1) key = k.toUpperCase();
  else key = k;
  const parts = [];
  if (e.ctrlKey || (mac && e.metaKey)) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export function bindings(custom = {}) {
  return Object.fromEntries(ACTIONS.map((a) => [a.id, custom[a.id] || a.def]));
}

/** Azione legata alla combinazione dell'evento, o null. */
export function actionFor(e, custom) {
  const combo = comboFromEvent(e);
  if (!combo) return null;
  for (const [id, c] of Object.entries(bindings(custom))) {
    if (c === combo && !(mac && MAC_MENU.has(id))) return id;
  }
  return null;
}

export const display = (combo) => (mac ? combo.replace(/Ctrl/g, '⌘').replace(/Shift/g, '⇧').replace(/Alt/g, '⌥') : combo);

/** Chiede di premere una nuova combinazione. Restituisce la combinazione, '' per tornare al predefinito, null se annullato. */
export function recordCombo(label) {
  const shown = h('kbd', { class: 'record-kbd' }, 'Premi i tasti…');
  let combo = null;
  const onKey = (e) => {
    if (e.key === 'Escape' || e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    const c = comboFromEvent(e);
    if (!c) return;
    combo = c;
    shown.textContent = display(c);
  };
  window.addEventListener('keydown', onKey, true);
  return modal({
    title: `Scorciatoia: ${label}`,
    body: h('div', { class: 'record' }, h('p', {}, 'Premi la combinazione che vuoi usare, poi Salva.'), shown),
    actions: [
      { label: 'Annulla', result: null },
      { label: 'Predefinita', result: '' },
      { label: 'Salva', kind: 'primary', value: () => combo || undefined },
    ],
  }).finally(() => window.removeEventListener('keydown', onKey, true));
}

/** Finestra con l'elenco di tutte le scorciatoie. */
export function showShortcuts(custom) {
  const b = bindings(custom);
  return modal({
    title: 'Scorciatoie da tastiera',
    wide: true,
    body: h('div', { class: 'shortcut-list' },
      ACTIONS.map((a) => h('div', { class: 'shortcut-row' }, h('span', {}, a.label), h('kbd', {}, display(b[a.id])))),
      FIXED.map(([k, d]) => h('div', { class: 'shortcut-row' }, h('span', {}, d), h('kbd', {}, display(k)))),
      h('p', { class: 'muted shortcut-note' }, 'Puoi cambiarle in Impostazioni → Scorciatoie.')),
    actions: [{ label: 'Chiudi', kind: 'primary', result: null }],
  });
}
