// Plays each bot against a fixed opponent and grades its moves with a depth-12 reference search,
// to check the bots make human-like (graded) mistakes rather than random one-move blunders.
import { Chess } from 'chess.js';
import { nodeEngine, loadOpeningsSync } from './node-engine.mjs';
import { chooseBotMove } from '../public/js/core/bots.js';
import { lineWp, forSide } from '../public/js/core/util.js';

loadOpeningsSync();
const games = Number(process.argv[2] || 2);
const levels = (process.argv[3] || '300,700,1100,1500,2000').split(',').map(Number);
const botEng = nodeEngine(), oppEng = nodeEngine(), refEng = nodeEngine();
await Promise.all([botEng.ready, oppEng.ready, refEng.ready]);
const pct = (x) => (100 * x).toFixed(1);

for (const elo of levels) {
  let moves = 0, sumLoss = 0, big = 0, mid = 0, small = 0, score = 0;
  for (let g = 0; g < games; g++) {
    const c = new Chess();
    const botColor = g % 2 === 0 ? 'w' : 'b';
    while (!c.isGameOver() && c.history().length < 120) {
      if (c.turn() === botColor) {
        const fen = c.fen();
        const m = await chooseBotMove({ engine: botEng, fen, elo });
        const ref = await refEng.go({ fen, depth: 11, multipv: 1 });
        const best = forSide(lineWp(ref.lines[0]), botColor);
        let wp = best;
        if (ref.best !== m.uci) {
          const mine = await refEng.go({ fen, depth: 11, multipv: 1, searchmoves: [m.uci] });
          wp = mine.lines[0] ? forSide(lineWp(mine.lines[0]), botColor) : best;
        }
        const loss = Math.max(0, best - wp);
        moves++; sumLoss += loss;
        if (loss > 0.2) big++; else if (loss > 0.1) mid++; else if (loss > 0.05) small++;
        c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
      } else {
        const m = await chooseBotMove({ engine: oppEng, fen: c.fen(), elo: 1500 });
        c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
      }
    }
    if (c.isCheckmate()) score += c.turn() === botColor ? 0 : 1; else score += 0.5;
  }
  console.log(`bot ${String(elo).padStart(4)}: avg win%-loss/move ${pct(sumLoss / moves)}  inacc ${small}  mistakes ${mid}  blunders ${big}  /${moves} moves   score vs 1500 bot: ${score}/${games}`);
}
process.exit(0);
