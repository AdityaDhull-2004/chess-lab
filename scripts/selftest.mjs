// Smoke tests for the engine wrapper, review classifier and bots (no browser needed).
import { Chess } from 'chess.js';
import { nodeEngine, loadOpeningsSync } from './node-engine.mjs';
import { analysePositions } from '../public/js/core/analyse.js';
import { classifyGame, movesFromChess } from '../public/js/core/review.js';
import { chooseBotMove, botProfile } from '../public/js/core/bots.js';

loadOpeningsSync();
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

const engine = nodeEngine();
await engine.ready;
console.log('engine:', engine.name);

// 1. basic search
const r = await engine.go({ fen: new Chess().fen(), depth: 10, multipv: 3 });
ok(r.best && r.lines.length === 3, `search returns best move (${r.best}) and 3 lines`);
ok(r.lines[0].cp !== undefined, 'score parsed (white view)');

// black to move: scores must be flipped to white's view. Black is a queen up -> very negative.
const rb = await engine.go({ fen: 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1', depth: 8 });
ok(rb.lines[0].cp > 500, `black (to move) is a queen down => big plus for white (${rb.lines[0].cp})`);

// 2. review of a scholar's-mate game with a clear blunder
const g = new Chess();
for (const m of ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']) g.move(m);
const moves = movesFromChess(g);
const fens = [moves[0].fenBefore, ...moves.map((m) => m.fenAfter)];
const evals = await analysePositions(fens, { engines: [engine], depth: 10, multipv: 2 });
const rev = classifyGame(moves, evals);
console.log(rev.moves.map((m) => `${m.san}:${m.cls}(${(m.loss * 100).toFixed(0)}%)`).join('  '));
ok(rev.moves[5].cls === 'blunder', '3...Nf6?? is a blunder');
ok(['best', 'great'].includes(rev.moves[6].cls), 'Qxf7# is best/great');
ok(rev.summary.w.accuracy > rev.summary.b.accuracy, `white accuracy ${rev.summary.w.accuracy.toFixed(1)} > black ${rev.summary.b.accuracy.toFixed(1)}`);

// 3. bots always return legal moves and weak bots are not instant-blunder machines
for (const elo of [300, 700, 1100, 1500, 2000, 3200]) {
  const c = new Chess('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3');
  const t0 = Date.now();
  const m = await chooseBotMove({ engine, fen: c.fen(), elo });
  let legal = false;
  try { c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] }); legal = true; } catch { /* */ }
  ok(legal, `bot ${elo} (${botProfile(elo).mode}) plays legal ${m.uci} via ${m.source} in ${Date.now() - t0}ms`);
}

engine.quit();
console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
