// Chessground + chess.js glue: legal-move dests, promotion picker, arrows, move-quality badges.
import { Chessground } from 'chessground';
import { Chess } from 'chess.js';
import { h, pieceImg } from './dom.js';

export class BoardView {
  /**
   * @param {HTMLElement} el   container (CSS gives it its square size)
   * @param {{orientation?:string, onMove?:(m:{from,to,promotion?})=>void, premove?:boolean}} o
   */
  constructor(el, { orientation = 'white', onMove = () => {}, premove = false } = {}) {
    this.el = el;
    this.onMove = onMove;
    this.chess = new Chess();
    this.lastOpts = {};
    this.premoveEnabled = premove;
    this.promoEl = null;
    this.cg = Chessground(el, {
      orientation, coordinates: true, autoCastle: true, disableContextMenu: true,
      animation: { enabled: true, duration: 160 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, showDests: true, events: { after: (o, d) => this._after(o, d) } },
      premovable: { enabled: premove, showDests: true },
      draggable: { showGhost: true, distance: 3 },
      drawable: {
        enabled: true, visible: true, eraseOnClick: true,
        brushes: {
          green: { key: 'g', color: '#2f9e44', opacity: 0.9, lineWidth: 11 },
          red: { key: 'r', color: '#c92a2a', opacity: 0.85, lineWidth: 11 },
          blue: { key: 'b', color: '#1c7ed6', opacity: 0.75, lineWidth: 9 },
          yellow: { key: 'y', color: '#f59f00', opacity: 0.9, lineWidth: 10 },
          paleBlue: { key: 'pb', color: '#1c7ed6', opacity: 0.45, lineWidth: 8 },
          paleGreen: { key: 'pg', color: '#2f9e44', opacity: 0.5, lineWidth: 8 },
        },
      },
    });
    this.ro = new ResizeObserver(() => {
      this.cg.redrawAll();
      if (this.pendingShapes && this.el.offsetWidth) { this.cg.setAutoShapes(this.pendingShapes); this.pendingShapes = null; }
    });
    this.ro.observe(el);
  }

  get orientation() { return this.cg.state.orientation; }
  flip() { this.cg.toggleOrientation(); }
  setOrientation(o) { if (this.cg.state.orientation !== o) this.cg.toggleOrientation(); }

  /**
   * Show a position.
   * @param {Chess} chess
   * @param {{lastMove?:{from:string,to:string}|null, interactive?:'white'|'black'|'both'|null, shapes?:object[]}} opts
   */
  update(chess, { lastMove = null, interactive = null, shapes } = {}) {
    this.chess = chess;
    this.lastOpts = { lastMove, interactive };
    this.closePromo();
    const turn = chess.turn() === 'w' ? 'white' : 'black';
    const dests = new Map();
    const canMove = interactive && (interactive === 'both' || interactive === turn) && !chess.isGameOver();
    if (canMove) {
      for (const m of chess.moves({ verbose: true })) {
        if (!dests.has(m.from)) dests.set(m.from, []);
        dests.get(m.from).push(m.to);
      }
    }
    this.cg.set({
      fen: chess.fen(), turnColor: turn, check: chess.inCheck() ? turn : false,
      lastMove: lastMove ? [lastMove.from, lastMove.to] : [],
      movable: { color: interactive === 'both' ? turn : interactive || undefined, dests },
      premovable: { enabled: this.premoveEnabled && !!interactive && interactive !== 'both' },
      viewOnly: false,
    });
    if (shapes) { if (this.el.offsetWidth) this.cg.setAutoShapes(shapes); else this.pendingShapes = shapes; }
    if (this.premoveEnabled && canMove) this.cg.playPremove();
  }

  setShapes(shapes) { if (this.el.offsetWidth) this.cg.setAutoShapes(shapes); else this.pendingShapes = shapes; }
  clearUserShapes() { this.cg.setShapes([]); }

  _after(orig, dest) {
    const piece = this.chess.get(orig);
    const isPromo = piece && piece.type === 'p' && ((piece.color === 'w' && dest[1] === '8') || (piece.color === 'b' && dest[1] === '1'))
      && this.chess.moves({ square: orig, verbose: true }).some((m) => m.to === dest);
    if (isPromo) {
      this.askPromotion(piece.color, dest).then((role) => {
        if (role) this.onMove({ from: orig, to: dest, promotion: role });
        else this.update(this.chess, this.lastOpts); // cancelled: snap back
      });
    } else {
      this.onMove({ from: orig, to: dest });
    }
  }

  askPromotion(color, dest) {
    return new Promise((resolve) => {
      this.closePromo();
      const files = 'abcdefgh';
      const flipped = this.orientation === 'black';
      let col = files.indexOf(dest[0]);
      if (flipped) col = 7 - col;
      const atTop = (color === 'w') !== flipped; // promotion square is on the top edge of the drawn board
      const box = h('div.promo', { style: { left: `${col * 12.5}%`, [atTop ? 'top' : 'bottom']: '0' }, class: atTop ? '' : 'up' },
        ['q', 'n', 'r', 'b'].map((r) => h('button', { title: r, onclick: (e) => { e.stopPropagation(); this.closePromo(); resolve(r); } }, pieceImg(color, r))));
      const shade = h('div.promo-shade', { onclick: () => { this.closePromo(); resolve(null); } });
      this.promoEl = [shade, box];
      this.el.append(shade, box);
    });
  }
  closePromo() { if (this.promoEl) { this.promoEl.forEach((n) => n.remove()); this.promoEl = null; } }

  destroy() { this.ro.disconnect(); this.cg.destroy(); }
}

/** Arrow shape helper. */
export const arrow = (uci, brush = 'green', width) => ({ orig: uci.slice(0, 2), dest: uci.slice(2, 4), brush, modifiers: width ? { lineWidth: width } : undefined });

/** Small circular badge in the top-right corner of a square (move classification). */
export function badge(square, sym, color) {
  const size = sym.length > 1 ? 15 : 17;
  return {
    orig: square,
    customSvg: {
      center: 'orig',
      html: `<g transform="translate(62,-4)"><circle cx="19" cy="19" r="19" fill="${color}" stroke="#fff" stroke-width="2.5"/>` +
        `<text x="19" y="${19 + size * 0.36}" font-family="Segoe UI,Arial,sans-serif" font-weight="800" font-size="${size + 6}" fill="#fff" text-anchor="middle">${sym}</text></g>`,
    },
  };
}
