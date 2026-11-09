// Diario del server: note in markdown, con i comandi lanciabili nel terminale con un clic.
import { h, icon, fail, toast } from './dom.js';
import { serverBadge } from './identity.js';

const api = window.api;

// Testo in linea: **grassetto**, *corsivo*, `codice`, [link](https://…).
function inline(text, onRun) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(h('strong', {}, t.slice(2, -2)));
    else if (t.startsWith('`')) {
      const code = t.slice(1, -1);
      out.push(h('code', { class: 'note-inline-cmd', title: 'Clic per eseguirlo nel terminale', tabindex: 0, role: 'button', onclick: () => onRun(code), onkeydown: (e) => { if (e.key === 'Enter') onRun(code); } }, code));
    } else if (t.startsWith('[')) {
      const [, label, url] = t.match(/\[([^\]]+)\]\(([^)]+)\)/);
      out.push(h('a', { href: url, onclick: (e) => { e.preventDefault(); window.open(url); } }, label));
    } else out.push(h('em', {}, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Markdown essenziale, costruito come nodi DOM (nessun HTML preso dal testo). */
export function renderMarkdown(src, onRun) {
  const lines = String(src || '').split('\n');
  const nodes = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      const text = code.join('\n');
      nodes.push(h('div', { class: 'note-code' },
        h('pre', {}, text),
        h('div', { class: 'note-code-actions' },
          h('button', { class: 'btn small', onclick: () => onRun(text) }, icon('terminal', 13), 'Esegui'),
          h('button', { class: 'btn small ghost', onclick: () => { navigator.clipboard.writeText(text); toast('Copiato', 'ok', 1500); } }, 'Copia'))));
      continue;
    }
    const hm = line.match(/^(#{1,3})\s+(.*)/);
    if (hm) { nodes.push(h(`h${hm[1].length + 2}`, { class: 'note-h' }, inline(hm[2], onRun))); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const t = lines[i].replace(/^\s*[-*]\s+/, '');
        const task = t.match(/^\[( |x)\]\s+(.*)/i);
        items.push(h('li', { class: task ? 'task' : '' }, task ? [h('span', { class: `task-box ${task[1] !== ' ' ? 'done' : ''}`, 'aria-hidden': 'true' }), inline(task[2], onRun)] : inline(t, onRun)));
        i++;
      }
      nodes.push(h('ul', {}, items));
      continue;
    }
    if (/^\s*\$\s+/.test(line)) {
      const cmd = line.replace(/^\s*\$\s+/, '');
      nodes.push(h('div', { class: 'note-code one' }, h('pre', {}, cmd), h('div', { class: 'note-code-actions' }, h('button', { class: 'btn small', onclick: () => onRun(cmd) }, icon('terminal', 13), 'Esegui'))));
      i++;
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|\s*[-*]\s|\s*\$\s)/.test(lines[i])) para.push(lines[i++]);
    nodes.push(h('p', {}, inline(para.join(' '), onRun)));
  }
  return nodes;
}

const TEMPLATE = `# Note su questo server

- A cosa serve:
- Chi lo gestisce:

## Comandi utili
$ sudo systemctl status nginx

\`\`\`
cd /var/www
git pull
\`\`\`

## Attenzione
- Non toccare il cron delle 4:00
`;

/** hooks: serverOf(id), run(serverId, cmd) */
export function createNotesTab(serverId, hooks) {
  let text = '';
  let editing = false;
  let timer = null;
  const view = h('div', { class: 'note-view' });
  const area = h('textarea', { class: 'textarea mono note-area hidden', spellcheck: false, 'aria-label': 'Testo del diario (markdown)' });
  const status = h('span', { class: 'muted', role: 'status' });
  const toggle = h('button', { class: 'btn small', onclick: () => setEditing(!editing) });

  const run = (cmd) => hooks.run(serverId, cmd);
  function render() {
    toggle.replaceChildren(icon(editing ? 'eye' : 'edit', 14), editing ? 'Fine' : 'Modifica');
    area.classList.toggle('hidden', !editing);
    view.classList.toggle('hidden', editing);
    if (!editing) {
      view.replaceChildren(...(text.trim() ? renderMarkdown(text, run) : [h('div', { class: 'empty' },
        icon('edit', 28),
        h('p', {}, 'Annota qui come è fatto il server, cosa non toccare e i comandi che usi spesso. I comandi scritti dopo "$ " o tra ``` diventano pulsanti da eseguire.'),
        h('button', { class: 'btn primary', onclick: () => { area.value = TEMPLATE; text = TEMPLATE; persist(); setEditing(true); } }, 'Inizia da un modello'))]));
    }
  }
  function setEditing(on) {
    editing = on;
    if (on) { area.value = text; setTimeout(() => area.focus(), 30); } else { text = area.value; persist(true); }
    render();
  }
  async function persist(now) {
    clearTimeout(timer);
    const go = async () => {
      try { await api.invoke('servers:setNote', serverId, text); status.textContent = 'Salvato'; } catch (e) { fail(e); }
    };
    if (now) await go(); else { status.textContent = 'Modificato…'; timer = setTimeout(go, 700); }
  }
  area.addEventListener('input', () => { text = area.value; persist(); });

  const s = hooks.serverOf(serverId);
  const el = h('div', { class: 'tab-pane page' },
    h('div', { class: 'page-inner note-inner' },
      h('div', { class: 'page-head' },
        s && serverBadge(s),
        h('div', {}, h('h2', { class: 'page-h' }, 'Diario'), h('p', { class: 'muted' }, `${s?.name || ''} · note salvate su questo PC`)),
        h('span', { class: 'spacer' }), status, toggle),
      view, area));

  return {
    kind: 'notes',
    serverId,
    title: `${s?.name || 'Server'} · diario`,
    el,
    async show() {
      if (this.loaded) return;
      this.loaded = true;
      try { text = await api.invoke('servers:getNote', serverId); } catch { text = ''; }
      render();
    },
    dispose() { clearTimeout(timer); if (editing) { text = area.value; api.invoke('servers:setNote', serverId, text).catch(() => {}); } },
  };
}
