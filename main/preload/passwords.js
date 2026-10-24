// passwords — saved-login capture and fill for the webview preload.
//
// Webviews run with nodeIntegrationInSubFrames off, so this only ever runs in
// a guest's top frame and never touches cross-origin iframes. On a login
// submit by the user (form submit, Enter in a field, or a click on a submit
// control; events a script dispatched are ignored) with a filled password
// field it sends { username, password } to main, which takes the origin from
// the sender frame, never from this payload. Card and one-time-code fields
// are never a login. A fill from main is applied only while the page is still
// on the origin main expected.

const DEDUPE_MS = 2000;
const USERNAME_TYPES = new Set(['text', 'email', 'tel']);

function isVisible(el, win) {
  if (el.hidden || el.disabled || el.type === 'hidden') return false;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hidden) return false;
    const style = win.getComputedStyle(n);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

const autocompleteTokens = (el) => (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);

// Sites mask a card's security code or a one-time code as type=password.
const isCardOrOneTimeCode = (el) => autocompleteTokens(el).some((t) => t.startsWith('cc-') || t === 'one-time-code');

const passwordFields = (scope, win) => Array.from(scope.querySelectorAll('input[type="password"]'))
  .filter((el) => isVisible(el, win) && !isCardOrOneTimeCode(el));

/**
 * The username field for `pw`: a visible text/email/tel input before it in
 * `scope`, preferring autocomplete=username|email. When reading a submit
 * (`needValue`), a filled autocomplete=username field the page keeps hidden
 * or read-only on a two-step sign-in's password step comes next, then the
 * nearest visible input.
 */
function usernameFieldFor(scope, pw, win, needValue) {
  const inputs = Array.from(scope.querySelectorAll('input')).filter((el) => !isCardOrOneTimeCode(el));
  const before = inputs.filter((el) => USERNAME_TYPES.has(el.type)
    && isVisible(el, win)
    && (el.compareDocumentPosition(pw) & win.Node.DOCUMENT_POSITION_FOLLOWING)
    && (!needValue || el.value.trim()));
  const hinted = before.filter((el) => /\b(username|email)\b/i.test(el.getAttribute('autocomplete') || ''));
  if (hinted.length) return hinted[hinted.length - 1];
  if (needValue) {
    const kept = inputs.find((el) => el.type !== 'password' && autocompleteTokens(el).includes('username') && el.value.trim());
    if (kept) return kept;
  }
  return before[before.length - 1] || null;
}

/**
 * Credentials a login submit in `scope` (a form or the document) would send,
 * or null when it has no filled visible password field. With several filled
 * password fields (sign-up confirm, change-password) the last is the new one.
 * @returns {{ username: string, password: string } | null}
 */
function extractCredentials(scope, win) {
  const filled = passwordFields(scope, win).filter((el) => el.value);
  const last = filled[filled.length - 1];
  if (!last) return null;
  const user = usernameFieldFor(scope, filled[0], win, true);
  return { username: user ? user.value.trim() : '', password: last.value };
}

// The prototype setter bypasses a framework's instance-level value override
// (React's tracker), so the input event below registers as a real change.
function setValue(el, value, win) {
  const desc = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value');
  desc.set.call(el, value);
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
}

// The focused field's form when it holds a login, else the page's first one.
function targetPasswordField(win) {
  const doc = win.document;
  const active = doc.activeElement;
  if (active && active.tagName === 'INPUT') {
    if (active.type === 'password' && isVisible(active, win)) return active;
    if (active.form) {
      const inForm = passwordFields(active.form, win)[0];
      if (inForm) return inForm;
    }
  }
  return passwordFields(doc, win)[0] || null;
}

/**
 * @param {{ origin?: string, username?: string, password?: string }} payload
 * @returns {{ ok: true } | { ok: false, reason: 'origin-mismatch' | 'no-form' }}
 */
function fillCredentials(win, payload) {
  const p = payload || {};
  if (typeof p.origin !== 'string' || win.location.origin !== p.origin || typeof p.password !== 'string') {
    return { ok: false, reason: 'origin-mismatch' };
  }
  const pw = targetPasswordField(win);
  if (!pw) return { ok: false, reason: 'no-form' };
  const user = usernameFieldFor(pw.form || win.document, pw, win, false);
  if (user && p.username) setValue(user, p.username, win);
  setValue(pw, p.password, win);
  return { ok: true };
}

const isSubmitControl = (el) => (el.tagName === 'BUTTON' && el.type === 'submit')
  || (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'image'));

function install(ipcRenderer, win) {
  if (!win || !win.document || !win.location) return;
  if (win.location.protocol !== 'https:' && win.location.protocol !== 'http:') return;
  const doc = win.document;
  let lastKey = '';
  let lastAt = 0;

  // A click on a submit button also fires submit; report the pair once.
  const report = (scope) => {
    const creds = extractCredentials(scope, win);
    if (!creds) return;
    const key = `${creds.username}\u0000${creds.password}`;
    const now = Date.now();
    if (key === lastKey && now - lastAt < DEDUPE_MS) return;
    lastKey = key;
    lastAt = now;
    ipcRenderer.send('passwords:captured', creds);
  };

  doc.addEventListener('submit', (e) => {
    if (!e.isTrusted) return;
    const form = /** @type {HTMLFormElement} */ (e.target);
    if (form && form.tagName === 'FORM') report(form);
  }, true);
  doc.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    const t = /** @type {HTMLInputElement} */ (e.target);
    if (e.key === 'Enter' && t && t.tagName === 'INPUT') report(t.form || doc);
  }, true);
  doc.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const t = /** @type {Element} */ (e.target);
    const control = t && typeof t.closest === 'function' ? t.closest('button, input') : null;
    if (control && isSubmitControl(control)) report(/** @type {HTMLButtonElement} */ (control).form || doc);
  }, true);

  ipcRenderer.on('passwords:fill', (_e, payload) => {
    ipcRenderer.send('passwords:fill-result', fillCredentials(win, payload));
  });
}

module.exports = { install, extractCredentials, fillCredentials };
