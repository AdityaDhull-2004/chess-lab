// Opening names (ECO) keyed by position. Data: lichess chess-openings (CC0), see scripts/build-openings.mjs.
import { posKey } from './util.js';

let DB = null;
let loading = null;

export function setOpenings(obj) { DB = obj; }

export async function loadOpenings(url = 'data/openings.json') {
  if (DB) return DB;
  if (!loading) loading = fetch(url).then((r) => r.json()).then((j) => (DB = j)).catch(() => (DB = {}));
  return loading;
}

/** @returns {[string,string]|null} [eco, name] if this exact position is a known opening position */
export function openingFor(fen) {
  return DB ? DB[posKey(fen)] || null : null;
}
export const inBook = (fen) => !!openingFor(fen);
