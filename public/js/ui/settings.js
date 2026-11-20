// Settings dialog: move-sound theme, volume and board colours.
import { h, modal, store, pieceUrl } from './dom.js';
import { sound, SOUND_THEMES } from './sound.js';

export const BOARD_THEMES = {
  green: { label: 'Green', light: '#eeeed2', dark: '#769656' },
  brown: { label: 'Classic brown', light: '#f0d9b5', dark: '#b58863' },
  wood: { label: 'Walnut', light: '#e8c99b', dark: '#a0734a' },
  blue: { label: 'Ocean blue', light: '#dee3e6', dark: '#8ca2ad' },
  grey: { label: 'Slate grey', light: '#e6e6e6', dark: '#8f8f8f' },
  purple: { label: 'Purple', light: '#ece8f5', dark: '#8877b7' },
  midnight: { label: 'Midnight', light: '#c9d1d9', dark: '#4b5d73' },
  coral: { label: 'Coral', light: '#f7e6d4', dark: '#d9826b' },
};

export const PIECE_SETS = {
  cburnett: 'Classic (Cburnett)', merida: 'Merida', chessnut: 'Chessnut', pirouetti: 'Pirouetti', letter: 'Letters',
  mpchess: 'MP Chess', fantasy: 'Fantasy', celtic: 'Celtic', rhosgfx: 'RhosGFX', pixel: 'Pixel',
};
export function applyPieceSet() {
  const set = store.get('pieceSet', 'cburnett');
  let st = document.getElementById('pieceStyle');
  if (!st) { st = document.createElement('style'); st.id = 'pieceStyle'; document.head.append(st); }
  const roles = { pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' };
  st.textContent = Object.entries(roles).map(([r, t]) => ['white', 'black'].map((c) =>
    `.cg-wrap piece.${r}.${c} { background-image: url(pieces/${set}/${c[0]}${t}.svg); }`).join('\n')).join('\n');
}

export function applyBoardTheme() {
  const key = store.get('boardTheme', 'green');
  const custom = store.get('boardCustom', { light: '#eeeed2', dark: '#769656' });
  const t = key === 'custom' ? custom : BOARD_THEMES[key] || BOARD_THEMES.green;
  const r = document.documentElement.style;
  r.setProperty('--sq-light', t.light); r.setProperty('--sq-dark', t.dark);
}

export function openSettings() {
  const swatch = (k, t) => h('button.swatch', {
    title: t.label, class: store.get('boardTheme', 'green') === k ? 'on' : '',
    style: { background: `linear-gradient(135deg, ${t.light} 50%, ${t.dark} 50%)` },
    onclick: (e) => { store.set('boardTheme', k); applyBoardTheme(); mark(e.currentTarget); },
  });
  const mark = (el) => { sw.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b === el)); };
  const sw = h('div.swatches', Object.entries(BOARD_THEMES).map(([k, t]) => swatch(k, t)));
  const custom = store.get('boardCustom', { light: '#eeeed2', dark: '#769656' });
  const pick = (which) => h('input', { type: 'color', value: custom[which], oninput: (e) => {
    custom[which] = e.target.value; store.set('boardCustom', custom); store.set('boardTheme', 'custom'); applyBoardTheme(); mark(null);
  } });

  const pieceGrid = h('div.piecegrid', Object.entries(PIECE_SETS).map(([k, label]) => h('button.pset', {
    title: label, class: store.get('pieceSet', 'cburnett') === k ? 'on' : '',
    onclick: (e) => { store.set('pieceSet', k); applyPieceSet(); pieceGrid.querySelectorAll('.pset').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); },
  }, h('img', { src: `pieces/${k}/wN.svg`, alt: label }), h('img', { src: `pieces/${k}/bQ.svg`, alt: '' }), h('small', label))));

  const themeSel = h('select', { onchange: (e) => { sound.setTheme(e.target.value); sound.move(); } },
    Object.entries(SOUND_THEMES).map(([k, t]) => h('option', { value: k, selected: k === sound.theme }, t.label)));
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: sound.volume, oninput: (e) => sound.setVolume(+e.target.value), onchange: () => sound.move() });
  const mute = h('label.chk', h('input', { type: 'checkbox', checked: !sound.muted, onchange: (e) => sound.setMuted(!e.target.checked) }), 'Sound on');
  const tests = h('div.btnrow', [['Move', 'move'], ['Capture', 'capture'], ['Check', 'check'], ['Castle', 'castle']].map(([l, k]) => h('button.btn.tiny', { onclick: () => sound[k]() }, l)));

  const body = h('div.settings-body',
    h('h4', 'Piece style'), pieceGrid,
    h('h4', 'Board colours'), sw,
    h('div.field.inline', h('label', 'Custom'), pick('light'), pick('dark')),
    h('h4', 'Move sounds'), mute,
    h('div.field', h('label', 'Sound style'), themeSel),
    h('div.field.inline', h('label', 'Volume'), vol), tests);
  return modal({ title: 'Settings', body, buttons: [{ label: 'Done', value: true, primary: true }] });
}
