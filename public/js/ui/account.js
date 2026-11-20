// Sign in / register / sign out, header account chip, and background polling for friend requests + challenges.
import { h, clear, toast, modal } from './dom.js';
import { app, api } from './app.js';

const userListeners = new Set();
export const onUser = (fn) => { userListeners.add(fn); return () => userListeners.delete(fn); };
const emitUser = () => userListeners.forEach((fn) => fn(app.user));

let chip, pollTimer = null;
const seen = new Set();
let banners;

export async function initAccount() {
  chip = document.getElementById('acct');
  try {
    const r = await fetch('api/me', { credentials: 'same-origin' });
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error('no server');
    app.hasServer = true;
    app.user = (await r.json()).user;
  } catch { app.hasServer = false; }
  document.documentElement.classList.toggle('noserver', !app.hasServer);
  renderChip();
  if (app.user) startPolling();
}

function setUser(u) {
  app.user = u; app.social = null;
  renderChip(); emitUser();
  if (u) startPolling(); else stopPolling();
}

export function renderChip() {
  if (!chip) return;
  clear(chip);
  if (!app.hasServer) return;
  if (!app.user) { chip.append(h('button.btn.tiny.primary', { onclick: () => openAuth('login') }, 'Sign in')); return; }
  const menu = h('div.menu', { style: { display: 'none' } },
    h('button', { onclick: () => { menu.style.display = 'none'; app.go('social'); } }, '👥 Friends & history'),
    h('button', { onclick: () => { menu.style.display = 'none'; changePassword(); } }, '🔑 Change password'),
    h('button', { onclick: async () => { menu.style.display = 'none'; try { await api('logout', {}); } catch { /* ignore */ } setUser(null); toast('Signed out'); } }, '⎋ Sign out'));
  const btn = h('button.userchip', { onclick: (e) => { e.stopPropagation(); menu.style.display = menu.style.display === 'none' ? '' : 'none'; } },
    h('span.dotonline'), h('b', app.user.username), h('small', ` ${app.user.rating}`));
  document.addEventListener('click', () => { menu.style.display = 'none'; });
  chip.append(btn, menu);
}

export function openAuth(mode = 'login') {
  if (!app.hasServer) return toast('Accounts need the server (not available on this static site).', 'err');
  const err = h('div.autherr');
  const user = h('input', { type: 'text', placeholder: 'Username', autocomplete: 'username', autocapitalize: 'off', maxlength: 20 });
  const pw = h('input', { type: 'password', placeholder: 'Password (8+ characters)', autocomplete: mode === 'login' ? 'current-password' : 'new-password' });
  const pw2 = h('input', { type: 'password', placeholder: 'Repeat password', autocomplete: 'new-password' });
  const submit = h('button.btn.primary.big', { type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account');
  const form = h('form.authform', { onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (mode === 'register' && pw.value !== pw2.value) { err.textContent = 'Passwords do not match'; return; }
    submit.disabled = true;
    try {
      const j = await api(mode === 'login' ? 'login' : 'register', { username: user.value.trim(), password: pw.value });
      wrap.remove(); setUser(j.user); toast(`Welcome, ${j.user.username}!`, 'ok');
    } catch (ex) { err.textContent = ex.message; submit.disabled = false; }
  } },
  user, pw, mode === 'register' ? pw2 : null, err, submit,
  h('div.muted.small.center', mode === 'login' ? ['No account? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); wrap.remove(); openAuth('register'); } }, 'Create one')]
    : ['Already registered? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); wrap.remove(); openAuth('login'); } }, 'Sign in')]),
  mode === 'register' ? h('div.muted.small', 'No email needed. Pick a username your friends can find; your password is stored hashed.') : null);
  const wrap = h('div.modal-wrap', { onclick: (e) => { if (e.target === wrap) wrap.remove(); } }, h('div.modal', h('h3', mode === 'login' ? 'Sign in' : 'Create your account'), form));
  document.body.append(wrap);
  user.focus();
}

async function changePassword() {
  const o = h('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
  const n = h('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
  const r = await modal({ title: 'Change password', body: h('div.authform', o, n), buttons: [{ label: 'Cancel', value: false }, { label: 'Change', value: true, primary: true }] });
  if (!r) return;
  try { await api('password', { oldPassword: o.value, newPassword: n.value }); toast('Password changed', 'ok'); } catch (e) { toast(e.message, 'err'); }
}

// ---------------------------------------------------------------- polling: requests + challenges
function startPolling() { stopPolling(); poll(); pollTimer = setInterval(poll, 6000); }
function stopPolling() { clearInterval(pollTimer); pollTimer = null; banners?.remove(); banners = null; seen.clear(); }

export async function poll() {
  if (!app.user) return;
  try {
    const d = await api('friends');
    app.social = d;
    if (d.me && JSON.stringify(d.me) !== JSON.stringify(app.user)) { app.user = d.me; renderChip(); }
    const n = d.incoming.length + d.challenges.length;
    const navBtn = document.querySelector('#nav button[data-view="social"]');
    if (navBtn) navBtn.dataset.badge = n ? String(n) : '';
    app.views.social?.refresh?.(d);
    for (const c of d.challenges) if (!seen.has(c.id)) { seen.add(c.id); showChallenge(c); }
  } catch (e) {
    if (/sign in/i.test(e.message)) setUser(null);
  }
}

function showChallenge(c) {
  if (!banners) { banners = h('div#challenges'); document.body.append(banners); }
  const tc = c.base ? `${c.base / 60}${c.inc ? '+' + c.inc : ' min'}` : 'unlimited';
  const card = h('div.challenge', h('div', h('b', c.from), ` challenges you to a ${tc} game`),
    h('div.btnrow', h('button.btn.primary.tiny', { onclick: () => { card.remove(); acceptChallenge(c); } }, 'Accept'),
      h('button.btn.tiny', { onclick: async () => { card.remove(); try { await api('challenge/decline', { id: c.id }); } catch { /* ignore */ } } }, 'Decline')));
  banners.append(card);
  import('./sound.js').then(({ sound }) => sound.notify());
}

export function acceptChallenge(c) {
  app.go('friend');
  history.pushState({}, '', '/g/' + c.id);
  app.views.online.join(c.id);
}
