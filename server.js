// Chess Lab server: static files, shareable online games (WebSocket), and a tiny
// proxy for importing games from chess.com / lichess. Stockfish itself runs in the browser.
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { openStore } from './server/store.js';
import { setupAccounts } from './server/accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const nm = (p) => path.join(__dirname, 'node_modules', p);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const store = await openStore({ file: process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json') });

// Cross-origin isolation lets the multi-threaded Stockfish build use SharedArrayBuffer.
app.use((req, res, next) => {
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

app.use('/vendor/chessground', express.static(nm('chessground/dist'), { maxAge: '7d' }));
app.use('/vendor/chessground-assets', express.static(nm('chessground/assets'), { maxAge: '7d' }));
app.use('/vendor/chess.js', express.static(nm('chess.js/dist/esm'), { maxAge: '7d' }));
app.use('/vendor/stockfish', express.static(nm('stockfish/bin'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));

const indexHtml = path.join(__dirname, 'public', 'index.html');
app.get('/g/:id', (req, res) => res.sendFile(indexHtml));

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  }
  return out;
}
app.get('/api/info', (req, res) => res.json({ lan: lanUrls(), games: games.size }));

// ---------------------------------------------------------------- import proxy
const UA = 'chess-lab/1.0 (personal analysis tool)';
const USER_RE = /^[A-Za-z0-9_-]{2,40}$/;

function pgnHeaders(pgn) {
  const h = {};
  for (const m of pgn.matchAll(/^\[(\w+)\s+"(.*)"\]\s*$/gm)) h[m[1]] = m[2];
  return h;
}
function splitPgns(text) {
  return text.split(/\r?\n\r?\n(?=\[Event )/).map((s) => s.trim()).filter((s) => s.includes('[Event'));
}
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw Object.assign(new Error(`upstream ${r.status}`), { status: r.status });
  return r.json();
}

app.get('/api/chesscom/:user', async (req, res) => {
  const user = req.params.user;
  if (!USER_RE.test(user)) return res.status(400).json({ error: 'bad username' });
  try {
    const { archives } = await getJson(`https://api.chess.com/pub/player/${user.toLowerCase()}/games/archives`);
    const games = [];
    for (const url of (archives || []).slice(-4).reverse()) {
      const data = await getJson(url);
      for (const g of (data.games || []).reverse()) {
        if (!g.pgn) continue;
        const h = pgnHeaders(g.pgn);
        games.push({
          source: 'chess.com', url: g.url, pgn: g.pgn,
          white: g.white?.username, black: g.black?.username,
          whiteElo: g.white?.rating, blackElo: g.black?.rating,
          result: h.Result, timeClass: g.time_class, timeControl: g.time_control,
          date: g.end_time ? new Date(g.end_time * 1000).toISOString().slice(0, 10) : h.Date,
          opening: h.ECOUrl ? h.ECOUrl.split('/').pop().replace(/-/g, ' ') : '',
        });
      }
      if (games.length >= 60) break;
    }
    res.json({ games: games.slice(0, 60) });
  } catch (e) {
    res.status(e.status === 404 ? 404 : 502).json({ error: e.status === 404 ? 'user not found' : 'chess.com request failed' });
  }
});

app.get('/api/lichess/:user', async (req, res) => {
  const user = req.params.user;
  if (!USER_RE.test(user)) return res.status(400).json({ error: 'bad username' });
  try {
    const r = await fetch(`https://lichess.org/api/games/user/${user}?max=50&pgnInBody=true&opening=true`, {
      headers: { 'User-Agent': UA, Accept: 'application/x-chess-pgn' },
    });
    if (r.status === 404) return res.status(404).json({ error: 'user not found' });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const games = splitPgns(await r.text()).map((pgn) => {
      const h = pgnHeaders(pgn);
      return {
        source: 'lichess', url: h.Site, pgn, white: h.White, black: h.Black,
        whiteElo: h.WhiteElo, blackElo: h.BlackElo, result: h.Result,
        timeClass: h.Event, timeControl: h.TimeControl, date: (h.UTCDate || h.Date || '').replace(/\./g, '-'),
        opening: h.Opening || '',
      };
    });
    res.json({ games });
  } catch {
    res.status(502).json({ error: 'lichess request failed' });
  }
});

app.get('/api/lichess-game/:id', async (req, res) => {
  const id = req.params.id.slice(0, 8);
  if (!/^[A-Za-z0-9]{8}$/.test(id)) return res.status(400).json({ error: 'bad game id' });
  try {
    const r = await fetch(`https://lichess.org/game/export/${id}?pgnInBody=true&opening=true`, {
      headers: { 'User-Agent': UA, Accept: 'application/x-chess-pgn' },
    });
    if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ error: 'game not found' });
    res.json({ pgn: await r.text() });
  } catch {
    res.status(502).json({ error: 'lichess request failed' });
  }
});

// ---------------------------------------------------------------- online games
const games = new Map();
const accounts = setupAccounts(app, store, {
  createChallengeGame: (o, toUid) => { const r = newGame({ ...o, reservedFor: toUid }); return { id: r.g.id, token: r.token, color: r.color }; },
  isGameWaiting: (id) => games.get(id)?.status === 'waiting',
});
const rid = (n) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n);
const other = (c) => (c === 'w' ? 'b' : 'w');
const clean = (s, max = 24) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

function newGame({ base, inc, color, name, uid = null, reservedFor = null }) {
  let id;
  do id = rid(8); while (games.has(id));
  const creator = color === 'w' || color === 'b' ? color : Math.random() < 0.5 ? 'w' : 'b';
  const token = rid(24);
  const g = {
    id,
    chess: new Chess(),
    seats: { w: null, b: null },
    conns: new Set(),
    tc: { base: Math.max(0, Math.min(base | 0, 3 * 3600)) * 1000, inc: Math.max(0, Math.min(inc | 0, 60)) * 1000 },
    clocks: { w: 0, b: 0 },
    turnStart: null,
    reservedFor,
    status: 'waiting',
    result: null,
    reason: null,
    drawOffer: null,
    rematch: { w: false, b: false },
    chat: [],
    sans: [],
    lastMove: null,
    gameNo: 1,
    created: Date.now(),
    updated: Date.now(),
    timer: null,
  };
  g.clocks.w = g.clocks.b = g.tc.base;
  g.seats[creator] = { token, name: clean(name) || 'Guest-' + rid(3), ws: null, uid };
  games.set(id, g);
  return { g, token, color: creator };
}

const ticking = (g) => g.status === 'playing' && g.tc.base > 0 && g.sans.length >= 2;
function remaining(g, c) {
  let t = g.clocks[c];
  if (ticking(g) && g.chess.turn() === c) t -= Date.now() - g.turnStart;
  return Math.max(0, t);
}

function snapshot(g, you) {
  const over = g.status === 'over';
  let pgn = null;
  if (over) {
    const c = new Chess();
    try { for (const s of g.sans) c.move(s); } catch { /* ignore */ }
    c.setHeader('Event', 'Chess Lab online game');
    c.setHeader('Date', new Date(g.created).toISOString().slice(0, 10).replace(/-/g, '.'));
    c.setHeader('White', g.seats.w?.name || '?');
    c.setHeader('Black', g.seats.b?.name || '?');
    c.setHeader('Result', g.result || '*');
    if (g.tc.base) c.setHeader('TimeControl', `${g.tc.base / 1000}+${g.tc.inc / 1000}`);
    pgn = c.pgn();
  }
  const pl = (c) => (g.seats[c] ? { name: g.seats[c].name, online: !!g.seats[c].ws && g.seats[c].ws.readyState === 1 } : null);
  return {
    t: 'state', id: g.id, you, status: g.status, result: g.result, reason: g.reason,
    fen: g.chess.fen(), turn: g.chess.turn(), sans: g.sans, lastMove: g.lastMove,
    check: g.chess.inCheck(), tc: g.tc,
    clocks: g.tc.base ? { w: remaining(g, 'w'), b: remaining(g, 'b') } : null,
    ticking: ticking(g), players: { w: pl('w'), b: pl('b') },
    drawOffer: g.drawOffer, rematch: g.rematch, chat: g.chat.slice(-50), gameNo: g.gameNo, pgn,
  };
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(g) {
  g.updated = Date.now();
  for (const ws of g.conns) send(ws, snapshot(g, ws.meta?.color || 's'));
}

function finish(g, result, reason) {
  if (g.status === 'over') return;
  if (ticking(g)) g.clocks[g.chess.turn()] = remaining(g, g.chess.turn()); // freeze clocks
  g.status = 'over'; g.result = result; g.reason = reason; g.drawOffer = null;
  clearTimeout(g.timer);
  try { accounts.recordOnlineGame(g); } catch (e) { console.error('record failed', e); }
}
function scheduleFlag(g) {
  clearTimeout(g.timer);
  if (!ticking(g)) return;
  const turn = g.chess.turn();
  g.timer = setTimeout(() => {
    if (g.status !== 'playing' || g.chess.turn() !== turn || remaining(g, turn) > 0) return;
    // flag fell: draw if the opponent cannot possibly mate
    const opp = other(turn);
    const mine = g.chess.board().flat().filter((p) => p && p.color === opp && p.type !== 'k');
    const insufficient = mine.length === 0 || (mine.length === 1 && (mine[0].type === 'n' || mine[0].type === 'b'));
    g.clocks[turn] = 0;
    if (insufficient) finish(g, '1/2-1/2', 'timeout vs insufficient material');
    else finish(g, opp === 'w' ? '1-0' : '0-1', 'timeout');
    broadcast(g);
  }, remaining(g, turn) + 30);
}

function applyMove(g, color, m) {
  if (g.status !== 'playing' || g.chess.turn() !== color) return false;
  const now = Date.now();
  if (ticking(g)) {
    g.clocks[color] -= now - g.turnStart;
    if (g.clocks[color] <= 0) { g.clocks[color] = 0; finish(g, color === 'w' ? '0-1' : '1-0', 'timeout'); return true; }
    g.clocks[color] += g.tc.inc;
  }
  let mv;
  try { mv = g.chess.move({ from: String(m.from), to: String(m.to), promotion: m.promotion ? String(m.promotion) : undefined }); }
  catch { return false; }
  g.sans.push(mv.san);
  g.lastMove = { from: mv.from, to: mv.to };
  g.turnStart = now;
  g.drawOffer = null;
  if (g.chess.isCheckmate()) finish(g, color === 'w' ? '1-0' : '0-1', 'checkmate');
  else if (g.chess.isStalemate()) finish(g, '1/2-1/2', 'stalemate');
  else if (g.chess.isInsufficientMaterial()) finish(g, '1/2-1/2', 'insufficient material');
  else if (g.chess.isThreefoldRepetition()) finish(g, '1/2-1/2', 'threefold repetition');
  else if (g.chess.isDraw()) finish(g, '1/2-1/2', '50-move rule');
  else scheduleFlag(g);
  return true;
}

function startIfReady(g) {
  if (g.status === 'waiting' && g.seats.w && g.seats.b) { g.status = 'playing'; g.turnStart = Date.now(); }
}

function handle(ws, msg) {
  const { t } = msg;
  if (t === 'create') {
    const { g, token, color } = newGame({ ...msg, name: ws.user ? ws.user.username : msg.name, uid: ws.uid });
    g.seats[color].ws = ws; ws.meta = { gid: g.id, color }; g.conns.add(ws);
    send(ws, { t: 'joined', id: g.id, color, token });
    return broadcast(g);
  }
  if (t === 'join') {
    const g = games.get(String(msg.id));
    if (!g) return send(ws, { t: 'error', code: 'nogame', message: 'This game does not exist (or has expired).' });
    let color = null;
    for (const c of ['w', 'b']) if (g.seats[c] && msg.token && g.seats[c].token === msg.token) color = c;
    for (const c of ['w', 'b']) if (!color && ws.uid && g.seats[c]?.uid === ws.uid) color = c; // same account, new browser
    let token = color ? g.seats[color].token : undefined;
    if (!color) {
      const free = ['w', 'b'].find((c) => !g.seats[c]);
      const blocked = (g.reservedFor && g.reservedFor !== ws.uid) || (ws.uid && ['w', 'b'].some((c) => g.seats[c]?.uid === ws.uid));
      if (free && !blocked) {
        token = rid(24); color = free;
        g.seats[free] = { token, name: ws.user ? ws.user.username : clean(msg.name) || 'Guest-' + rid(3), ws: null, uid: ws.uid || null };
      }
    } else if (!ws.user && msg.name && clean(msg.name)) g.seats[color].name = clean(msg.name);
    if (color) g.seats[color].ws = ws;
    ws.meta = { gid: g.id, color: color || 's' };
    g.conns.add(ws);
    send(ws, { t: 'joined', id: g.id, color: color || 's', token: color ? token : null });
    startIfReady(g);
    return broadcast(g);
  }
  const g = games.get(ws.meta?.gid);
  if (!g) return;
  const color = ws.meta.color;
  if (color !== 'w' && color !== 'b') return; // spectators are read-only
  switch (t) {
    case 'move':
      if (!applyMove(g, color, msg)) send(ws, { t: 'illegal' });
      return broadcast(g);
    case 'resign':
      if (g.status === 'playing') { finish(g, color === 'w' ? '0-1' : '1-0', 'resignation'); broadcast(g); }
      return;
    case 'abort':
      if (g.status === 'waiting') {
        games.delete(g.id);
        for (const c of g.conns) send(c, { t: 'error', code: 'nogame', message: 'Game cancelled.' });
        return;
      }
      if (g.status === 'playing' && g.sans.length < 2) { finish(g, null, 'aborted'); broadcast(g); }
      return;
    case 'draw-offer':
      if (g.status === 'playing' && g.sans.length >= 2) { g.drawOffer = color; broadcast(g); }
      return;
    case 'draw-accept':
      if (g.status === 'playing' && g.drawOffer && g.drawOffer !== color) { finish(g, '1/2-1/2', 'agreement'); broadcast(g); }
      return;
    case 'draw-decline':
      if (g.drawOffer && g.drawOffer !== color) { g.drawOffer = null; broadcast(g); }
      return;
    case 'rematch':
      if (g.status !== 'over') return;
      g.rematch[color] = true;
      if (g.rematch.w && g.rematch.b) {
        const s = g.seats; g.seats = { w: s.b, b: s.w };
        for (const c of g.conns) if (c.meta.color === 'w' || c.meta.color === 'b') c.meta.color = other(c.meta.color);
        g.chess = new Chess(); g.sans = []; g.lastMove = null; g.result = null; g.reason = null;
        g.clocks.w = g.clocks.b = g.tc.base; g.drawOffer = null; g.rematch = { w: false, b: false };
        g.status = 'playing'; g.turnStart = Date.now(); g.gameNo++;
        for (const c of g.conns) send(c, { t: 'joined', id: g.id, color: c.meta.color, swap: true });
      }
      return broadcast(g);
    case 'chat': {
      const text = clean(msg.text, 200);
      if (!text) return;
      g.chat.push({ c: color, name: g.seats[color].name, text, ts: Date.now() });
      if (g.chat.length > 100) g.chat.shift();
      return broadcast(g);
    }
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 4096,
  verifyClient: ({ origin, req }) => { try { return !origin || new URL(origin).host === req.headers.host; } catch { return false; } },
});
wss.on('connection', (ws, req) => {
  ws.user = accounts.userFromCookieHeader(req.headers.cookie);
  ws.uid = ws.user ? ws.user.username.toLowerCase() : null;
  ws.isAlive = true; ws.meta = null; ws.hits = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    if (++ws.hits > 40) return; // crude flood control, reset every second
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handle(ws, msg); } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => {
    const g = games.get(ws.meta?.gid);
    if (!g) return;
    g.conns.delete(ws);
    const c = ws.meta.color;
    if ((c === 'w' || c === 'b') && g.seats[c]?.ws === ws) { g.seats[c].ws = null; broadcast(g); }
  });
});
setInterval(() => { for (const ws of wss.clients) ws.hits = 0; }, 1000);
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 25000);
setInterval(() => {
  const now = Date.now();
  for (const [id, g] of games) {
    const age = now - g.updated;
    if (age > 24 * 3600e3 || (g.status === 'over' && !g.conns.size && age > 3600e3) || (g.status === 'waiting' && !g.conns.size && age > 3600e3)) {
      clearTimeout(g.timer); games.delete(id);
    }
  }
}, 10 * 60e3);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Chess Lab running:  http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  Same Wi-Fi friends: ${u}`);
  console.log('  Over the internet: run a tunnel (see README) or deploy to a Node host.\n');
});
