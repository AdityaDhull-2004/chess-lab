// Evaluation graph (canvas): white's win chance over the game, with markers for key moves.
import { h } from './dom.js';
import { CLASSES } from '../core/review.js';

export class EvalGraph {
  constructor(onSelect) {
    this.onSelect = onSelect;
    this.canvas = h('canvas.evalgraph');
    this.el = h('div.graphwrap', this.canvas);
    this.wins = null; // win% (white) for positions 0..n
    this.marks = [];
    this.cursor = 0;
    this.drag = false;
    const pick = (e) => {
      if (!this.wins) return;
      const r = this.canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      this.onSelect(Math.round(x * (this.wins.length - 1)));
    };
    this.canvas.addEventListener('pointerdown', (e) => { this.drag = true; this.canvas.setPointerCapture(e.pointerId); pick(e); });
    this.canvas.addEventListener('pointermove', (e) => { if (this.drag) pick(e); });
    this.canvas.addEventListener('pointerup', () => { this.drag = false; });
    new ResizeObserver(() => this.draw()).observe(this.el);
  }
  set(wins, reviewMoves) {
    this.wins = wins;
    this.marks = (reviewMoves || []).map((m, i) => ({ ply: i + 1, cls: m.cls })).filter((m) => ['brilliant', 'great', 'blunder', 'mistake', 'miss'].includes(m.cls));
    this.draw();
  }
  setCursor(ply) { this.cursor = ply; this.draw(); }
  draw() {
    const cv = this.canvas;
    const r = this.el.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.floor(r.width), H = 90;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--graph-bg').trim() || '#262421';
    g.fillRect(0, 0, W, H);
    if (!this.wins || this.wins.length < 2) return;
    const n = this.wins.length - 1;
    const X = (i) => (i / n) * W, Y = (w) => H - (w / 100) * H;
    g.beginPath(); g.moveTo(0, H);
    this.wins.forEach((w, i) => g.lineTo(X(i), Y(w)));
    g.lineTo(W, H); g.closePath();
    g.fillStyle = css.getPropertyValue('--graph-fill').trim() || '#e8e6e1';
    g.fill();
    g.strokeStyle = 'rgba(128,128,128,.55)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    for (const m of this.marks) {
      g.fillStyle = CLASSES[m.cls].color;
      g.beginPath(); g.arc(X(m.ply), Y(this.wins[m.ply]), 3.2, 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = '#f5a623'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(X(this.cursor), 0); g.lineTo(X(this.cursor), H); g.stroke();
  }
}
