// Analyse a list of positions with one or more engines in parallel.
import { terminalFor } from './review.js';

/**
 * @param {string[]} fens
 * @param {{engines:Engine[], depth:number, multipv?:number, onProgress?:(done:number,total:number,i:number,result:object)=>void, signal?:{aborted:boolean}, cache?:Map}} o
 * @returns {Promise<object[]>} evals[i] = {lines, depth}
 */
export async function analysePositions(fens, { engines, depth, movetime = null, multipv = 2, onProgress, signal = {}, cache = new Map() }) {
  const results = new Array(fens.length);
  const todo = [];
  let done = 0;
  const byFen = new Map(); // fen -> [indices] (repeated positions are analysed once)
  fens.forEach((fen, i) => {
    const term = terminalFor(fen);
    if (term) { results[i] = term; done++; return; }
    const key = `${fen}|${depth}|${movetime}|${multipv}`;
    if (cache.has(key)) { results[i] = cache.get(key); done++; return; }
    if (byFen.has(key)) { byFen.get(key).push(i); return; }
    byFen.set(key, [i]);
    todo.push({ i, key, fen });
  });
  let next = 0;
  async function worker(engine) {
    engine.setOption('UCI_LimitStrength', 'false');
    while (!signal.aborted) {
      const job = todo[next++];
      if (!job) return;
      const r = await engine.go({ fen: job.fen, depth, movetime, multipv });
      if (signal.aborted) return;
      const res = { lines: r.lines, depth: r.depth, best: r.best };
      cache.set(job.key, res);
      for (const idx of byFen.get(job.key)) { results[idx] = res; done++; onProgress?.(done, fens.length, idx, res); }
    }
  }
  if (onProgress && done) onProgress(done, fens.length, -1, null);
  await Promise.all(engines.map(worker));
  if (signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
  return results;
}
