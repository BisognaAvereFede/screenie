// Pannello "File": browser SFTP con trascinamento, menu contestuale e cache delle cartelle.
import {
  h, icon, iconButton, setPressed, fail, toast, confirmDialog, inputDialog, contextMenu, menuAnchor, isMenuKey,
  formatSize, formatDate, formatMode, enter,
} from './dom.js';

let animatedDir = ''; // ultima cartella mostrata con l'animazione d'ingresso

const api = window.api;
const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parent = (p) => (p === '/' ? '/' : p.replace(/\/[^/]+\/?$/, '') || '/');

export function createFilesPanel({ getServerId, settings, openEditor, openCommand }) {
  const state = new Map(); // serverId -> { cwd, home }
  const cache = new Map(); // `${serverId}:${dir}` -> items
  let items = [];
  let selected = new Set();
  let anchor = null;
  let loadSeq = 0;
  let rowSeq = 0;

  const pathInput = h('input', { class: 'path-input', type: 'text', spellcheck: false, 'aria-label': 'Percorso della cartella (Invio per aprire)' });
  const filterInput = h('input', { class: 'filter-input', type: 'search', placeholder: 'Filtra…', spellcheck: false, 'aria-label': 'Filtra i file della cartella' });
  const hiddenBtn = iconButton('eye', 'Mostra/nascondi file nascosti', () => {
    settings.showHidden = !settings.showHidden;
    api.invoke('settings:set', { showHidden: settings.showHidden });
    setPressed(hiddenBtn, settings.showHidden);
    render();
  });
  setPressed(hiddenBtn, settings.showHidden);
  // Le azioni meno frequenti stanno in un menu, per tenere la barra pulita.
  const moreBtn = iconButton('more', 'Altre azioni', () => {
    const r = moreBtn.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      { label: 'Vai alla home', icon: 'home', action: () => go(st()?.home || '/') },
      '-',
      { label: 'Nuova cartella…', icon: 'folderPlus', action: newFolder },
      { label: 'Nuovo file…', icon: 'filePlus', action: newFile },
      { label: 'Carica file…', icon: 'upload', action: () => pickUpload(false) },
      { label: 'Carica cartella…', icon: 'upload', action: () => pickUpload(true) },
      '-',
      { label: settings.showHidden ? 'Nascondi file nascosti' : 'Mostra file nascosti', icon: 'eye', action: () => hiddenBtn.click() },
    ]);
  });

  // ---------- Preferiti ----------
  const favorites = new Map(); // serverId -> [{ path, name }]
  const favBar = h('div', { class: 'fav-bar', role: 'group', 'aria-label': 'Cartelle preferite' });
  const starBtn = iconButton('star', 'Aggiungi questa cartella ai preferiti', () => toggleFavorite(cwd()), 'star-btn');

  const favs = () => favorites.get(getServerId()) || [];
  const isFav = (p) => favs().some((f) => f.path === p);

  async function saveFavs(list) {
    const serverId = getServerId();
    try {
      favorites.set(serverId, await api.invoke('servers:setFavorites', serverId, list));
    } catch (e) {
      fail(e);
    }
    renderFavs();
  }

  function toggleFavorite(path) {
    if (!getServerId()) return;
    if (isFav(path)) saveFavs(favs().filter((f) => f.path !== path));
    else {
      saveFavs([...favs(), { path, name: path.split('/').pop() || '/' }]);
      toast(`"${path}" aggiunta ai preferiti`, 'ok', 2000);
    }
  }

  async function renameFavorite(f) {
    const name = await inputDialog('Rinomina preferito', 'Nome', f.name, { ok: 'Rinomina' });
    if (name) saveFavs(favs().map((x) => (x.path === f.path ? { ...x, name } : x)));
  }

  function renderFavs() {
    const here = cwd();
    setPressed(starBtn, isFav(here));
    starBtn.title = isFav(here) ? 'Rimuovi questa cartella dai preferiti' : 'Aggiungi questa cartella ai preferiti';
    starBtn.setAttribute('aria-label', 'Cartella nei preferiti');
    favBar.classList.toggle('hidden', !getServerId() || !favs().length);
    favBar.replaceChildren(...favs().map((f) => {
      const chip = h('button', {
        class: `fav ${f.path === here ? 'active' : ''}`,
        type: 'button',
        'aria-current': f.path === here ? 'location' : null,
        title: `${f.path}\nTrascina qui dei file per caricarli in questa cartella`,
        onclick: () => go(f.path),
        onkeydown: (e) => { if (isMenuKey(e)) { e.preventDefault(); chip.dispatchEvent(new MouseEvent('contextmenu', menuAnchor(chip))); } },
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Apri', icon: 'folder', action: () => go(f.path) },
            { label: 'Apri terminale qui', icon: 'terminal', action: () => openCommand(null, f.path) },
            { label: 'Rinomina', icon: 'edit', action: () => renameFavorite(f) },
            '-',
            { label: 'Rimuovi dai preferiti', icon: 'x', danger: true, action: () => toggleFavorite(f.path) },
          ]);
        },
      }, icon('star', 12), h('span', {}, f.name));
      chip.addEventListener('dragover', (e) => { e.preventDefault(); chip.classList.add('drop'); });
      chip.addEventListener('dragleave', () => chip.classList.remove('drop'));
      chip.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chip.classList.remove('drop');
        el.classList.remove('dragging');
        dragDepth = 0;
        uploadFiles(e.dataTransfer.files, f.path);
      });
      return chip;
    }));
  }

  // Elenco navigabile da tastiera: frecce per spostarsi, Maiusc/Ctrl per selezionare più file.
  const list = h('div', { class: 'file-list', tabindex: 0, role: 'listbox', 'aria-label': 'File della cartella', 'aria-multiselectable': 'true' });
  let focusName = null;
  const dropHint = h('div', { class: 'drop-hint' }, icon('upload', 28), h('span', {}, 'Rilascia per caricare qui'));
  const el = h('div', { class: 'panel-body files' },
    h('div', { class: 'panel-toolbar' },
      iconButton('up', 'Cartella superiore', () => go(parent(cwd()))),
      iconButton('refresh', 'Aggiorna', () => load(cwd(), true)),
      starBtn,
      h('span', { class: 'spacer' }),
      moreBtn,
    ),
    h('form', { class: 'path-bar', onsubmit: (e) => { e.preventDefault(); go(pathInput.value.trim() || '/'); } }, pathInput),
    favBar,
    h('div', { class: 'filter-bar' }, icon('search', 14), filterInput),
    h('div', { class: 'file-list-wrap' }, list, dropHint),
  );

  const st = () => state.get(getServerId());
  const cwd = () => st()?.cwd || '/';

  filterInput.addEventListener('input', () => render());

  // ---------- Caricamento ----------

  async function load(dir, fresh = false) {
    const serverId = getServerId();
    if (!serverId) return;
    const key = `${serverId}:${dir}`;
    const seq = ++loadSeq;
    // Mostra subito la versione in cache, poi aggiorna in background.
    if (cache.has(key)) {
      st().cwd = dir;
      items = cache.get(key);
      render();
    } else if (!fresh) {
      list.classList.add('loading');
    }
    try {
      const listing = await api.invoke('sftp:list', serverId, dir);
      if (seq !== loadSeq || serverId !== getServerId()) return;
      cache.set(key, listing);
      st().cwd = dir;
      items = listing;
      render();
    } catch (e) {
      if (seq === loadSeq) fail(e);
    } finally {
      if (seq === loadSeq) list.classList.remove('loading');
    }
  }

  function go(dir) {
    selected.clear();
    focusName = null;
    filterInput.value = '';
    load(dir);
  }

  function visible() {
    const f = filterInput.value.trim().toLowerCase();
    return items.filter((it) => (settings.showHidden || !it.name.startsWith('.')) && (!f || it.name.toLowerCase().includes(f)));
  }

  function render() {
    pathInput.value = cwd();
    renderFavs();
    const rows = visible();
    if (!getServerId()) {
      list.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'Connettiti a un server per sfogliare i file.')));
      return;
    }
    if (!rows.length) {
      list.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'muted' }, filterInput.value ? 'Nessun file corrisponde al filtro.' : 'Cartella vuota. Trascina qui dei file per caricarli.')));
      return;
    }
    list.removeAttribute('aria-activedescendant');
    const dirKey = `${getServerId()}:${cwd()}`;
    if (dirKey !== animatedDir) { animatedDir = dirKey; enter(list, 900); }
    list.replaceChildren(...rows.map((it) => {
      const full = join(cwd(), it.name);
      const row = h('div', {
        class: `file-row ${selected.has(it.name) ? 'selected' : ''} ${it.isDir ? 'dir' : ''}`,
        role: 'option',
        id: `file-${rowSeq++}`,
        'aria-selected': String(selected.has(it.name)),
        'aria-label': `${it.name}, ${it.isDir ? 'cartella' : it.isLink ? 'collegamento' : `file, ${formatSize(it.size)}`}`,
        draggable: false,
        title: `${it.name}\n${formatMode(it.mode)} · ${formatSize(it.size)} · modificato ${formatDate(it.mtime)}`,
        onclick: (e) => select(it, e),
        ondblclick: () => (it.isDir ? go(full) : openFile(full)),
        oncontextmenu: (e) => {
          e.preventDefault();
          if (!selected.has(it.name)) {
            selected = new Set([it.name]);
            renderSelection();
          }
          menu(e, it);
        },
      },
      icon(it.isDir ? 'folder' : it.isLink ? 'link' : 'file', 15),
      h('span', { class: 'file-name' }, it.name),
      h('span', { class: 'file-size' }, it.isDir ? '' : formatSize(it.size)),
      h('span', { class: 'file-date' }, formatDate(it.mtime)));
      row.dataset.name = it.name;
      // Rilascio su una cartella: carica dentro quella cartella.
      if (it.isDir) {
        row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop'); });
        row.addEventListener('dragleave', () => row.classList.remove('drop'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          row.classList.remove('drop');
          el.classList.remove('dragging');
          uploadFiles(e.dataTransfer.files, full);
        });
      }
      return row;
    }));
    if (focusName) renderSelection();
  }

  function renderSelection() {
    for (const row of list.children) {
      if (!row.dataset.name) continue;
      const on = selected.has(row.dataset.name);
      row.classList.toggle('selected', on);
      row.setAttribute('aria-selected', String(on));
      row.classList.toggle('focused', row.dataset.name === focusName);
      if (row.dataset.name === focusName) {
        list.setAttribute('aria-activedescendant', row.id);
        row.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function select(it, e) {
    const names = visible().map((x) => x.name);
    if (e.shiftKey && anchor) {
      const [a, b] = [names.indexOf(anchor), names.indexOf(it.name)].sort((x, y) => x - y);
      selected = new Set(names.slice(a, b + 1));
    } else if (e.ctrlKey || e.metaKey) {
      selected.has(it.name) ? selected.delete(it.name) : selected.add(it.name);
      anchor = it.name;
    } else {
      selected = new Set([it.name]);
      anchor = it.name;
    }
    focusName = it.name;
    renderSelection();
  }

  const selectedPaths = () => [...selected].map((n) => join(cwd(), n));

  // ---------- Azioni ----------

  async function openFile(full) {
    try {
      await openEditor(full);
    } catch (e) {
      fail(e);
    }
  }

  async function editExternal(full) {
    try {
      await api.invoke('sftp:editExternal', getServerId(), full);
      toast('Aperto nell\'editor esterno: ogni salvataggio viene caricato in automatico', 'ok', 5000);
    } catch (e) {
      fail(e);
    }
  }

  async function download(paths) {
    const dir = await api.invoke('dialog:pickDownloadDir');
    if (!dir) return;
    try {
      await api.invoke('sftp:download', getServerId(), paths, dir);
      toast('Download completato', 'ok', 4000);
    } catch (e) {
      fail(e);
    }
  }

  async function renameItem(it) {
    const name = await inputDialog('Rinomina', 'Nuovo nome', it.name, { ok: 'Rinomina' });
    if (!name || name === it.name) return;
    if (name.includes('/')) return toast('Il nome non può contenere "/"', 'warn');
    try {
      await api.invoke('sftp:rename', getServerId(), join(cwd(), it.name), join(cwd(), name));
      load(cwd(), true);
    } catch (e) {
      fail(e);
    }
  }

  async function removeItems(paths) {
    const names = paths.map((p) => p.split('/').pop());
    const ok = await confirmDialog(
      paths.length === 1 ? `Eliminare "${names[0]}"?` : `Eliminare ${paths.length} elementi?`,
      `Le cartelle vengono eliminate con tutto il contenuto. Non c'è un cestino: l'operazione è definitiva.${paths.length > 1 ? `\n\n${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}` : ''}`,
      { ok: 'Elimina' },
    );
    if (!ok) return;
    try {
      for (const p of paths) await api.invoke('sftp:remove', getServerId(), p);
      selected.clear();
      load(cwd(), true);
    } catch (e) {
      fail(e);
      load(cwd(), true);
    }
  }

  async function newFolder() {
    if (!getServerId()) return;
    const name = await inputDialog('Nuova cartella', 'Nome', '', { ok: 'Crea' });
    if (!name) return;
    try {
      await api.invoke('sftp:mkdir', getServerId(), join(cwd(), name));
      load(cwd(), true);
    } catch (e) {
      fail(e);
    }
  }

  async function newFile() {
    if (!getServerId()) return;
    const name = await inputDialog('Nuovo file', 'Nome', '', { ok: 'Crea e apri' });
    if (!name) return;
    const full = join(cwd(), name);
    try {
      await api.invoke('sftp:createFile', getServerId(), full);
      await load(cwd(), true);
      openFile(full);
    } catch (e) {
      fail(e);
    }
  }

  async function uploadPaths(paths, dir) {
    if (!paths.length || !getServerId()) return;
    try {
      await api.invoke('sftp:upload', getServerId(), paths, dir);
      if (dir === cwd()) load(cwd(), true);
      toast('Caricamento completato', 'ok', 3000);
    } catch (e) {
      fail(e);
    }
  }

  function uploadFiles(fileList, dir) {
    const paths = [...fileList].map((f) => api.pathForFile(f)).filter(Boolean);
    uploadPaths(paths, dir);
  }

  async function pickUpload(dirs) {
    if (!getServerId()) return;
    uploadPaths(await api.invoke('dialog:pickUpload', dirs), cwd());
  }

  function menu(e, it) {
    const paths = selectedPaths();
    const one = paths.length === 1;
    const full = join(cwd(), it.name);
    contextMenu(e.clientX, e.clientY, [
      one && !it.isDir && { label: 'Apri nell\'editor', icon: 'edit', action: () => openFile(full) },
      one && !it.isDir && { label: 'Apri con editor esterno', icon: 'external', action: () => editExternal(full) },
      one && it.isDir && { label: 'Apri cartella', icon: 'folder', action: () => go(full) },
      one && it.isDir && { label: 'Apri terminale qui', icon: 'terminal', action: () => openCommand(null, full) },
      one && it.isDir && { label: isFav(full) ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti', icon: 'star', action: () => toggleFavorite(full) },
      { label: one ? 'Scarica…' : `Scarica ${paths.length} elementi…`, icon: 'download', action: () => download(paths) },
      '-',
      { label: 'Copia percorso', icon: 'link', action: () => navigator.clipboard.writeText(paths.join('\n')) },
      one && { label: 'Rinomina', icon: 'edit', hint: 'F2', action: () => renameItem(it) },
      { label: one ? 'Elimina' : `Elimina ${paths.length} elementi`, icon: 'trash', danger: true, hint: 'Canc', action: () => removeItems(paths) },
    ]);
  }

  list.addEventListener('contextmenu', (e) => {
    if (e.target !== list) return;
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Nuova cartella', icon: 'folderPlus', action: newFolder },
      { label: 'Nuovo file', icon: 'filePlus', action: newFile },
      { label: 'Carica file…', icon: 'upload', action: () => pickUpload(false) },
      { label: 'Carica cartella…', icon: 'upload', action: () => pickUpload(true) },
      '-',
      { label: 'Apri terminale qui', icon: 'terminal', action: () => openCommand(null, cwd()) },
      { label: isFav(cwd()) ? 'Rimuovi cartella dai preferiti' : 'Aggiungi cartella ai preferiti', icon: 'star', action: () => toggleFavorite(cwd()) },
      { label: 'Aggiorna', icon: 'refresh', action: () => load(cwd(), true) },
    ]);
  });

  list.addEventListener('keydown', (e) => {
    const paths = selectedPaths();
    const names = visible().map((x) => x.name);
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[e.key];
    if ((step || e.key === 'Home' || e.key === 'End') && names.length) {
      e.preventDefault();
      const i = names.indexOf(focusName);
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? names.length - 1
        : Math.max(0, Math.min(names.length - 1, i < 0 ? 0 : i + step));
      const it = items.find((x) => x.name === names[j]);
      if (e.ctrlKey || e.metaKey) { focusName = it.name; renderSelection(); } // sposta solo il cursore
      else select(it, { shiftKey: e.shiftKey });
      return;
    }
    if (e.key === ' ' && (e.ctrlKey || e.metaKey) && focusName) {
      e.preventDefault();
      select(items.find((x) => x.name === focusName), { ctrlKey: true });
      return;
    }
    if (isMenuKey(e)) {
      e.preventDefault();
      const row = [...list.children].find((r) => r.dataset.name === focusName && selected.has(focusName));
      if (row) menu(menuAnchor(row), items.find((x) => x.name === focusName));
      else list.dispatchEvent(new MouseEvent('contextmenu', menuAnchor(list)));
      return;
    }
    if (e.key === 'Delete' && paths.length) removeItems(paths);
    else if (e.key === 'F2' && paths.length === 1) renameItem(items.find((x) => x.name === [...selected][0]));
    else if (e.key === 'Backspace') go(parent(cwd()));
    else if (e.key === 'Enter' && paths.length === 1) {
      const it = items.find((x) => x.name === [...selected][0]);
      it?.isDir ? go(paths[0]) : openFile(paths[0]);
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      selected = new Set(visible().map((x) => x.name));
      renderSelection();
    } else if (e.key === 'F5') load(cwd(), true);
  });

  // Trascina dal desktop/Esplora risorse per caricare.
  let dragDepth = 0;
  el.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files') || !getServerId()) return;
    dragDepth++;
    el.classList.add('dragging');
  });
  el.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      el.classList.remove('dragging');
    }
  });
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    el.classList.remove('dragging');
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files, cwd());
  });

  return {
    el,
    // Chiamato quando cambia il server attivo o dopo la connessione.
    show(serverId, home) {
      if (serverId && home && !state.has(serverId)) state.set(serverId, { cwd: home, home });
      if (serverId && !favorites.has(serverId)) {
        api.invoke('servers:getFavorites', serverId).then((list) => {
          favorites.set(serverId, list);
          if (getServerId() === serverId) renderFavs();
        }).catch(() => {});
      }
      if (!serverId || !state.has(serverId)) {
        items = [];
        render();
        return;
      }
      load(cwd());
    },
    forget(serverId) {
      state.delete(serverId);
      for (const k of cache.keys()) if (k.startsWith(`${serverId}:`)) cache.delete(k);
    },
    refresh: () => { if (getServerId()) load(cwd(), true); else render(); },
    go: (dir) => { if (getServerId() && st()) go(dir); },
    cwd,
  };
}
