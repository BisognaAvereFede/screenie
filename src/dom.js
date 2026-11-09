// Piccoli helper per DOM, icone, notifiche e finestre di dialogo.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else el.style[prop] = val;
      }
    }
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  terminal: '<path d="m5 8 4 4-4 4M12 16h7"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 7a8 8 0 1 0 11.4 0"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 12v5M9.5 14.5h5"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sidebarLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  sidebarRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  chevronLeft: '<path d="m14 6-6 6 6 6"/>',
  chevronRight: '<path d="m10 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 10 6 6 6-6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  splitRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  splitDown: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
  snippet: '<path d="M8 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2M16 5h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2M9 12h6"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  import: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  tunnel: '<path d="M4 20V10a8 8 0 0 1 16 0v10"/><path d="M8 20v-8a4 4 0 0 1 8 0v8"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
};

export function icon(name, size = 16) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg focusable="false" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
  return span;
}

export function iconButton(name, title, onclick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, type: 'button', title, 'aria-label': title, onclick }, icon(name));
}

/** Pulsante attivabile (preferito, file nascosti…): stato visivo e `aria-pressed` insieme. */
export function setPressed(btn, on) {
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
}

/** Interruttore on/off: checkbox nativa con aspetto a levetta e nome accessibile. */
export function toggleSwitch(checked, label, onToggle) {
  const input = h('input', { type: 'checkbox', checked, 'aria-label': label, onchange: (e) => onToggle?.(e.target.checked) });
  return { input, el: h('label', { class: 'toggle' }, input, h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-thumb' }))) };
}

// ---------- Movimento ----------

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
export const motionOK = () => !reducedMotion.matches;

/**
 * Fa partire le animazioni d'ingresso di `el` (e dei suoi figli, vedi `.enter` nel CSS)
 * solo quando serve davvero: le liste che si ridisegnano ogni pochi secondi non ripartono.
 */
export function enter(el, ms = 1400) {
  if (!el) return;
  el.classList.remove('enter');
  void el.offsetWidth; // riavvia le animazioni CSS
  el.classList.add('enter');
  clearTimeout(el._enterTimer);
  el._enterTimer = setTimeout(() => el.classList.remove('enter'), ms);
}

/** Toglie un elemento con una breve animazione d'uscita. */
export function leave(el, keyframes, ms = 220) {
  if (!el?.isConnected || !motionOK()) { el?.remove(); return; }
  el.style.pointerEvents = 'none';
  el.animate(keyframes, { duration: ms, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).finished
    .finally(() => el.remove());
}

// ---------- Notifiche ----------

export function toast(message, kind = 'info', ms = 3500) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

export const fail = (e) => toast(e?.message || String(e), 'error', 6000);

// ---------- Finestre modali ----------

let modalSeq = 0;

export function modal({ title, body, actions, onClose, wide }) {
  const root = document.getElementById('modals');
  let close;
  const titleId = `modal-title-${++modalSeq}`;
  const opener = document.activeElement;
  const result = new Promise((resolve) => {
    const backdrop = h('div', { class: 'backdrop' });
    const dialog = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('h2', { id: titleId }, title),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-actions' }, actions.map((a) => h('button', {
        class: `btn ${a.kind || ''}`,
        type: a.submit ? 'submit' : 'button',
        onclick: async () => {
          const v = a.value ? await a.value() : a.result;
          if (v === undefined && a.value) return; // validazione fallita
          close(v);
        },
      }, a.label))));
    close = (v) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      onClose?.();
      if (opener?.isConnected) opener.focus();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      // Tab resta dentro la finestra.
      if (e.key === 'Tab') {
        const items = [...dialog.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent);
        const first = items[0];
        const last = items[items.length - 1];
        if (!dialog.contains(document.activeElement)) { e.preventDefault(); first?.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        dialog.querySelector('.modal-actions .primary, .modal-actions .danger')?.click();
      }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.append(dialog);
    root.append(backdrop);
    setTimeout(() => (dialog.querySelector('input:not([type=checkbox])') || dialog.querySelector('.btn.primary'))?.focus(), 30);
  });
  return result;
}

export function confirmDialog(title, message, { danger = true, ok = 'Conferma' } = {}) {
  return modal({
    title,
    body: h('p', {}, message),
    actions: [
      { label: 'Annulla', result: false },
      { label: ok, kind: danger ? 'danger' : 'primary', result: true },
    ],
  }).then(Boolean);
}

export function inputDialog(title, label, value = '', { ok = 'OK', hint } = {}) {
  const input = h('input', { type: 'text', value, spellcheck: false });
  setTimeout(() => {
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
  }, 40);
  return modal({
    title,
    body: h('label', { class: 'field' }, h('span', {}, label), input, hint && h('small', {}, hint)),
    actions: [
      { label: 'Annulla', result: null },
      { label: ok, kind: 'primary', value: () => input.value.trim() || undefined },
    ],
  });
}

// ---------- Menu contestuale ----------

export function contextMenu(x, y, items) {
  document.querySelector('.ctx-menu')?.remove();
  const opener = document.activeElement;
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', away, true);
    if (opener?.isConnected) opener.focus();
  };
  const menu = h('div', { class: 'ctx-menu', role: 'menu' },
    items.filter(Boolean).map((it) => it === '-'
      ? h('div', { class: 'ctx-sep', role: 'separator' })
      : h('button', {
        class: `ctx-item ${it.danger ? 'danger' : ''}`,
        type: 'button',
        role: 'menuitem',
        tabindex: -1,
        onclick: () => { close(); it.action(); },
      }, it.icon ? icon(it.icon, 14) : h('span', { class: 'icon', 'aria-hidden': 'true' }), h('span', {}, it.label), it.hint ? h('kbd', { 'aria-hidden': 'true' }, it.hint) : null)));
  // Frecce per scorrere le voci, Esc o Tab per chiudere.
  menu.addEventListener('keydown', (e) => {
    const entries = [...menu.querySelectorAll('.ctx-item')];
    const i = entries.indexOf(document.activeElement);
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (step) { e.preventDefault(); entries[(i + step + entries.length) % entries.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); entries[e.key === 'Home' ? 0 : entries.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  menu.querySelector('.ctx-item')?.focus();
  const away = (e) => {
    if (!menu.contains(e.target)) close();
  };
  setTimeout(() => document.addEventListener('mousedown', away, true));
}

/** Coordinate per aprire il menu contestuale da tastiera (tasto Menu o Maiusc+F10) sotto un elemento. */
export function menuAnchor(el) {
  const r = el.getBoundingClientRect();
  return { clientX: r.left + 16, clientY: r.bottom, preventDefault() {} };
}

export const isMenuKey = (e) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');

// ---------- Formattazione ----------

export function formatSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

export function formatDate(sec) {
  const d = new Date(sec * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
}

export function formatMode(mode) {
  const chars = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? chars[i] : '-';
  return s;
}
