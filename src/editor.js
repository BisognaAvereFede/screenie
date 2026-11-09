// Editor di file remoti con salvataggio automatico via SFTP.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { php } from '@codemirror/lang-php';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { sql } from '@codemirror/legacy-modes/mode/sql';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { h, fail, toggleSwitch, modal, toast } from './dom.js';
import { diffView } from './diff.js';
import { effectiveTheme, onThemeChange } from './theme.js';

const api = window.api;

// Colori presi dalle variabili CSS: seguono tema e colore principale senza ricreare l'editor.
const baseTheme = (dark) => EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--card)', color: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--card)', border: 'none', color: 'var(--faint)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent) !important' },
  '.cm-scroller': { fontFamily: 'var(--mono)' },
}, { dark });
const editorTheme = (mode) => (mode === 'dark' ? [oneDark, baseTheme(true)] : [baseTheme(false)]);

function languageFor(path) {
  const name = path.split('/').pop().toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (name === 'dockerfile') return StreamLanguage.define(dockerFile);
  if (/nginx|\/sites-(available|enabled)\//.test(path) || ext === 'conf' && /nginx/.test(path)) return StreamLanguage.define(nginx);
  if (name.startsWith('.') && /rc$|profile$/.test(name)) return StreamLanguage.define(shell);
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': return javascript({ jsx: true });
    case 'ts': case 'tsx': return javascript({ typescript: true, jsx: ext === 'tsx' });
    case 'py': return python();
    case 'php': return php();
    case 'html': case 'htm': return html();
    case 'css': case 'scss': return css();
    case 'json': return json();
    case 'md': return markdown();
    case 'yml': case 'yaml': return yaml();
    case 'sh': case 'bash': case 'zsh': return StreamLanguage.define(shell);
    case 'toml': return StreamLanguage.define(toml);
    case 'sql': return StreamLanguage.define(sql({}));
    case 'ini': case 'conf': case 'cfg': case 'env': case 'properties': return StreamLanguage.define(properties);
    default: return [];
  }
}

// File di configurazione: niente salvataggio automatico, e prima di salvare mostra le differenze.
const isConfig = (p) => p.startsWith('/etc/') || /\.(conf|cnf|cfg|ini|service|timer|socket|env|ya?ml|toml)$|(^|\/)(\.env[\w.-]*|\.htaccess|Caddyfile|crontab)$/i.test(p);

export async function createEditorTab({ serverId, path, settings, onDirtyChange }) {
  const { content, mtime: initialMtime } = await api.invoke('sftp:read', serverId, path);
  const config = isConfig(path);
  let lastVersionAt = 0;

  let mtime = initialMtime;
  let savedText = content;
  let timer = null;
  let saving = null;
  let conflict = false;

  const status = h('span', { class: 'save-status ok', role: 'status' }, 'Salvato');
  const { input: autoToggle, el: autoSwitch } = toggleSwitch(settings.autosave && !config, 'Salvataggio automatico');
  if (config) autoToggle.disabled = true;
  const banner = h('div', { class: 'conflict-banner hidden' });
  // <bdi> evita che la direzione rtl (usata per tagliare il percorso a sinistra) sposti le barre.
  const pathLabel = h('span', { class: 'editor-path', title: path }, h('bdi', {}, path));
  const header = h('div', { class: 'editor-header' },
    pathLabel,
    h('span', { class: 'spacer' }),
    status,
    h('div', { class: 'switch', title: config ? 'File di configurazione: prima di salvare ti mostro le differenze' : 'Salva automaticamente mentre scrivi' }, autoSwitch, h('span', { 'aria-hidden': 'true', onclick: () => autoToggle.click() }, 'Salvataggio automatico')),
    h('button', { class: 'btn small ghost', onclick: () => showDiff(), title: 'Confronta con la versione sul server' }, 'Differenze'),
    h('button', { class: 'btn small ghost', onclick: () => showVersions(), title: 'Le ultime 10 versioni salvate da Screenie' }, 'Versioni'),
    h('button', { class: 'btn small', onclick: () => manualSave(), title: 'Ctrl+S' }, 'Salva'),
  );
  const host = h('div', { class: 'editor-host' });
  const el = h('div', { class: 'tab-pane editor-pane' }, header, banner, host);

  const setStatus = (text, kind) => {
    status.textContent = text;
    status.className = `save-status ${kind}`;
  };

  const isDirty = () => view.state.doc.toString() !== savedText;

  async function save(force = false) {
    clearTimeout(timer);
    if (saving) await saving;
    const text = view.state.doc.toString();
    if (!force && text === savedText) return true;
    if (conflict && !force) return false;
    setStatus('Salvataggio…', 'busy');
    // Tiene una copia della versione che sta per essere sostituita (al massimo una ogni 2 minuti).
    if (Date.now() - lastVersionAt > 120000) {
      lastVersionAt = Date.now();
      api.invoke('data:saveVersion', serverId, path, savedText).catch(() => {});
    }
    saving = (async () => {
      try {
        const r = await api.invoke('sftp:write', serverId, path, text, mtime, force);
        if (r.conflict) {
          conflict = true;
          showConflict();
          setStatus('Non salvato: conflitto', 'error');
          return false;
        }
        mtime = r.mtime;
        savedText = text;
        conflict = false;
        banner.classList.add('hidden');
        const time = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setStatus(isDirty() ? 'Modificato' : `Salvato alle ${time}`, isDirty() ? 'dirty' : 'ok');
        onDirtyChange?.(isDirty());
        if (isDirty() && autoToggle.checked) schedule();
        return true;
      } catch (e) {
        setStatus('Errore di salvataggio', 'error');
        fail(e);
        return false;
      } finally {
        saving = null;
      }
    })();
    return saving;
  }

  // Salvataggio a mano (pulsante o Ctrl+S): per i file di configurazione chiede conferma con le differenze.
  async function manualSave() {
    const text = view.state.doc.toString();
    if (config && text !== savedText) {
      const ok = await modal({
        title: `Salvare ${path.split('/').pop()}?`,
        wide: true,
        body: h('div', {}, h('p', { class: 'muted' }, 'Queste sono le modifiche rispetto alla versione sul server.'), diffView(savedText, text)),
        actions: [{ label: 'Annulla', result: false }, { label: 'Salva sul server', kind: 'primary', result: true }],
      });
      if (!ok) return false;
      lastVersionAt = 0; // un salvataggio voluto tiene sempre la versione precedente
    }
    return save();
  }

  function showDiff() {
    modal({
      title: 'Differenze con il server',
      wide: true,
      body: diffView(savedText, view.state.doc.toString()),
      actions: [{ label: 'Chiudi', kind: 'primary', result: null }],
    });
  }

  async function showVersions() {
    let list;
    try { list = await api.invoke('data:versions', serverId, path); } catch (e) { fail(e); return; }
    if (!list.length) { toast('Ancora nessuna versione salvata: Screenie ne tiene una copia a ogni salvataggio', 'info', 4500); return; }
    const preview = h('div', { class: 'version-preview' });
    let chosen = list[0];
    const items = list.map((v) => h('button', {
      class: 'version-item', type: 'button',
      onclick: (e) => {
        chosen = v;
        for (const b of e.currentTarget.parentElement.children) b.classList.toggle('active', b === e.currentTarget);
        preview.replaceChildren(diffView(v.content, view.state.doc.toString()));
      },
    }, h('strong', {}, new Date(v.t).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })), h('span', {}, `${v.content.split('\n').length} righe`)));
    items[0].classList.add('active');
    preview.append(diffView(list[0].content, view.state.doc.toString()));
    const r = await modal({
      title: 'Versioni precedenti',
      wide: true,
      body: h('div', { class: 'versions' }, h('div', { class: 'version-list' }, items), h('div', {}, h('p', { class: 'muted' }, 'Differenze tra la versione scelta e quella che hai aperta adesso.'), preview)),
      actions: [{ label: 'Chiudi', result: null }, { label: 'Ripristina questa versione', kind: 'primary', value: () => chosen }],
    });
    if (r) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: r.content } });
      toast("Versione ripristinata nell'editor: salva per scriverla sul server", 'ok', 4500);
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (autoToggle.checked && !conflict) timer = setTimeout(() => save(), settings.autosaveDelay || 800);
  }

  function showConflict() {
    banner.replaceChildren(
      h('span', {}, 'Il file è stato modificato sul server da qualcun altro dopo che l\'hai aperto.'),
      h('button', { class: 'btn small danger', onclick: () => save(true) }, 'Sovrascrivi con la mia versione'),
      h('button', { class: 'btn small', onclick: reload }, 'Ricarica dal server (perdi le modifiche)'),
    );
    banner.classList.remove('hidden');
  }

  async function reload() {
    try {
      const r = await api.invoke('sftp:read', serverId, path);
      mtime = r.mtime;
      savedText = r.content;
      conflict = false;
      banner.classList.add('hidden');
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: r.content } });
      setStatus('Ricaricato', 'ok');
      onDirtyChange?.(false);
    } catch (e) {
      fail(e);
    }
  }

  autoToggle.addEventListener('change', () => {
    api.invoke('settings:set', { autosave: autoToggle.checked });
    settings.autosave = autoToggle.checked;
    if (autoToggle.checked && isDirty()) schedule();
  });

  const lang = new Compartment();
  const themeSlot = new Compartment();
  const offTheme = onThemeChange((mode) => view.dispatch({ effects: themeSlot.reconfigure(editorTheme(mode)) }));
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        themeSlot.of(editorTheme(effectiveTheme())),
        keymap.of([indentWithTab, { key: 'Mod-s', preventDefault: true, run: () => { manualSave(); return true; } }]),
        lang.of(languageFor(path)),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const dirty = isDirty();
          onDirtyChange?.(dirty);
          if (dirty && !conflict) {
            setStatus(autoToggle.checked ? 'Modificato · salvo tra un attimo' : 'Modificato', 'dirty');
            schedule();
          }
        }),
      ],
    }),
  });

  return {
    kind: 'editor',
    serverId,
    path,
    title: path.split('/').pop(),
    el,
    show: () => requestAnimationFrame(() => view.focus()),
    focus: () => view.focus(),
    isDirty,
    save: () => manualSave(),
    dispose: () => {
      offTheme();
      clearTimeout(timer);
      view.destroy();
    },
  };
}
