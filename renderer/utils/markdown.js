// markdown — safe markdown-to-HTML for chat answers and artifacts.
//
// marked (GFM: tables, task lists, strikethrough) produces the markup, every
// renderer override escapes what it emits, and DOMPurify then enforces a
// fixed tag/attribute allowlist as a second line of defense. Raw HTML in the
// source is shown as escaped text, never passed through. Link targets are
// limited to http(s)/mailto; images render as plain links so a model answer
// cannot make the app fetch remote content on its own.
//
// Streaming-safe: callers re-render the full buffer on every tick. An
// unclosed code fence renders as a code block marked `md-code-unclosed`; a
// half-typed table renders as a paragraph until its delimiter row arrives.

const { Marked } = require('marked');
const createDOMPurify = require('dompurify');
// lib/core sets module.exports.default to itself; the typings only declare the default export.
const hljs = require('highlight.js/lib/core').default;
const { escapeHtml } = require('./html');

/** @type {Array<[string, any]>} */
const LANGUAGES = [
  ['javascript', require('highlight.js/lib/languages/javascript')],
  ['typescript', require('highlight.js/lib/languages/typescript')],
  ['python', require('highlight.js/lib/languages/python')],
  ['json', require('highlight.js/lib/languages/json')],
  ['bash', require('highlight.js/lib/languages/bash')],
  ['xml', require('highlight.js/lib/languages/xml')],
  ['css', require('highlight.js/lib/languages/css')],
  ['markdown', require('highlight.js/lib/languages/markdown')],
];
for (const [name, language] of LANGUAGES) hljs.registerLanguage(name, language);

const SAFE_URL_RX = /^(?:https?:|mailto:)/i;
const LANG_RX = /^[\w+#.-]{1,32}$/;
const COPY_BUTTON = '<button class="md-copy" type="button" aria-label="Copy code">Copy</button>';
const COPY_RESET_MS = 1600;

function safeHref(href) {
  const url = String(href == null ? '' : href).trim();
  return SAFE_URL_RX.test(url) ? url : null;
}

function fenceClosed(raw) {
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
  if (!open) return true;
  const ch = open[1][0] === '`' ? '`' : '~';
  return new RegExp(`\\n {0,3}\\${ch}{${open[1].length},}[ \\t]*\\n*$`).test(raw);
}

const TABLE_DELIM_RX = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

// GFM splits table cells on every unescaped `|`, even inside code spans, and
// models routinely write `a | b` in a table cell. Escaping those pipes on table
// lines keeps the code span in one cell; table cells unescape `\|` back to `|`.
function escapeTableCodePipes(src) {
  const lines = src.split('\n');
  let fence = null;
  let inTable = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; inTable = false; continue; }
    if (!line.trim()) { inTable = false; continue; }
    if (!inTable && line.includes('|') && i + 1 < lines.length
      && lines[i + 1].includes('|') && TABLE_DELIM_RX.test(lines[i + 1])) inTable = true;
    if (inTable && line.includes('`')) {
      lines[i] = line.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g,
        (_m, ticks, body) => ticks + body.replace(/(?<!\\)\|/g, '\\|') + ticks);
    }
  }
  return lines.join('\n');
}

const renderer = {
  heading(token) {
    const d = token.depth;
    return `<h${d} class="md-h md-h${d}">${this.parser.parseInline(token.tokens)}</h${d}>`;
  },
  paragraph(token) {
    return `<p class="md-p">${this.parser.parseInline(token.tokens)}</p>`;
  },
  blockquote(token) {
    return `<blockquote class="md-quote">${this.parser.parse(token.tokens)}</blockquote>`;
  },
  hr() {
    return '<hr class="md-hr">';
  },
  list(token) {
    const tag = token.ordered ? 'ol' : 'ul';
    const startNum = Number(token.start);
    const start = token.ordered && Number.isInteger(startNum) && startNum !== 1 ? ` start="${startNum}"` : '';
    const body = token.items.map((item) => this.listitem(item)).join('');
    return `<${tag} class="md-list"${start}>${body}</${tag}>`;
  },
  checkbox(token) {
    return `<input type="checkbox" class="md-task" disabled${token.checked ? ' checked' : ''}> `;
  },
  table(token) {
    const head = this.tablerow({ text: token.header.map((cell) => this.tablecell(cell)).join('') });
    const rows = token.rows
      .map((row) => this.tablerow({ text: row.map((cell) => this.tablecell(cell)).join('') }))
      .join('');
    return '<div class="md-table-wrap"><table class="md-table">'
      + `<thead>${head}</thead>${rows ? `<tbody>${rows}</tbody>` : ''}</table></div>`;
  },
  codespan(token) {
    return `<code class="md-inline-code">${escapeHtml(token.text)}</code>`;
  },
  code(token) {
    const lang = String(token.lang || '').trim().split(/\s+/)[0].toLowerCase();
    const label = LANG_RX.test(lang) ? lang : '';
    const known = label && hljs.getLanguage(label) ? label : '';
    const body = known
      ? hljs.highlight(token.text, { language: known, ignoreIllegals: true }).value
      : escapeHtml(token.text);
    const preCls = fenceClosed(token.raw) ? 'md-code' : 'md-code md-code-unclosed';
    const codeCls = known ? `hljs language-${known}` : (label ? `language-${label}` : '');
    return `<pre class="${preCls}"${label ? ` data-lang="${label}"` : ''}>`
      + (label ? `<span class="md-code-lang">${label}</span>` : '')
      + COPY_BUTTON
      + `<code${codeCls ? ` class="${codeCls}"` : ''}>${body}</code></pre>`;
  },
  html(token) {
    const text = escapeHtml(token.text);
    return token.block ? `<p class="md-p">${text.trim()}</p>` : text;
  },
  link(token) {
    const href = safeHref(token.href);
    if (!href) return escapeHtml(token.raw);
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
    return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">`
      + `${this.parser.parseInline(token.tokens)}</a>`;
  },
  image(token) {
    const href = safeHref(token.href);
    const alt = escapeHtml(token.text || token.href || 'image');
    if (!href) return alt;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${alt}</a>`;
  },
};

const md = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer,
  hooks: { preprocess: escapeTableCodePipes },
});

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
    'code', 'pre', 'span', 'blockquote', 'ul', 'ol', 'li', 'a', 'input', 'button',
    'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'target', 'rel', 'class', 'type', 'checked', 'disabled',
    'align', 'start', 'data-lang', 'aria-label',
  ],
  ALLOWED_URI_REGEXP: SAFE_URL_RX,
  // Attribute values outside this list are checked against ALLOWED_URI_REGEXP,
  // which would strip plain values such as type="checkbox" or align="right".
  ADD_URI_SAFE_ATTR: ['type', 'align', 'start', 'data-lang'],
  ALLOW_DATA_ATTR: false,
};

let purifier = null;
const copyTimers = new WeakMap();
const boundRoots = new WeakSet();

// One private DOMPurify instance so these hooks never leak into other users
// of the library. Created on first use: it needs the renderer's window.
function getPurifier() {
  if (purifier) return purifier;
  const instance = createDOMPurify(window);
  instance.addHook('afterSanitizeAttributes', (node) => {
    const tag = node.nodeName;
    if (tag === 'A') {
      if (node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      } else {
        node.removeAttribute('target');
        node.removeAttribute('rel');
      }
    } else if (tag === 'INPUT') {
      if (node.getAttribute('type') !== 'checkbox') node.remove();
      else node.setAttribute('disabled', '');
    } else if (tag === 'BUTTON') {
      if (node.getAttribute('class') !== 'md-copy') node.remove();
      else node.setAttribute('type', 'button');
    }
  });
  purifier = instance;
  return purifier;
}

function mdToHtml(text) {
  if (text == null) return '';
  const html = /** @type {string} */ (md.parse(String(text)));
  return getPurifier().sanitize(html, SANITIZE_CONFIG);
}

function setCopyState(btn, state, label) {
  btn.textContent = label;
  btn.classList.toggle('md-copy--done', state === 'done');
  btn.classList.toggle('md-copy--error', state === 'error');
  clearTimeout(copyTimers.get(btn));
  copyTimers.set(btn, setTimeout(() => {
    btn.textContent = 'Copy';
    btn.classList.remove('md-copy--done', 'md-copy--error');
    btn.removeAttribute('title');
  }, COPY_RESET_MS));
}

function copyCode(btn) {
  const code = btn.closest('pre') && btn.closest('pre').querySelector('code');
  const text = code ? code.textContent : '';
  const fail = (err) => {
    const msg = (err && err.message) || String(err);
    console.error('[markdown] code copy failed:', msg);
    btn.title = `Copy failed: ${msg}`;
    setCopyState(btn, 'error', 'Copy failed');
  };
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
  if (!clip || typeof clip.writeText !== 'function') {
    fail(new Error('Clipboard is unavailable'));
    return Promise.resolve(false);
  }
  return Promise.resolve()
    .then(() => clip.writeText(text))
    .then(() => { setCopyState(btn, 'done', 'Copied'); return true; }, (err) => { fail(err); return false; });
}

// Delegated click handler for the copy buttons mdToHtml emits. Bind once on
// the container whose innerHTML is re-rendered; it survives every re-render.
function bindCodeCopy(rootEl) {
  if (!rootEl || typeof rootEl.addEventListener !== 'function') {
    throw new TypeError('bindCodeCopy: rootEl must be a DOM element');
  }
  if (boundRoots.has(rootEl)) return;
  boundRoots.add(rootEl);
  rootEl.addEventListener('click', (e) => {
    const target = /** @type {any} */ (e.target);
    const btn = target && target.closest ? target.closest('button.md-copy') : null;
    if (!btn || !rootEl.contains(btn)) return;
    e.preventDefault();
    copyCode(btn);
  });
}

module.exports = { mdToHtml, bindCodeCopy, escapeHtml };
