// DOM-free helpers shared by the engine, bots and review code.
import { Chess } from 'chess.js';

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const posKey = (fen) => fen.split(' ').slice(0, 3).join(' ');
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Lichess' open win-probability curve: centipawns (white's view) -> 0..1 chance for white. */
export const wpFromCp = (cp) => 1 / (1 + Math.exp(-0.00368208 * clamp(cp, -3000, 3000)));

/** Win probability (white's view) of an engine line. Mate lines are decided; synthetic terminal lines carry .wp. */
export function lineWp(line) {
  if (!line) return 0.5;
  if (line.wp !== undefined) return line.wp;
  if (line.mate !== undefined) return line.mate > 0 ? 1 : line.mate < 0 ? 0 : 0.5;
  return wpFromCp(line.cp);
}
/** Centipawns (white's view) capped to +-1000 for loss statistics. */
export function lineCp(line) {
  if (!line) return 0;
  if (line.mate !== undefined && line.wp === undefined) return line.mate > 0 ? 1000 : -1000;
  return clamp(line.cp ?? 0, -1000, 1000);
}
export const forSide = (wpWhite, color) => (color === 'w' ? wpWhite : 1 - wpWhite);

export function fmtScore(line) {
  if (!line) return '–';
  if (line.terminal) return line.wp === 0.5 ? '0.00' : line.wp === 1 ? '1-0' : '0-1';
  if (line.mate !== undefined) return (line.mate > 0 ? '+' : '-') + '#' + Math.abs(line.mate);
  const v = line.cp / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
}

/** Synthetic "analysis" of a finished position so classification can treat mates/draws uniformly. */
export function terminalLine(chess) {
  if (chess.isCheckmate()) return { terminal: true, wp: chess.turn() === 'w' ? 0 : 1, cp: chess.turn() === 'w' ? -1000 : 1000, pv: [], depth: 99 };
  if (chess.isDraw() || chess.isStalemate() || chess.isInsufficientMaterial()) return { terminal: true, wp: 0.5, cp: 0, pv: [], depth: 99 };
  return null;
}

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export function materialDiff(chess, color) {
  let d = 0;
  for (const row of chess.board()) for (const p of row) if (p) d += (p.color === color ? 1 : -1) * VAL[p.type];
  return d;
}

/** Play a UCI move on a chess.js instance; returns the verbose move or null. */
export function playUci(chess, uci) {
  try {
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
  } catch { return null; }
}

/** Convert a UCI PV into SAN moves starting from a FEN. */
export function pvToSan(fen, pv, max = 14) {
  const c = new Chess(fen);
  const out = [];
  for (const u of pv.slice(0, max)) {
    const m = playUci(c, u);
    if (!m) break;
    out.push({ san: m.san, uci: u, fen: c.fen(), color: m.color, from: m.from, to: m.to });
  }
  return out;
}
/** "1. e4 e5 2. Nf3" style text for a SAN list starting at a given FEN. */
export function formatPv(fen, sans) {
  const parts = fen.split(' ');
  let turn = parts[1], num = parseInt(parts[5], 10) || 1;
  let s = '';
  sans.forEach((san, i) => {
    if (turn === 'w') s += `${num}. `; else if (i === 0) s += `${num}… `;
    s += san + ' ';
    if (turn === 'b') num++;
    turn = turn === 'w' ? 'b' : 'w';
  });
  return s.trim();
}

export function uciOf(m) { return m.from + m.to + (m.promotion || ''); }
