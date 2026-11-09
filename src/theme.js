// Aspetto: tema chiaro/scuro/sistema, colore principale, font e zoom.
const api = window.api;

export const ACCENTS = [
  { name: 'Viola Screenie', value: '#7652e8' },
  { name: 'Blu', value: '#3f5fe8' },
  { name: 'Rosa', value: '#ff5c7a' },
  { name: 'Corallo', value: '#ff7a59' },
  { name: 'Arancione', value: '#f59e0b' },
  { name: 'Verde', value: '#22c55e' },
  { name: 'Acqua', value: '#14b8a6' },
  { name: 'Azzurro', value: '#38bdf8' },
];

export const ZOOMS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export const TERM_FONTS = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Lucida Console', 'Courier New', 'JetBrains Mono', 'Fira Code', 'Source Code Pro'];

const UI_FALLBACK = '"Plus Jakarta Sans Variable", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif';
const MONO_FALLBACK = '"Cascadia Mono", Consolas, "SF Mono", Menlo, monospace';
const quote = (f) => `"${f.replace(/"/g, '')}"`;

// Luminanza relativa WCAG di un colore #rrggbb.
function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Mescola due colori #rrggbb (t = quota di `to`).
function mix(from, to, t) {
  const ch = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(ch(from, i) * (1 - t) + ch(to, i) * t).toString(16).padStart(2, '0')).join('')}`;
}

// Il colore principale usato come testo: schiarito (tema scuro) o scurito (tema chiaro)
// quanto basta per arrivare a 4.5:1 sulle superfici, anche sopra --accent-soft.
function readableAccent(accent, mode) {
  const [base, toward] = mode === 'light' ? ['#eef0f4', '#000000'] : ['#2a2d36', '#ffffff'];
  const surface = mix(base, accent, 0.14); // fondo tinto di --accent-soft (scheda attiva, selezione)
  for (let t = 0; t <= 1; t += 0.04) {
    const c = mix(accent, toward, t);
    if (contrast(c, surface) >= 4.5) return c;
  }
  return toward;
}

const listeners = new Set();
const media = window.matchMedia('(prefers-color-scheme: dark)');
let current = null;

/** Tema effettivamente in uso ('dark' o 'light'). */
export function effectiveTheme(theme = current?.theme) {
  if (theme === 'light' || theme === 'dark') return theme;
  return media.matches ? 'dark' : 'light';
}

export const monoFamily = () => (current?.termFont ? `${quote(current.termFont)}, ${MONO_FALLBACK}` : MONO_FALLBACK);

/** Applica le impostazioni di aspetto a tutta l'interfaccia e avvisa terminali ed editor. */
export function applyAppearance(settings) {
  current = settings;
  const root = document.documentElement;
  const mode = effectiveTheme(settings.theme);
  root.dataset.theme = mode;
  let accent = settings.accent || ACCENTS[0].value;
  // Testo sopra il colore: bianco o scuro, quello che contrasta di più. Con 4.8:1 resta
  // sopra 4.5 anche il testo attenuato al 92% (riquadro CPU).
  let onAccent = contrast(accent, '#ffffff') >= contrast(accent, '#1d2030') ? '#ffffff' : '#1d2030';
  if (contrast(accent, onAccent) < 4.8) {
    // Colori di luminosità media (es. #4f7cff): né bianco né scuro bastano, scurisci il fondo.
    const base = accent;
    for (let t = 0.04; contrast(accent, '#ffffff') < 4.8 && t <= 1; t += 0.04) accent = mix(base, '#000000', t);
    onAccent = '#ffffff';
  }
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--on-accent', onAccent);
  root.style.setProperty('--accent-text', readableAccent(accent, mode));
  root.style.setProperty('--ui', UI_FALLBACK);
  root.style.setProperty('--mono', monoFamily());
  // I pulsanti _ □ X non seguono lo zoom: lo spazio sotto di loro va compensato.
  root.style.setProperty('--titlebar', `${44 / (settings.zoom || 1)}px`);
  root.style.setProperty('--controls', `${146 / (settings.zoom || 1)}px`); // larghezza dei pulsanti _ □ X
  api.invoke('window:appearance', { theme: settings.theme, zoom: settings.zoom || 1 }).catch(() => {});
  for (const fn of listeners) fn(mode);
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

media.addEventListener('change', () => {
  if (current?.theme === 'system') applyAppearance(current);
});

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Temi del terminale. "auto" segue il tema dell'app (sfondo sfumato nella scheda).
const PALETTES = {
  dracula: { label: 'Dracula', background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' },
  'solarized-dark': { label: 'Solarized scuro', background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
  'solarized-light': { label: 'Solarized chiaro', background: '#fdf6e3', foreground: '#586e75', cursor: '#586e75', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' },
  nord: { label: 'Nord', background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0', brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4' },
  'one-dark': { label: 'One Dark', background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf', brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff' },
  'github-light': { label: 'GitHub chiaro', background: '#ffffff', foreground: '#24292f', cursor: '#0969da', black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781', brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f' },
};
export const TERM_THEMES = [{ value: 'auto', label: "Come l'app" }, ...Object.entries(PALETTES).map(([value, p]) => ({ value, label: p.label }))];

/** Sfondo pieno del tema del terminale scelto, o null se segue l'app. */
export function terminalBackground() {
  return PALETTES[current?.termTheme]?.background || null;
}

/** Colori del terminale per il tema corrente. */
export function terminalTheme() {
  const accent = css('--accent') || '#7652e8';
  const pal = PALETTES[current?.termTheme];
  if (pal) {
    const { label: _l, ...colors } = pal;
    return { ...colors, background: '#00000000', cursorAccent: pal.background, selectionBackground: `${accent}55` };
  }
  if (effectiveTheme() === 'light') {
    return {
      // Sfondo trasparente: lo dà il CSS (.term-host), con la sfumatura verso il bordo della scheda.
      background: '#00000000', foreground: '#2b2f3a', cursor: accent, cursorAccent: '#f6f7fb', selectionBackground: `${accent}40`,
      black: '#2b2f3a', red: '#d6304f', green: '#178a5a', yellow: '#a87308',
      blue: '#2f5fcf', magenta: '#7a4fd6', cyan: '#0f8a80', white: '#c8ccd6',
      brightBlack: '#6b7183', brightRed: '#e8506b', brightGreen: '#1fa971', brightYellow: '#c98a0a',
      brightBlue: '#3f74e0', brightMagenta: '#8b6cf0', brightCyan: '#14a396', brightWhite: '#9aa0b0',
    };
  }
  return {
    background: '#00000000', foreground: '#dfe1e8', cursor: accent, cursorAccent: '#15161c', selectionBackground: `${accent}40`,
    black: '#2b2e38', red: '#ff6b81', green: '#34c98a', yellow: '#f5c45c',
    blue: '#5b8def', magenta: '#a78bfa', cyan: '#4fd1c5', white: '#dfe1e8',
    brightBlack: '#5e6374', brightRed: '#ff8a9e', brightGreen: '#6ee7b7', brightYellow: '#fcd98a',
    brightBlue: '#8fb2f5', brightMagenta: '#c4b5fd', brightCyan: '#81e6d9', brightWhite: '#ffffff',
  };
}
