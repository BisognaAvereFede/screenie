// Identità dei server (colore e sigla) e controllo dei comandi pericolosi sui server di produzione.
import { h, modal } from './dom.js';

// Colori tenui, distinguibili anche per luminosità; il primo è il viola di Screenie.
export const SERVER_COLORS = ['#8b6cff', '#3fa7d6', '#2bb39a', '#e0a33a', '#e46f6f', '#d16ba5', '#7d8597', '#6fbf4f'];

function hash(s) {
  let x = 0;
  for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x;
}

export const colorOf = (s) => (s?.color || SERVER_COLORS[hash(s?.id || s?.name || '') % SERVER_COLORS.length]);

export function glyphOf(s) {
  if (s?.glyph) return s.glyph.toUpperCase();
  const words = String(s?.name || s?.host || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/);
  const g = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return (g || '?').toUpperCase();
}

/** Quadratino con la sigla del server, nel suo colore. */
export function serverBadge(s, cls = '') {
  return h('span', { class: `server-badge ${cls}`, style: { '--server-color': colorOf(s) }, 'aria-hidden': 'true' }, glyphOf(s));
}

// ---------- Comandi pericolosi ----------
const DANGER = [
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+-?[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR]|-[rR]f?|--recursive)/, 'cancella file e cartelle in modo ricorsivo'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, 'cancella dati dal database'],
  [/\bdelete\s+from\s+\w+\s*;?\s*$/i, 'cancella tutte le righe di una tabella'],
  [/\b(reboot|shutdown|poweroff|halt)\b/, 'spegne o riavvia il server'],
  [/\binit\s+[06]\b/, 'spegne o riavvia il server'],
  [/\bmkfs(\.\w+)?\b/, 'formatta un disco'],
  [/\bdd\s+.*\bof=\/dev\//, 'scrive direttamente su un disco'],
  [/:\(\)\s*\{.*\};\s*:/, 'blocca il server (fork bomb)'],
  [/\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, 'rende scrivibile da tutti l\'intero sistema'],
  [/\bchown\s+-R\s+\S+\s+\/(\s|$)/, 'cambia il proprietario dell\'intero sistema'],
  [/\bsystemctl\s+(stop|restart|disable|mask)\s+(nginx|apache2|httpd|mysql|mariadb|postgresql|docker|sshd?|redis|php[\d.]*-fpm)\b/, 'ferma o riavvia un servizio importante'],
  [/\bkill(all)?\s+-9\b/, 'termina processi in modo forzato'],
  [/\bdocker\s+(rm|rmi|system\s+prune|volume\s+(rm|prune)|compose\s+down)\b/, 'rimuove container, immagini o volumi'],
  [/\bgit\s+(push\s+.*(-f\b|--force)|reset\s+--hard|clean\s+-[a-z]*f)/, 'riscrive o cancella la cronologia di git'],
  [/>\s*\/etc\/\S+/, 'sovrascrive un file di sistema'],
  [/\bufw\s+(disable|reset)\b|\biptables\s+-F\b/, 'disattiva il firewall'],
];

/** Motivo per cui il comando è pericoloso, oppure null. */
export function dangerReason(cmd) {
  const c = String(cmd || '');
  for (const [re, why] of DANGER) if (re.test(c)) return why;
  return null;
}

/** Chiede conferma prima di eseguire un comando pericoloso su un server di produzione. */
export async function confirmDanger(server, cmd) {
  const why = dangerReason(cmd);
  if (!why || !server?.production) return true;
  focusDangerCancel();
  const r = await modal({
    title: 'Comando pericoloso su un server di produzione',
    body: h('div', { class: 'danger-confirm' },
      h('div', { class: 'danger-server', style: { '--server-color': colorOf(server) } },
        serverBadge(server), h('div', {}, h('strong', {}, server.name), h('span', {}, 'PRODUZIONE'))),
      h('pre', { class: 'danger-cmd' }, cmd),
      h('p', {}, `Questo comando ${why}. Sei sicuro di volerlo eseguire proprio qui?`)),
    actions: [
      { label: 'Annulla', result: false },
      { label: 'Esegui comunque', kind: 'danger', result: true },
    ],
  });
  return !!r;
}

// Il terminale ha ancora il focus: lo sposto su "Annulla" così Invio non conferma per sbaglio.
export function focusDangerCancel() {
  const go = () => document.querySelector('.danger-confirm')?.closest('.modal')?.querySelector('.btn')?.focus();
  for (const ms of [40, 120, 300]) setTimeout(go, ms);
}
