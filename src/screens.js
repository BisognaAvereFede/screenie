// Pannello "Screen": elenca, crea, apre, rinomina e termina le sessioni screen.
import { h, icon, iconButton, fail, toast, confirmDialog, inputDialog, contextMenu } from './dom.js';

const api = window.api;

// "11/06/26 21:47:58" (formato di screen: mese/giorno/anno, o giorno/mese se il primo supera 12) → Date
function parseCreated(text) {
  const m = String(text || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  let [a, b] = [Number(m[1]), Number(m[2])];
  let [month, day] = a > 12 ? [b, a] : [a, b];
  if (month > 12) [month, day] = [day, month];
  const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(year, month - 1, day, Number(m[4]), Number(m[5]), Number(m[6] || 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function relativeTime(d) {
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'adesso';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min fa`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? 'ora' : 'ore'} fa`;
  const days = Math.round(hr / 24);
  if (days < 31) return days === 1 ? 'ieri' : `${days} giorni fa`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} ${months === 1 ? 'mese' : 'mesi'} fa`;
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function createScreensPanel({ getServerId, openScreen, openCommand, onGone }) {
  const known = new Map(); // serverId -> nomi degli screen visti l'ultima volta
  const killed = new Set(); // screen terminati da qui: niente avviso
  const list = h('div', { class: 'screen-list' });
  const nameInput = h('input', { type: 'text', placeholder: 'nome, es. backup', spellcheck: false, maxlength: 48, 'aria-label': 'Nome del nuovo screen' });
  const cmdInput = h('input', { type: 'text', placeholder: 'comando da avviare (facoltativo)', spellcheck: false, 'aria-label': 'Comando da avviare nel nuovo screen (facoltativo)' });
  const form = h('form', {
    class: 'screen-form',
    onsubmit: (e) => { e.preventDefault(); create(); },
  },
  h('div', { class: 'row' }, nameInput, h('button', { class: 'btn primary', type: 'submit', title: 'Crea lo screen e aprilo' }, icon('plus', 14), 'Crea')),
  cmdInput);
  const el = h('div', { class: 'panel-body screens' }, form, list);

  let timer = null;
  let busy = false;
  let lastKey = '';

  async function create() {
    const serverId = getServerId();
    const name = nameInput.value.trim();
    if (!serverId) return;
    if (!name) {
      nameInput.focus();
      return;
    }
    try {
      await api.invoke('screen:create', serverId, name, cmdInput.value.trim());
      nameInput.value = '';
      cmdInput.value = '';
      await refresh(true);
      const s = current.find((x) => x.name === name);
      if (s) openScreen(s);
    } catch (e) {
      fail(e);
    }
  }

  async function kill(s) {
    const ok = await confirmDialog(
      `Terminare lo screen "${s.name}"?`,
      'Lo screen e i programmi che ci girano dentro verranno chiusi. Non si può annullare.',
      { ok: 'Termina' },
    );
    if (!ok) return;
    try {
      killed.add(s.name);
      await api.invoke('screen:kill', getServerId(), s.id);
      toast(`Screen "${s.name}" terminato`, 'ok');
      refresh(true);
    } catch (e) {
      fail(e);
    }
  }

  async function rename(s) {
    const name = await inputDialog('Rinomina screen', 'Nuovo nome', s.name, { ok: 'Rinomina' });
    if (!name || name === s.name) return;
    try {
      await api.invoke('screen:rename', getServerId(), s.id, name);
      refresh(true);
    } catch (e) {
      fail(e);
    }
  }

  let current = [];

  function render(data) {
    current = data.sessions;
    if (!data.installed) {
      list.replaceChildren(h('div', { class: 'empty' },
        h('p', {}, 'screen non è installato su questo server.'),
        h('button', { class: 'btn primary', onclick: () => openCommand('sudo apt-get install -y screen') }, 'Installa screen'),
      ));
      form.classList.add('hidden');
      return;
    }
    form.classList.remove('hidden');
    if (!data.sessions.length) {
      list.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'Nessuno screen attivo.'), h('p', { class: 'muted' }, 'Scrivi un nome qui sopra e premi Invio.')));
      return;
    }
    list.replaceChildren(...data.sessions.map((s) => {
      const row = h('div', {
        class: `screen-row ${s.attached ? 'attached' : ''}`,
        title: `${s.id} · PID ${s.pid}`,
        ondblclick: () => openScreen(s),
        oncontextmenu: (e) => {
          e.preventDefault();
          contextMenu(e.clientX, e.clientY, [
            { label: 'Apri', icon: 'terminal', action: () => openScreen(s) },
            { label: 'Rinomina', icon: 'edit', action: () => rename(s) },
            '-',
            { label: 'Termina', icon: 'trash', danger: true, action: () => kill(s) },
          ]);
        },
      },
      h('span', { class: `tile ${s.dead ? 'red' : s.attached ? 'green' : 'purple'}` }, icon('layers', 16)),
      h('div', { class: 'screen-main' },
        h('div', { class: 'screen-name' }, s.name),
        h('div', { class: 'screen-meta' },
          h('span', { class: `chip ${s.dead ? 'bad' : s.attached ? 'live' : ''}` }, s.dead ? 'morto' : s.attached ? 'agganciato' : 'staccato'),
          s.created && (() => {
            const d = parseCreated(s.created);
            return h('span', { class: 'muted', title: d ? d.toLocaleString('it-IT') : s.created }, d ? relativeTime(d) : s.created);
          })())),
      h('div', { class: 'screen-actions' },
        h('button', { class: 'btn small primary', 'aria-label': `Apri lo screen ${s.name}`, onclick: () => openScreen(s), title: s.attached ? 'Lo stacca dall\'altra finestra e lo apre qui' : 'Apri in una nuova scheda' }, 'Apri'),
        iconButton('edit', `Rinomina ${s.name}`, () => rename(s)),
        iconButton('power', `Termina lo screen ${s.name}`, () => kill(s), 'danger-ghost')));
      return row;
    }));
    if (data.sessions.some((s) => s.dead)) {
      list.append(h('button', { class: 'btn small', onclick: async () => { await api.invoke('screen:wipe', getServerId()); refresh(true); } }, 'Pulisci sessioni morte'));
    }
  }

  async function refresh(force = false) {
    const serverId = getServerId();
    if (!serverId) {
      list.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'Connettiti a un server per vedere i suoi screen.')));
      form.classList.add('hidden');
      lastKey = '';
      return;
    }
    if (busy && !force) return;
    busy = true;
    try {
      const data = await api.invoke('screen:list', serverId);
      // Avviso quando uno screen sparisce senza che l'abbia chiuso tu da qui.
      const names = new Set(data.sessions.filter((x) => !x.dead).map((x) => x.name));
      const before = known.get(serverId);
      if (before) for (const n of before) if (!names.has(n) && !killed.delete(n)) onGone?.(n, serverId);
      known.set(serverId, names);
      const key = serverId + JSON.stringify(data);
      if (key !== lastKey || force) {
        lastKey = key;
        render(data);
      }
    } catch (e) {
      if (force) fail(e);
    } finally {
      busy = false;
    }
  }

  return {
    el,
    refresh,
    start() {
      clearInterval(timer);
      refresh(true);
      timer = setInterval(() => { if (el.offsetParent) refresh(); }, 4000);
    },
    focusNew: () => nameInput.focus(),
  };
}
