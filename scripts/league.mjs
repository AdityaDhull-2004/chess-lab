// Round-robin-ish league between bot levels to check the rating ladder is monotonic and well spread.
// usage: node scripts/league.mjs <gamesPerPair> <comma separated levels> [maxPlies]
import { Chess } from 'chess.js';
import { nodeEngine, loadOpeningsSync } from './node-engine.mjs';
import { chooseBotMove } from '../public/js/core/bots.js';
import { lineWp } from '../public/js/core/util.js';

loadOpeningsSync();
const N = Number(process.argv[2] || 6);
const levels = (process.argv[3] || '300,500,700,900,1100,1300,1500,1700').split(',').map(Number);
const MAXPLY = Number(process.argv[4] || 140);
const engines = new Map(levels.map((l) => [l, nodeEngine()]));
const judge = nodeEngine();
await Promise.all([...engines.values(), judge].map((e) => e.ready));

async function play(whiteElo, blackElo) {
  const c = new Chess();
  const ucis = [];
  while (!c.isGameOver() && ucis.length < MAXPLY) {
    const elo = c.turn() === 'w' ? whiteElo : blackElo;
    const eng = engines.get(c.turn() === 'w' ? whiteElo : blackElo) || engines.get(elo);
    const m = await chooseBotMove({ engine: eng, fen: c.fen(), elo });
    c.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
    ucis.push(m.uci);
  }
  if (c.isCheckmate()) return c.turn() === 'w' ? 0 : 1;
  if (c.isGameOver()) return 0.5;
  const r = await judge.go({ fen: c.fen(), depth: 9 });
  const wp = r.lines[0] ? lineWp(r.lines[0]) : 0.5;
  return wp > 0.75 ? 1 : wp < 0.25 ? 0 : 0.5;
}

const games = []; // {a, b, s}  s = score of a
for (let i = 0; i < levels.length; i++) {
  for (const gap of [1, 2]) {
    const j = i + gap; if (j >= levels.length) continue;
    const a = levels[i], b = levels[j];
    let sa = 0;
    for (let g = 0; g < N; g++) {
      const s = g % 2 === 0 ? 1 - (await play(b, a)) : await play(a, b); // score of weaker `a`
      sa += s; games.push({ a, b, s });
    }
    console.log(`${a} vs ${b}: weaker scored ${sa}/${N}`);
  }
}
// Bradley-Terry / Elo fit by gradient descent
const r = new Map(levels.map((l) => [l, 0]));
for (let it = 0; it < 3000; it++) {
  const g = new Map(levels.map((l) => [l, 0]));
  for (const { a, b, s } of games) {
    const e = 1 / (1 + 10 ** ((r.get(b) - r.get(a)) / 400));
    g.set(a, g.get(a) + (s - e)); g.set(b, g.get(b) - (s - e));
  }
  for (const l of levels) r.set(l, r.get(l) + 4 * g.get(l));
}
const mean = [...r.values()].reduce((x, y) => x + y, 0) / levels.length;
const nomMean = levels.reduce((x, y) => x + y, 0) / levels.length;
console.log('\nnominal -> fitted (anchored to same mean)');
for (const l of levels) console.log(String(l).padStart(5), '->', Math.round(r.get(l) - mean + nomMean));
process.exit(0);
