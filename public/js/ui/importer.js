// "Import" panel: paste PGN/FEN, upload a file, or fetch recent games from chess.com / Lichess by username.
import { h, clear, toast, store, esc } from './dom.js';
import { savedGames } from './app.js';

export function splitPgns(text) {
  return text.replace(/\r\n/g, '\n').split(/\n\s*\n(?=\[Event )/).map((s) => s.trim()).filter((s) => /\[Event |^\s*1\./m.test(s) || s.length > 0);
}
export function pgnHeader(pgn, key) {
  const m = pgn.match(new RegExp(`^\\[${key}\\s+"(.*)"\\]`, 'm'));
  return m ? m[1] : '';
}

export function createImporter({ onLoad }) {
  const prefs = store.get('importPrefs', { source: 'chess.com', user: '' });
  const ta = h('textarea', { rows: 6, placeholder: 'Paste a PGN, a FEN, or a lichess.org game link here…', spellcheck: 'false' });
  const results = h('div.gamelist');
  const saved = h('div.gamelist');
  const file = h('input', { type: 'file', accept: '.pgn,.txt', style: { display: 'none' }, onchange: async (e) => { const f = e.target.files[0]; if (f) { ta.value = await f.text(); loadText(); } e.target.value = ''; } });
  const userIn = h('input', { type: 'text', placeholder: 'username', value: prefs.user, autocapitalize: 'off', spellcheck: 'false',
    onkeydown: (e) => { if (e.key === 'Enter') fetchGames(); } });
  const srcSel = h('div.seg');
  const status = h('div.muted.small');

  function drawSrc() {
    clear(srcSel);
    for (const s of ['chess.com', 'lichess']) srcSel.append(h('button', { class: prefs.source === s ? 'on' : '', onclick: () => { prefs.source = s; store.set('importPrefs', prefs); drawSrc(); } }, s === 'lichess' ? 'Lichess' : 'Chess.com'));
  }
  drawSrc();

  async function loadText() {
    const text = ta.value.trim();
    if (!text) return toast('Nothing to load');
    const li = text.match(/lichess\.org\/(?:game\/export\/)?([A-Za-z0-9]{8})/);
    if (li && !/\[Event/.test(text)) {
      status.textContent = 'Fetching game from Lichess…';
      try {
        const r = await fetch(`api/lichess-game/${li[1]}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        status.textContent = '';
        return onLoad({ pgn: j.pgn });
      } catch (e) { status.textContent = ''; return toast('Could not fetch that game: ' + e.message, 'err'); }
    }
    if (/chess\.com\//i.test(text) && !/\[Event/.test(text)) {
      return toast('Chess.com game links can’t be fetched directly — use the username list below, or paste the PGN (Share → PGN).', 'err');
    }
    if (/^[rnbqkp1-8/]+ [wb] [KQkq-]+ [a-h1-8-]+( \d+ \d+)?$/i.test(text)) return onLoad({ fen: text });
    const games = splitPgns(text);
    if (games.length > 1) { showGames(games.map((pgn) => ({ pgn, white: pgnHeader(pgn, 'White'), black: pgnHeader(pgn, 'Black'), result: pgnHeader(pgn, 'Result'), date: pgnHeader(pgn, 'Date').replace(/\./g, '-'), timeClass: pgnHeader(pgn, 'Event') })), results, null); return toast(`${games.length} games found — pick one below`); }
    onLoad({ pgn: text });
  }

  async function fetchGames() {
    const user = userIn.value.trim();
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(user)) return toast('Enter a valid username', 'err');
    prefs.user = user; store.set('importPrefs', prefs);
    status.textContent = `Fetching ${user}'s recent games…`;
    clear(results);
    try {
      const r = await fetch(`api/${prefs.source === 'lichess' ? 'lichess' : 'chesscom'}/${encodeURIComponent(user)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'request failed');
      status.textContent = j.games.length ? `${j.games.length} recent games` : 'No games found.';
      showGames(j.games, results, user);
    } catch (e) { status.textContent = ''; toast(e.message, 'err'); }
  }

  function showGames(games, into, user) {
    clear(into);
    for (const g of games) {
      const u = (user || '').toLowerCase();
      const iWhite = u && (g.white || '').toLowerCase() === u, iBlack = u && (g.black || '').toLowerCase() === u;
      let outcome = '';
      if (g.result === '1-0') outcome = iWhite ? 'win' : iBlack ? 'loss' : '';
      else if (g.result === '0-1') outcome = iBlack ? 'win' : iWhite ? 'loss' : '';
      else if (g.result === '1/2-1/2') outcome = 'draw';
      into.append(h('button.grow', { onclick: () => onLoad({ pgn: g.pgn, orientation: iBlack ? 'black' : 'white', user }) },
        h('span.chip', { class: outcome }, g.result || '*'),
        h('span.gnames', `${g.white || '?'}${g.whiteElo ? ` (${g.whiteElo})` : ''} vs ${g.black || '?'}${g.blackElo ? ` (${g.blackElo})` : ''}`),
        h('span.gmeta', [g.date, g.timeClass, g.opening].filter(Boolean).join(' · '))));
    }
  }

  function refreshSaved() {
    clear(saved);
    const list = savedGames();
    if (!list.length) { saved.append(h('div.muted.small', 'Games you finish against bots or friends are saved here automatically.')); return; }
    for (const g of list) {
      saved.append(h('button.grow', { onclick: () => onLoad({ pgn: g.pgn, orientation: g.color === 'b' ? 'black' : 'white' }) },
        h('span.chip', g.result || '*'),
        h('span.gnames', `${g.white} vs ${g.black}`),
        h('span.gmeta', [g.date, g.kind === 'bot' ? 'vs ' + g.opponent : 'online'].filter(Boolean).join(' · '))));
    }
  }
  refreshSaved();

  const el = h('div.importer',
    h('h3', 'Load a game'),
    ta,
    h('div.btnrow', h('button.btn.primary', { onclick: loadText }, 'Load'), h('button.btn', { onclick: () => file.click() }, 'Upload .pgn'), file,
      h('button.btn', { onclick: () => { ta.value = ''; } }, 'Clear')),
    h('h3', 'Import from your account'),
    h('p.muted.small', 'Fetch your recent games to review them for free. Only public game data is requested.'),
    h('div.userrow', srcSel, userIn, h('button.btn', { onclick: fetchGames }, 'Fetch')),
    status, results,
    h('h3', 'Saved on this device'), saved);
  return { el, refreshSaved, setText: (t) => { ta.value = t; } };
}
