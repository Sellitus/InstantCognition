// readableExtractor — produces a JS source string that, when executed inside a
// webview's page context, returns a compact readable summary of the page.
//
// Goals:
//   - Strip chrome/nav/ads/script/style.
//   - Prefer semantic regions (<article>, <main>, role=main, role=article).
//   - Walk block elements producing a linear structured outline (headings + paragraphs).
//   - Never return raw HTML; text only.
//
// The shape matches the consumer in AgentService: { title, url, byline, excerpt,
// headings, mainText, wordCount }. Bounds keep results within LLM context.

const MAX_MAIN_TEXT_DEFAULT = 6000;
const MAX_HEADINGS_DEFAULT = 40;

function buildReadableScript(opts = {}) {
  const maxText = opts.maxMainText || MAX_MAIN_TEXT_DEFAULT;
  const maxHeadings = opts.maxHeadings || MAX_HEADINGS_DEFAULT;

  return `
(function () {
  var MAX_TEXT = ${maxText};
  var MAX_HEADINGS = ${maxHeadings};

  function trim(s) { return (s || '').replace(/\\s+/g, ' ').trim(); }
  function clip(s, n) { s = trim(s); return s.length > n ? s.slice(0, n) + '…' : s; }

  // Heuristic: pick the primary content root.
  function pickRoot() {
    var candidates = [
      document.querySelector('article'),
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
      document.querySelector('[role="article"]'),
      document.querySelector('#content, #main, #main-content, .content, .article, .post'),
    ].filter(Boolean);
    if (candidates.length) return candidates[0];
    return document.body;
  }

  var IGNORED_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1,
    NAV: 1, HEADER: 1, FOOTER: 1, ASIDE: 1, FORM: 1,
  };
  var IGNORED_ROLES = { navigation: 1, banner: 1, contentinfo: 1, complementary: 1, search: 1 };

  function visibleEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (IGNORED_TAGS[el.tagName]) return false;
    var role = el.getAttribute && el.getAttribute('role');
    if (role && IGNORED_ROLES[role.toLowerCase()]) return false;
    var style;
    try { style = window.getComputedStyle(el); } catch (_) { return true; }
    if (!style) return true;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    return true;
  }

  // Meta extractors
  function metaContent(name) {
    var m = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
    return m ? trim(m.getAttribute('content') || '') : '';
  }
  var title = trim(document.title || metaContent('og:title'));
  var url = location.href;
  var byline = metaContent('author') || metaContent('article:author') || '';
  var excerpt = metaContent('description') || metaContent('og:description') || '';

  var root = pickRoot();
  var headings = [];
  var parts = [];
  var used = 0;

  // Walk in document order, collecting block-level text.
  function walk(el) {
    if (used >= MAX_TEXT) return;
    if (!el || !visibleEl(el)) return;
    var tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      var ht = clip(el.innerText || el.textContent, 200);
      if (ht && headings.length < MAX_HEADINGS) {
        headings.push({ level: Number(tag.charAt(1)), text: ht });
      }
      if (ht) {
        var line = '\\n' + '#'.repeat(Number(tag.charAt(1))) + ' ' + ht + '\\n';
        parts.push(line);
        used += line.length;
      }
      return;
    }
    if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'PRE' || tag === 'LI') {
      var text = clip(el.innerText || el.textContent, 600);
      if (text) {
        var prefix = tag === 'LI' ? '• ' : (tag === 'BLOCKQUOTE' ? '> ' : '');
        parts.push(prefix + text + '\\n');
        used += text.length + prefix.length + 1;
      }
      return;
    }
    // Descend for containers that may wrap content
    var children = el.children;
    for (var i = 0; i < children.length && used < MAX_TEXT; i++) walk(children[i]);
  }

  walk(root);
  var mainText = parts.join('').replace(/\\n{3,}/g, '\\n\\n').trim();
  if (mainText.length > MAX_TEXT) mainText = mainText.slice(0, MAX_TEXT) + '…';

  var words = mainText ? mainText.split(/\\s+/).filter(Boolean).length : 0;

  // Fallback: if the semantic walk produced nothing, take a bounded slice of body.innerText.
  if (!mainText && document.body) {
    mainText = clip(document.body.innerText || '', MAX_TEXT);
    words = mainText ? mainText.split(/\\s+/).filter(Boolean).length : 0;
  }

  return {
    url: url,
    title: title,
    byline: byline,
    excerpt: excerpt,
    headings: headings,
    mainText: mainText,
    wordCount: words,
  };
})();
`;
}

module.exports = { buildReadableScript };
