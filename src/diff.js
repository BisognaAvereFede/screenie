// Differenze riga per riga tra due testi, e la loro vista.
import { h } from './dom.js';

/** Restituisce [{ type: 'same'|'add'|'del', text }]. */
export function diffLines(a, b) {
  const A = String(a ?? '').split('\n');
  const B = String(b ?? '').split('\n');
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length - 1;
  let endB = B.length - 1;
  while (endA >= start && endB >= start && A[endA] === B[endB]) { endA--; endB--; }
  const midA = A.slice(start, endA + 1);
  const midB = B.slice(start, endB + 1);
  const out = A.slice(0, start).map((text) => ({ type: 'same', text }));
  const n = midA.length;
  const m = midB.length;
  if (n * m > 4_000_000) {
    // Troppe righe diverse per un confronto preciso: mostra il blocco tolto e quello aggiunto.
    out.push(...midA.map((text) => ({ type: 'del', text })), ...midB.map((text) => ({ type: 'add', text })));
  } else {
    // Sottosequenza comune più lunga.
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = midA[i] === midB[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { out.push({ type: 'same', text: midA[i] }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push({ type: 'del', text: midA[i++] });
      else out.push({ type: 'add', text: midB[j++] });
    }
    while (i < n) out.push({ type: 'del', text: midA[i++] });
    while (j < m) out.push({ type: 'add', text: midB[j++] });
  }
  out.push(...A.slice(endA + 1).map((text) => ({ type: 'same', text })));
  return out;
}

/** Vista compatta: solo le righe cambiate con 3 righe di contesto. */
export function diffView(a, b, { context = 3 } = {}) {
  const d = diffLines(a, b);
  const changed = d.map((x) => x.type !== 'same');
  if (!changed.includes(true)) return h('div', { class: 'diff-empty' }, 'Nessuna differenza.');
  const keep = d.map((_, i) => {
    for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) if (changed[k]) return true;
    return false;
  });
  const rows = [];
  let lineA = 0;
  let lineB = 0;
  let skipped = false;
  const added = changed.filter((c, i) => c && d[i].type === 'add').length;
  const removed = changed.filter((c, i) => c && d[i].type === 'del').length;
  d.forEach((x, i) => {
    if (x.type !== 'add') lineA++;
    if (x.type !== 'del') lineB++;
    if (!keep[i]) { skipped = true; return; }
    if (skipped) { rows.push(h('div', { class: 'diff-gap' }, '⋯')); skipped = false; }
    rows.push(h('div', { class: `diff-row ${x.type}` },
      h('span', { class: 'diff-num' }, x.type === 'add' ? '' : String(lineA)),
      h('span', { class: 'diff-num' }, x.type === 'del' ? '' : String(lineB)),
      h('span', { class: 'diff-sign', 'aria-label': x.type === 'add' ? 'aggiunta' : x.type === 'del' ? 'rimossa' : '' }, x.type === 'add' ? '+' : x.type === 'del' ? '−' : ' '),
      h('span', { class: 'diff-text' }, x.text || ' ')));
  });
  return h('div', { class: 'diff' },
    h('div', { class: 'diff-summary' }, h('span', { class: 'add' }, `+${added}`), h('span', { class: 'del' }, `−${removed}`), 'righe'),
    h('div', { class: 'diff-body' }, rows));
}
