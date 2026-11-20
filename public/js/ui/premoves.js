// Multiple premoves: queued moves are played on a "virtual" board (the opponent is assumed to pass),
// so you can premove the same piece several times. The queue is validated again when it is executed.
import { Chess } from 'chess.js';
import { h } from './dom.js';

function forceTurn(c, me) {
  if (c.turn() === me) return c;
  const p = c.fen().split(' ');
  p[1] = me; p[3] = '-';
  try { return new Chess(p.join(' ')); } catch { return null; }
}

export class Premoves {
  constructor() { this.q = []; }
  get length() { return this.q.length; }
  clear() { this.q = []; }

  /** Board after `sent` (my moves already sent, not yet confirmed) and every queued premove. null if invalid. */
  position(fen, me, sent = []) {
    let c;
    try { c = new Chess(fen); } catch { return null; }
    for (const m of sent) { try { c.move(m); } catch { return null; } }
    for (const m of this.q) {
      c = forceTurn(c, me);
      if (!c) return null;
      try { c.move(m); } catch { return null; }
    }
    return forceTurn(c, me);
  }

  /** Queue a premove if it is legal on the virtual board. */
  tryAdd(fen, me, sent, m) {
    const c = this.position(fen, me, sent);
    if (!c) return false;
    try { c.move({ from: m.from, to: m.to, promotion: m.promotion }); } catch { return false; }
    this.q.push({ from: m.from, to: m.to, promotion: m.promotion });
    return true;
  }

  /** Take the next premove if it is legal on the real position, else drop the whole queue. */
  next(fen) {
    const m = this.q.shift();
    if (!m) return null;
    try { new Chess(fen).move({ from: m.from, to: m.to, promotion: m.promotion }); return m; } catch { this.q = []; return null; }
  }
}

/** Little "n premoves queued" pill over the board; click to cancel. */
export function createPreBadge(boxEl, pre, onCancel) {
  const el = h('div.preinfo', { title: 'Cancel premoves (Esc)', onclick: onCancel });
  boxEl.append(el);
  return {
    refresh() {
      el.style.display = pre.length ? '' : 'none';
      el.textContent = `${pre.length} premove${pre.length > 1 ? 's' : ''} queued ✕`;
    },
  };
}
