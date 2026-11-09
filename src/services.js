// Mappa dei servizi: cosa gira sul server, su che porte ascolta e quante connessioni ha.
import { h, icon, fail } from './dom.js';
import { serverBadge } from './identity.js';

const api = window.api;

/** hooks: serverOf(id), openTerminal(serverId, command), isOn(id) */
export function createServicesTab(serverId, hooks) {
  const body = h('div', { class: 'svc-body' });
  const updated = h('span', { class: 'muted' });

  async function load() {
    if (!hooks.isOn(serverId)) {
      body.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'Connettiti al server per vedere i suoi servizi.')));
      return;
    }
    body.classList.add('loading');
    let d;
    try { d = await api.invoke('server:services', serverId); } catch (e) { fail(e); body.classList.remove('loading'); return; }
    body.classList.remove('loading');
    updated.textContent = `aggiornata alle ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
    const logs = (label, cmd) => h('button', { class: 'btn small ghost', onclick: () => hooks.openTerminal(serverId, cmd) }, icon('terminal', 13), label);

    const pub = d.listening.filter((p) => p.scope === 'pubblica');
    const loc = d.listening.filter((p) => p.scope === 'locale');
    const portCard = (p) => h('div', { class: `svc-node ${p.scope}` },
      h('div', { class: 'svc-port' }, String(p.port)),
      h('div', { class: 'svc-text' },
        h('strong', {}, p.process || 'processo sconosciuto'),
        h('span', {}, `${p.scope === 'pubblica' ? 'raggiungibile da fuori' : 'solo dal server'}${p.connections ? ` · ${p.connections} connession${p.connections === 1 ? 'e' : 'i'} attiv${p.connections === 1 ? 'a' : 'e'}` : ''}`)),
      p.process && logs('Log', `journalctl -n 300 -f _COMM=${p.process.replace(/[^\w.-]/g, '')}`));

    body.replaceChildren(...[
      h('div', { class: 'svc-map' },
        h('div', { class: 'svc-col' },
          h('div', { class: 'svc-col-head' }, icon('globe', 15), 'Internet'),
          h('p', { class: 'muted' }, pub.length ? 'Porte aperte verso l\'esterno' : 'Nessuna porta aperta verso l\'esterno'),
          pub.map(portCard)),
        h('div', { class: 'svc-flow', 'aria-hidden': 'true' }),
        h('div', { class: 'svc-col' },
          h('div', { class: 'svc-col-head' }, icon('server', 15), 'Dentro il server'),
          h('p', { class: 'muted' }, loc.length ? 'Servizi raggiungibili solo localmente (database, cache…)' : 'Nessun servizio solo locale'),
          loc.map(portCard))),
      d.docker.length > 0 && h('section', { class: 'svc-section' },
        h('div', { class: 'section-head' }, h('span', {}, `Container Docker (${d.docker.length})`)),
        h('div', { class: 'svc-grid' }, d.docker.map((c) => h('div', { class: 'svc-node' },
          h('div', { class: 'svc-port' }, icon('layers', 16)),
          h('div', { class: 'svc-text' }, h('strong', {}, c.name), h('span', {}, `${c.image}${c.ports ? ` · ${c.ports}` : ''}`), h('span', { class: 'muted' }, c.status)),
          logs('Log', `docker logs -f --tail 300 ${c.name.replace(/[^\w.-]/g, '')}`))))),
      d.units.length > 0 && h('section', { class: 'svc-section' },
        h('div', { class: 'section-head' }, h('span', {}, `Servizi di sistema attivi (${d.units.length})`)),
        h('div', { class: 'svc-units' }, d.units.map((u) => h('div', { class: 'svc-unit' },
          h('span', { class: 'status-dot on' }),
          h('div', { class: 'svc-text' }, h('strong', {}, u.name), h('span', { class: 'muted' }, u.description)),
          logs('Log', `journalctl -u ${u.name.replace(/[^\w@.-]/g, '')} -n 300 -f`))))),
      !d.listening.length && !d.docker.length && !d.units.length && h('div', { class: 'empty' }, h('p', {}, 'Non ho trovato servizi: sul server potrebbero mancare i comandi ss o systemctl.'))].filter(Boolean));
  }

  const s = hooks.serverOf(serverId);
  const el = h('div', { class: 'tab-pane page' },
    h('div', { class: 'page-inner' },
      h('div', { class: 'page-head' },
        s && serverBadge(s),
        h('div', {}, h('h2', { class: 'page-h' }, 'Mappa dei servizi'), h('p', { class: 'muted' }, `${s?.name || ''} · cosa gira e dove ascolta`)),
        h('span', { class: 'spacer' }),
        updated,
        h('button', { class: 'btn small', onclick: load }, icon('refresh', 14), 'Aggiorna')),
      body));

  return {
    kind: 'services',
    serverId,
    title: `${s?.name || 'Server'} · servizi`,
    el,
    loaded: false,
    show() { if (!this.loaded) { this.loaded = true; load(); } },
    dispose() {},
  };
}
