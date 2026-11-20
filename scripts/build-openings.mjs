// Builds public/data/openings.json from the lichess chess-openings TSV files (CC0).
// Key = first 3 FEN fields (placement, side to move, castling), value = [eco, name].
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = {};
let n = 0;
for (const f of ['a', 'b', 'c', 'd', 'e']) {
  const lines = fs.readFileSync(path.join(here, f + '.tsv'), 'utf8').split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [eco, name, pgn] = line.split('\t');
    const c = new Chess();
    try { c.loadPgn(pgn); } catch { continue; }
    const key = c.fen().split(' ').slice(0, 3).join(' ');
    // later (longer) entries overwrite earlier ones only if not already present
    if (!out[key]) { out[key] = [eco, name]; n++; }
  }
}
fs.writeFileSync(path.join(here, '..', 'public', 'data', 'openings.json'), JSON.stringify(out));
console.log('openings:', n);
