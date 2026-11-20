// Minimal UCI wrapper around Stockfish (WASM worker in the browser, anything with send/onmessage in tests).
// All scores are normalised to WHITE's point of view.

export class Engine {
  /**
   * @param {'lite'|'full'} kind    lite = ~2 MB net (fast load), full = ~100 MB NNUE (strongest)
   * @param {{transport?:object, threads?:number, hash?:number, forceSingle?:boolean}} opts
   */
  constructor(kind = 'lite', opts = {}) {
    this.kind = kind;
    this.opts = {};
    this.cur = null;
    this.waiters = [];
    this.name = 'Stockfish';
    this.multi = false;
    this.transport = opts.transport || null;
    this.ready = this._init(opts);
  }

  async _init({ threads = 1, hash = 32, forceSingle = false }) {
    if (!this.transport) {
      const iso = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
      this.multi = iso && !forceSingle && threads > 1;
      const file = `stockfish-19${this.kind === 'lite' ? '-lite' : ''}${this.multi ? '' : '-single'}.js`;
      const worker = new Worker('vendor/stockfish/' + file);
      this.transport = {
        send: (c) => worker.postMessage(c),
        terminate: () => worker.terminate(),
      };
      worker.onmessage = (e) => this._line(typeof e.data === 'string' ? e.data : String(e.data));
      worker.onerror = (e) => { console.error('Stockfish worker error', e); };
    }
    const uok = this._wait('uciok');
    this.send('uci');
    await uok;
    if (this.multi) this.setOption('Threads', threads);
    this.setOption('Hash', hash);
    const rok = this._wait('readyok');
    this.send('isready');
    await rok;
    return this;
  }

  send(cmd) { this.transport.send(cmd); }
  _wait(token) { return new Promise((resolve) => this.waiters.push({ token, resolve })); }

  setOption(name, value) {
    if (this.opts[name] === value) return;
    this.opts[name] = value;
    this.send(`setoption name ${name} value ${value}`);
  }

  async newGame() {
    await this.ready;
    await this.stop();
    this.send('ucinewgame');
    const rok = this._wait('readyok');
    this.send('isready');
    await rok;
  }

  /** Called by the transport for each output line. */
  _line(line) {
    line = line.trim();
    if (!line) return;
    if (line.startsWith('id name')) this.name = line.slice(8);
    if (line === 'uciok' || line === 'readyok') {
      const i = this.waiters.findIndex((w) => w.token === line);
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve();
      return;
    }
    const cur = this.cur;
    if (!cur) return;
    if (line.startsWith('info ')) {
      const info = parseInfo(line);
      if (!info) return;
      const sign = cur.turn === 'w' ? 1 : -1;
      if (info.cp !== undefined) info.cp *= sign;
      if (info.mate !== undefined) info.mate *= sign;
      if (info.bound && cur.lines[info.multipv - 1] && !cur.lines[info.multipv - 1].bound) return; // keep the exact one
      cur.lines[info.multipv - 1] = info;
      if (cur.onInfo) cur.onInfo(cur.snapshot());
    } else if (line.startsWith('bestmove')) {
      const t = line.split(/\s+/);
      this.cur = null;
      const lines = cur.snapshot();
      cur.resolve({ best: t[1] && t[1] !== '(none)' ? t[1] : null, ponder: t[3] || null, lines, depth: lines[0]?.depth || 0 });
    }
  }

  /**
   * Run one search. Any search already running is stopped first.
   * Resolves with {best, lines:[{multipv,depth,cp|mate,pv[],nodes,nps}], depth}.
   */
  async go({ fen, startFen = null, moves = null, depth = null, movetime = null, nodes = null, multipv = 1, infinite = false, onInfo = null, searchmoves = null } = {}) {
    await this.ready;
    while (this.cur) { const p = this.cur.promise; this.send('stop'); await p; }
    this.setOption('MultiPV', multipv);
    const cur = {
      turn: fen.split(' ')[1], lines: [], onInfo,
      snapshot() { return this.lines.filter(Boolean).sort((a, b) => a.multipv - b.multipv); },
    };
    cur.promise = new Promise((r) => { cur.resolve = r; });
    this.cur = cur;
    if (startFen && moves && moves.length) this.send(`position fen ${startFen} moves ${moves.join(' ')}`);
    else this.send(`position fen ${fen}`);
    let cmd = 'go';
    if (infinite) cmd += ' infinite';
    else {
      if (depth) cmd += ` depth ${depth}`;
      if (movetime) cmd += ` movetime ${movetime}`;
      if (nodes) cmd += ` nodes ${nodes}`;
      if (cmd === 'go') cmd += ' depth 12';
    }
    if (searchmoves && searchmoves.length) cmd += ' searchmoves ' + searchmoves.join(' ');
    this.send(cmd);
    return cur.promise;
  }

  /** Stop the running search (its promise still resolves with the best result so far). */
  async stop() {
    if (!this.cur) return;
    const p = this.cur.promise;
    this.send('stop');
    await p;
  }

  quit() { try { this.transport.terminate(); } catch { /* ignore */ } }
}

export function parseInfo(line) {
  const t = line.split(/\s+/);
  const o = { multipv: 1, pv: [] };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': o.depth = +t[++i]; break;
      case 'seldepth': o.seldepth = +t[++i]; break;
      case 'multipv': o.multipv = +t[++i]; break;
      case 'score': {
        const k = t[++i]; const v = +t[++i];
        if (k === 'cp') o.cp = v; else if (k === 'mate') o.mate = v;
        if (t[i + 1] === 'lowerbound' || t[i + 1] === 'upperbound') o.bound = t[++i];
        break;
      }
      case 'nodes': o.nodes = +t[++i]; break;
      case 'nps': o.nps = +t[++i]; break;
      case 'time': o.time = +t[++i]; break;
      case 'hashfull': o.hashfull = +t[++i]; break;
      case 'pv': o.pv = t.slice(i + 1); i = t.length; break;
      case 'string': return null;
      default: break;
    }
  }
  if (o.cp === undefined && o.mate === undefined) return null;
  if (!o.pv.length) return null;
  return o;
}
