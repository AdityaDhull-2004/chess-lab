// usage: node scripts/pair.mjs <weakerElo> <strongerElo> <games> [maxPlies]  -> prints score of the weaker bot
import { Chess } from 'chess.js';
import { nodeEngine, loadOpeningsSync } from './node-engine.mjs';
import { chooseBotMove } from '../public/js/core/bots.js';
import { lineWp } from '../public/js/core/util.js';
loadOpeningsSync();
const [a, b, N, MAXPLY] = [Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4] || 6), Number(process.argv[5] || 110)];
const ea = nodeEngine(), eb = nodeEngine(), judge = nodeEngine();
await Promise.all([ea.ready, eb.ready, judge.ready]);
async function play(wElo, bElo) {
  const c = new Chess(); let n = 0;
  while (!c.isGameOver() && n < MAXPLY) {
    const elo = c.turn() === 'w' ? wElo : bElo;
    const eng = elo === a ? ea : eb;
    const m = await chooseBotMove({ engine: eng, fen: c.fen(), elo });
    c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] }); n++;
  }
  if (c.isCheckmate()) return c.turn() === 'w' ? 0 : 1;
  if (c.isGameOver()) return 0.5;
  const r = await judge.go({ fen: c.fen(), depth: 10 });
  const wp = r.lines[0] ? lineWp(r.lines[0]) : 0.5;
  return wp > 0.72 ? 1 : wp < 0.28 ? 0 : 0.5;
}
let s = 0;
for (let g = 0; g < N; g++) s += g % 2 === 0 ? 1 - (await play(b, a)) : await play(a, b);
console.log(`${a} vs ${b}: weaker scored ${s}/${N}`);
process.exit(0);
