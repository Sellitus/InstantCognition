// annotate — page annotation mode for the webview preload. The host page
// sends `ic-annotate:start`; a full-viewport catcher layer (inside a closed
// shadow root, so page CSS cannot restyle it) outlines the element under the
// pointer, and a click reports that element to the host with
// sendToHost('ic-annotate:picked', payload). Escape exits and reports
// `ic-annotate:cancelled`; `ic-annotate:stop` from the host exits silently.
//
// While inactive nothing is attached to the page: only the two IPC
// listeners exist. The catcher swallows the pick click, so the page never
// sees it. The HTML snippet is serialized markup for the model to read; it
// is capped and never inserted or executed anywhere.

const { describeElement, isSensitiveField } = require('../agent/recorder/domDescribe');

const MAX_TEXT = 500;
const MAX_HTML = 2000;
const MAX_URL = 2048;
const HOST_ATTR = 'data-ic-annotate';

// The overlay lives in the guest page, where the app's design tokens do not
// exist, so its colors are fixed here.
const OVERLAY_CSS = [
  '.catcher{position:fixed;inset:0;cursor:crosshair;pointer-events:auto;background:transparent}',
  '.box{position:fixed;display:none;pointer-events:none;box-sizing:border-box;border:2px solid #2563eb;',
  'background:rgba(37,99,235,.12);border-radius:3px}',
  '.tag{position:fixed;display:none;pointer-events:none;max-width:320px;overflow:hidden;white-space:nowrap;',
  'text-overflow:ellipsis;font:12px/1.4 system-ui,sans-serif;color:#fff;background:#1e3a8a;padding:2px 6px;border-radius:3px}',
].join('');

const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// outerHTML omits typed values, but a value attribute can still carry a
// prefilled secret, so sensitive fields lose it before serializing.
function htmlSnippet(el) {
  const fields = [el, ...Array.from(el.querySelectorAll('input'))];
  const hint = (f) => ({ type: f.getAttribute('type'), autocomplete: f.getAttribute('autocomplete'), name: f.getAttribute('name'), id: f.getAttribute('id') });
  if (!fields.some((f) => f.tagName === 'INPUT' && f.hasAttribute('value') && isSensitiveField(hint(f)))) {
    return String(el.outerHTML || '').slice(0, MAX_HTML);
  }
  const copy = /** @type {Element} */ (el.cloneNode(true));
  for (const f of [copy, ...Array.from(copy.querySelectorAll('input'))]) {
    if (f.tagName === 'INPUT' && isSensitiveField(hint(f))) f.removeAttribute('value');
  }
  return String(copy.outerHTML || '').slice(0, MAX_HTML);
}

/**
 * The payload sent to the host for a picked element. rect is in the page's
 * CSS pixels; viewport lets the host scale it to the webview's on-screen box.
 * @param {Element} el
 * @param {Window} win
 */
function buildPick(el, win) {
  const d = describeElement(el) || { selector: '', strategy: 'css', role: '', name: '', tag: '' };
  const r = el.getBoundingClientRect();
  const h = /** @type {HTMLElement} */ (el);
  return {
    selector: d.selector,
    strategy: d.strategy,
    role: d.role,
    name: d.name,
    tag: d.tag,
    rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    viewport: { width: win.innerWidth, height: win.innerHeight },
    text: clean(h.innerText || el.textContent, MAX_TEXT),
    htmlSnippet: htmlSnippet(el),
    url: clean(win.location && win.location.href, MAX_URL),
    title: clean(win.document.title, 200),
  };
}

/**
 * Wire annotation mode into a page. Returns a small control surface (used by
 * tests), or null when there is no page.
 * @param {{ on: Function, sendToHost: Function }} ipc
 * @param {Window|null} win
 */
function install(ipc, win) {
  if (!win || !win.document || !ipc || typeof ipc.on !== 'function') return null;
  const doc = win.document;
  let host = null;
  let catcher = null;
  let box = null;
  let tag = null;
  /** @type {Element|null} */ let hovered = null;

  const isActive = () => host !== null;

  function elementAt(x, y) {
    if (typeof doc.elementsFromPoint !== 'function') return null;
    return doc.elementsFromPoint(x, y).find((e) => e !== host && e !== doc.documentElement && e !== doc.body) || null;
  }

  function paint() {
    if (!hovered || !hovered.isConnected) { box.style.display = 'none'; tag.style.display = 'none'; return; }
    const r = hovered.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const d = describeElement(hovered);
    tag.textContent = d ? (d.name || d.text ? `${d.role || d.tag} · ${d.name || d.text}` : d.selector) : '';
    Object.assign(tag.style, { display: 'block', left: `${Math.max(0, r.left)}px`, top: `${Math.max(0, r.top - 22)}px` });
  }

  function onMove(e) {
    const next = elementAt(e.clientX, e.clientY);
    if (next !== hovered) { hovered = next; paint(); }
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const target = elementAt(e.clientX, e.clientY) || hovered;
    if (!target) return;
    const payload = buildPick(target, win);
    stop();
    ipc.sendToHost('ic-annotate:picked', payload);
  }
  function swallow(e) { e.preventDefault(); e.stopPropagation(); }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    stop();
    ipc.sendToHost('ic-annotate:cancelled');
  }
  function onScroll() { if (hovered) paint(); }

  function start() {
    if (isActive()) return;
    host = doc.createElement('div');
    host.setAttribute(HOST_ATTR, '');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = OVERLAY_CSS;
    catcher = doc.createElement('div');
    catcher.className = 'catcher';
    box = doc.createElement('div');
    box.className = 'box';
    tag = doc.createElement('div');
    tag.className = 'tag';
    root.append(style, catcher, box, tag);
    catcher.addEventListener('mousemove', onMove);
    catcher.addEventListener('click', onClick);
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu']) catcher.addEventListener(type, swallow);
    win.addEventListener('keydown', onKey, true);
    win.addEventListener('scroll', onScroll, true);
    (doc.documentElement || doc.body).appendChild(host);
  }

  function stop() {
    if (!isActive()) return;
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('scroll', onScroll, true);
    host.remove();
    host = null;
    catcher = null;
    box = null;
    tag = null;
    hovered = null;
  }

  ipc.on('ic-annotate:start', () => start());
  ipc.on('ic-annotate:stop', () => stop());
  return { start, stop, isActive };
}

module.exports = { install, buildPick, MAX_TEXT, MAX_HTML };
