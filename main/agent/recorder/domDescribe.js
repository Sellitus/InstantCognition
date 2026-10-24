// domDescribe — page-side helpers shared by the action recorder (inlined into
// the CDP capture script via Function#toString) and the annotation preload
// (called directly). Each function must stay self-contained: no references to
// module scope, no closures, ES5 only, because the recorder ships its source
// text into arbitrary pages. The istanbul hints keep coverage counters out of
// that source text; an instrumented copy would throw inside the page.

/**
 * Describe an element with the most robust locator available, in priority
 * order: id, data-testid, aria-label, name attribute, then a structural CSS
 * path. role + accessible name and visible text ride along so a replayer can
 * fall back to them when the CSS selector no longer matches.
 * @param {Element} el
 * @returns {{ selector: string, strategy: string, tag: string, role: string, name: string, text: string } | null}
 */
/* istanbul ignore next */
function describeElement(el) {
  var MAX_TEXT = 80;
  var MAX_SELECTOR = 300;
  if (!el || el.nodeType !== 1) return null;
  var doc = el.ownerDocument;
  var SIMPLE_ID = /^[A-Za-z][\w-]*$/;
  // Framework-generated ids (React :r1:, ember123, long digit runs, hashes)
  // change between page loads, so they make brittle selectors.
  var VOLATILE_ID = /^:|\d{4,}|^ember\d|^[a-f0-9]{10,}$/i;

  function clean(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }
  function attrSel(name, v) { return '[' + name + '="' + String(v).replace(/["\\]/g, '\\$&') + '"]'; }
  function idSel(id) { return SIMPLE_ID.test(id) ? '#' + id : attrSel('id', id); }
  // A candidate the page's engine cannot parse is not a usable selector, so
  // the SyntaxError means "try the next strategy".
  function unique(sel) {
    try { return doc.querySelectorAll(sel).length === 1; } catch (_syntaxError) { return false; }
  }
  function roleOf(e) {
    var explicit = e.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    var tag = e.tagName.toLowerCase();
    var type = (e.getAttribute('type') || '').toLowerCase();
    if (tag === 'button' || (tag === 'input' && /^(button|submit|reset|image)$/.test(type))) return 'button';
    if (tag === 'a' && e.hasAttribute('href')) return 'link';
    if (tag === 'input' && type === 'checkbox') return 'checkbox';
    if (tag === 'input' && type === 'radio') return 'radio';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea' || (tag === 'input' && !/^(hidden|file|range|color)$/.test(type))) return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    return '';
  }
  function isField(e) { return /^(input|textarea|select)$/i.test(e.tagName); }
  function textOf(e) {
    if (isField(e)) return '';
    return clean(e.innerText || e.textContent, MAX_TEXT);
  }
  function nameOf(e) {
    var aria = e.getAttribute('aria-label');
    if (aria) return clean(aria, MAX_TEXT);
    var labelledBy = e.getAttribute('aria-labelledby');
    if (labelledBy) {
      var parts = labelledBy.split(/\s+/).map(function (id) {
        var ref = doc.getElementById(id);
        return ref ? ref.textContent : '';
      }).join(' ');
      if (clean(parts, MAX_TEXT)) return clean(parts, MAX_TEXT);
    }
    if (isField(e)) {
      var forLabel = e.id ? doc.querySelector('label' + attrSel('for', e.id)) : null;
      var label = forLabel || (e.closest ? e.closest('label') : null);
      if (label && clean(label.textContent, MAX_TEXT)) return clean(label.textContent, MAX_TEXT);
      return clean(e.getAttribute('title') || e.getAttribute('name'), MAX_TEXT);
    }
    return clean(e.getAttribute('alt') || e.getAttribute('title') || textOf(e), MAX_TEXT);
  }
  function cssPath(e) {
    var parts = [];
    var cur = e;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      var tag = cur.tagName.toLowerCase();
      var cid = cur.getAttribute('id');
      if (cid && !VOLATILE_ID.test(cid) && unique(idSel(cid))) { parts.unshift(idSel(cid)); break; }
      var parent = cur.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var same = 0;
      var index = 0;
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === cur.tagName) {
          same += 1;
          if (parent.children[i] === cur) index = same;
        }
      }
      parts.unshift(same > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
      cur = parent;
    }
    return parts.join(' > ');
  }

  var tag = el.tagName.toLowerCase();
  var out = { selector: '', strategy: 'css', tag: tag, role: roleOf(el), name: nameOf(el), text: textOf(el) };
  var id = el.getAttribute('id');
  var testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
  var aria = el.getAttribute('aria-label');
  var fieldName = isField(el) ? el.getAttribute('name') : '';
  var candidates = [];
  if (id && !VOLATILE_ID.test(id)) candidates.push(['id', idSel(id)]);
  if (testId) candidates.push(['testid', attrSel('data-testid', testId)]);
  if (aria) candidates.push(['aria-label', tag + attrSel('aria-label', aria)]);
  if (fieldName) candidates.push(['name', tag + attrSel('name', fieldName)]);
  for (var c = 0; c < candidates.length; c++) {
    if (candidates[c][1].length <= MAX_SELECTOR && unique(candidates[c][1])) {
      out.strategy = candidates[c][0];
      out.selector = candidates[c][1];
      return out;
    }
  }
  out.selector = cssPath(el).slice(0, MAX_SELECTOR);
  if (out.role && out.name) out.strategy = 'role';
  else if (out.text) out.strategy = 'text';
  return out;
}

/**
 * True for fields whose value must never leave the page: passwords, payment
 * card fields (autocomplete cc-*), one-time codes, PINs and similar secrets.
 * Over-matching is the safe direction, but name/id hints are split into words
 * (camelCase humps, punctuation) so `pin` matches pin_code and not spinner.
 * @param {{ type?: string|null, autocomplete?: string|null, name?: string|null, id?: string|null }} hints
 * @returns {boolean}
 */
/* istanbul ignore next */
function isSensitiveField(hints) {
  if (!hints || typeof hints !== 'object') return false;
  if (String(hints.type || '').toLowerCase() === 'password') return true;
  var tokens = String(hints.autocomplete || '').toLowerCase().split(/\s+/);
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i];
    if (t.indexOf('cc-') === 0 || t === 'current-password' || t === 'new-password' || t === 'one-time-code') return true;
  }
  var raw = String(hints.name || '') + ' ' + String(hints.id || '');
  // Words separated by single spaces, padded: a leading space marks a word start.
  var words = ' ' + raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).join(' ') + ' ';
  return /pass(word|wd)|pwd|cvv|cvc|securitycode| (pin|otp|totp|mfa|ssn|csc)\d* | (pin|pass)code| passphrase| (credit)?card| cc ?(num|no |exp|csc|cvv|cvc|name|type|holder)| one ?time| expir| security ?code/.test(words);
}

module.exports = { describeElement, isSensitiveField };
