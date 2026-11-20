// Play against Stockfish-powered bots.
import { Chess } from 'chess.js';
import { h, clear, confirmBox, toast, store } from './dom.js';
import { BoardView, arrow } from './board.js';
import { Premoves, createPreBadge } from './premoves.js';
import { app, saveGame } from './app.js';
import { BOTS, botForElo, chooseBotMove, botDelay, botProfile } from '../core/bots.js';
import { sound } from './sound.js';
import { lineWp, forSide, pvToSan, uciOf, START_FEN, sleep, fmtScore } from '../core/util.js';
import { EvalBar, PlayerBar, MoveList, capturedFrom, resultText } from './parts.js';

const TIMES = [
  { label: 'No clock', base: 0, inc: 0 },
  { label: '1 min', base: 60, inc: 0 },
  { label: '3 min', base: 180, inc: 0 },
  { label: '3 | 2', base: 180, inc: 2 },
  { label: '5 min', base: 300, inc: 0 },
  { label: '10 min', base: 600, inc: 0 },
  { label: '15 | 10', base: 900, inc: 10 },
  { label: '30 min', base: 1800, inc: 0 },
];

const GREET = ['Good luck!', "Let's play!", 'Have fun!', 'May the best player win.'];
const WIN = ['Good game! Want to go again?', 'Thanks for the game!', 'Better luck next time.'];
const LOSE = ['Well played!', 'You got me this time.', 'Nicely done!'];
const DRAW = ['A fair result.', 'Honours even.'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function createPlayView(root) {
  const prefs = store.get('playPrefs', { elo: 900, color: 'w', time: 0, eval: false, hints: true, takeback: true });
  let S = null; // current game
  let board, evalBar, topBar, botBar, moveList;
  let clockTimer = null;

  // ---------------------------------------------------------------- layout
  evalBar = new EvalBar();
  topBar = new PlayerBar();
  botBar = new PlayerBar();
  const boardEl = h('div.board-el');
  const boardBox = h('div.boardbox', boardEl);
  const bw = h('div.bw', evalBar.el, boardBox);
  const pre = new Premoves();
  const preBadge = createPreBadge(boardBox, pre, () => { pre.clear(); showPosition(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && pre.length && root.classList.contains('active')) { pre.clear(); showPosition(); } });
  const boardCol = h('div.board-col', bw);
  const side = h('aside.side');
  root.append(h('div.layout', boardCol, h('div.sidecol', topBar.el, side, botBar.el)));
  evalBar.el.style.display = 'none';

  board = new BoardView(boardEl, { onMove: onUserMove });
  moveList = new MoveList((ply) => { if (S) { S.view = ply === S.fens.length - 1 ? null : ply; showPosition(); } });
  board.update(new Chess(), { interactive: null });

  // ---------------------------------------------------------------- setup card
  function renderSetup() {
    clear(side);
    const sel = { elo: prefs.elo };
    const gridBtns = BOTS.map((b) => h('button.botcard', { dataset: { elo: b.elo }, onclick: () => setElo(b.elo) },
      h('span.em', b.emoji), h('span.bn', b.name), h('span.be', b.elo)));
    const slider = h('input', { type: 'range', min: 250, max: 3200, step: 50, value: prefs.elo, oninput: (e) => setElo(+e.target.value) });
    const info = h('div.botinfo');
    function setElo(e) {
      sel.elo = prefs.elo = +e; slider.value = e;
      const b = botForElo(e), p = botProfile(e);
      gridBtns.forEach((g) => g.classList.toggle('on', +g.dataset.elo === b.elo && Math.abs(b.elo - e) < 75));
      const how = p.mode === 'custom' ? `Human-like: searches about ${p.depth} half-move${p.depth > 1 ? 's' : ''} ahead and sometimes plays a plausible second-best move — it can miss deeper tactics.` : 'Stockfish at full strength.';
      clear(info);
      info.append(h('div.big', `${b.emoji} ${b.name} ${Math.abs(b.elo - e) < 75 ? '' : '≈'} ${e}`), h('div.muted', b.blurb), h('div.muted.small', how));
    }
    const colorSeg = seg([['w', '♔ White'], ['r', '🎲 Random'], ['b', '♚ Black']], prefs.color, (v) => (prefs.color = v));
    const timeSel = h('select', { onchange: (e) => (prefs.time = +e.target.value) }, TIMES.map((t, i) => h('option', { value: i, selected: i === prefs.time }, t.label)));
    const chk = (key, label) => h('label.chk', h('input', { type: 'checkbox', checked: prefs[key], onchange: (e) => (prefs[key] = e.target.checked) }), label);
    side.append(h('div.card.setup',
      h('h2', 'Play a bot'),
      h('div.botgrid', gridBtns),
      h('div.sliderrow', h('span.muted.small', 'Custom rating'), slider),
      info,
      h('div.field', h('label', 'Play as'), colorSeg),
      h('div.field', h('label', 'Time'), timeSel),
      h('div.checks', chk('eval', 'Show evaluation bar'), chk('hints', 'Allow hints'), chk('takeback', 'Allow takebacks')),
      h('button.btn.primary.big', { onclick: startGame }, 'Start game'),
      h('p.muted.small', 'Bots run Stockfish entirely in your browser — nothing is sent anywhere. Ratings are approximate and not comparable to chess.com or Lichess.')));
    setElo(prefs.elo);
  }

  function seg(options, value, onchange) {
    const el = h('div.seg');
    const draw = (v) => { clear(el); options.forEach(([val, lab]) => el.append(h('button', { class: val === v ? 'on' : '', onclick: () => { onchange(val); draw(val); } }, lab))); };
    draw(value);
    return el;
  }

  // ---------------------------------------------------------------- game lifecycle
  async function startGame() {
    store.set('playPrefs', prefs);
    sound.start();
    pre.clear();
    const color = prefs.color === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : prefs.color;
    const bot = botForElo(prefs.elo);
    const tc = TIMES[prefs.time];
    S = {
      chess: new Chess(), player: color, bot: { ...bot, elo: prefs.elo }, tc,
      clock: tc.base ? { w: tc.base * 1000, b: tc.base * 1000 } : null, lastTick: performance.now(),
      fens: [START_FEN], moves: [], sans: [], ucis: [], over: false, result: null, reason: null,
      view: null, token: 0, thinking: false, opts: { ...prefs }, shapes: [], say: pick(GREET), pgn: null,
    };
    S.chess.setHeader('Event', 'Chess Lab vs bot');
    S.chess.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
    S.chess.setHeader('White', color === 'w' ? 'You' : `${S.bot.name} (bot)`);
    S.chess.setHeader('Black', color === 'b' ? 'You' : `${S.bot.name} (bot)`);
    S.chess.setHeader(color === 'w' ? 'BlackElo' : 'WhiteElo', String(S.bot.elo));
    if (tc.base) S.chess.setHeader('TimeControl', `${tc.base}${tc.inc ? '+' + tc.inc : ''}`);
    board.setOrientation(color === 'w' ? 'white' : 'black');
    evalBar.flip(color === 'b');
    evalBar.el.style.display = S.opts.eval ? '' : 'none';
    evalBar.set(0.5, '0.00');
    const eng = app.botEngine();
    app.setStatus('Starting engine…');
    await eng.newGame();
    app.setStatus('');
    renderGameCard();
    showPosition();
    startClock();
    if (S.chess.turn() !== S.player) botTurn(); else refreshAssist();
  }

  function startClock() {
    clearInterval(clockTimer);
    if (!S.clock) { renderBars(); return; }
    S.lastTick = performance.now();
    clockTimer = setInterval(() => {
      if (!S || S.over) return;
      const now = performance.now(), dt = now - S.lastTick; S.lastTick = now;
      const side = S.chess.turn();
      S.clock[side] -= dt;
      if (S.clock[side] <= 0) {
        S.clock[side] = 0;
        // timeout (a draw if the opponent has only a king / lone minor)
        endGame(side === 'w' ? '0-1' : '1-0', 'on time');
      }
      renderBars();
    }, 100);
  }

  function gameOverInfo(c) {
    if (c.isCheckmate()) return { result: c.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
    if (c.isStalemate()) return { result: '1/2-1/2', reason: 'stalemate' };
    if (c.isInsufficientMaterial()) return { result: '1/2-1/2', reason: 'insufficient material' };
    if (c.isThreefoldRepetition()) return { result: '1/2-1/2', reason: 'threefold repetition' };
    if (c.isDraw()) return { result: '1/2-1/2', reason: '50-move rule' };
    return null;
  }

  function endGame(result, reason) {
    if (S.over) return;
    pre.clear();
    S.over = true; S.result = result; S.reason = reason; S.token++; S.thinking = false;
    clearInterval(clockTimer);
    app.botEngine().stop();
    S.chess.setHeader('Result', result);
    S.pgn = S.chess.pgn();
    const mine = (result === '1-0' && S.player === 'w') || (result === '0-1' && S.player === 'b');
    S.say = result === '1/2-1/2' ? pick(DRAW) : mine ? pick(LOSE) : pick(WIN);
    sound.end();
    if (S.sans.length) saveGame({ pgn: S.pgn, kind: 'bot', white: S.chess.getHeaders().White, black: S.chess.getHeaders().Black, result, date: new Date().toISOString().slice(0, 10), opponent: `${S.bot.name} ${S.bot.elo}`, color: S.player });
    renderGameCard(); renderBars(); showPosition();
  }

  // ---------------------------------------------------------------- moves
  function playMove(m, who) {
    let mv;
    try { mv = S.chess.move(m); } catch { return false; }
    S.sans.push(mv.san); S.ucis.push(uciOf(mv)); S.fens.push(S.chess.fen()); S.moves.push({ from: mv.from, to: mv.to });
    S.view = null; S.shapes = [];
    sound.forMove(mv, S.chess);
    if (S.clock && S.tc.inc) S.clock[mv.color] += S.tc.inc * 1000;
    const over = gameOverInfo(S.chess);
    if (over) { endGame(over.result, over.reason); return true; }
    showPosition(); renderGameCard(); renderBars();
    if (who === 'player') botTurn();
    else {
      const pm = pre.length ? pre.next(S.chess.fen()) : null;
      if (pm) { playMove(pm, 'player'); return true; }
      refreshAssist();
    }
    return true;
  }

  function onUserMove(m) {
    if (!S || S.over || S.view !== null) { showPosition(); return; }
    if (S.chess.turn() !== S.player) { pre.tryAdd(S.chess.fen(), S.player, [], m); showPosition(); return; }
    if (!playMove(m, 'player')) showPosition();
  }

  async function botTurn() {
    if (!S || S.over) return;
    const tok = ++S.token;
    S.thinking = true; renderGameCard();
    const t0 = performance.now();
    let r = null;
    try {
      r = await chooseBotMove({ engine: app.botEngine(), fen: S.chess.fen(), startFen: START_FEN, uciMoves: S.ucis, elo: S.bot.elo });
    } catch (e) { console.error('bot error', e); }
    if (tok !== S.token || S.over) return;
    if (!r || !r.uci) { // never leave the player hanging
      const ms = S.chess.moves({ verbose: true });
      const m = ms[Math.floor(Math.random() * ms.length)];
      r = { uci: uciOf(m), source: 'fallback' };
    }
    let wait = botDelay(S.bot.elo, r.source) - (performance.now() - t0);
    if (S.clock) wait = Math.min(wait, Math.max(0, S.clock[S.chess.turn()] - 300));
    if (wait > 0) await sleep(wait);
    if (tok !== S.token || S.over) return;
    S.thinking = false;
    playMove({ from: r.uci.slice(0, 2), to: r.uci.slice(2, 4), promotion: r.uci[4] }, 'bot');
  }

  /** Optional evaluation bar refresh after the bot has moved. */
  async function refreshAssist() {
    if (!S || S.over || !S.opts.eval) return;
    const tok = S.token;
    const eng = app.botEngine();
    eng.setOption('UCI_LimitStrength', 'false');
    const r = await eng.go({ fen: S.chess.fen(), depth: 12 });
    if (tok !== S.token || !r.lines[0]) return;
    evalBar.set(lineWp(r.lines[0]), fmtScore(r.lines[0]));
  }

  async function hint() {
    if (!S || S.over || S.chess.turn() !== S.player || S.view !== null) return;
    const eng = app.botEngine();
    eng.setOption('UCI_LimitStrength', 'false');
    toast('Thinking…');
    const r = await eng.go({ fen: S.chess.fen(), depth: 16, multipv: 1 });
    if (!S || S.over || !r.best) return;
    S.shapes = [arrow(r.best, 'green')];
    const san = pvToSan(S.chess.fen(), r.lines[0].pv, 1)[0]?.san;
    toast(`Hint: ${san}`, 'ok');
    showPosition();
  }

  async function takeback() {
    if (!S || S.over || !S.sans.length) return;
    S.token++; S.thinking = false; pre.clear();
    app.botEngine().stop();
    const n = S.chess.turn() === S.player ? 2 : 1;
    for (let i = 0; i < n && S.sans.length; i++) { S.chess.undo(); S.sans.pop(); S.ucis.pop(); S.fens.pop(); S.moves.pop(); }
    S.view = null; S.shapes = [];
    showPosition(); renderGameCard(); renderBars();
    if (S.chess.turn() !== S.player) botTurn(); else refreshAssist();
  }

  async function offerDraw() {
    if (!S || S.over || S.sans.length < 2) return toast('Play a few more moves first');
    const eng = app.botEngine();
    eng.setOption('UCI_LimitStrength', 'false');
    const r = await eng.go({ fen: S.chess.fen(), depth: 12 });
    const botColor = S.player === 'w' ? 'b' : 'w';
    const wp = r.lines[0] ? forSide(lineWp(r.lines[0]), botColor) : 0.5;
    if (wp <= 0.42) { toast(`${S.bot.name} accepts the draw`, 'ok'); endGame('1/2-1/2', 'agreement'); }
    else toast(`${S.bot.name} declines — "I'd like to play on."`);
  }

  async function resign() {
    if (!S || S.over) return;
    if (await confirmBox('Resign?', 'Do you want to resign this game?', 'Resign')) endGame(S.player === 'w' ? '0-1' : '1-0', 'resignation');
  }

  // ---------------------------------------------------------------- rendering
  function showPosition() {
    if (!S) return;
    const last = S.fens.length - 1;
    const ply = S.view ?? last;
    let c = ply === last ? S.chess : new Chess(S.fens[ply]);
    const live = ply === last && !S.over;
    let lastMove = ply > 0 ? S.moves[ply - 1] : null;
    let shapes = ply === last ? S.shapes : [];
    if (live && S.chess.turn() !== S.player) {
      const v = pre.position(S.chess.fen(), S.player);
      if (v) { c = v; if (pre.length) lastMove = null; shapes = pre.q.map((m) => arrow(m.from + m.to, 'paleBlue', 8)); } else pre.clear();
    }
    board.update(c, { lastMove, interactive: live ? (S.player === 'w' ? 'white' : 'black') : null, shapes });
    preBadge.refresh();
    moveList.render(S.sans, ply);
    renderBars();
  }

  function renderBars() {
    if (!S) return;
    const botColor = S.player === 'w' ? 'b' : 'w';
    const last = S.fens[S.view ?? S.fens.length - 1];
    const cap = capturedFrom(last);
    const bot = { name: S.bot.name, sub: String(S.bot.elo), avatar: S.bot.emoji };
    const me = { name: 'You', sub: '', avatar: '🙂' };
    // bottom = the human
    botBar.setPlayer(me); topBar.setPlayer(bot);
    const mineCaps = S.player === 'w' ? cap.byWhite : cap.byBlack, theirCaps = S.player === 'w' ? cap.byBlack : cap.byWhite;
    const lead = S.player === 'w' ? cap.diff : -cap.diff;
    botBar.setCaptured(mineCaps, botColor, lead > 0 ? lead : 0);
    topBar.setCaptured(theirCaps, S.player, lead < 0 ? -lead : 0);
    const turn = S.chess.turn();
    botBar.setClock(S.clock ? S.clock[S.player] : null, !S.over && turn === S.player, true);
    topBar.setClock(S.clock ? S.clock[botColor] : null, !S.over && turn === botColor, false);
  }

  function renderGameCard() {
    if (!S) return;
    clear(side);
    const status = S.over ? h('div.banner', { class: S.result === '1/2-1/2' ? 'draw' : (S.result === '1-0') === (S.player === 'w') ? 'win' : 'loss' },
      h('b', S.result === '1/2-1/2' ? 'Draw' : (S.result === '1-0') === (S.player === 'w') ? 'You won!' : 'You lost'), ` · ${resultText(S.result, S.reason).split(' · ')[1] || ''}`)
      : h('div.status', S.thinking ? `${S.bot.name} is thinking…` : S.chess.turn() === S.player ? 'Your move' : '…');
    const btn = (label, fn, cls = '', disabled = false) => h('button.btn', { class: cls, onclick: fn, disabled }, label);
    const actions = S.over
      ? h('div.btnrow', btn('🔍 Analyse game', () => app.openAnalysis({ pgn: S.pgn, orientation: S.player === 'w' ? 'white' : 'black', review: true }), 'primary'),
        btn('↻ Rematch', rematch), btn('New opponent', () => { S = null; renderSetup(); resetBoard(); }))
      : h('div.btnrow',
        S.opts.hints ? btn('💡 Hint', hint) : null,
        S.opts.takeback ? btn('↶ Takeback', takeback, '', !S.sans.length) : null,
        btn('½ Draw', offerDraw), btn('⚑ Resign', resign, 'danger'),
        btn('⇅ Flip', () => { board.flip(); evalBar.flip(board.orientation === 'black'); }));
    side.append(h('div.card.gamecard',
      h('div.botline', h('span.avatar.lg', S.bot.emoji), h('div', h('b', `${S.bot.name}`), h('div.muted.small', `Rating ≈ ${S.bot.elo}${S.tc.base ? ' · ' + S.tc.label : ''}`))),
      h('div.bubble', S.say), status, moveList.el, actions));
  }

  function rematch() {
    const c = S.player === 'w' ? 'b' : 'w';
    prefs.color = c; startGame();
  }

  function resetBoard() {
    clearInterval(clockTimer);
    board.setOrientation('white'); board.update(new Chess(), { interactive: null });
    topBar.setPlayer({ name: 'Opponent', avatar: '🤖' }); botBar.setPlayer({ name: 'You', avatar: '🙂' });
    topBar.setCaptured([], 'w', 0); botBar.setCaptured([], 'b', 0); topBar.setClock(null); botBar.setClock(null);
    evalBar.el.style.display = 'none';
  }

  // keyboard: browse moves
  function onKey(e) {
    if (!S || !root.classList.contains('active') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const last = S.fens.length - 1, cur = S.view ?? last;
    if (e.key === 'ArrowLeft' && cur > 0) { S.view = cur - 1; showPosition(); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && cur < last) { S.view = cur + 1 === last ? null : cur + 1; showPosition(); e.preventDefault(); }
  }
  addEventListener('keydown', onKey);

  resetBoard();
  renderSetup();
  return { activate() { board.cg.redrawAll(); }, resume: () => S };
}
