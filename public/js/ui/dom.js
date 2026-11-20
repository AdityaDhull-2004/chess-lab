// Tiny DOM helpers.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div.card#id', {onclick, dataset:{x:1}, class:'a'}, child, 'text', [children]) */
export function h(tag, props, ...kids) {
  const m = tag.match(/^([a-z0-9]+)((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m ? m[1] : tag);
  if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g)) { if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1); }
  if (props != null && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.classList.add(...String(v).split(/\s+/).filter(Boolean));
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtClock(ms) {
  if (ms == null) return '';
  ms = Math.max(0, ms);
  const tenths = Math.floor(ms / 100) % 10;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60), sec = s % 60;
  if (ms < 10000) return `${m}:${String(sec).padStart(2, '0')}.${tenths}`;
  const hr = Math.floor(m / 60);
  return hr ? `${hr}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

let toastBox;
export function toast(msg, kind = '') {
  if (!toastBox) { toastBox = h('div#toasts'); document.body.append(toastBox); }
  const t = h('div.toast', { class: kind }, msg);
  toastBox.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3200);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'ok'); return true; }
  catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }); ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); toast(ok ? 'Copied to clipboard' : 'Copy failed', ok ? 'ok' : 'err'); return ok;
  }
}

/** Small modal. Returns a promise resolving to the clicked button's value. */
export function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }] }) {
  return new Promise((resolve) => {
    const close = (v) => { wrap.remove(); resolve(v); };
    const wrap = h('div.modal-wrap', { onclick: (e) => { if (e.target === wrap) close(null); } },
      h('div.modal', h('h3', title), typeof body === 'string' ? h('p', body) : body,
        h('div.modal-btns', buttons.map((b) => h('button.btn', { class: b.primary ? 'primary' : b.danger ? 'danger' : '', onclick: () => close(b.value) }, b.label)))));
    document.body.append(wrap);
  });
}
export const confirmBox = (title, body, yes = 'Yes', no = 'Cancel') =>
  modal({ title, body, buttons: [{ label: no, value: false }, { label: yes, value: true, primary: true }] });

export const store = {
  get(k, d) { try { const v = localStorage.getItem('chesslab.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('chesslab.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

export const pieceSet = () => store.get('pieceSet', 'cburnett');
export const pieceUrl = (color, type) => `pieces/${pieceSet()}/${color}${type.toUpperCase()}.svg`;
export const pieceImg = (color, type, cls = 'pc') => h('img', { class: cls, src: pieceUrl(color, type), alt: '', draggable: 'false' });
