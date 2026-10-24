// DiffView — renders a unified patch (jsdiff `createTwoFilesPatch` output) as
// numbered add/delete/context rows. Every string lands through textContent, so
// patch content can never become markup. A patch that does not parse renders
// as raw text rather than as an empty "no changes" view.

const { parsePatch } = require('diff');

const DEFAULT_COLLAPSE_ABOVE = 400;

const ROW_KIND = { '+': 'add', '-': 'del', ' ': 'ctx', '\\': 'meta' };

/** @param {string} tag @param {string} [className] @param {string} [text] */
function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Strips the a/ b/ prefixes git-style patches put on file names. */
function displayName(file) {
  const name = String((file && (file.newFileName || file.oldFileName)) || '');
  return name.replace(/^[ab]\//, '');
}

/**
 * @param {string} text
 * @returns {{ files: any[] } | { error: string }}
 */
function parseUnified(text) {
  let files;
  try {
    files = parsePatch(text);
  } catch (err) {
    return { error: (err instanceof Error && err.message) || String(err) };
  }
  const hunks = files.reduce((n, f) => n + ((f && f.hunks) || []).length, 0);
  if (!hunks) return { error: 'no hunks found' };
  return { files };
}

class DiffView {
  /**
   * @param {{ diff: string, collapseAbove?: number }} opts
   */
  constructor(opts) {
    const o = opts || /** @type {any} */ ({});
    this._text = typeof o.diff === 'string' ? o.diff : '';
    this._collapseAbove = Number.isInteger(o.collapseAbove) && o.collapseAbove > 0 ? o.collapseAbove : DEFAULT_COLLAPSE_ABOVE;
    this.el = node('div', 'diff-view');
    this._render();
  }

  _render() {
    if (!this._text.trim()) {
      this.el.appendChild(node('div', 'diff-view__empty', 'No changes.'));
      return;
    }
    const parsed = parseUnified(this._text);
    if ('error' in parsed) {
      this.el.classList.add('diff-view--raw');
      this.el.appendChild(node('div', 'diff-view__note', `Showing the raw patch (it could not be parsed: ${parsed.error}).`));
      this.el.appendChild(node('pre', 'diff-view__raw', this._text));
      return;
    }
    const { files } = parsed;
    let adds = 0;
    let dels = 0;
    let lines = 0;
    for (const f of files) {
      for (const h of f.hunks) {
        for (const l of h.lines) {
          lines += 1;
          if (l[0] === '+') adds += 1;
          else if (l[0] === '-') dels += 1;
        }
      }
    }
    const header = node('div', 'diff-view__summary');
    header.append(
      node('span', 'diff-view__stat diff-view__stat--add', `+${adds}`),
      node('span', 'diff-view__stat diff-view__stat--del', `−${dels}`),
      node('span', 'diff-view__stat', `${lines} line${lines === 1 ? '' : 's'}`),
    );
    this.el.appendChild(header);

    const body = node('div', 'diff-view__body');
    this.el.appendChild(body);
    if (lines <= this._collapseAbove) {
      this._renderFiles(body, files);
      return;
    }
    this.el.classList.add('diff-view--collapsed');
    body.hidden = true;
    const toggle = node('button', 'diff-view__expand', `Show full diff (${lines} lines)`);
    toggle.setAttribute('type', 'button');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      const expand = body.hidden;
      if (expand && !body.firstChild) this._renderFiles(body, files);
      body.hidden = !expand;
      this.el.classList.toggle('diff-view--collapsed', !expand);
      toggle.setAttribute('aria-expanded', expand ? 'true' : 'false');
      toggle.textContent = expand ? 'Hide diff' : `Show full diff (${lines} lines)`;
    });
    this.el.insertBefore(toggle, body);
  }

  /** @param {HTMLElement} body @param {any[]} files */
  _renderFiles(body, files) {
    for (const f of files) {
      const name = displayName(f);
      if (files.length > 1 && name) body.appendChild(node('div', 'diff-view__file', name));
      const table = node('table', 'diff-view__table');
      const tbody = node('tbody');
      table.appendChild(tbody);
      for (const h of f.hunks) {
        const head = node('tr', 'diff-view__row diff-view__row--hunk');
        const cell = node('td', 'diff-view__hunk', `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
        cell.setAttribute('colspan', '4');
        head.appendChild(cell);
        tbody.appendChild(head);
        let oldNo = h.oldStart;
        let newNo = h.newStart;
        for (const line of h.lines) {
          const sign = line[0];
          const kind = ROW_KIND[sign] || 'ctx';
          const row = node('tr', `diff-view__row diff-view__row--${kind}`);
          let o = '';
          let n = '';
          if (kind === 'del') { o = String(oldNo); oldNo += 1; }
          else if (kind === 'add') { n = String(newNo); newNo += 1; }
          else if (kind === 'ctx') { o = String(oldNo); n = String(newNo); oldNo += 1; newNo += 1; }
          row.append(
            node('td', 'diff-view__num', o),
            node('td', 'diff-view__num', n),
            node('td', 'diff-view__sign', kind === 'meta' ? '' : (sign || ' ')),
            node('td', 'diff-view__code', kind === 'meta' ? line : line.slice(1)),
          );
          tbody.appendChild(row);
        }
      }
      body.appendChild(table);
    }
  }
}

module.exports = DiffView;
module.exports.DEFAULT_COLLAPSE_ABOVE = DEFAULT_COLLAPSE_ABOVE;
