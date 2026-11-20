// Builds a fully static copy (bots + analysis + review) for GitHub Pages into ./dist.
// Accounts, friends and online play need the Node server, so the static site hides them automatically.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const nm = (...p) => path.join(root, 'node_modules', ...p);
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), dist, { recursive: true });

const copy = (from, to, filter = () => true) => {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) if (filter(f)) fs.copyFileSync(path.join(from, f), path.join(to, f));
};
copy(nm('chessground', 'dist'), path.join(dist, 'vendor', 'chessground'), (f) => f.endsWith('.js') && !f.endsWith('.min.js'));
copy(nm('chessground', 'assets'), path.join(dist, 'vendor', 'chessground-assets'), (f) => f.endsWith('.css'));
copy(nm('chess.js', 'dist', 'esm'), path.join(dist, 'vendor', 'chess.js'), (f) => f === 'chess.js');
// only the small single-threaded engine (the ~100 MB full net is for self-hosting)
copy(nm('stockfish', 'bin'), path.join(dist, 'vendor', 'stockfish'), (f) => /^stockfish-19-lite-single\.(js|wasm)$/.test(f));

let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
html = html.replace('<base href="/">', '<base href="./">')
  .replace('<script type="importmap">', '<script>window.CHESSLAB_LITE_ONLY = true;</script>\n  <script type="importmap">');
fs.writeFileSync(path.join(dist, 'index.html'), html);
fs.copyFileSync(path.join(dist, 'index.html'), path.join(dist, '404.html'));
fs.writeFileSync(path.join(dist, '.nojekyll'), '');
const size = (d) => fs.readdirSync(d, { recursive: true }).reduce((n, f) => { const p = path.join(d, f); return n + (fs.statSync(p).isFile() ? fs.statSync(p).size : 0); }, 0);
console.log(`static site written to dist/ (${(size(dist) / 1e6).toFixed(1)} MB)`);
