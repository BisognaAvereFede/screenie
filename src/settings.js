// Pagina "Impostazioni".
import { h, icon, toggleSwitch, modal, toast, fail, confirmDialog } from './dom.js';
import { ACCENTS, ZOOMS, TERM_FONTS, TERM_THEMES } from './theme.js';
import { ACTIONS, bindings, display, recordCombo } from './keys.js';
import pkg from '../package.json';
import logoUrl from './logo-mark.svg';

const api = window.api;
const DEFAULTS = { theme: 'system', zoom: 1, accent: ACCENTS[0].value };

/**
 * `settings` è l'oggetto condiviso con il resto dell'app; `change(patch)` lo aggiorna,
 * lo salva e applica subito le modifiche. `onImported()` ricarica i server dopo un ripristino.
 */
export function createSettingsPage({ settings, change, onImported, update, checkUpdates, installUpdate }) {
  const body = h('div', { class: 'page-inner' });
  const el = h('div', { class: 'tab-pane page' }, body);

  const row = (title, desc, control) => h('div', { class: 'set-row', role: 'group', 'aria-label': title },
    h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, title), desc && h('div', { class: 'set-desc' }, desc)),
    control && h('div', { class: 'set-control' }, control));

  const card = (iconName, tone, title, ...rows) => h('section', { class: 'settings-card' },
    h('div', { class: 'settings-card-head' }, h('span', { class: `tile ${tone}` }, icon(iconName, 16)), h('h2', {}, title)),
    ...rows);

  // Gruppo di opzioni esclusive: un solo punto di Tab, le frecce cambiano scelta.
  function segmented(label, options, value, onPick) {
    const group = h('div', { class: 'seg-group', role: 'radiogroup', 'aria-label': label }, options.map((o) => h('button', {
      class: `seg-opt ${o.value === value ? 'active' : ''}`,
      type: 'button',
      role: 'radio',
      'aria-checked': String(o.value === value),
      tabindex: o.value === value ? 0 : -1,
      onclick: () => onPick(o.value),
    }, o.icon && icon(o.icon, 14), o.label)));
    group.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const i = options.findIndex((o) => o.value === value);
      const next = options[(i + step + options.length) % options.length];
      Promise.resolve(onPick(next.value)).then(() => el.querySelector(`.seg-group[aria-label="${label}"] .seg-opt.active`)?.focus());
    });
    return group;
  }

  const toggle = (label, checked, onToggle) => toggleSwitch(checked, label, onToggle).el;

  function selectBox(label, options, value, onPick) {
    const sel = h('select', { class: 'select', 'aria-label': label, onchange: (e) => onPick(e.target.value) },
      options.map((o) => h('option', { value: o.value }, o.label)));
    sel.value = value;
    return sel;
  }

  function fontPicker(fonts, value, placeholder, onPick) {
    const input = h('input', { type: 'text', value, placeholder, spellcheck: false, list: 'term-fonts', class: 'font-input', 'aria-label': 'Font del terminale' });
    input.addEventListener('change', () => onPick(input.value.trim()));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    return h('div', { class: 'font-picker' },
      input,
      h('datalist', { id: 'term-fonts' }, fonts.map((f) => h('option', { value: f }))),
      value && h('button', { class: 'icon-btn', type: 'button', title: 'Torna al predefinito', 'aria-label': 'Torna al font predefinito', onclick: () => onPick('') }, icon('x', 14)));
  }

  // ---------- Comandi salvati ----------
  async function editSnippet(snip) {
    const name = h('input', { type: 'text', value: snip?.name || '', placeholder: 'es. Log di nginx' });
    const command = h('textarea', { class: 'textarea', rows: 4, spellcheck: false, placeholder: 'es. tail -f /var/log/nginx/error.log' });
    command.value = snip?.command || '';
    const saved = await modal({
      title: snip ? 'Modifica comando' : 'Nuovo comando salvato',
      body: h('div', {},
        h('label', { class: 'field' }, h('span', {}, 'Nome'), name),
        h('label', { class: 'field' }, h('span', {}, 'Comando'), command),
        h('p', { class: 'hint' }, icon('terminal', 14), 'Viene scritto nel terminale attivo e inviato con Invio. Lo trovi nel pulsante "Comandi salvati" del terminale e nella palette comandi.')),
      actions: [
        { label: 'Annulla', result: null },
        { label: 'Salva', kind: 'primary', value: () => (name.value.trim() && command.value.trim() ? { id: snip?.id, name: name.value.trim(), command: command.value.trim() } : undefined) },
      ],
    });
    if (!saved) return;
    const list = [...(settings.snippets || [])];
    const i = list.findIndex((x) => x.id === saved.id);
    if (i >= 0) list[i] = saved; else list.push(saved);
    await change({ snippets: list });
  }

  async function removeSnippet(snip) {
    if (!(await confirmDialog(`Eliminare "${snip.name}"?`, 'Il comando salvato viene rimosso.', { ok: 'Elimina' }))) return;
    await change({ snippets: settings.snippets.filter((x) => x.id !== snip.id) });
  }

  // ---------- Backup ----------
  async function exportBackup() {
    try {
      const p = await api.invoke('config:export');
      if (p) toast(`Configurazione esportata in ${p}`, 'ok', 5000);
    } catch (e) { fail(e); }
  }
  async function importBackup() {
    try {
      const r = await api.invoke('config:import');
      if (!r) return;
      toast(`Ripristinati ${r.total} server (${r.added} nuovi)`, 'ok', 4000);
      onImported?.();
    } catch (e) { fail(e); }
  }

  function updateRow() {
    const u = update?.() || { status: 'idle' };
    const text = {
      unsupported: 'Gli aggiornamenti automatici funzionano nella versione installata su Windows.',
      checking: 'Controllo in corso…',
      downloading: `Scarico la versione ${u.version || ''}… ${u.percent ? `${u.percent}%` : ''}`,
      ready: `La versione ${u.version} è pronta: riavvia per installarla.`,
      none: 'Hai l’ultima versione.',
      error: `Controllo non riuscito: ${u.error || 'errore sconosciuto'}`,
      idle: 'Screenie controlla da solo all’avvio e ogni 4 ore.',
    }[u.status] || '';
    return row('Aggiornamenti', text, u.status === 'ready'
      ? h('button', { class: 'btn small primary', onclick: () => installUpdate?.() }, 'Riavvia e aggiorna')
      : u.status !== 'unsupported' && h('button', { class: 'btn small', disabled: u.status === 'checking' || u.status === 'downloading', onclick: () => checkUpdates?.() }, 'Controlla ora'));
  }

  function render() {
    const s = settings;
    const customAccent = !ACCENTS.some((a) => a.value.toLowerCase() === (s.accent || '').toLowerCase());
    const colorInput = h('input', { type: 'color', value: s.accent || ACCENTS[0].value, title: 'Scegli un colore qualsiasi', 'aria-label': 'Colore personalizzato' });
    colorInput.addEventListener('change', () => change({ accent: colorInput.value }));
    const keys = bindings(s.keys);

    body.replaceChildren(
      h('p', { class: 'muted page-note' }, 'Le modifiche si applicano subito e vengono salvate in automatico.'),

      card('eye', 'accent', 'Aspetto',
        row('Tema', 'Come il sistema operativo, oppure sempre chiaro o scuro.',
          segmented('Tema', [
            { value: 'system', label: 'Sistema' },
            { value: 'light', label: 'Chiaro' },
            { value: 'dark', label: 'Scuro' },
          ], s.theme, (theme) => change({ theme }))),
        row('Dimensione interfaccia', 'Ingrandisce o rimpicciolisce tutta l\'app.',
          h('div', { class: 'zoom-group', role: 'group', 'aria-label': 'Dimensione interfaccia' }, ZOOMS.map((z) => h('button', {
            class: `zoom-opt ${Math.abs((s.zoom || 1) - z) < 0.001 ? 'active' : ''}`,
            type: 'button',
            'aria-pressed': String(Math.abs((s.zoom || 1) - z) < 0.001),
            onclick: () => change({ zoom: z }),
          }, `${Math.round(z * 100)}%`)))),
        row('Colore principale', 'Pulsanti, selezioni, scheda attiva e cursore.',
          h('div', { class: 'swatches', role: 'group', 'aria-label': 'Colore principale' },
            ACCENTS.map((a) => h('button', {
              class: `swatch ${a.value.toLowerCase() === (s.accent || '').toLowerCase() ? 'active' : ''}`,
              type: 'button',
              title: a.name,
              'aria-label': a.name,
              'aria-pressed': String(a.value.toLowerCase() === (s.accent || '').toLowerCase()),
              style: { '--sw': a.value },
              onclick: () => change({ accent: a.value }),
            })),
            h('label', { class: `swatch custom ${customAccent ? 'active' : ''}`, title: 'Colore personalizzato', style: customAccent ? { '--sw': s.accent } : {} },
              colorInput, icon('plus', 14)))),
        h('div', { class: 'card-foot' },
          h('button', { class: 'btn small', onclick: () => change({ ...DEFAULTS }) }, 'Ripristina aspetto predefinito'))),

      card('terminal', 'purple', 'Terminale',
        row('Tema del terminale', 'Colori della console. "Come l\'app" segue il tema chiaro o scuro.',
          selectBox('Tema del terminale', TERM_THEMES, s.termTheme || 'auto', (termTheme) => change({ termTheme }))),
        row('Font', 'Anche per l\'editor. Meglio un font a larghezza fissa.',
          fontPicker(TERM_FONTS, s.termFont, 'Predefinito (Cascadia Mono)', (termFont) => change({ termFont }))),
        row('Dimensione testo', 'Anche con Ctrl + e Ctrl −.',
          h('div', { class: 'stepper' },
            h('button', { class: 'icon-btn', type: 'button', onclick: () => change({ fontSize: Math.max(9, s.fontSize - 1) }), title: 'Più piccolo', 'aria-label': 'Testo del terminale più piccolo' }, '−'),
            h('span', { class: 'stepper-value', 'aria-live': 'polite' }, `${s.fontSize} px`),
            h('button', { class: 'icon-btn', type: 'button', onclick: () => change({ fontSize: Math.min(28, s.fontSize + 1) }), title: 'Più grande', 'aria-label': 'Testo del terminale più grande' }, '+'))),
        row('Console compatta', 'Meno margine e angoli più stretti: più righe e colonne visibili.',
          toggle('Console compatta', s.compactTerm, (compactTerm) => change({ compactTerm })))),

      card('edit', 'blue', 'Editor',
        row('Salvataggio automatico', 'Salva sul server mentre scrivi.',
          toggle('Salvataggio automatico', s.autosave, (autosave) => change({ autosave }))),
        row('Attesa prima di salvare', 'Quanto aspettare dopo l\'ultima modifica.',
          segmented('Attesa prima di salvare', [
            { value: 500, label: '0,5 s' },
            { value: 800, label: '0,8 s' },
            { value: 1500, label: '1,5 s' },
            { value: 3000, label: '3 s' },
          ], s.autosaveDelay, (autosaveDelay) => change({ autosaveDelay })))),

      card('folder', 'green', 'File e pannelli',
        row('Mostra file nascosti', 'I file che iniziano con un punto, come .env o .bashrc.',
          toggle('Mostra file nascosti', s.showHidden, (showHidden) => change({ showHidden }))),
        row('Pannello server automatico', 'Si chiude da solo quando il server selezionato non è connesso.',
          toggle('Pannello server automatico', s.autoInspector, (autoInspector) => change({ autoInspector }))),
        row('Riapri le schede all\'avvio', 'Riconnette i server e riapre terminali, screen e file dove li avevi lasciati.',
          toggle('Riapri le schede all\'avvio', s.restoreSession, (restoreSession) => change({ restoreSession })))),

      card('bell', 'orange', 'Avvio e notifiche',
        row('Finestra di avvio', 'Il logo animato prima che si apra l\'app.',
          toggle('Finestra di avvio', s.splash, (splash) => change({ splash }))),
        row('Suono di avvio', 'Il breve suono della finestra di avvio.',
          toggle('Suono di avvio', s.splashSound, (splashSound) => change({ splashSound }))),
        row('Notifiche', 'Quando uno screen termina o un comando lungo finisce in una scheda che non stai guardando.',
          toggle('Notifiche', s.notifications, (notifications) => change({ notifications })))),

      card('snippet', 'accent', 'Comandi salvati',
        (s.snippets || []).length
          ? s.snippets.map((snip) => h('div', { class: 'set-row snippet-row' },
            h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, snip.name), h('code', { class: 'snippet-cmd' }, snip.command)),
            h('div', { class: 'set-control' },
              h('button', { class: 'icon-btn', type: 'button', title: 'Modifica', 'aria-label': `Modifica ${snip.name}`, onclick: () => editSnippet(snip) }, icon('edit', 15)),
              h('button', { class: 'icon-btn danger-ghost', type: 'button', title: 'Elimina', 'aria-label': `Elimina ${snip.name}`, onclick: () => removeSnippet(snip) }, icon('trash', 15)))))
          : row('Nessun comando salvato', 'Salva i comandi che usi spesso per lanciarli con un clic nel terminale.', null),
        h('div', { class: 'card-foot' }, h('button', { class: 'btn small', onclick: () => editSnippet(null) }, icon('plus', 14), 'Aggiungi comando'))),

      card('keyboard', 'blue', 'Scorciatoie',
        ACTIONS.map((a) => h('div', { class: 'set-row key-row' },
          h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, a.label)),
          h('div', { class: 'set-control' },
            h('kbd', { class: s.keys?.[a.id] ? 'custom' : '' }, display(keys[a.id])),
            h('button', {
              class: 'btn small',
              type: 'button',
              onclick: async () => {
                const combo = await recordCombo(a.label);
                if (combo === null) return;
                const clash = combo && ACTIONS.find((o) => o.id !== a.id && keys[o.id] === combo);
                if (clash) { toast(`${combo} è già usata per "${clash.label}"`, 'warn'); return; }
                const next = { ...(s.keys || {}) };
                if (combo) next[a.id] = combo; else delete next[a.id];
                change({ keys: next });
              },
            }, 'Cambia')))),
        h('div', { class: 'card-foot' }, h('button', { class: 'btn small', onclick: () => change({ keys: {} }) }, 'Ripristina tutte'))),

      card('download', 'green', 'Backup',
        row('Esporta configurazione', 'Server, preferiti, impostazioni e host key in un file JSON. Le passphrase non vengono incluse.',
          h('button', { class: 'btn small', onclick: exportBackup }, icon('download', 14), 'Esporta…')),
        row('Importa configurazione', 'Aggiunge o aggiorna i server dal file e ripristina le impostazioni.',
          h('button', { class: 'btn small', onclick: importBackup }, icon('upload', 14), 'Importa…'))),

      card('shield', 'purple', 'Informazioni',
        h('div', { class: 'about' },
          h('img', { class: 'about-logo', src: logoUrl, alt: '' }),
          h('div', {}, h('div', { class: 'about-name' }, 'Screenie'), h('div', { class: 'set-desc' }, `Versione ${pkg.version}`))),
        updateRow(),
        row('Sicurezza', 'Le chiavi restano sul tuo PC; le passphrase salvate sono cifrate dal sistema operativo.', null)),
    );
  }

  render();
  return {
    kind: 'settings',
    serverId: null,
    title: 'Impostazioni',
    el,
    show: render,
    focus() {},
    dispose() {},
    refresh: render,
  };
}
