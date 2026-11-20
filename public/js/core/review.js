// Game Review: move classification, accuracy and summary stats.
//
// This follows the "expected points" idea used by chess.com's Game Review: every position gets a win
// probability, and a move is graded by how much win probability the mover gave up compared with the
// engine's best move. Thresholds (Excellent <=2%, Good <=5%, Inaccuracy <=10%, Mistake <=20%, Blunder >20%)
// are the ones chess.com documents publicly. Accuracy uses Lichess' open formula.
import { Chess } from 'chess.js';
import { clamp, lineWp, lineCp, forSide, materialDiff, playUci, uciOf, terminalLine } from './util.js';
import { openingFor } from './openings.js';

export const CLASSES = {
  brilliant:  { label: 'Brilliant',  sym: '!!', color: '#1baca6' },
  great:      { label: 'Great',      sym: '!',  color: '#5c8bb0' },
  best:       { label: 'Best',       sym: '★',  color: '#81b64c' },
  excellent:  { label: 'Excellent',  sym: '✓',  color: '#96bc4b' },
  good:       { label: 'Good',       sym: '✓',  color: '#a3b18a' },
  book:       { label: 'Book',       sym: '♗',  color: '#a88865' },
  inaccuracy: { label: 'Inaccuracy', sym: '?!', color: '#f7c631' },
  mistake:    { label: 'Mistake',    sym: '?',  color: '#e58f2a' },
  miss:       { label: 'Miss',       sym: '✕',  color: '#ff7769' },
  blunder:    { label: 'Blunder',    sym: '??', color: '#ca3431' },
  forced:     { label: 'Forced',     sym: '',   color: '#8a8a8a' },
};
export const CLASS_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];

/** Lichess accuracy for one move from win percentages (0..100) before/after, from the mover's view. */
export function moveAccuracy(winBefore, winAfter) {
  const diff = Math.max(0, winBefore - winAfter);
  return clamp(103.1668 * Math.exp(-0.04354 * diff) - 3.1669 + 1, 0, 100); // +1 is lichess' "uncertainty bonus"
}

const stdDev = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

/** Volatility-weighted + harmonic mean accuracy, like Lichess. */
export function gameAccuracy(winsWhitePct, accs, colors, color) {
  const n = accs.length;
  if (!n) return null;
  const win = clamp(Math.floor(n / 10), 2, 8);
  const weights = accs.map((_, i) => {
    const start = i < win - 2 ? 0 : i - (win - 2);
    const w = winsWhitePct.slice(start, start + win);
    return clamp(stdDev(w.length ? w : [50]), 0.5, 12);
  });
  let sw = 0, sa = 0, inv = 0, cnt = 0;
  accs.forEach((a, i) => {
    if (colors[i] !== color) return;
    sw += weights[i]; sa += weights[i] * a; inv += 1 / Math.max(a, 1); cnt++;
  });
  if (!cnt) return null;
  return (sa / sw + cnt / inv) / 2;
}

/** Very rough performance estimate from average centipawn loss. Shown as an estimate only. */
export const estimateRating = (acpl) => Math.round(clamp(3100 * Math.exp(-0.01 * acpl), 100, 3200) / 25) * 25;

/**
 * @param {object[]} moves  [{color, san, uci, fenBefore, fenAfter}]
 * @param {object[]} evals  evals[i] = analysis of the position BEFORE move i (evals[n] = final position);
 *                          each {lines:[{cp|mate|wp, pv[]},...]} from white's view, best line first.
 */
export function classifyGame(moves, evals) {
  const out = [];
  const winsWhite = evals.map((e) => 100 * lineWp(e.lines[0]));
  const accs = [];
  const colors = [];
  const cpLoss = { w: [], b: [] };

  moves.forEach((mv, i) => {
    const before = evals[i], after = evals[i + 1];
    const c = mv.color;
    const bestLine = before.lines[0];
    const wpBest = forSide(lineWp(bestLine), c);
    // evaluation of the move actually played: reuse its own multipv line if it was among them (same depth/search)
    const same = before.lines.find((l) => l.pv?.[0] === mv.uci);
    const playedLine = same || after.lines[0];
    let wpPlayed = forSide(lineWp(playedLine), c);
    let isBest = bestLine.pv?.[0] === mv.uci;
    if (isBest) wpPlayed = wpBest;
    const loss = isBest ? 0 : Math.max(0, wpBest - wpPlayed);
    const cp = isBest ? 0 : Math.max(0, (c === 'w' ? 1 : -1) * (lineCp(bestLine) - lineCp(playedLine)));
    cpLoss[c].push(cp);

    const legalCount = new Chess(mv.fenBefore).moves().length;
    let cls;
    const prev = out[i - 1];
    const bookHit = openingFor(mv.fenAfter);
    if (legalCount === 1) cls = 'forced';
    else if (bookHit && i < 40) cls = 'book';
    else if (loss <= 0.003 || isBest) cls = 'best';
    else if (loss <= 0.02) cls = 'excellent';
    else if (loss <= 0.05) cls = 'good';
    else if (loss <= 0.10) cls = 'inaccuracy';
    else if (loss <= 0.20) cls = 'mistake';
    else cls = 'blunder';

    // Miss: the opponent just erred and this move fails to take advantage (but is not a blunder itself).
    if ((cls === 'inaccuracy' || cls === 'mistake') && prev && ['mistake', 'blunder', 'miss'].includes(prev.cls) && loss >= 0.07) cls = 'miss';

    // Great: the best move was the ONLY good move (alternatives lose a lot) and it is not a trivial recapture.
    if ((cls === 'best' || cls === 'excellent') && before.lines[1]) {
      const gap = wpBest - forSide(lineWp(before.lines[1]), c);
      const wasRecapture = prev && mv.to === prev.to && mv.captured;
      if (gap >= 0.15 && wpBest < 0.97 && !wasRecapture && wpBest > 0.04) cls = 'great';
    }

    // Brilliant: a good move that gives up material for compensation (checked along the engine's own continuation).
    if ((cls === 'best' || cls === 'excellent' || cls === 'great') && wpBest < 0.92 && wpPlayed > 0.45 && loss <= 0.02) {
      if (isSacrifice(mv, after.lines[0])) cls = 'brilliant';
    }

    // Is a move that leaves the player already totally winning still "best"? keep, but nothing special.
    const acc = moveAccuracy(100 * wpBest, 100 * wpPlayed);
    accs.push(acc); colors.push(c);
    out.push({
      i, color: c, san: mv.san, uci: mv.uci, from: mv.from, to: mv.to, captured: mv.captured, cls, loss, acc,
      bestUci: bestLine.pv?.[0] || null, bestLine, playedLine, wpBefore: wpBest, wpAfter: wpPlayed,
    });
  });

  const summary = {};
  for (const c of ['w', 'b']) {
    const mine = out.filter((m) => m.color === c);
    const counts = {};
    for (const k of Object.keys(CLASSES)) counts[k] = 0;
    mine.forEach((m) => counts[m.cls]++);
    const acpl = cpLoss[c].length ? cpLoss[c].reduce((a, b) => a + b, 0) / cpLoss[c].length : 0;
    summary[c] = { counts, accuracy: gameAccuracy(winsWhite, accs, colors, c), acpl, rating: estimateRating(acpl), moves: mine.length };
  }
  return { moves: out, summary, winsWhite };
}

/** Did `mv` knowingly give up material (>= 2 points net) in the engine's continuation? */
function isSacrifice(mv, afterLine) {
  if (!afterLine || !afterLine.pv?.length) return false;
  const c = new Chess(mv.fenBefore);
  const start = materialDiff(c, mv.color);
  try { c.move({ from: mv.from, to: mv.to, promotion: mv.uci[4] }); } catch { return false; }
  const pv = afterLine.pv;
  let k = 0, last = null;
  const maxK = Math.min(pv.length, 6);
  while (k < pv.length) {
    last = playUci(c, pv[k]);
    if (!last) break;
    k++;
    if (k >= maxK && !last.captured) break;
    if (k >= maxK + 2) break;
  }
  if (!k) return false;
  const end = materialDiff(c, mv.color);
  // quiet position reached and still down at least a minor piece => a real sacrifice
  return end <= start - 2;
}

/** Build move records from a chess.js game (mainline). */
export function movesFromChess(game) {
  const verbose = game.history({ verbose: true });
  return verbose.map((m, i) => ({
    i, color: m.color, san: m.san, uci: uciOf(m), from: m.from, to: m.to, captured: m.captured,
    fenBefore: m.before, fenAfter: m.after,
  }));
}

/** Evals for the n+1 positions of a move list; positions that are game-over get a synthetic terminal line. */
export function terminalFor(fen) {
  const c = new Chess(fen);
  const t = terminalLine(c);
  return t ? { lines: [t], depth: 99 } : null;
}
