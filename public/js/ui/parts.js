// Reusable UI pieces: eval bar, player bars with captured pieces, simple move list.
import { h, clear, fmtClock, pieceImg } from './dom.js';

export class EvalBar {
  constructor() {
    this.fill = h('div.fill');
    this.label = h('div.lbl', '0.0');
    this.el = h('div.evalbar', { title: 'Engine evaluation' }, this.fill, this.label);
    this.set(0.5, '0.00');
  }
  flip(flipped) { this.el.classList.toggle('flipped', flipped); }
  /** @param {number} wp white's win probability 0..1 */
  set(wp, text) {
    this.fill.style.height = `${Math.max(2, Math.min(98, wp * 100))}%`;
    this.label.textContent = text;
    this.label.classList.toggle('wlead', wp >= 0.5);
  }
}

const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const ORDER = ['q', 'r', 'b', 'n', 'p'];

/** Pieces each side has captured, plus material difference (white minus black), from a FEN. */
export function capturedFrom(fen) {
  const cnt = { w: {}, b: {} };
  for (const ch of fen.split(' ')[0]) {
    if (/[prnbq]/i.test(ch)) { const c = ch === ch.toUpperCase() ? 'w' : 'b'; const t = ch.toLowerCase(); cnt[c][t] = (cnt[c][t] || 0) + 1; }
  }
  const byWhite = [], byBlack = []; // byWhite = black pieces white has captured
  let diff = 0;
  for (const t of ORDER) {
    const missB = Math.max(0, START_COUNT[t] - (cnt.b[t] || 0));
    const missW = Math.max(0, START_COUNT[t] - (cnt.w[t] || 0));
    for (let i = 0; i < missB; i++) byWhite.push(t);
    for (let i = 0; i < missW; i++) byBlack.push(t);
    diff += ((cnt.w[t] || 0) - (cnt.b[t] || 0)) * VAL[t];
  }
  return { byWhite, byBlack, diff };
}

export class PlayerBar {
  constructor() {
    this.avatar = h('div.avatar');
    this.name = h('span.pname');
    this.sub = h('span.psub');
    this.caps = h('div.caps');
    this.clock = h('div.clock');
    this.el = h('div.pbar', this.avatar, h('div.who', h('div', this.name, this.sub), this.caps), this.clock);
  }
  setPlayer({ name, sub = '', avatar = '', online = null }) {
    this.name.textContent = name;
    this.sub.textContent = sub ? ` (${sub})` : '';
    clear(this.avatar); this.avatar.append(typeof avatar === 'string' ? document.createTextNode(avatar || (name || '?')[0].toUpperCase()) : avatar);
    this.avatar.classList.toggle('offline', online === false);
  }
  /** @param {string[]} types captured piece types  @param {'w'|'b'} victimColor  @param {number} adv material lead (shown if >0) */
  setCaptured(types, victimColor, adv) {
    clear(this.caps);
    let last = null;
    for (const t of types) {
      const img = pieceImg(victimColor, t, 'cap');
      if (last === t) img.classList.add('stack');
      last = t; this.caps.append(img);
    }
    if (adv > 0) this.caps.append(h('span.adv', `+${adv}`));
  }
  setClock(ms, active, low = false) {
    this.clock.textContent = ms == null ? '' : fmtClock(ms);
    this.clock.classList.toggle('active', !!active);
    this.clock.classList.toggle('low', !!low && ms != null && ms < 20000);
    this.clock.style.display = ms == null ? 'none' : '';
  }
}

/** Two-column-per-row move list. render(sans, activePly) where activePly = number of plies applied (0 = start). */
export class MoveList {
  constructor(onSelect) {
    this.onSelect = onSelect;
    this.el = h('div.moves');
  }
  render(sans, active, { startPly = 0 } = {}) {
    clear(this.el);
    for (let i = 0; i < sans.length; i += 2) {
      const n = Math.floor((i + startPly) / 2) + 1;
      const mk = (idx) => (idx < sans.length
        ? h('span.mv', { class: active === idx + 1 ? 'on' : '', onclick: () => this.onSelect(idx + 1) }, sans[idx])
        : h('span.mv.empty'));
      this.el.append(h('div.row', h('span.num', n + '.'), mk(i), mk(i + 1)));
    }
    const on = this.el.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
    else if (!active) this.el.scrollTop = 0;
  }
}

export const resultText = (result, reason) => {
  const r = result === '1-0' ? 'White wins' : result === '0-1' ? 'Black wins' : result === '1/2-1/2' ? 'Draw' : 'Game over';
  return reason ? `${r} · ${reason}` : r;
};
