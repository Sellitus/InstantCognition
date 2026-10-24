// domExtractor — produces a JS source string that, when executed inside a
// webview's page context via webContents.executeJavaScript() (or webview.executeJavaScript),
// returns a compact JSON-serializable observation of the page.
//
// The script is intentionally self-contained (single IIFE, no dependencies)
// and bounded in size so the result fits in an LLM context window.

const MAX_TEXT_LENGTH_DEFAULT = 8000;
const MAX_INTERACTIVES_DEFAULT = 80;
const MAX_LINKS_DEFAULT = 60;

function buildExtractScript(opts = {}) {
  const maxText = opts.maxTextLength || MAX_TEXT_LENGTH_DEFAULT;
  const maxInteractives = opts.maxInteractives || MAX_INTERACTIVES_DEFAULT;
  const maxLinks = opts.maxLinks || MAX_LINKS_DEFAULT;

  // Returns a string suitable for executeJavaScript. The IIFE returns a
  // JSON-stringifiable object so the caller receives a parsed value.
  return `
(function () {
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    var style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) === 0) return false;
    return true;
  }
  function cssSelectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return '#' + el.id;
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var part = node.tagName.toLowerCase();
      if (node.className && typeof node.className === 'string') {
        var cls = node.className.trim().split(/\\s+/).filter(function (c) { return /^[A-Za-z][\\w-]*$/.test(c); }).slice(0, 2);
        if (cls.length) part += '.' + cls.join('.');
      }
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (sameTag.length > 1) {
          var idx = sameTag.indexOf(node) + 1;
          part += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(part);
      if (node.id && /^[A-Za-z][\\w-]*$/.test(node.id)) { parts[0] = '#' + node.id; break; }
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }
  function trim(s, n) { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }

  var title = document.title || '';
  var url = location.href;
  var bodyText = trim(document.body ? document.body.innerText : '', ${maxText});

  var interactives = [];
  var seen = 0;
  var els = document.querySelectorAll('a, button, input, textarea, select, [role=button], [role=link], [contenteditable=true]');
  for (var i = 0; i < els.length && interactives.length < ${maxInteractives}; i++) {
    var el = els[i];
    if (!visible(el)) continue;
    seen++;
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || '';
    var label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.value || trim(el.innerText || el.textContent, 80);
    var entry = { tag: tag, selector: cssSelectorFor(el), label: trim(label, 80) };
    if (tag === 'input' || tag === 'textarea') {
      entry.type = el.type || 'text';
      entry.name = el.name || '';
    }
    if (role) entry.role = role;
    if (el.href) entry.href = el.href;
    interactives.push(entry);
  }

  var links = [];
  var aTags = document.querySelectorAll('a[href]');
  for (var j = 0; j < aTags.length && links.length < ${maxLinks}; j++) {
    var a = aTags[j];
    if (!visible(a)) continue;
    var t = trim(a.innerText || a.textContent, 80);
    if (!t) continue;
    links.push({ text: t, href: a.href });
  }

  return {
    url: url,
    title: title,
    text: bodyText,
    interactives: interactives,
    interactiveCount: seen,
    links: links,
    docHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
    scrollY: window.scrollY || 0,
    viewportHeight: window.innerHeight || 0,
  };
})();
`;
}

module.exports = { buildExtractScript };
