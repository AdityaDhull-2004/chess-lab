// Play a friend over a shareable link (server relays moves over WebSocket and enforces the rules + clocks).
import { Chess } from 'chess.js';
import { h, clear, toast, copyText, store, fmtClock, confirmBox } from './dom.js';
import { BoardView, arrow } from './board.js';
import { Premoves, createPreBadge } from './premoves.js';
import { app, saveGame } from './app.js';
import { sound } from './sound.js';
import { PlayerBar, MoveList, capturedFrom, resultText } from './parts.js';
import { START_FEN } from '../core/util.js';

const TCS = [
  { label: '1 | 0', base: 60, inc: 0 }, { label: '3 | 0', base: 180, inc: 0 }, { label: '3 | 2', base: 180, inc: 2 },
  { label: '5 | 0', base: 300, inc: 0 }, { label: '10 | 0', base: 600, inc: 0 }, { label: '15 | 10', base: 900, inc: 10 }, { label: '∞', base: 0, inc: 0 },
];

class Conn {
  constructor(onMsg, onStatus) { this.onMsg = onMsg; this.onStatus = onStatus; this.queue = []; this.ws = null; this.tries = 0; this.closed = false; this.hello = null; }
  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => { this.tries = 0; this.onStatus('open'); if (this.hello) ws.send(JSON.stringify(this.hello())); this.queue.splice(0).forEach((m) => ws.send(m)); };
    ws.onmessage = (e) => { try { this.onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      this.onStatus('closed');
      if (!this.closed) setTimeout(() => this.connect(), Math.min(8000, 500 * 2 ** this.tries++));
    };
  }
  send(obj) {
    const m = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === 1) this.ws.send(m); else this.queue.push(m);
  }
  close() { this.closed = true; this.ws?.close(); }
}

export function createOnlineView(root) {
  let G = null;           // latest server snapshot
  let gameId = null;
  let fens = [START_FEN], moves = [];
  let view = null;        // browsing ply (null = live)
  let conn = null;
  let lanUrl = null;
  let clockBase = null;
  const saved = new Set();
  const name = () => store.get('name', '');

  const topBar = new PlayerBar(), botBar = new PlayerBar();
  const boardEl = h('div.board-el');
  const boxEl = h('div.boardbox', boardEl);
  const bw = h('div.bw', boxEl);
  const boardCol = h('div.board-col', bw);
  const side = h('aside.side');
  root.append(h('div.layout', boardCol, h('div.sidecol', topBar.el, side, botBar.el)));
  const board = new BoardView(boardEl, { onMove: onMove });
  const pre = new Premoves();
  let pending = null; // my move sent to the server but not yet confirmed
  const cancelPre = () => { pre.clear(); showPosition(); };
  const preBadge = createPreBadge(boxEl, pre, cancelPre);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && pre.length && root.classList.contains('active')) cancelPre(); });
  const moveList = new MoveList((ply) => { view = ply === fens.length - 1 ? null : ply; showPosition(); });
  let chatBox = null, chatIn = null;

  fetch('api/info').then((r) => r.json()).then((j) => { lanUrl = j.lan?.[0] || null; if (G?.status === 'waiting') renderSide(); }).catch(() => {});

  // ---------------------------------------------------------------- connection
  function ensureConn() {
    if (conn) return conn;
    conn = new Conn(onMsg, () => {});
    conn.hello = () => (gameId ? { t: 'join', id: gameId, token: sessionStorage.getItem('chesslab.tok.' + gameId) || undefined, name: name() } : null);
    conn.connect();
    return conn;
  }

  function onMsg(m) {
    if (m.t === 'joined') {
      gameId = m.id;
      if (m.token) sessionStorage.setItem('chesslab.tok.' + m.id, m.token);
      if (location.pathname !== '/g/' + m.id) history.pushState({}, '', '/g/' + m.id);
    } else if (m.t === 'state') {
      applyState(m);
    } else if (m.t === 'error') {
      if (m.code === 'nogame') { G = null; gameId = null; if (location.pathname.startsWith('/g/')) history.pushState({}, '', '/'); renderLobby(m.message); resetBoard(); }
      else toast(m.message || 'Error', 'err');
    } else if (m.t === 'illegal') { showPosition(); }
  }

  function applyState(s) {
    const prevLen = G?.sans?.length ?? 0;
    const sameGame = G && G.id === s.id && G.gameNo === s.gameNo;
    G = s;
    pending = null;
    // rebuild positions from the move list
    const c = new Chess();
    fens = [START_FEN]; moves = [];
    for (const san of s.sans) { try { const mv = c.move(san); fens.push(c.fen()); moves.push({ from: mv.from, to: mv.to }); } catch { break; } }
    if (!sameGame) { view = null; pre.clear(); saved.delete(s.id + ':' + s.gameNo); board.setOrientation(s.you === 'b' ? 'black' : 'white'); }
    else if (s.you !== 'w' && s.you !== 'b') { /* spectator keeps orientation */ }
    if (s.sans.length > prevLen && sameGame) {
      const last = moves.length - 1;
      const cc = new Chess(fens[last]); const mv = cc.move(s.sans[last]); sound.forMove(mv, cc);
    }
    if (s.status === 'over' && s.pgn && s.sans.length && !saved.has(s.id + ':' + s.gameNo)) {
      saved.add(s.id + ':' + s.gameNo);
      saveGame({ pgn: s.pgn, kind: 'online', white: s.players.w?.name, black: s.players.b?.name, result: s.result, date: new Date().toISOString().slice(0, 10), color: s.you });
      sound.end();
    }
    if (s.drawOffer && s.drawOffer !== s.you && s.you !== 's' && sameGame) sound.notify();
    if (s.status !== 'playing') pre.clear();
    else if (s.turn === s.you && pre.length) {
      const pm = pre.next(s.fen);
      if (pm) { conn.send({ t: 'move', from: pm.from, to: pm.to, promotion: pm.promotion }); pending = pm; }
    }
    clockBase = s.clocks ? { ...s.clocks, at: performance.now(), turn: s.turn, ticking: s.ticking && s.status === 'playing' } : null;
    renderAll();
  }

  // ---------------------------------------------------------------- actions
  function onMove(m) {
    if (!G || G.status !== 'playing' || view !== null || (G.you !== 'w' && G.you !== 'b')) { showPosition(); return; }
    if (G.turn === G.you && !pending && !pre.length) {
      conn.send({ t: 'move', from: m.from, to: m.to, promotion: m.promotion });
      pending = { from: m.from, to: m.to, promotion: m.promotion };
    } else pre.tryAdd(G.fen, G.you, pending ? [pending] : [], m);
    showPosition();
  }
  const act = (t) => conn.send({ t });

  async function create(opts) {
    ensureConn();
    const nm = name();
    conn.hello = () => (gameId ? { t: 'join', id: gameId, token: sessionStorage.getItem('chesslab.tok.' + gameId) || undefined, name: nm } : null);
    conn.send({ t: 'create', base: opts.base, inc: opts.inc, color: opts.color, name: nm });
  }
  function join(id) {
    gameId = id;
    ensureConn();
    if (conn.ws?.readyState === 1) conn.send({ t: 'join', id, token: sessionStorage.getItem('chesslab.tok.' + id) || undefined, name: name() });
    renderSide(true);
  }

  // ---------------------------------------------------------------- rendering
  function resetBoard() {
    board.setOrientation('white'); board.update(new Chess(), { interactive: null });
    topBar.setPlayer({ name: 'Opponent', avatar: '👤' }); botBar.setPlayer({ name: 'You', avatar: '🙂' });
    topBar.setCaptured([], 'w', 0); botBar.setCaptured([], 'b', 0); topBar.setClock(null); botBar.setClock(null);
  }

  function renderAll() { showPosition(); renderBars(); renderSide(); }

  function showPosition() {
    if (!G) return;
    const last = fens.length - 1, ply = view ?? last;
    let c = new Chess(fens[ply]);
    let lastMove = ply > 0 ? moves[ply - 1] : null, shapes = [];
    const you = G.you === 'w' ? 'white' : G.you === 'b' ? 'black' : null;
    if (you && G.status === 'playing' && ply === last) {
      const v = pre.position(G.fen, G.you, pending ? [pending] : []);
      if (v) { c = v; if (pre.length || pending) lastMove = null; shapes = pre.q.map((m) => arrow(m.from + m.to, 'paleBlue', 8)); } else pre.clear();
    }
    board.update(c, { lastMove, interactive: G.status === 'playing' && ply === last ? you : null, shapes });
    preBadge.refresh();
    moveList.render(G.sans, ply);
  }

  function renderBars() {
    if (!G) return;
    const bottomColor = board.orientation === 'black' ? 'b' : 'w';
    const topColor = bottomColor === 'w' ? 'b' : 'w';
    const info = (c) => { const p = G.players[c]; return { name: p ? p.name : 'Waiting…', sub: '', avatar: p ? '' : '?', online: p ? p.online : null }; };
    botBar.setPlayer(info(bottomColor)); topBar.setPlayer(info(topColor));
    const cap = capturedFrom(fens[view ?? fens.length - 1]);
    const capsOf = (c) => (c === 'w' ? cap.byWhite : cap.byBlack);
    const lead = (c) => (c === 'w' ? cap.diff : -cap.diff);
    botBar.setCaptured(capsOf(bottomColor), topColor, Math.max(0, lead(bottomColor)));
    topBar.setCaptured(capsOf(topColor), bottomColor, Math.max(0, lead(topColor)));
    paintClocks();
  }

  function paintClocks() {
    if (!G) return;
    const bottomColor = board.orientation === 'black' ? 'b' : 'w';
    const topColor = bottomColor === 'w' ? 'b' : 'w';
    if (!clockBase) { botBar.setClock(null); topBar.setClock(null); return; }
    const now = performance.now();
    const rem = (c) => Math.max(0, clockBase[c] - (clockBase.ticking && clockBase.turn === c ? now - clockBase.at : 0));
    const live = G.status === 'playing';
    botBar.setClock(rem(bottomColor), live && G.turn === bottomColor, true);
    topBar.setClock(rem(topColor), live && G.turn === topColor, true);
  }
  setInterval(() => { if (G && clockBase && G.status === 'playing') paintClocks(); }, 100);

  function shareLink() {
    const base = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && lanUrl ? lanUrl : location.origin;
    return `${base}/g/${gameId}`;
  }

  function renderSide(connecting = false) {
    clear(side); chatBox = null;
    if (!G) { if (connecting) side.append(h('div.card', h('p', 'Connecting to game…'))); else renderLobby(); return; }
    const you = G.you;
    const playing = G.status === 'playing', over = G.status === 'over', waiting = G.status === 'waiting';
    const spectator = you !== 'w' && you !== 'b';
    const btn = (label, fn, cls = '', dis = false) => h('button.btn', { class: cls, onclick: fn, disabled: dis }, label);
    const parts = [];

    if (waiting) {
      const link = shareLink();
      const isLocal = /^(localhost|127\.0\.0\.1)/.test(new URL(link).hostname) || /^(10\.|192\.168\.|172\.)/.test(new URL(link).hostname);
      parts.push(h('div.card.share',
        h('h3', 'Invite a friend'),
        h('p.muted', 'Send this link. The first person who opens it plays the other colour.'),
        h('div.linkrow', h('input', { readonly: true, value: link, onfocus: (e) => e.target.select() }), btn('Copy', () => copyText(link), 'primary')),
        navigator.share ? btn('Share…', () => navigator.share({ title: 'Chess game', url: link }).catch(() => {})) : null,
        isLocal ? h('p.muted.small', 'This link works for devices on your Wi-Fi. For friends anywhere on the internet, run a tunnel (e.g. cloudflared / ngrok) or deploy the app — see the README.') : null,
        h('div.waiting', h('span.spin'), ' Waiting for your opponent to join…'),
        btn('Cancel game', () => { act('abort'); }, 'danger')));
    }

    if (!waiting) {
      const banner = over
        ? h('div.banner', { class: G.result === '1/2-1/2' || !G.result ? 'draw' : spectator ? 'draw' : (G.result === '1-0') === (you === 'w') ? 'win' : 'loss' },
          h('b', G.result ? (spectator ? resultText(G.result).split(' · ')[0] : G.result === '1/2-1/2' ? 'Draw' : (G.result === '1-0') === (you === 'w') ? 'You won!' : 'You lost') : 'Game aborted'), G.reason ? ` · ${G.reason}` : '')
        : h('div.status', spectator ? 'You are watching' : G.turn === you ? 'Your move' : "Opponent's move");
      const offer = playing && G.drawOffer && G.drawOffer !== you && !spectator
        ? h('div.offer', 'Opponent offers a draw ', btn('Accept', () => act('draw-accept'), 'primary'), btn('Decline', () => act('draw-decline')))
        : playing && G.drawOffer === you ? h('div.muted.small', 'Draw offer sent…') : null;
      const actions = spectator ? null : over
        ? h('div.btnrow', G.pgn ? btn('🔍 Analyse game', () => app.openAnalysis({ pgn: G.pgn, orientation: you === 'b' ? 'black' : 'white', review: true }), 'primary') : null,
          btn(G.rematch[you] ? 'Rematch requested…' : G.rematch[you === 'w' ? 'b' : 'w'] ? '↻ Accept rematch' : '↻ Rematch', () => act('rematch'), G.rematch[you === 'w' ? 'b' : 'w'] ? 'primary' : '', G.rematch[you]),
          btn('New game', () => { G = null; gameId = null; history.pushState({}, '', '/'); resetBoard(); renderSide(); }))
        : h('div.btnrow', btn(G.sans.length < 2 ? '✕ Abort' : '⚑ Resign', () => (G.sans.length < 2 ? act('abort') : confirmBox('Resign?', 'Do you want to resign this game?', 'Resign').then((y) => y && act('resign'))), 'danger'),
          btn('½ Offer draw', () => act('draw-offer'), '', G.sans.length < 2 || G.drawOffer === you), btn('⇅ Flip', () => { board.flip(); renderBars(); }));
      chatIn = h('input', { type: 'text', placeholder: 'Say something nice…', maxlength: 200, onkeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) { conn.send({ t: 'chat', text: e.target.value }); e.target.value = ''; } } });
      chatBox = h('div.chat', h('div.msgs', G.chat.map((m) => h('div.msg', { class: m.c === you ? 'me' : '' }, h('b', m.name + ': '), m.text))), spectator ? null : chatIn);
      parts.push(h('div.card.gamecard',
        h('div.muted.small', `${G.tc.base ? `${G.tc.base / 60000}${G.tc.inc ? ' | ' + G.tc.inc / 1000 : ' min'}` : 'Unlimited'} · game ${G.gameNo}`),
        banner, offer, moveList.el, actions, chatBox));
      queueMicrotask(() => { const ms = chatBox?.querySelector('.msgs'); if (ms) ms.scrollTop = ms.scrollHeight; });
    }
    side.append(...parts);
  }

  function renderLobby(message) {
    clear(side);
    const prefs = store.get('onlinePrefs', { tc: 3, color: 'r' });
    const nameIn = h('input', { type: 'text', value: name(), placeholder: 'Your name', maxlength: 24, oninput: (e) => store.set('name', e.target.value.trim()) });
    const signedIn = !!app.user;
    const tcSeg = h('div.seg.wrap'), colSeg = h('div.seg');
    const draw = () => {
      clear(tcSeg); TCS.forEach((t, i) => tcSeg.append(h('button', { class: i === prefs.tc ? 'on' : '', onclick: () => { prefs.tc = i; draw(); } }, t.label)));
      clear(colSeg); [['w', '♔ White'], ['r', '🎲 Random'], ['b', '♚ Black']].forEach(([v, l]) => colSeg.append(h('button', { class: prefs.color === v ? 'on' : '', onclick: () => { prefs.color = v; draw(); } }, l)));
      store.set('onlinePrefs', prefs);
    };
    draw();
    const codeIn = h('input', { type: 'text', placeholder: 'Paste a game link or code' });
    side.append(h('div.card.setup',
      message ? h('div.banner.loss', message) : null,
      h('h2', 'Play a friend'),
      h('p.muted', 'Create a game, send the link, and play in real time. No account needed.'),
      signedIn ? h('div.muted', ['Playing as ', h('b', app.user.username), ' — this game will be saved to your history.']) : h('div.field', h('label', 'Your name'), nameIn),
      h('div.field', h('label', 'Time control (minutes | increment)'), tcSeg),
      h('div.field', h('label', 'Play as'), colSeg),
      h('button.btn.primary.big', { onclick: () => { if (!app.user && !name()) { const g = 'Guest' + Math.floor(Math.random() * 900 + 100); store.set('name', g); } const t = TCS[prefs.tc]; create({ base: t.base, inc: t.inc, color: prefs.color }); } }, 'Create game & get link'),
      h('hr'),
      h('div.field', h('label', 'Have a link?'), h('div.linkrow', codeIn, h('button.btn', { onclick: () => { const m = codeIn.value.match(/([A-Za-z0-9]{8})\s*$/); if (m) join(m[1]); else toast('That doesn’t look like a game link', 'err'); } }, 'Join')))));
  }

  // ---------------------------------------------------------------- keyboard + lifecycle
  addEventListener('keydown', (e) => {
    if (!G || !root.classList.contains('active') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const last = fens.length - 1, cur = view ?? last;
    if (e.key === 'ArrowLeft' && cur > 0) { view = cur - 1; showPosition(); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && cur < last) { view = cur + 1 === last ? null : cur + 1; showPosition(); e.preventDefault(); }
  });
  addEventListener('popstate', () => { if (!location.pathname.startsWith('/g/') && G) { /* stay in game view; user navigated away */ } });

  resetBoard();
  renderLobby();
  return {
    activate() { board.cg.redrawAll(); },
    join,
    get gameId() { return gameId; },
  };
}
