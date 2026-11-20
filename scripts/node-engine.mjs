// Runs the same Engine class in Node: each engine is its own child process (like a browser worker).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Engine } from '../public/js/core/engine.js';
import { setOpenings } from '../public/js/core/openings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export function loadOpeningsSync() {
  setOpenings(JSON.parse(fs.readFileSync(path.join(here, '..', 'public', 'data', 'openings.json'), 'utf8')));
}

export function nodeEngine(kind = 'lite-single', opts = {}) {
  const file = require('stockfish').findEngine(kind);
  const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'ignore'] });
  let engine, buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); engine._line(line); }
  });
  const transport = {
    send: (c) => child.stdin.write(c + '\n'),
    terminate: () => { try { child.kill(); } catch { /* ignore */ } },
  };
  engine = new Engine('lite', { ...opts, transport });
  return engine;
}
