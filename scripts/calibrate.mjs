// Measures how a bot actually plays: average centipawn loss (ACPL, lichess style, capped at 1000) and mistake rates,
// by playing it against itself and grading every move with a depth-12 reference search.
// usage: node scripts/calibrate.mjs <elo> [games] [maxPlies]
import { Chess } from 'chess.js';
import { nodeEngine, loadOpeningsSync } from './node-engine.mjs';
import { chooseBotMove } from '../public/js/core/bots.js';
import { lineCp, lineWp, forSide } from '../public/js/core/util.js';
loadOpeningsSync();
const elo = Number(process.argv[2]), N = Number(process.argv[3] || 3), MAXPLY = Number(process.argv[4] || 90);
const bot = nodeEngine(), ref = nodeEngine();
await Promise.all([bot.ready, ref.ready]);
let n = 0, sumCp = 0, inacc = 0, mist = 0, blund = 0;
for (let g = 0; g < N; g++) {
  const c = new Chess(); let ply = 0;
  while (!c.isGameOver() && ply < MAXPLY) {
    const fen = c.fen(), me = c.turn();
    const m = await chooseBotMove({ engine: bot, fen, elo });
    const best = await ref.go({ fen, depth: 12 });
    let cpB = lineCp(best.lines[0]), wpB = forSide(lineWp(best.lines[0]), me), cpP = cpB, wpP = wpB;
    if (best.best !== m.uci) {
      const r = await ref.go({ fen, depth: 12, searchmoves: [m.uci] });
      if (r.lines[0]) { cpP = lineCp(r.lines[0]); wpP = forSide(lineWp(r.lines[0]), me); }
    }
    const sgn = me === 'w' ? 1 : -1;
    sumCp += Math.max(0, sgn * (cpB - cpP)); n++;
    const loss = Math.max(0, wpB - wpP);
    if (loss > 0.2) blund++; else if (loss > 0.1) mist++; else if (loss > 0.05) inacc++;
    c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] }); ply++;
  }
}
const pm = (x) => (100 * x / n).toFixed(1) + '%';
console.log(`elo ${String(elo).padStart(4)}  ACPL ${(sumCp / n).toFixed(0).padStart(4)}   inacc ${pm(inacc)}  mistakes ${pm(mist)}  blunders ${pm(blund)}   (${n} moves)`);
process.exit(0);
