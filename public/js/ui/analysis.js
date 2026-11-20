// Analysis board + Game Review.
import { Chess } from 'chess.js';
import { h, clear, esc, toast, copyText, store, confirmBox } from './dom.js';
import { BoardView, arrow, badge } from './board.js';
import { app, api } from './app.js';
import { EvalBar, PlayerBar, capturedFrom } from './parts.js';
import { EvalGraph } from './evalgraph.js';
import { createImporter } from './importer.js';
import { openingFor } from '../core/openings.js';
import { analysePositions } from '../core/analyse.js';
import { classifyGame, CLASSES, CLASS_ORDER } from '../core/review.js';
import { START_FEN, lineWp, fmtScore, pvToSan, formatPv, uciOf, terminalLine, forSide } from '../core/util.js';

let nid = 0;
class Node {
  constructor(parent, mv, fen) {
    this.id = ++nid; this.parent = parent; this.children = []; this.fen = fen; this.rev = null;
    if (parent) {
      const f = parent.fen.split(' ');
      this.color = f[1]; this.num = +f[5] || 1;
      this.san = mv.san; this.uci = uciOf(mv); this.from = mv.from; this.to = mv.to;
    }
  }
}

const DEPTHS = [{ k: 'quick', label: 'Quick', depth: 12, hint: '~15 s' }, { k: 'std', label: 'Standard', depth: 16, hint: '~1 min' },
  { k: 'deep', label: 'Deep', depth: 20, hint: '~3–5 min' }, { k: 'max', label: 'Max', depth: 24, hint: 'slow' }];
const BAD = ['inaccuracy', 'mistake', 'miss', 'blunder'];
const SHOWN_IN_LIST = ['brilliant', 'great', 'inaccuracy', 'mistake', 'miss', 'blunder'];
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

export function createAnalysisView(root) {
  const prefs = store.get('analysisPrefs', { depth: 22, lines: 3, on: true, arrows: true, review: 'std' });
  const savePrefs = () => store.set('analysisPrefs', prefs);

  // ---- model
  let rootNode = new Node(null, null, START_FEN);
  let cur = rootNode;
  const nodes = new Map([[rootNode.id, rootNode]]);
  let meta = { white: 'White', black: 'Black', whiteElo: '', blackElo: '', result: '', event: '', date: '' };
  let review = null;               // {moves, summary, winsWhite, depth}
  const reviewEvals = new Map();   // fen -> {lines}
  const reviewCache = new Map();
  let reviewing = null;            // {signal, done, total}
  const live = { fen: null, lines: [], depth: 0, tok: 0, done: false };
  let liveTimer = null, rafPending = false;
  let tab = 'analysis';

  // ---- layout
  const evalBar = new EvalBar();
  const topBar = new PlayerBar(), botBar = new PlayerBar();
  const boardEl = h('div.board-el');
  const bw = h('div.bw', evalBar.el, h('div.boardbox', boardEl));
  const boardCol = h('div.board-col', bw);
  const side = h('aside.side.analysis');
  root.append(h('div.layout', boardCol, h('div.sidecol', topBar.el, side, botBar.el)));
  const board = new BoardView(boardEl, { onMove: onBoardMove });

  const graph = new EvalGraph((ply) => gotoMainlinePly(ply));
  const importer = createImporter({ onLoad: (p) => load(p) });

  const tabs = h('div.tabs');
  const body = h('div.tabbody');
  const coach = h('div.coach');
  const moveBox = h('div.movelist');
  const nav = h('div.navrow',
    navBtn('⏮', 'Start (Home)', () => goto(rootNode)), navBtn('◀', 'Previous (←)', prev), navBtn('▶', 'Next (→)', next), navBtn('⏭', 'End', () => goto(lastOf(cur))),
    h('span.sp'),
    navBtn('⇅', 'Flip board (F)', flip), navBtn('🗑', 'Delete this move & everything after it', delFromHere),
    navBtn('⎘', 'Copy PGN', () => copyText(buildPgn())), navBtn('FEN', 'Copy FEN', () => copyText(cur.fen)));
  side.append(tabs, body, coach, h('div.movepane', moveBox, nav));

  function navBtn(label, title, fn) { return h('button.nb', { title, onclick: fn }, label); }

  // ---------------------------------------------------------------- tree helpers
  const lastOf = (n) => { while (n.children[0]) n = n.children[0]; return n; };
  const mainline = () => { const out = []; let n = rootNode.children[0]; while (n) { out.push(n); n = n.children[0]; } return out; };
  const depthOf = (n) => { let d = 0; while (n.parent) { n = n.parent; d++; } return d; };
  function prev() { if (cur.parent) goto(cur.parent); }
  function next() { if (cur.children[0]) goto(cur.children[0]); }
  function flip() { board.flip(); evalBar.flip(board.orientation === 'black'); renderBars(); }
  function gotoMainlinePly(ply) { const ml = mainline(); goto(ply <= 0 ? rootNode : ml[Math.min(ply, ml.length) - 1]); }

  function addMove(from, to, promotion) {
    const c = new Chess(cur.fen);
    let mv;
    try { mv = c.move({ from, to, promotion }); } catch { return null; }
    const existing = cur.children.find((n) => n.uci === uciOf(mv));
    if (existing) return existing;
    const n = new Node(cur, mv, c.fen());
    cur.children.push(n); nodes.set(n.id, n);
    renderMoves();
    return n;
  }
  function onBoardMove({ from, to, promotion }) {
    const n = addMove(from, to, promotion);
    if (n) { playSound(n); goto(n); } else showBoard();
  }
  async function playSound(n) {
    const { sound } = await import('./sound.js');
    const c = new Chess(n.parent.fen); const mv = c.move(n.san);
    sound.forMove(mv, c);
  }
  async function delFromHere() {
    if (cur === rootNode) return;
    const p = cur.parent;
    p.children = p.children.filter((n) => n !== cur);
    (function drop(n) { nodes.delete(n.id); n.children.forEach(drop); })(cur);
    renderMoves(); goto(p);
  }

  // ---------------------------------------------------------------- loading
  async function load({ pgn, fen, orientation, review: autoReview, meta: m } = {}) {
    await app.loadOpenings();
    let root, line = [];
    let hdr = {};
    try {
      if (pgn) {
        const c = new Chess();
        c.loadPgn(pgn);
        hdr = c.getHeaders();
        const hist = c.history({ verbose: true });
        root = hist.length ? hist[0].before : c.fen();
        line = hist;
      } else if (fen) {
        root = new Chess(fen).fen();
      } else return;
    } catch (e) {
      toast('Could not read that game: ' + (e.message || e), 'err');
      return;
    }
    stopReview(); stopLive();
    rootNode = new Node(null, null, root); nodes.clear(); nodes.set(rootNode.id, rootNode);
    let p = rootNode;
    for (const mv of line) { const n = new Node(p, mv, mv.after); p.children.push(n); nodes.set(n.id, n); p = n; }
    review = null; reviewEvals.clear();
    meta = { white: hdr.White || 'White', black: hdr.Black || 'Black', whiteElo: hdr.WhiteElo || '', blackElo: hdr.BlackElo || '', result: hdr.Result || '', event: hdr.Event || '', date: (hdr.Date || '').replace(/\./g, '-'), ...m };
    const who = (orientation) || (/^you$/i.test(meta.black) ? 'black' : 'white');
    board.setOrientation(who); evalBar.flip(who === 'black');
    graph.set(null, null);
    renderMoves();
    goto(rootNode);
    setTab(autoReview && line.length ? 'review' : 'analysis');
    if (autoReview && line.length) runReview(DEPTHS.find((d) => d.k === prefs.review)?.depth || 16);
  }

  function buildPgn() {
    const c = new Chess(rootNode.fen);
    for (const n of mainline()) { try { c.move(n.san); } catch { break; } }
    c.setHeader('White', meta.white); c.setHeader('Black', meta.black);
    if (meta.result) c.setHeader('Result', meta.result);
    return c.pgn();
  }

  // ---------------------------------------------------------------- navigation / rendering
  function goto(n, opts = {}) {
    cur = n;
    showBoard();
    markMoveList();
    renderBars();
    renderCoach();
    renderPanel();
    graph.setCursor(mainlineIndex(n));
    scheduleLive();
  }
  function mainlineIndex(n) {
    // ply of the nearest ancestor that lies on the mainline
    let x = n;
    while (x.parent && x.parent.children[0] !== x) x = x.parent;
    return depthOf(x);
  }

  function evalFor(n) {
    if (live.fen === n.fen && live.lines.length) return live.lines;
    const r = reviewEvals.get(n.fen);
    return r ? r.lines : null;
  }

  function showBoard() {
    const c = new Chess(cur.fen);
    const shapes = [];
    const lines = evalFor(cur);
    if (prefs.arrows && lines && !c.isGameOver()) {
      lines.slice(0, prefs.lines).forEach((l, i) => {
        if (l.pv?.[0]) shapes.push(arrow(l.pv[0], i === 0 ? 'green' : 'paleBlue', i === 0 ? 12 : 8));
      });
    }
    if (cur.rev && SHOWN_IN_LIST.concat(['best', 'excellent', 'good']).includes(cur.rev.cls)) {
      const cl = CLASSES[cur.rev.cls];
      if (cl.sym && !['good', 'excellent'].includes(cur.rev.cls)) shapes.push(badge(cur.to, cl.sym, cl.color));
    }
    if (hintShape) shapes.push(hintShape);
    board.update(c, { lastMove: cur.parent ? { from: cur.from, to: cur.to } : null, interactive: 'both', shapes });
    const l0 = lines?.[0];
    if (l0) evalBar.set(lineWp(l0), fmtScore(l0)); else evalBar.set(0.5, '0.00');
  }
  let hintShape = null;

  function renderBars() {
    const bottomWhite = board.orientation === 'white';
    const mk = (color) => ({ name: color === 'w' ? meta.white : meta.black, sub: color === 'w' ? meta.whiteElo : meta.blackElo, avatar: '' });
    (bottomWhite ? botBar : topBar).setPlayer(mk('w')); (bottomWhite ? topBar : botBar).setPlayer(mk('b'));
    const cap = capturedFrom(cur.fen);
    const wBar = bottomWhite ? botBar : topBar, bBar = bottomWhite ? topBar : botBar;
    wBar.setCaptured(cap.byWhite, 'b', cap.diff > 0 ? cap.diff : 0);
    bBar.setCaptured(cap.byBlack, 'w', cap.diff < 0 ? -cap.diff : 0);
    wBar.setClock(null); bBar.setClock(null);
  }

  // ---- move list (with variations)
  function moveHtml(n, needNum) {
    let s = '';
    if (n.color === 'w') s += `<span class="mn">${n.num}.</span>`;
    else if (needNum) s += `<span class="mn">${n.num}…</span>`;
    let bd = '';
    if (n.rev && SHOWN_IN_LIST.includes(n.rev.cls)) { const c = CLASSES[n.rev.cls]; bd = `<i class="bd" style="background:${c.color}" title="${c.label}">${esc(c.sym)}</i>`; }
    return `${s}<span class="mv" data-id="${n.id}">${esc(n.san)}${bd}</span> `;
  }
  function chain(parent, needNum) {
    let html = '', p = parent, n = parent.children[0];
    while (n) {
      html += moveHtml(n, needNum); needNum = false;
      for (const alt of p.children.slice(1)) {
        html += `<span class="var">(${moveHtml(alt, true)}${chain(alt, false)})</span> `;
        needNum = true;
      }
      p = n; n = n.children[0];
    }
    return html;
  }
  function renderMoves() {
    moveBox.innerHTML = rootNode.children.length ? chain(rootNode, rootNode.fen.split(' ')[1] === 'b') : '<div class="muted small">No moves yet — play on the board, or load a game.</div>';
    markMoveList();
  }
  moveBox.addEventListener('click', (e) => {
    const t = e.target.closest('[data-id]');
    if (t) { const n = nodes.get(+t.dataset.id); if (n) goto(n); }
  });
  function markMoveList() {
    moveBox.querySelector('.mv.on')?.classList.remove('on');
    const el = moveBox.querySelector(`[data-id="${cur.id}"]`);
    if (el) { el.classList.add('on'); el.scrollIntoView({ block: 'nearest' }); }
  }

  // ---- coach box (move quality for the current move)
  function bestSanFor(n) {
    const r = n.rev; if (!r?.bestUci) return null;
    const c = new Chess(n.parent.fen);
    try { return c.move({ from: r.bestUci.slice(0, 2), to: r.bestUci.slice(2, 4), promotion: r.bestUci[4] }).san; } catch { return null; }
  }
  function renderCoach() {
    clear(coach);
    const op = currentOpening();
    const r = cur.rev;
    if (r) {
      const cl = CLASSES[r.cls];
      const bestSan = bestSanFor(cur);
      const delta = r.loss > 0.004 ? ` (−${(r.loss * 100).toFixed(0)}% win chance)` : '';
      coach.append(
        h('div.cline', h('span.cb', { style: { background: cl.color } }, cl.sym || '•'),
          h('div', h('b', `${cur.san} is ${r.cls === 'forced' ? 'forced' : article(cl.label) + ' ' + cl.label.toLowerCase() + ' move'}`), h('span.muted', delta),
            h('div.muted.small', `Eval after: ${fmtScore(r.playedLine)}`))),
        BAD.includes(r.cls) && bestSan ? h('div.cline2', 'Best was ', h('b', bestSan), ' ',
          h('button.btn.tiny', { onclick: () => showHint(r.bestUci) }, 'Show'), ' ',
          h('button.btn.tiny', { onclick: () => playBest(cur.parent, r.bestUci) }, 'Play it')) : null,
        op ? h('div.muted.small', `${op[0]} · ${op[1]}`) : null);
    } else if (op) {
      coach.append(h('div.cline', h('span.cb', { style: { background: '#a88865' } }, '♗'), h('div', h('b', op[1]), h('div.muted.small', `ECO ${op[0]}`))));
    }
    coach.style.display = coach.childNodes.length ? '' : 'none';
  }
  function showHint(uci) { hintShape = arrow(uci, 'yellow', 13); showBoard(); }
  function playBest(parent, uci) {
    const save = cur; cur = parent;
    const n = addMove(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
    cur = save; if (n) goto(n);
  }
  function currentOpening() {
    for (let n = cur; n; n = n.parent) { const o = openingFor(n.fen); if (o) return o; }
    return null;
  }

  // ---------------------------------------------------------------- live engine
  function scheduleLive() {
    hintShape = null;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(runLive, 140);
  }
  function stopLive() { live.tok++; clearTimeout(liveTimer); if (app._analysisEngine) app._analysisEngine.stop(); }

  async function runLive() {
    if (reviewing) return;
    const fen = cur.fen;
    const term = terminalLine(new Chess(fen));
    if (term) { live.fen = fen; live.lines = [term]; live.depth = 99; live.done = true; liveRender(); return; }
    if (!prefs.on) { live.lines = []; live.fen = null; liveRender(); app._analysisEngine?.stop(); return; }
    const tok = ++live.tok;
    live.fen = fen; live.done = false;
    const cached = reviewEvals.get(fen);
    live.lines = cached ? cached.lines : [];
    live.depth = cached ? cached.depth || 0 : 0;
    liveRender();
    const eng = app.analysisEngine();
    await eng.ready;
    if (tok !== live.tok) return;
    eng.setOption('UCI_LimitStrength', 'false');
    const res = await eng.go({
      fen, depth: prefs.depth >= 40 ? null : prefs.depth, infinite: prefs.depth >= 40, multipv: prefs.lines,
      onInfo: (lines) => { if (tok !== live.tok) return; live.lines = lines; live.depth = lines[0]?.depth || 0; live.nps = lines[0]?.nps; liveRender(); },
    });
    if (tok !== live.tok) return;
    if (res.lines.length) live.lines = res.lines;
    live.depth = res.depth; live.done = true;
    liveRender();
  }
  function liveRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; showBoard(); if (tab === 'analysis') renderLines(); });
  }

  // ---------------------------------------------------------------- panels
  function setTab(t) {
    tab = t;
    clear(tabs);
    for (const [k, l] of [['analysis', 'Analysis'], ['review', 'Review'], ['import', 'Import']]) {
      tabs.append(h('button', { class: k === t ? 'on' : '', onclick: () => setTab(k) }, l, k === 'review' && review ? h('span.dot') : null));
    }
    renderPanel();
  }
  function renderPanel() {
    if (tab === 'analysis') renderAnalysisPanel();
    else if (tab === 'review') renderReviewPanel();
    else renderImportPanel();
  }

  // -- analysis tab
  let linesBox = null;
  function renderAnalysisPanel() {
    clear(body);
    const eng = app.settings;
    const toggle = h('label.switch', h('input', { type: 'checkbox', checked: prefs.on, onchange: (e) => { prefs.on = e.target.checked; savePrefs(); if (!prefs.on) stopLive(); scheduleLive(); } }), h('span.sl'), h('span', ' Engine'));
    const depthLbl = h('span.val', prefs.depth >= 40 ? '∞' : String(prefs.depth));
    const depth = h('input', { type: 'range', min: 6, max: 40, value: prefs.depth, oninput: (e) => { prefs.depth = +e.target.value; depthLbl.textContent = prefs.depth >= 40 ? '∞' : prefs.depth; }, onchange: () => { savePrefs(); scheduleLive(); } });
    const linesSel = h('select', { onchange: (e) => { prefs.lines = +e.target.value; savePrefs(); scheduleLive(); } }, [1, 2, 3, 4, 5].map((n) => h('option', { value: n, selected: n === prefs.lines }, `${n} line${n > 1 ? 's' : ''}`)));
    const kindSel = h('select', { onchange: (e) => { app.setEngineKind(e.target.value); stopLive(); scheduleLive(); renderPanel(); } },
      h('option', { value: 'lite', selected: eng.engineKind === 'lite' }, 'Lite (fast, ~2 MB)'), window.CHESSLAB_LITE_ONLY ? null : h('option', { value: 'full', selected: eng.engineKind === 'full' }, 'Full NNUE (strongest, ~100 MB)'));
    const maxT = Math.max(1, Math.min(app.cores - 1, 16));
    const thrSel = h('select', { disabled: !app.isolated, onchange: (e) => { app.setThreads(+e.target.value); stopLive(); scheduleLive(); } },
      Array.from({ length: maxT }, (_, i) => i + 1).map((n) => h('option', { value: n, selected: n === eng.threads }, `${n} thread${n > 1 ? 's' : ''}`)));
    const arrows = h('label.chk', h('input', { type: 'checkbox', checked: prefs.arrows, onchange: (e) => { prefs.arrows = e.target.checked; savePrefs(); showBoard(); } }), 'Arrows');
    linesBox = h('div.lines');
    body.append(h('div.panel',
      h('div.enghead', toggle, h('span.engname', { id: 'engname' }, app.status || '')),
      h('div.field.inline', h('label', 'Depth'), depth, depthLbl),
      h('div.settings', linesSel, kindSel, thrSel, arrows),
      !app.isolated ? h('div.muted.small', 'Multi-threading needs HTTPS or localhost; running single-threaded.') : null,
      linesBox));
    renderLines();
  }
  function renderLines() {
    if (!linesBox) return;
    clear(linesBox);
    if (!prefs.on) { linesBox.append(h('div.muted', 'Engine is off.')); return; }
    const lines = live.fen === cur.fen ? live.lines : [];
    if (!lines.length) { linesBox.append(h('div.muted', app.status.startsWith('Loading') ? app.status : 'Thinking…')); return; }
    const term = lines[0].terminal;
    if (term) { linesBox.append(h('div.muted', lines[0].wp === 0.5 ? 'Draw — game over.' : 'Checkmate.')); return; }
    lines.forEach((l, i) => {
      const sans = pvToSan(cur.fen, l.pv, 14);
      const sc = fmtScore(l);
      const good = lineWp(l) >= 0.5;
      const row = h('div.eline', h('span.sc', { class: good ? 'w' : 'b' }, sc));
      const pvBox = h('span.pv');
      const parts = cur.fen.split(' '); let turn = parts[1], num = +parts[5] || 1;
      sans.forEach((s, k) => {
        if (turn === 'w') pvBox.append(h('span.mn', `${num}.`)); else if (k === 0) pvBox.append(h('span.mn', `${num}…`));
        pvBox.append(h('span.pm', { onclick: () => playLine(sans, k) }, s.san), ' ');
        if (turn === 'b') num++;
        turn = turn === 'w' ? 'b' : 'w';
      });
      row.append(pvBox);
      linesBox.append(row);
      if (i === 0) {
        const done = live.done ? 'done' : '';
        linesBox.append(h('div.muted.small.depthline', { class: done }, `depth ${l.depth || live.depth}${l.nps ? ` · ${(l.nps / 1000).toFixed(0)}k n/s` : ''}${live.done ? ' · complete' : ' · searching…'}`));
      }
    });
  }
  function playLine(sans, upto) {
    let n = cur;
    const save = cur;
    for (let i = 0; i <= upto; i++) {
      cur = n;
      const m = sans[i];
      const nn = addMove(m.from, m.to, m.uci[4]);
      if (!nn) break;
      n = nn;
    }
    cur = save; goto(n);
  }

  // -- review tab
  function renderReviewPanel() {
    clear(body);
    if (reviewing) return body.append(reviewProgress());
    if (!review) {
      const ml = mainline();
      const chips = h('div.seg.wrap', DEPTHS.map((d) => h('button', { class: prefs.review === d.k ? 'on' : '', onclick: () => { prefs.review = d.k; savePrefs(); renderReviewPanel(); } }, `${d.label}`, h('small', ` d${d.depth}`))));
      return body.append(h('div.panel.center',
        h('h2', 'Game Review'),
        h('p.muted', ml.length ? `Stockfish checks all ${ml.length} moves and grades each one (Brilliant, Great, Best … Blunder), then reports your accuracy — the same idea as chess.com’s Game Review, with no subscription.`
          : 'Load a game first (Import tab), or play some moves on the board.'),
        chips,
        h('div.muted.small', `Estimated time: ${DEPTHS.find((d) => d.k === prefs.review).hint} on a typical laptop (parallel workers: ${app.settings.engineKind === 'full' ? 1 : Math.max(1, Math.min(app.cores - 1, 6))}).`),
        h('button.btn.primary.big', { disabled: !ml.length, onclick: () => runReview(DEPTHS.find((d) => d.k === prefs.review).depth) }, '▶ Start review')));
    }
    const s = review.summary;
    const acc = (c) => (s[c].accuracy == null ? '–' : s[c].accuracy.toFixed(1));
    const rows = CLASS_ORDER.map((k) => h('tr', h('td', h('span.cb.sm', { style: { background: CLASSES[k].color } }, CLASSES[k].sym || '•'), ' ', CLASSES[k].label), h('td.n', s.w.counts[k]), h('td.n', s.b.counts[k])));
    const moments = review.moves.filter((m) => ['brilliant', 'great', 'blunder', 'mistake', 'miss'].includes(m.cls));
    body.append(h('div.panel.review',
      h('div.accrow',
        h('div.acc', h('div.who', meta.white), h('div.big', acc('w')), h('div.muted.small', `≈ ${s.w.rating} perf.`)),
        h('div.acc', h('div.who', meta.black), h('div.big', acc('b')), h('div.muted.small', `≈ ${s.b.rating} perf.`))),
      h('div.muted.small', `Accuracy (0–100). Reviewed at depth ${review.depth}. Performance is a rough estimate from average centipawn loss (${s.w.acpl.toFixed(0)} / ${s.b.acpl.toFixed(0)}).`),
      graph.el,
      h('table.cls', h('thead', h('tr', h('th'), h('th.n', 'W'), h('th.n', 'B'))), h('tbody', rows)),
      h('div.btnrow', h('button.btn', { onclick: () => jumpMoment(-1) }, '◀ Prev key move'), h('button.btn.primary', { onclick: () => jumpMoment(1) }, 'Next key move ▶')),
      moments.length ? h('div.moments', moments.map((m) => h('button.grow', { onclick: () => gotoMainlinePly(m.i + 1) },
        h('span.cb.sm', { style: { background: CLASSES[m.cls].color } }, CLASSES[m.cls].sym),
        h('span.gnames', `${Math.floor(m.i / 2) + 1}${m.color === 'w' ? '.' : '…'} ${m.san}`), h('span.gmeta', CLASSES[m.cls].label)))) : null,
      h('div.btnrow', h('button.btn', { onclick: () => { review = null; reviewEvals.clear(); mainline().forEach((n) => (n.rev = null)); renderMoves(); renderCoach(); graph.set(null, null); showBoard(); setTab('review'); } }, '↻ Re-run review'))));
    graph.set(review.winsWhite, review.moves);
    graph.setCursor(mainlineIndex(cur));
  }
  function jumpMoment(dir) {
    if (!review) return;
    const idx = mainlineIndex(cur); // 0 = start; move i is ply i+1
    const keys = review.moves.filter((m) => ['brilliant', 'great', 'blunder', 'mistake', 'miss'].includes(m.cls)).map((m) => m.i + 1);
    const target = dir > 0 ? keys.find((k) => k > idx) : [...keys].reverse().find((k) => k < idx);
    if (target) gotoMainlinePly(target); else toast('No more key moves in that direction');
  }

  function reviewProgress() {
    const bar = h('div.bar', h('div.barfill', { id: 'rvfill', style: { width: `${(reviewing.done / Math.max(1, reviewing.total)) * 100}%` } }));
    return h('div.panel.center', h('h2', 'Reviewing…'), bar,
      h('div.muted', { id: 'rvtxt' }, `${reviewing.done} / ${reviewing.total} positions · depth ${reviewing.depth}`),
      h('button.btn', { onclick: stopReview }, 'Cancel'));
  }
  function stopReview() {
    if (reviewing) { reviewing.signal.aborted = true; for (const e of app.reviewEngines()) e.stop(); }
  }

  async function runReview(depth) {
    if (reviewing) return;
    const ml = mainline();
    if (!ml.length) return toast('Nothing to review');
    stopLive();
    const c = new Chess(rootNode.fen);
    const moves = [];
    for (const n of ml) {
      const m = c.move({ from: n.from, to: n.to, promotion: n.uci[4] });
      moves.push({ color: m.color, san: m.san, uci: uciOf(m), from: m.from, to: m.to, captured: m.captured, fenBefore: m.before, fenAfter: m.after });
    }
    const fens = [rootNode.fen, ...moves.map((m) => m.fenAfter)];
    reviewing = { signal: { aborted: false }, done: 0, total: fens.length, depth };
    setTab('review');
    const engines = app.reviewEngines();
    app.setStatus('Loading engine…');
    await Promise.all(engines.map((e) => e.ready));
    app.setStatus(`Reviewing with ${engines.length} engine worker${engines.length > 1 ? 's' : ''}`);
    try {
      const t0 = performance.now();
      const evals = await analysePositions(fens, {
        engines, depth, movetime: { 12: 2500, 16: 5000, 20: 12000, 24: 30000 }[depth] || 8000, multipv: 2, signal: reviewing.signal, cache: reviewCache,
        onProgress: (done, total) => {
          reviewing.done = done;
          const f = document.getElementById('rvfill'), t = document.getElementById('rvtxt');
          if (f) f.style.width = `${(done / total) * 100}%`;
          if (t) t.textContent = `${done} / ${total} positions · depth ${depth} · ${((performance.now() - t0) / 1000).toFixed(0)}s`;
        },
      });
      const result = classifyGame(moves, evals);
      review = { ...result, depth, evals };
      fens.forEach((f, i) => reviewEvals.set(f, { lines: evals[i].lines, depth: evals[i].depth }));
      ml.forEach((n, i) => { n.rev = result.moves[i]; });
      toast('Review complete', 'ok');
      if (app.user && meta.gameId) api('games/' + meta.gameId + '/review', { w: result.summary.w.accuracy, b: result.summary.b.accuracy, depth }).catch(() => {});
    } catch (e) {
      if (!e.aborted) { console.error(e); toast('Review failed: ' + e.message, 'err'); }
    }
    reviewing = null;
    app.setStatus('');
    renderMoves(); renderCoach(); setTab('review'); showBoard(); scheduleLive();
  }

  // -- import tab
  function renderImportPanel() {
    clear(body);
    importer.refreshSaved();
    body.append(h('div.panel', importer.el));
  }

  // ---------------------------------------------------------------- keyboard
  addEventListener('keydown', (e) => {
    if (!root.classList.contains('active') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowLeft') { prev(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { next(); e.preventDefault(); }
    else if (e.key === 'Home' || e.key === 'ArrowUp') { goto(rootNode); e.preventDefault(); }
    else if (e.key === 'End' || e.key === 'ArrowDown') { goto(lastOf(cur)); e.preventDefault(); }
    else if (e.key === 'f' || e.key === 'F') flip();
  });
  app.onStatus((s) => { const el = document.getElementById('engname'); if (el) el.textContent = s; if (tab === 'analysis') renderLines(); });

  // ---------------------------------------------------------------- init
  setTab('analysis');
  renderMoves();
  goto(rootNode);
  app.loadOpenings().then(renderCoach);

  return {
    load,
    activate() { board.cg.redrawAll(); graph.draw(); if (tab === 'analysis') scheduleLive(); },
    deactivate() { stopLive(); },
  };
}
