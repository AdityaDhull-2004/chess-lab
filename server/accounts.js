// Accounts, sessions, friends, challenges and game history (REST API under /api).
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { Chess } from 'chess.js';

const scrypt = promisify(crypto.scrypt);
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;
const COOKIE = 'cl_sid';
const SESSION_MS = 30 * 24 * 3600e3;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = (n) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, 'x').slice(0, n);

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

/**
 * @param {import('express').Express} app
 * @param {object} store  document store (see store.js)
 * @param {{createChallengeGame:Function, isGameWaiting:(id:string)=>boolean}} hooks
 */
export function setupAccounts(app, store, hooks) {
  const lastSeen = new Map();     // uid -> ms
  const challenges = new Map();   // uid -> [{from, id, base, inc, ts}]
  const attempts = new Map();     // ip|user -> {n, ts}

  const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex');
  const userOf = (uid) => store.get('users', uid);
  const publicUser = (u) => ({ username: u.username, rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws, created: u.created });
  const isOnline = (uid) => Date.now() - (lastSeen.get(uid) || 0) < 25000;

  function sessionUser(token) {
    if (!token) return null;
    const s = store.get('sessions', sha(token));
    if (!s) return null;
    if (s.exp < Date.now()) { store.del('sessions', sha(token)); return null; }
    return userOf(s.uid) || null;
  }
  function userFromCookieHeader(header) { return sessionUser(parseCookies(header)[COOKIE]); }

  function startSession(req, res, uid) {
    const token = crypto.randomBytes(32).toString('base64url');
    store.set('sessions', sha(token), { uid, exp: Date.now() + SESSION_MS });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS, path: '/' });
  }

  function throttle(key) {
    const now = Date.now();
    const a = attempts.get(key);
    if (a && now - a.ts < 15 * 60e3 && a.n >= 10) return false;
    return true;
  }
  function fail(key) { const now = Date.now(); const a = attempts.get(key); attempts.set(key, a && now - a.ts < 15 * 60e3 ? { n: a.n + 1, ts: a.ts } : { n: 1, ts: now }); }

  const router = express.Router();
  router.use(express.json({ limit: '300kb' }));
  // CSRF defence in depth: state-changing requests must be JSON (cross-site forms/fetch cannot send that without CORS)
  router.use((req, res, next) => {
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
    req.user = sessionUser(parseCookies(req.headers.cookie)[COOKIE]);
    if (req.user) lastSeen.set(req.user.username.toLowerCase(), Date.now());
    next();
  });
  const need = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in' }));
  const uidOf = (u) => u.username.toLowerCase();

  // ------------------------------------------------------------ auth
  router.post('/register', async (req, res) => {
    const { username, password } = req.body || {};
    if (!USER_RE.test(String(username))) return res.status(400).json({ error: 'Username: 3–20 letters, numbers or _' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8–72 characters' });
    const uid = username.toLowerCase();
    if (!throttle('reg|' + req.ip)) return res.status(429).json({ error: 'Too many attempts, try later' });
    if (userOf(uid)) return res.status(409).json({ error: 'That username is taken' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = { username, salt, hash: await hashPw(password, salt), created: Date.now(), rating: 1200, wins: 0, losses: 0, draws: 0, friends: [], incoming: [], outgoing: [] };
    store.set('users', uid, user);
    startSession(req, res, uid);
    res.json({ user: publicUser(user) });
  });

  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    const key = 'login|' + req.ip + '|' + String(username).toLowerCase();
    if (!throttle(key)) return res.status(429).json({ error: 'Too many attempts, try again in a few minutes' });
    const u = USER_RE.test(String(username)) ? userOf(String(username).toLowerCase()) : null;
    const hash = u ? await hashPw(String(password), u.salt) : null;
    const ok = u && hash.length === u.hash.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.hash));
    if (!ok) { fail(key); return res.status(401).json({ error: 'Wrong username or password' }); }
    attempts.delete(key);
    startSession(req, res, uidOf(u));
    res.json({ user: publicUser(u) });
  });

  router.post('/logout', (req, res) => {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    if (t) store.del('sessions', sha(t));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

  router.post('/password', need, async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 72) return res.status(400).json({ error: 'New password must be 8–72 characters' });
    const u = req.user;
    const h = await hashPw(String(oldPassword), u.salt);
    if (h.length !== u.hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.hash))) return res.status(401).json({ error: 'Current password is wrong' });
    u.salt = crypto.randomBytes(16).toString('hex'); u.hash = await hashPw(newPassword, u.salt);
    store.set('users', uidOf(u), u);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ friends
  const brief = (uid) => { const f = userOf(uid); return f ? { username: f.username, rating: f.rating, online: isOnline(uid) } : null; };
  router.get('/friends', need, (req, res) => {
    const u = req.user, me = uidOf(u);
    const now = Date.now();
    const mine = (challenges.get(me) || []).filter((c) => now - c.ts < 15 * 60e3 && hooks.isGameWaiting(c.id));
    challenges.set(me, mine);
    res.json({
      me: publicUser(u),
      friends: u.friends.map(brief).filter(Boolean).sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username)),
      incoming: u.incoming.map(brief).filter(Boolean), outgoing: u.outgoing.map(brief).filter(Boolean),
      challenges: mine,
    });
  });

  router.post('/friends/request', need, (req, res) => {
    const u = req.user, me = uidOf(u), them = String(req.body?.username || '').toLowerCase();
    const t = USER_RE.test(them) ? userOf(them) : null;
    if (!t) return res.status(404).json({ error: 'No user with that name' });
    if (them === me) return res.status(400).json({ error: "You can't add yourself" });
    if (u.friends.includes(them)) return res.status(409).json({ error: 'Already friends' });
    if (u.incoming.includes(them)) { // they already asked us: accept
      u.incoming = u.incoming.filter((x) => x !== them); t.outgoing = t.outgoing.filter((x) => x !== me);
      u.friends.push(them); t.friends.push(me);
    } else if (!u.outgoing.includes(them)) { u.outgoing.push(them); t.incoming.push(me); }
    store.set('users', me, u); store.set('users', them, t);
    res.json({ ok: true });
  });
  const answer = (accept) => (req, res) => {
    const u = req.user, me = uidOf(u), them = String(req.body?.username || '').toLowerCase();
    const t = userOf(them);
    if (!t || !u.incoming.includes(them)) return res.status(404).json({ error: 'No such request' });
    u.incoming = u.incoming.filter((x) => x !== them); t.outgoing = t.outgoing.filter((x) => x !== me);
    if (accept) { u.friends.push(them); t.friends.push(me); }
    store.set('users', me, u); store.set('users', them, t);
    res.json({ ok: true });
  };
  router.post('/friends/accept', need, answer(true));
  router.post('/friends/decline', need, answer(false));
  router.post('/friends/remove', need, (req, res) => {
    const u = req.user, me = uidOf(u), them = String(req.body?.username || '').toLowerCase();
    const t = userOf(them);
    u.friends = u.friends.filter((x) => x !== them); u.outgoing = u.outgoing.filter((x) => x !== them);
    if (t) { t.friends = t.friends.filter((x) => x !== me); t.incoming = t.incoming.filter((x) => x !== me); store.set('users', them, t); }
    store.set('users', me, u);
    res.json({ ok: true });
  });

  router.get('/users/:name', need, (req, res) => {
    const t = userOf(String(req.params.name).toLowerCase());
    if (!t) return res.status(404).json({ error: 'No such user' });
    res.json({ user: publicUser(t), isFriend: req.user.friends.includes(uidOf(t)) });
  });

  // ------------------------------------------------------------ challenges
  router.post('/challenge', need, (req, res) => {
    const u = req.user, me = uidOf(u), to = String(req.body?.to || '').toLowerCase();
    if (!u.friends.includes(to)) return res.status(403).json({ error: 'You can only challenge friends' });
    const { base = 180, inc = 0, color = 'r' } = req.body || {};
    const { id, token, color: myColor } = hooks.createChallengeGame({ uid: me, name: u.username, base: +base, inc: +inc, color }, to);
    const list = challenges.get(to) || [];
    list.push({ from: u.username, id, base: Math.max(0, Math.min(+base | 0, 10800)), inc: Math.max(0, Math.min(+inc | 0, 60)), ts: Date.now() });
    challenges.set(to, list);
    res.json({ id, token, color: myColor });
  });
  router.post('/challenge/decline', need, (req, res) => {
    const me = uidOf(req.user);
    challenges.set(me, (challenges.get(me) || []).filter((c) => c.id !== req.body?.id));
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ game history
  const summary = (r) => ({ id: r.id, kind: r.kind, white: r.white, black: r.black, result: r.result, reason: r.reason, date: r.date, tc: r.tc, moves: r.moves, opponent: r.opponent, color: r.color, review: r.review, created: r.created });
  const canSee = (u, r) => { const me = uidOf(u); return r.uids.includes(me) || r.uids.some((x) => u.friends.includes(x)); };

  router.get('/games', need, (req, res) => {
    const me = uidOf(req.user);
    const list = store.all('games').filter((r) => r.uids.includes(me)).sort((a, b) => b.created - a.created).slice(0, 300).map(summary);
    res.json({ games: list });
  });
  router.get('/users/:name/games', need, (req, res) => {
    const them = String(req.params.name).toLowerCase();
    if (them !== uidOf(req.user) && !req.user.friends.includes(them)) return res.status(403).json({ error: 'Only friends can see game history' });
    const list = store.all('games').filter((r) => r.uids.includes(them) && r.kind === 'online').sort((a, b) => b.created - a.created).slice(0, 100).map(summary);
    res.json({ games: list });
  });
  router.get('/games/:id', need, (req, res) => {
    const r = store.get('games', req.params.id);
    if (!r || !canSee(req.user, r)) return res.status(404).json({ error: 'Not found' });
    res.json({ game: { ...summary(r), pgn: r.pgn } });
  });
  router.delete('/games/:id', need, (req, res) => {
    const r = store.get('games', req.params.id);
    if (!r || !r.uids.includes(uidOf(req.user))) return res.status(404).json({ error: 'Not found' });
    store.del('games', r.id);
    res.json({ ok: true });
  });
  router.post('/games', need, (req, res) => { // bot games reported by the browser
    const { pgn, opponent, color, result, date } = req.body || {};
    if (typeof pgn !== 'string' || pgn.length > 60000) return res.status(400).json({ error: 'Bad PGN' });
    if (!['1-0', '0-1', '1/2-1/2', '*'].includes(result)) return res.status(400).json({ error: 'Bad result' });
    let moves = 0;
    try { const c = new Chess(); c.loadPgn(pgn); moves = c.history().length; } catch { return res.status(400).json({ error: 'Unreadable PGN' }); }
    if (!moves) return res.status(400).json({ error: 'Empty game' });
    const me = uidOf(req.user);
    const rec = {
      id: 'b' + rid(9), kind: 'bot', white: color === 'b' ? String(opponent || 'Bot').slice(0, 40) : req.user.username, black: color === 'b' ? req.user.username : String(opponent || 'Bot').slice(0, 40),
      uids: [me], result, reason: '', date: String(date || '').slice(0, 10), tc: '', moves, opponent: String(opponent || '').slice(0, 40), color: color === 'b' ? 'b' : 'w', pgn, review: null, created: Date.now(),
    };
    store.set('games', rec.id, rec);
    res.json({ id: rec.id });
  });
  router.post('/games/:id/review', need, (req, res) => {
    const r = store.get('games', req.params.id);
    if (!r || !r.uids.includes(uidOf(req.user))) return res.status(404).json({ error: 'Not found' });
    const n = (x) => (Number.isFinite(+x) ? Math.max(0, Math.min(100, +x)) : null);
    r.review = { w: n(req.body?.w), b: n(req.body?.b), depth: Math.max(1, Math.min(60, +req.body?.depth || 0)) };
    store.set('games', r.id, r);
    res.json({ ok: true });
  });

  app.use('/api', router);

  // ------------------------------------------------------------ hooks used by the game server
  const K = 32;
  function recordOnlineGame(g) {
    const id = `${g.id}-${g.gameNo}`;
    if (store.get('games', id) || !g.sans.length) return;
    const uids = ['w', 'b'].map((c) => g.seats[c]?.uid).filter(Boolean);
    if (!uids.length) return; // guests only: nothing to store server-side
    const c = new Chess(); try { for (const s of g.sans) c.move(s); } catch { /* ignore */ }
    const white = g.seats.w?.name || '?', black = g.seats.b?.name || '?';
    c.setHeader('Event', 'Chess Lab online game'); c.setHeader('Date', new Date(g.created).toISOString().slice(0, 10).replace(/-/g, '.'));
    c.setHeader('White', white); c.setHeader('Black', black); c.setHeader('Result', g.result || '*');
    if (g.tc.base) c.setHeader('TimeControl', `${g.tc.base / 1000}+${g.tc.inc / 1000}`);
    const rec = {
      id, kind: 'online', white, black, uids, result: g.result || '*', reason: g.reason || '', date: new Date().toISOString().slice(0, 10),
      tc: g.tc.base ? `${g.tc.base / 60000}+${g.tc.inc / 1000}` : '∞', moves: g.sans.length, pgn: c.pgn(), review: null, created: Date.now(),
    };
    store.set('games', id, rec);
    // ratings + stats (only between two different accounts, and not for aborted/very short games)
    const wu = g.seats.w?.uid && userOf(g.seats.w.uid), bu = g.seats.b?.uid && userOf(g.seats.b.uid);
    const bump = (u, s) => { if (!u) return; if (s === 1) u.wins++; else if (s === 0) u.losses++; else u.draws++; };
    if (g.result && g.sans.length >= 2) {
      const sa = g.result === '1-0' ? 1 : g.result === '0-1' ? 0 : 0.5;
      bump(wu, sa); bump(bu, 1 - sa);
      if (wu && bu && wu !== bu && g.sans.length >= 4) {
        const ea = 1 / (1 + 10 ** ((bu.rating - wu.rating) / 400));
        wu.rating = Math.round(wu.rating + K * (sa - ea)); bu.rating = Math.round(bu.rating + K * ((1 - sa) - (1 - ea)));
      }
      if (wu) store.set('users', uidOf(wu), wu);
      if (bu) store.set('users', uidOf(bu), bu);
    }
  }

  return { userFromCookieHeader, recordOnlineGame, uidOf, canReserve: (uid) => !!userOf(uid) };
}
