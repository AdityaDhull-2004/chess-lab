// Human-like Stockfish bots.
//
// Why not just "random blunders"? A bot that hangs its queen on move 5 and then plays perfectly feels fake.
// Real club players lose the thread gradually, so each bot combines FOUR ingredients:
//   1. Opening book   - plays sensible theory for a few moves (deeper for stronger bots).
//   2. Limited vision - weak bots search only 1-4 plies, so they miss 2-3 move tactics the way humans do.
//   3. Noisy choice   - among the engine's top candidate moves they pick by a softmax over win-probability
//                       loss; weaker bots have a hotter temperature => plausible, slightly worse moves.
//   4. Blunder cap    - the noise can never throw away more than `cap` win-probability (so no free queens
//                       unless the bot is genuinely at the very bottom), and a rare "slip" is allowed.
// Only the 3000+ bots use full-strength Stockfish; everything else is the model above.
import { Chess } from 'chess.js';
import { clamp, lerp, lineWp, forSide, uciOf } from './util.js';
import { openingFor } from './openings.js';

export const BOTS = [
  { elo: 300,  name: 'Pip',      emoji: '🐣', blurb: 'Just learned how the pieces move.' },
  { elo: 500,  name: 'Clover',   emoji: '🍀', blurb: 'Plays fast, forgets to look at your threats.' },
  { elo: 700,  name: 'Biscuit',  emoji: '🍪', blurb: 'Loves grabbing pawns. Sometimes too many.' },
  { elo: 900,  name: 'Otto',     emoji: '🐢', blurb: 'Slow and steady, but misses forks.' },
  { elo: 1100, name: 'Maya',     emoji: '🌻', blurb: 'Knows basic tactics. Still leaves pieces hanging.' },
  { elo: 1300, name: 'Leo',      emoji: '🦁', blurb: 'Aggressive attacker with shaky defence.' },
  { elo: 1500, name: 'Sana',     emoji: '🎯', blurb: 'Solid club player. Punishes obvious errors.' },
  { elo: 1700, name: 'Viktor',   emoji: '♞',  blurb: 'Tactically sharp, occasionally careless.' },
  { elo: 1900, name: 'Ingrid',   emoji: '🧊', blurb: 'Cold, positional, rarely blunders.' },
  { elo: 2100, name: 'Rafael',   emoji: '🔥', blurb: 'Expert-level calculation.' },
  { elo: 2300, name: 'Mira',     emoji: '🌙', blurb: 'Master strength. Converts small edges.' },
  { elo: 2500, name: 'Orion',    emoji: '✨', blurb: 'Grandmaster-level. Very few mistakes.' },
  { elo: 2800, name: 'Atlas',    emoji: '🪐', blurb: 'Near-perfect play.' },
  { elo: 3200, name: 'Stockfish', emoji: '🤖', blurb: 'Full strength. Good luck.' },
];
export const botForElo = (elo) => BOTS.reduce((b, x) => (Math.abs(x.elo - elo) < Math.abs(b.elo - elo) ? x : b), BOTS[0]);

/**
 * Everything about how a bot of a given rating plays, in one inspectable place.
 * Strength comes from three knobs that all shrink as the rating rises: search depth (tactical vision),
 * softmax temperature (how often it picks a slightly worse move) and the blunder cap.
 * (Stockfish's own UCI_Elo limiter is NOT used: it makes random piece-dropping blunders, which is exactly
 * the unnatural behaviour we want to avoid.)  Anchors were tuned with scripts/league.mjs.
 */
const ANCHORS = [
  // elo, depth, tau, cap, slipP, slipCap   (calibrated so average centipawn loss matches real players, see scripts/calibrate.mjs)
  [250, 1, 0.40, 0.70, 0.27, 0.90], [500, 2, 0.30, 0.55, 0.20, 0.80], [800, 3, 0.18, 0.40, 0.12, 0.60], [1100, 4, 0.10, 0.27, 0.055, 0.50],
  [1400, 5, 0.07, 0.20, 0.03, 0.40], [1700, 6, 0.066, 0.18, 0.016, 0.30], [2000, 7, 0.032, 0.11, 0.006, 0.30], [2300, 9, 0.034, 0.11, 0.006, 0.25],
  [2600, 10, 0.024, 0.10, 0.007, 0.30], [2900, 12, 0.014, 0.06, 0.004, 0.25],
];
export function botProfile(elo) {
  elo = clamp(Math.round(elo), 250, 3200);
  if (elo >= 3000) return { mode: 'full', elo, movetime: 1200, bookPlies: 20 };
  let i = 0;
  while (i < ANCHORS.length - 2 && elo >= ANCHORS[i + 1][0]) i++;
  const [e0, d0, t0, c0, p0, s0] = ANCHORS[i], [e1, d1, t1, c1, p1, s1] = ANCHORS[i + 1];
  const f = clamp((elo - e0) / (e1 - e0), 0, 1);
  return {
    mode: 'custom', elo,
    depth: Math.round(lerp(d0, d1, f)),
    candidates: elo < 1500 ? 10 : 6,
    movetime: 2500,
    tau: Math.exp(lerp(Math.log(t0), Math.log(t1), f)),
    cap: lerp(c0, c1, f),
    slipP: lerp(p0, p1, f),
    slipCap: lerp(s0, s1, f),
    bookPlies: elo < 600 ? 4 : elo < 1000 ? 8 : elo < 1500 ? 10 : elo < 2000 ? 14 : 18,
  };
}

function configure(engine) {
  engine.setOption('UCI_LimitStrength', 'false');
}

function weightedPick(items, weights, rnd) {
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = rnd() * sum;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

/**
 * Choose a move for the bot.
 * @returns {Promise<{uci:string, source:string}>}
 */
export async function chooseBotMove({ engine, fen, startFen = null, uciMoves = null, elo, rnd = Math.random }) {
  const p = botProfile(elo);
  const chess = new Chess(fen);
  const legal = chess.moves({ verbose: true });
  if (!legal.length) return null;
  if (legal.length === 1) return { uci: uciOf(legal[0]), source: 'forced' };
  const me = chess.turn();
  const ply = chess.history().length || (parseInt(fen.split(' ')[5], 10) - 1) * 2 + (me === 'b' ? 1 : 0);

  // ---- 1. opening book (validated by a quick full-strength search so we never "book" into a bad line)
  if (ply < p.bookPlies && rnd() < 0.92) {
    engine.setOption('UCI_LimitStrength', 'false');
    const r = await engine.go({ fen, startFen, moves: uciMoves, depth: 7, multipv: Math.min(14, legal.length) });
    if (r.lines.length) {
      const best = forSide(lineWp(r.lines[0]), me);
      const tol = Math.max(0.05, p.mode === 'custom' ? Math.min(0.12, p.cap) : 0.05);
      const cands = r.lines.filter((l) => {
        const loss = best - forSide(lineWp(l), me);
        if (loss > tol) return false;
        const c = new Chess(fen);
        try { c.move({ from: l.pv[0].slice(0, 2), to: l.pv[0].slice(2, 4), promotion: l.pv[0][4] }); } catch { return false; }
        return !!openingFor(c.fen());
      });
      if (cands.length) {
        // first move: bias towards the main moves
        const w = cands.map((l) => (ply === 0 ? ({ e2e4: 6, d2d4: 5, g1f3: 2, c2c4: 2 }[l.pv[0]] || 0.4) : 1));
        return { uci: weightedPick(cands, w, rnd).pv[0], source: 'book' };
      }
    }
  }

  // ---- 2. full-strength Stockfish
  if (p.mode === 'full') {
    configure(engine);
    const r = await engine.go({ fen, startFen, moves: uciMoves, movetime: p.movetime, multipv: 1 });
    return { uci: r.best, source: 'full' };
  }

  // ---- 3. human-like bots: depth-limited search + noisy choice among the best candidates
  configure(engine);
  const r = await engine.go({ fen, startFen, moves: uciMoves, depth: p.depth, movetime: p.movetime, multipv: Math.min(p.candidates, legal.length) });
  if (!r.lines.length) return { uci: r.best, source: 'fallback' };
  const scored = r.lines.map((l) => ({ uci: l.pv[0], wp: forSide(lineWp(l), me), mate: l.mate !== undefined && ((l.mate > 0) === (me === 'w')) }));
  const bestWp = Math.max(...scored.map((s) => s.wp));
  // Anyone above ~450 takes a mate in one when they see it.
  const mateNow = scored.find((s) => s.mate && s.wp >= 0.999);
  if (mateNow && p.elo >= 450 && rnd() < 0.97) return { uci: mateNow.uci, source: 'mate' };

  let pool = scored.filter((s) => bestWp - s.wp <= p.cap + 1e-9);
  let source = 'noisy';
  if (rnd() < p.slipP) {
    // a genuine slip: any plausible move that is not catastrophic
    const slip = scored.filter((s) => bestWp - s.wp <= p.slipCap);
    if (slip.length > 1) { pool = slip; source = 'slip'; }
  }
  const temp = source === 'slip' ? p.tau * 4 : p.tau;
  const weights = pool.map((s) => Math.exp(-(bestWp - s.wp) / temp));
  return { uci: weightedPick(pool, weights, rnd).uci, source };
}

/** Rough "thinking" time so a bot does not answer instantly. */
export function botDelay(elo, source, rnd = Math.random) {
  if (source === 'forced') return 250 + rnd() * 250;
  if (source === 'book') return 350 + rnd() * 650;
  const base = elo < 1000 ? 600 : elo < 2000 ? 700 : 500;
  return base + rnd() * 1100;
}
