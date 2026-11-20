// Synthesised board sounds (no audio files needed) with selectable themes and volume.
import { store } from './dom.js';

let ctx = null;
let muted = store.get('muted', false);
let theme = store.get('soundTheme', 'wood');
let volume = store.get('volume', 0.8);
const ac = () => {
  if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
};

function thud(freq, gain, dur, q = 1.2) {
  const c = ac(); if (!c || muted || theme === 'none') return;
  const n = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  const src = c.createBufferSource(); src.buffer = buf;
  const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain(); g.gain.value = gain * volume;
  src.connect(f).connect(g).connect(c.destination); src.start();
}
function beep(freq, dur, gain = 0.08, when = 0, type = 'sine') {
  const c = ac(); if (!c || muted || theme === 'none') return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.value = freq;
  const t = c.currentTime + when, peak = Math.max(0.0002, gain * volume);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
}

// each theme: how a move / capture / check / castle sounds
export const SOUND_THEMES = {
  wood: { label: 'Wooden board',
    move: () => thud(900, 0.5, 0.06), capture: () => thud(500, 0.9, 0.11),
    check: () => { thud(700, 0.8, 0.09); beep(880, 0.12, 0.05, 0.02, 'triangle'); }, castle: () => { thud(900, 0.5, 0.06); setTimeout(() => thud(800, 0.5, 0.06), 90); } },
  clack: { label: 'Hard clack (marble)',
    move: () => { thud(1900, 0.7, 0.035, 3); beep(230, 0.05, 0.12, 0, 'triangle'); }, capture: () => { thud(1400, 1.1, 0.06, 3); beep(150, 0.1, 0.2, 0, 'triangle'); },
    check: () => { thud(1500, 1, 0.06, 3); beep(990, 0.14, 0.06, 0.03, 'triangle'); }, castle: () => { thud(1900, 0.7, 0.035, 3); setTimeout(() => thud(1700, 0.7, 0.035, 3), 80); } },
  click: { label: 'Soft click',
    move: () => thud(3200, 0.45, 0.02, 4), capture: () => thud(2200, 0.8, 0.04, 4),
    check: () => { thud(2600, 0.8, 0.04, 4); beep(1200, 0.08, 0.04, 0.02); }, castle: () => { thud(3200, 0.45, 0.02, 4); setTimeout(() => thud(3000, 0.45, 0.02, 4), 70); } },
  soft: { label: 'Soft tones',
    move: () => beep(420, 0.08, 0.12), capture: () => beep(260, 0.14, 0.16),
    check: () => { beep(520, 0.14, 0.12); beep(700, 0.16, 0.1, 0.08); }, castle: () => { beep(420, 0.07, 0.1); beep(520, 0.07, 0.1, 0.08); } },
  digital: { label: 'Digital / arcade',
    move: () => beep(660, 0.05, 0.07, 0, 'square'), capture: () => { beep(440, 0.06, 0.09, 0, 'square'); beep(330, 0.08, 0.09, 0.05, 'square'); },
    check: () => { beep(880, 0.07, 0.08, 0, 'square'); beep(1100, 0.1, 0.08, 0.07, 'square'); }, castle: () => { beep(660, 0.05, 0.07, 0, 'square'); beep(880, 0.05, 0.07, 0.07, 'square'); } },
  none: { label: 'No move sounds', move() {}, capture() {}, check() {}, castle() {} },
};

export const sound = {
  get muted() { return muted; },
  get theme() { return theme; },
  get volume() { return volume; },
  setMuted(v) { muted = v; store.set('muted', v); },
  setTheme(t) { if (SOUND_THEMES[t]) { theme = t; store.set('soundTheme', t); } },
  setVolume(v) { volume = Math.max(0, Math.min(1, v)); store.set('volume', volume); },
  move() { SOUND_THEMES[theme]?.move(); },
  capture() { SOUND_THEMES[theme]?.capture(); },
  check() { SOUND_THEMES[theme]?.check(); },
  castle() { SOUND_THEMES[theme]?.castle(); },
  start() { beep(523, 0.12, 0.06); beep(659, 0.16, 0.06, 0.1); },
  end() { beep(440, 0.18, 0.07); beep(330, 0.3, 0.07, 0.16); },
  notify() { beep(740, 0.1, 0.06); beep(988, 0.14, 0.06, 0.09); },
  low() { beep(1200, 0.05, 0.05, 0, 'square'); },
  forMove(m, chess) {
    if (chess?.isCheckmate?.() || chess?.inCheck?.()) return this.check();
    if (m.flags?.includes('k') || m.flags?.includes('q')) return this.castle();
    if (m.captured) return this.capture();
    return this.move();
  },
};
