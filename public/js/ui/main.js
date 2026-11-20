// App shell: tabs, theme, sound toggle, and routing for /g/<id> invite links.
import { app } from './app.js';
import { $, $$, store } from './dom.js';
import { sound } from './sound.js';
import { createPlayView } from './play.js';
import { createOnlineView } from './online.js';
import { createAnalysisView } from './analysis.js';
import { createSocialView } from './social.js';
import { initAccount } from './account.js';
import { openSettings, applyBoardTheme, applyPieceSet } from './settings.js';

const factories = { bots: createPlayView, friend: createOnlineView, analysis: createAnalysisView, social: createSocialView };
const created = {};
let current = null;

function nav(name) {
  if (!factories[name]) name = 'bots';
  if (current && created[current]?.deactivate) created[current].deactivate();
  current = name;
  if (!created[name]) {
    created[name] = factories[name]($('#view-' + name));
    app.views[{ bots: 'play', friend: 'online', analysis: 'analysis', social: 'social' }[name]] = created[name];
  }
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  created[name].activate?.();
  try { sessionStorage.setItem('chesslab.view', name); } catch { /* ignore */ }
  window.scrollTo(0, 0);
}
app.nav = nav;

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  if (location.pathname.startsWith('/g/')) history.pushState({}, '', new URL('./', document.baseURI).pathname);
  nav(b.dataset.view);
});

// theme + sound
const root = document.documentElement;
const applyTheme = (t) => { root.dataset.theme = t; store.set('theme', t); };
applyTheme(store.get('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
$('#themeBtn').onclick = () => applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
const paintSound = () => { $('#soundBtn').textContent = sound.muted ? '🔇' : '🔊'; };
$('#soundBtn').onclick = () => { sound.setMuted(!sound.muted); paintSound(); };
paintSound();
app.onStatus((s) => { $('#engStatus').textContent = s; });

// full screen / focus mode: hides the header and gives the board the whole window
function setFocus(on) {
  document.documentElement.classList.toggle('focus', on);
  if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  window.dispatchEvent(new Event('resize'));
}
$('#fsExit').onclick = () => setFocus(false);
$('#fsBtn').onclick = () => setFocus(!document.documentElement.classList.contains('focus'));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) document.documentElement.classList.remove('focus'); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.documentElement.classList.contains('focus') && !document.fullscreenElement) setFocus(false);
  if ((e.key === 'z' || e.key === 'Z') && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && !e.ctrlKey && !e.metaKey) setFocus(!document.documentElement.classList.contains('focus'));
});
applyBoardTheme();
applyPieceSet();
$('#setBtn').onclick = () => openSettings();
app.views = {};
app.loadOpenings();

initAccount();

// routing
const m = location.pathname.match(/^\/g\/([A-Za-z0-9]{8})$/);
if (m) {
  nav('friend');
  created.friend.join(m[1]);
} else {
  nav(sessionStorage.getItem('chesslab.view') === 'analysis' ? 'analysis' : sessionStorage.getItem('chesslab.view') === 'friend' ? 'friend' : 'bots');
}
// warm up the bot engine while the user picks an opponent
if (current === 'bots') setTimeout(() => app.botEngine(), 400);
