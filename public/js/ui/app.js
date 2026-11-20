// Shared application state: engine instances, settings and cross-view navigation.
import { Engine } from '../core/engine.js';
import { loadOpenings } from '../core/openings.js';
import { store } from './dom.js';

const listeners = new Set();
const cores = Math.max(1, (navigator.hardwareConcurrency || 4));
export const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

export const isNumber = (x) => Number.isFinite(x);

/** JSON helper for the server API (throws Error with the server message). */
export async function api(path, body, method) {
  const r = await fetch('api/' + path, {
    method: method || (body !== undefined ? 'POST' : 'GET'), credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch { /* ignore */ }
  if (!r.ok) throw new Error(j?.error || 'Request failed (' + r.status + ')');
  return j;
}

export const app = {
  user: null, hasServer: false, social: null,
  cores,
  isolated,
  views: {},
  settings: {
    engineKind: window.CHESSLAB_LITE_ONLY ? 'lite' : store.get('engineKind',/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname) ? 'full' : 'lite'),
    threads: store.get('threads', Math.max(1, Math.min(isolated ? cores - 1 : 1, 8))),
  },
  status: '',
  _botEngine: null,
  _analysisEngine: null,
  _pool: [],

  onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  setStatus(s) { this.status = s; listeners.forEach((fn) => fn(s)); },

  /** Lite single-threaded engine used for bots, hints and quick evaluations. */
  botEngine() {
    if (!this._botEngine) this._botEngine = new Engine('lite', { threads: 1, hash: 32 });
    return this._botEngine;
  },

  /** Engine for live analysis (kind from settings). Re-created if the settings change. */
  analysisEngine() {
    const { engineKind, threads } = this.settings;
    const e = this._analysisEngine;
    if (e && e.kind === engineKind && e._threads === threads) return e;
    if (e) e.quit();
    this.setStatus('Loading engine…');
    const n = new Engine(engineKind, { threads, hash: engineKind === 'full' ? 256 : 64 });
    n._threads = threads;
    n.ready.then(() => this.setStatus(`${n.name}${n.multi ? ` · ${threads} threads` : ' · 1 thread'}`));
    this._analysisEngine = n;
    return n;
  },

  /** Engines used to review a whole game. Lite => several single-threaded workers in parallel. */
  reviewEngines() {
    if (this.settings.engineKind === 'full') return [this.analysisEngine()];
    const want = Math.max(1, Math.min(cores - 1, 6));
    while (this._pool.length < want) this._pool.push(new Engine('lite', { threads: 1, hash: 32, forceSingle: true }));
    return this._pool.slice(0, want);
  },

  setEngineKind(kind) { this.settings.engineKind = kind; store.set('engineKind', kind); },
  setThreads(n) { this.settings.threads = n; store.set('threads', n); },

  go(view) { this.nav?.(view); },
  /** Open the analysis board with a PGN/FEN; optionally start a full review. */
  openAnalysis(payload) {
    this.go('analysis');
    this.views.analysis?.load(payload);
  },
  loadOpenings,
};

// ---- locally saved games (bot games + online games), most recent first
export function saveGame(rec) {
  if (rec.kind === 'bot' && app.user) api('games', { pgn: rec.pgn, opponent: rec.opponent, color: rec.color, result: rec.result, date: rec.date }).catch(() => {});
  const list = store.get('games', []);
  list.unshift({ ...rec, saved: Date.now() });
  store.set('games', list.slice(0, 60));
}
export const savedGames = () => store.get('games', []);
