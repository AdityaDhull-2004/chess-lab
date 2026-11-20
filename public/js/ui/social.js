// Friends, challenges, ratings and saved game history.
import { h, clear, toast, confirmBox, modal } from './dom.js';
import { app, api } from './app.js';
import { onUser, openAuth, poll } from './account.js';

const TCS = [{ label: '1 | 0', base: 60, inc: 0 }, { label: '3 | 0', base: 180, inc: 0 }, { label: '3 | 2', base: 180, inc: 2 },
  { label: '5 | 0', base: 300, inc: 0 }, { label: '10 | 0', base: 600, inc: 0 }, { label: '15 | 10', base: 900, inc: 10 }, { label: '∞', base: 0, inc: 0 }];

export function createSocialView(root) {
  let filter = 'all';
  let games = null, lastSig = '';
  const wrap = h('div.social');
  async function add() {
    if (!addIn.value.trim()) return;
    try { await api('friends/request', { username: addIn.value.trim() }); toast('Friend request sent', 'ok'); addIn.value = ''; await poll(); } catch (e) { toast(e.message, 'err'); }
  }
  // kept across re-renders so typing is never lost
  const addIn = h('input', { type: 'text', placeholder: 'Friend’s username', autocapitalize: 'off', onkeydown: (e) => { if (e.key === 'Enter') add(); } });
  root.append(wrap);

  const chipFor = (g, me) => {
    const mine = g.white === me ? 'w' : g.black === me ? 'b' : null;
    let cls = 'draw';
    if (g.result === '1-0' || g.result === '0-1') cls = !mine ? '' : (g.result === '1-0') === (mine === 'w') ? 'win' : 'loss';
    return h('span.chip', { class: cls }, g.result || '*');
  };

  function gameRow(g, { mine = true, who } = {}) {
    const me = who || app.user.username;
    const acc = g.review ? ` · acc ${g.review.w != null ? g.review.w.toFixed(0) : '–'}/${g.review.b != null ? g.review.b.toFixed(0) : '–'}` : '';
    return h('div.hrow',
      h('button.grow', { onclick: () => openGame(g, me) },
        chipFor(g, me), h('span.gnames', `${g.white} vs ${g.black}`),
        h('span.gmeta', [g.date, g.kind === 'bot' ? 'vs bot' : 'online', g.tc, g.moves ? `${Math.ceil(g.moves / 2)} moves` : '', g.reason].filter(Boolean).join(' · ') + acc)),
      mine ? h('button.nb', { title: 'Delete from history', onclick: async () => { if (await confirmBox('Delete game?', 'Remove this game from your history?', 'Delete')) { await api('games/' + g.id, undefined, 'DELETE').catch((e) => toast(e.message, 'err')); load(); } } }, '🗑') : null);
  }

  async function openGame(g, me) {
    try {
      const { game } = await api('games/' + g.id);
      app.openAnalysis({ pgn: game.pgn, orientation: game.black === me ? 'black' : 'white', review: false, meta: { gameId: game.id } });
    } catch (e) { toast(e.message, 'err'); }
  }

  async function load() {
    try { games = (await api('games')).games; } catch { games = []; }
    render();
  }

  async function challengeDialog(friend) {
    let tc = 2, color = 'r';
    const tcSeg = h('div.seg.wrap'), colSeg = h('div.seg');
    const draw = () => {
      clear(tcSeg); TCS.forEach((t, i) => tcSeg.append(h('button', { type: 'button', class: i === tc ? 'on' : '', onclick: () => { tc = i; draw(); } }, t.label)));
      clear(colSeg); [['w', '♔ White'], ['r', '🎲 Random'], ['b', '♚ Black']].forEach(([v, l]) => colSeg.append(h('button', { type: 'button', class: color === v ? 'on' : '', onclick: () => { color = v; draw(); } }, l)));
    };
    draw();
    const ok = await modal({ title: `Challenge ${friend.username}`, body: h('div.authform', h('div.field', h('label', 'Time (minutes | increment)'), tcSeg), h('div.field', h('label', 'You play'), colSeg)),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Send challenge', value: true, primary: true }] });
    if (!ok) return;
    try {
      const r = await api('challenge', { to: friend.username, base: TCS[tc].base, inc: TCS[tc].inc, color });
      sessionStorage.setItem('chesslab.tok.' + r.id, r.token);
      app.go('friend'); history.pushState({}, '', '/g/' + r.id); app.views.online.join(r.id);
      toast(`Challenge sent to ${friend.username}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function friendGames(f) {
    try {
      const { games: gs } = await api(`users/${encodeURIComponent(f.username)}/games`);
      const list = h('div.hlist', gs.length ? gs.map((g) => gameRow(g, { mine: false, who: f.username })) : h('div.muted', 'No online games yet.'));
      await modal({ title: `${f.username}'s games`, body: list, buttons: [{ label: 'Close', value: true, primary: true }] });
    } catch (e) { toast(e.message, 'err'); }
  }

  function render() {
    clear(wrap);
    if (!app.hasServer) return wrap.append(h('div.card', h('h2', 'Friends & history'), h('p.muted', 'Accounts, friends and saved history need the Chess Lab server. This copy is the static site (bots + analysis only). Run the server or open the hosted version to use them.')));
    if (!app.user) return wrap.append(h('div.card.center', h('h2', 'Friends & game history'),
      h('p.muted', 'Create an account to add friends, challenge them to games, keep a rating and save your game history across devices.'),
      h('div.btnrow', h('button.btn.primary', { onclick: () => openAuth('register') }, 'Create account'), h('button.btn', { onclick: () => openAuth('login') }, 'Sign in'))));
    const u = app.user, d = app.social || { friends: [], incoming: [], outgoing: [], challenges: [] };

    const act = async (path, name) => { try { await api(path, { username: name }); await poll(); } catch (e) { toast(e.message, 'err'); } };

    const friendsCard = h('div.card',
      h('h2', 'Friends'),
      h('div.linkrow', addIn, h('button.btn.primary', { onclick: add }, 'Add')),
      d.incoming.length ? h('div', h('h3', 'Requests'), d.incoming.map((f) => h('div.frow', h('b', f.username), h('span.muted', ` ${f.rating}`), h('span.sp'),
        h('button.btn.primary.tiny', { onclick: () => act('friends/accept', f.username) }, 'Accept'), h('button.btn.tiny', { onclick: () => act('friends/decline', f.username) }, 'Decline')))) : null,
      h('h3', `Your friends (${d.friends.length})`),
      d.friends.length ? d.friends.map((f) => h('div.frow', h('span.dotonline', { class: f.online ? '' : 'off', title: f.online ? 'online' : 'offline' }), h('b', f.username), h('span.muted', ` ${f.rating}`), h('span.sp'),
        h('button.btn.primary.tiny', { onclick: () => challengeDialog(f) }, '⚔ Challenge'), h('button.btn.tiny', { onclick: () => friendGames(f) }, 'Games'),
        h('button.btn.tiny.danger', { title: 'Remove friend', onclick: async () => { if (await confirmBox('Remove friend?', `Remove ${f.username} from your friends?`, 'Remove')) act('friends/remove', f.username); } }, '✕')))
        : h('div.muted.small', 'No friends yet — ask a friend to register, then add their username above.'),
      d.outgoing.length ? h('div.muted.small', 'Waiting for: ' + d.outgoing.map((f) => f.username).join(', ')) : null);

    const shown = (games || []).filter((g) => filter === 'all' || g.kind === filter);
    const stats = h('div.stats',
      h('div.stat', h('b', u.rating), h('small', 'Rating')), h('div.stat', h('b', u.wins), h('small', 'Wins')), h('div.stat', h('b', u.losses), h('small', 'Losses')), h('div.stat', h('b', u.draws), h('small', 'Draws')));
    const seg = h('div.seg', [['all', 'All'], ['online', 'Online'], ['bot', 'Vs bots']].map(([k, l]) => h('button', { class: filter === k ? 'on' : '', onclick: () => { filter = k; render(); } }, l)));
    const histCard = h('div.card',
      h('div.histhead', h('h2', u.username), h('span.muted', 'rating updates after online games with friends')), stats,
      h('h3', 'Game history'), seg,
      h('div.hlist', games === null ? h('div.muted', 'Loading…') : shown.length ? shown.map((g) => gameRow(g)) : h('div.muted', 'No games yet. Finish a game while signed in and it appears here.')));
    wrap.append(friendsCard, histCard);
  }

  onUser(() => { games = null; render(); if (app.user) load(); });
  render();
  return {
    activate() { if (app.user) { poll(); load(); } render(); },
    refresh(d) { app.social = d; const sig = JSON.stringify(d); if (sig === lastSig || document.activeElement === addIn) return; lastSig = sig; if (root.classList.contains('active')) render(); },
  };
}
