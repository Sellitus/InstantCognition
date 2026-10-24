// DiffView — unified patch rendering through the real jsdiff parser: numbered
// add/delete/context rows, raw fallback for unparseable input, and the
// collapse threshold for large patches.

const { createTwoFilesPatch } = require('diff');
const DiffView = require('../../../../../renderer/components/assistant/DiffView');

const rows = (view, kind) => [...view.el.querySelectorAll(`.diff-view__row--${kind}`)];
const cells = (row) => [...row.querySelectorAll('td')].map((td) => td.textContent);

test('renders add, delete and context rows with old/new line numbers', () => {
  const patch = createTwoFilesPatch('src/a.js', 'src/a.js', 'one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n');
  const view = new DiffView({ diff: patch });
  const del = rows(view, 'del');
  const add = rows(view, 'add');
  expect(del).toHaveLength(1);
  expect(add).toHaveLength(2);
  expect(cells(del[0])).toEqual(['2', '', '-', 'two']);
  expect(cells(add[0])).toEqual(['', '2', '+', 'TWO']);
  expect(cells(add[1])).toEqual(['', '4', '+', 'four']);
  expect(cells(rows(view, 'ctx')[0])).toEqual(['1', '1', ' ', 'one']);
  expect(view.el.querySelector('.diff-view__hunk').textContent).toBe('@@ -1,3 +1,4 @@');
  expect(view.el.querySelector('.diff-view__stat--add').textContent).toBe('+2');
  expect(view.el.querySelector('.diff-view__stat--del').textContent).toBe('−1');
  expect(view.el.querySelector('.diff-view__raw')).toBeNull();
});

test('patch content is text, never markup', () => {
  const patch = createTwoFilesPatch('x.html', 'x.html', '', '<img src=x onerror="alert(1)">\n');
  const view = new DiffView({ diff: patch });
  expect(view.el.querySelector('img')).toBeNull();
  expect(rows(view, 'add')[0].querySelector('.diff-view__code').textContent).toBe('<img src=x onerror="alert(1)">');
});

test('a malformed patch renders as escaped raw text with a note', () => {
  const text = '@@ -1,2 +1,2 @@\n<script>alert(1)</script>\n';
  const view = new DiffView({ diff: text });
  expect(view.el.classList.contains('diff-view--raw')).toBe(true);
  const raw = view.el.querySelector('pre.diff-view__raw');
  expect(raw.textContent).toBe(text);
  expect(view.el.querySelector('script')).toBeNull();
  expect(view.el.querySelector('.diff-view__note').textContent).toMatch(/could not be parsed/);
  expect(view.el.querySelector('.diff-view__table')).toBeNull();
});

test('text with no hunks at all falls back to raw rather than an empty diff', () => {
  const view = new DiffView({ diff: 'not a patch' });
  expect(view.el.querySelector('pre.diff-view__raw').textContent).toBe('not a patch');
  expect(view.el.querySelector('.diff-view__empty')).toBeNull();
});

test('an empty or missing diff says there are no changes', () => {
  expect(new DiffView({ diff: '' }).el.querySelector('.diff-view__empty').textContent).toBe('No changes.');
  expect(new DiffView(/** @type {any} */ ({ diff: 42 })).el.querySelector('.diff-view__empty')).not.toBeNull();
});

test('a patch over the threshold starts collapsed and expands on demand', () => {
  const before = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const after = Array.from({ length: 300 }, (_, i) => `LINE ${i}`).join('\n') + '\n';
  const view = new DiffView({ diff: createTwoFilesPatch('big', 'big', before, after) });
  document.body.appendChild(view.el);
  const body = view.el.querySelector('.diff-view__body');
  const toggle = view.el.querySelector('button.diff-view__expand');
  expect(view.el.classList.contains('diff-view--collapsed')).toBe(true);
  expect(body.hidden).toBe(true);
  expect(rows(view, 'add')).toHaveLength(0);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.textContent).toBe('Show full diff (600 lines)');
  toggle.click();
  expect(body.hidden).toBe(false);
  expect(rows(view, 'add')).toHaveLength(300);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  toggle.click();
  expect(body.hidden).toBe(true);
  view.el.remove();
});

test('a patch at the threshold renders expanded', () => {
  const before = Array.from({ length: 200 }, (_, i) => `a${i}`).join('\n') + '\n';
  const after = Array.from({ length: 200 }, (_, i) => `b${i}`).join('\n') + '\n';
  const view = new DiffView({ diff: createTwoFilesPatch('f', 'f', before, after) });
  expect(view.el.querySelector('button.diff-view__expand')).toBeNull();
  expect(rows(view, 'del')).toHaveLength(200);
});
