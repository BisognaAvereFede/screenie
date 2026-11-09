// Macchina del tempo: CPU, memoria e disco del server negli ultimi giorni, con i processi
// che consumavano di più in ogni momento. I campioni li raccoglie Screenie una volta al minuto
// mentre è aperto e connesso al server.
import { h, icon, fail, formatSize } from './dom.js';
import { serverBadge } from './identity.js';

const api = window.api;
const RANGES = [
  { id: '1h', label: '1 ora', ms: 3600e3 },
  { id: '6h', label: '6 ore', ms: 6 * 3600e3 },
  { id: '24h', label: '24 ore', ms: 24 * 3600e3 },
  { id: '7d', label: '7 giorni', ms: 7 * 24 * 3600e3 },
];
const SVG = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

const fmtTime = (t, withDay) => new Date(t).toLocaleString('it-IT', withDay ? { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });

/** hooks: serverOf(id), openTerminal(serverId, command) */
export function createTimelineTab(serverId, hooks) {
  let range = RANGES[2];
  let samples = [];
  let index = -1; // campione scelto (-1 = l'ultimo)
  let timer = null;

  const rangeBtns = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Periodo' });
  const chart = h('div', { class: 'tl-chart' });
  const slider = h('input', { type: 'range', class: 'tl-slider', min: 0, max: 0, value: 0, 'aria-label': 'Momento da esaminare' });
  const readout = h('div', { class: 'tl-readout' });
  const procs = h('div', { class: 'tl-procs' });
  const legend = h('div', { class: 'tl-legend' },
    h('span', { class: 'cpu' }, 'CPU'), h('span', { class: 'mem' }, 'Memoria'), h('span', { class: 'disk' }, 'Disco'));

  slider.addEventListener('input', () => { index = Number(slider.value); renderPoint(); drawCursor(); });

  let autoRange = true;
  async function load() {
    try {
      // Alla prima apertura sceglie il periodo più corto che contiene tutti i dati raccolti.
      if (autoRange) {
        autoRange = false;
        const all = await api.invoke('data:metrics', serverId, Date.now() - RANGES[3].ms);
        const span = all.length ? Date.now() - all[0].t : 0;
        range = RANGES.find((r) => r.ms >= span * 1.05) || RANGES[3];
        renderRanges();
      }
      samples = await api.invoke('data:metrics', serverId, Date.now() - range.ms);
    } catch (e) { fail(e); samples = []; }
    if (index >= samples.length || index < 0) index = samples.length - 1;
    slider.max = String(Math.max(0, samples.length - 1));
    slider.value = String(Math.max(0, index));
    slider.disabled = samples.length < 2;
    draw();
    renderPoint();
  }

  let cursorLine = null;
  let cursorDot = null;
  const W = 900;
  const H = 220;
  const x = (t) => ((t - (Date.now() - range.ms)) / range.ms) * W;
  const y = (v) => H - 6 - (Math.min(100, v) / 100) * (H - 12);

  function draw() {
    chart.replaceChildren();
    if (samples.length < 2) {
      chart.append(h('div', { class: 'empty' }, icon('clock', 28),
        h('p', {}, 'Sto raccogliendo i dati: Screenie salva un campione al minuto mentre è connesso a questo server. Torna tra qualche minuto.')));
      return;
    }
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'tl-svg', role: 'img', 'aria-label': `CPU, memoria e disco nelle ultime ${range.label}` });
    for (const v of [25, 50, 75]) svg.append(svgEl('line', { x1: 0, x2: W, y1: y(v), y2: y(v), class: 'tl-grid' }));
    // Interrompe la linea dove mancano campioni (app chiusa o server disconnesso).
    const line = (key) => {
      let d = '';
      let prev = null;
      for (const s of samples) {
        const gap = prev && s.t - prev.t > 5 * 60e3;
        d += `${!prev || gap ? 'M' : 'L'}${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`;
        prev = s;
      }
      return svgEl('path', { d, class: `tl-line ${key}` });
    };
    svg.append(line('disk'), line('mem'), line('cpu'));
    cursorLine = svgEl('line', { x1: 0, x2: 0, y1: 0, y2: H, class: 'tl-cursor' });
    cursorDot = svgEl('circle', { r: 4, class: 'tl-dot' });
    svg.append(cursorLine, cursorDot);
    svg.addEventListener('pointerdown', (e) => {
      const pick = (ev) => {
        const r = svg.getBoundingClientRect();
        const t = Date.now() - range.ms + ((ev.clientX - r.left) / r.width) * range.ms;
        let best = 0;
        samples.forEach((s, i) => { if (Math.abs(s.t - t) < Math.abs(samples[best].t - t)) best = i; });
        index = best;
        slider.value = String(index);
        renderPoint();
        drawCursor();
      };
      pick(e);
      svg.setPointerCapture(e.pointerId);
      svg.onpointermove = pick;
      svg.onpointerup = () => { svg.onpointermove = null; };
    });
    chart.append(svg, h('div', { class: 'tl-axis' },
      h('span', {}, fmtTime(Date.now() - range.ms, range.ms > 24 * 3600e3)),
      h('span', {}, fmtTime(Date.now() - range.ms / 2, range.ms > 24 * 3600e3)),
      h('span', {}, 'adesso')));
    drawCursor();
  }

  function drawCursor() {
    const s = samples[index];
    if (!s || !cursorLine) return;
    cursorLine.setAttribute('x1', x(s.t));
    cursorLine.setAttribute('x2', x(s.t));
    cursorDot.setAttribute('cx', x(s.t));
    cursorDot.setAttribute('cy', y(s.cpu));
  }

  function renderPoint() {
    const s = samples[index];
    if (!s) { readout.replaceChildren(); procs.replaceChildren(); return; }
    const peak = s.cpu >= 85 ? 'CPU molto alta' : s.mem >= 90 ? 'memoria quasi piena' : s.disk >= 90 ? 'disco quasi pieno' : '';
    readout.replaceChildren(
      h('div', { class: 'tl-when' }, h('span', { class: 'muted' }, new Date(s.t).toDateString() === new Date().toDateString() ? 'Oggi alle' : new Date(s.t).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })), h('strong', {}, fmtTime(s.t))),
      h('div', { class: 'tl-values' },
        h('div', {}, h('span', {}, 'CPU'), h('strong', { class: s.cpu >= 85 ? 'hot' : '' }, `${s.cpu}%`)),
        h('div', {}, h('span', {}, 'Memoria'), h('strong', { class: s.mem >= 90 ? 'hot' : '' }, `${s.mem}%`)),
        h('div', {}, h('span', {}, 'Disco'), h('strong', { class: s.disk >= 90 ? 'hot' : '' }, `${s.disk}%`))),
      peak && h('p', { class: 'tl-peak' }, icon('activity', 14), peak));
    procs.replaceChildren(
      h('div', { class: 'section-head' }, h('span', {}, 'Processi in quel momento')),
      ...(s.procs?.length ? s.procs.map((p, i) => h('div', { class: `tl-proc ${i === 0 && p.cpu >= 50 ? 'hot' : ''}` },
        h('code', {}, p.name), h('span', {}, `${p.cpu.toFixed(0)}% CPU`), h('span', { class: 'muted' }, formatSize(p.rss)))) : [h('p', { class: 'muted' }, 'Nessun dato sui processi.')]),
      h('button', {
        class: 'btn small',
        onclick: () => {
          const from = Math.floor(s.t / 1000) - 60;
          hooks.openTerminal(serverId, `journalctl --since @${from} --until @${from + 180} --no-pager | less -R +G`);
        },
      }, icon('terminal', 14), 'Apri i log di quei minuti'));
  }

  function renderRanges() {
    rangeBtns.replaceChildren(...RANGES.map((r) => h('button', {
      class: `seg ${r === range ? 'active' : ''}`, type: 'button', 'aria-pressed': String(r === range),
      onclick: () => { range = r; index = -1; renderRanges(); load(); },
    }, r.label)));
  }

  const s = hooks.serverOf(serverId);
  const el = h('div', { class: 'tab-pane page' },
    h('div', { class: 'page-inner' },
      h('div', { class: 'page-head' },
        s && serverBadge(s),
        h('div', {}, h('h2', { class: 'page-h' }, 'Macchina del tempo'), h('p', { class: 'muted' }, `${s?.name || ''} · trascina sul grafico per tornare a un momento preciso`)),
        h('span', { class: 'spacer' }),
        rangeBtns),
      h('div', { class: 'tl-card' }, chart, slider, legend),
      h('div', { class: 'tl-detail' }, readout, procs)));

  renderRanges();
  return {
    kind: 'timeline',
    serverId,
    title: `${s?.name || 'Server'} · storia`,
    el,
    show() { load(); clearInterval(timer); timer = setInterval(() => { if (index === samples.length - 1) index = -1; load(); }, 60000); },
    dispose() { clearInterval(timer); },
  };
}
