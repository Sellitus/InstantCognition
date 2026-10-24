/**
 * @jest-environment jsdom
 */

// OmniboxSuggest — address-bar dropdown. The IPC boundary is injected as
// `invoke`; everything else (DOM, keyboard handling, ordering) is real.
jest.mock('electron', () => ({ ipcRenderer: { invoke: jest.fn() } }));

const OmniboxSuggest = require('../../../../renderer/components/OmniboxSuggest');

let input;
let root;
let settings;
let picks;
let responses;
let invoke;
let omni;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function type(text) {
  input.value = text;
  input.dispatchEvent(new Event('input'));
  jest.advanceTimersByTime(200);
}

function key(name) {
  const e = new KeyboardEvent('keydown', { key: name, cancelable: true });
  return { consumed: omni.handleKey(e), prevented: e.defaultPrevented };
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const labels = () => [...root.querySelectorAll('.omnibox-row .omnibox-label')].map((n) => n.textContent);
const notes = () => [...root.querySelectorAll('.omnibox-note')].map((n) => n.textContent);
const list = () => root.querySelector('[role="listbox"]');

beforeEach(() => {
  jest.useFakeTimers();
  document.body.textContent = '';
  root = document.createElement('div');
  input = document.createElement('input');
  root.appendChild(input);
  document.body.appendChild(root);
  settings = {};
  picks = [];
  responses = {
    'bookmarks:search': () => Promise.resolve([{ name: 'Electron docs', url: 'https://electronjs.org/docs' }]),
    'history:search': () => Promise.resolve([
      { title: 'Electron docs (visited)', url: 'https://electronjs.org/docs' },
      { title: 'Electron releases', url: 'https://releases.electronjs.org/' },
    ]),
    'search:suggest': () => Promise.resolve({ ok: true, suggestions: ['electron app', 'electron forge'] }),
  };
  invoke = jest.fn((channel, arg) => responses[channel](arg));
  omni = new OmniboxSuggest(input, { getSettings: () => settings, onPick: (row) => picks.push(row), invoke });
  omni.attach(root);
});

afterEach(() => {
  omni.destroy();
  jest.useRealTimers();
});

test('the input is an ARIA combobox bound to the listbox', () => {
  expect(input.getAttribute('role')).toBe('combobox');
  expect(input.getAttribute('aria-controls')).toBe(list().id);
  expect(input.getAttribute('aria-expanded')).toBe('false');
});

test('shows bookmarks, then history, then engine suggestions, one row per URL', async () => {
  type('electron');
  await flush();
  expect(labels()).toEqual(['Electron docs', 'Electron releases', 'electron app', 'electron forge']);
  expect(input.getAttribute('aria-expanded')).toBe('true');
  expect(invoke).toHaveBeenCalledWith('search:suggest', { query: 'electron' });
});

test('typing is debounced into a single lookup', async () => {
  input.value = 'e';
  input.dispatchEvent(new Event('input'));
  input.value = 'el';
  input.dispatchEvent(new Event('input'));
  jest.advanceTimersByTime(200);
  await flush();
  expect(invoke.mock.calls.filter(([c]) => c === 'search:suggest')).toEqual([['search:suggest', { query: 'el' }]]);
});

test('arrows move the highlight (wrapping through the typed text) and Enter picks it', async () => {
  type('electron');
  await flush();
  expect(key('ArrowDown')).toEqual({ consumed: true, prevented: true });
  expect(input.getAttribute('aria-activedescendant')).toBe(`${list().id}-0`);
  key('ArrowDown');
  key('ArrowDown');
  expect(root.querySelector('[aria-selected="true"] .omnibox-label').textContent).toBe('electron app');
  expect(key('Enter')).toEqual({ consumed: true, prevented: true });
  expect(picks).toEqual([{ type: 'search', value: 'electron app' }]);
  expect(list().hidden).toBe(true);

  type('electron');
  await flush();
  key('ArrowUp'); // from the typed text up wraps to the last row
  expect(root.querySelector('[aria-selected="true"] .omnibox-label').textContent).toBe('electron forge');
});

test('Enter with nothing highlighted is left to the host (navigate to the typed text)', async () => {
  type('electron');
  await flush();
  expect(key('Enter')).toEqual({ consumed: false, prevented: false });
  expect(picks).toEqual([]);
  expect(list().hidden).toBe(true);
});

test('Escape closes the list and is consumed; with the list closed keys pass through', async () => {
  type('electron');
  await flush();
  expect(key('Escape').consumed).toBe(true);
  expect(list().hidden).toBe(true);
  expect(key('ArrowDown').consumed).toBe(false);
  expect(key('Escape').consumed).toBe(false);
});

test('clicking a page row picks its URL', async () => {
  type('electron');
  await flush();
  root.querySelector('.omnibox-row-url').click();
  expect(picks).toEqual([{ type: 'url', value: 'https://electronjs.org/docs' }]);
});

test('a late answer for an older query is dropped', async () => {
  const slow = deferred();
  responses['search:suggest'] = jest.fn()
    .mockReturnValueOnce(slow.promise)
    .mockReturnValue(Promise.resolve({ ok: true, suggestions: ['newer'] }));
  type('old');
  type('new');
  await flush();
  slow.resolve({ ok: true, suggestions: ['stale'] });
  await flush();
  expect(labels()).toContain('newer');
  expect(labels()).not.toContain('stale');
});

test('a late answer keeps the highlight on the same row', async () => {
  const pages = deferred();
  responses['bookmarks:search'] = () => pages.promise;
  responses['history:search'] = () => Promise.resolve([]);
  type('electron');
  await flush();
  key('ArrowDown');
  expect(root.querySelector('[aria-selected="true"] .omnibox-label').textContent).toBe('electron app');
  pages.resolve([{ name: 'Docs', url: 'https://electronjs.org/docs' }]);
  await flush();
  expect(root.querySelector('[aria-selected="true"] .omnibox-label').textContent).toBe('electron app');
});

test('shows a loading note while suggestions are in flight, then the results', async () => {
  const pending = deferred();
  responses['search:suggest'] = () => pending.promise;
  type('electron');
  await flush();
  expect(notes()).toEqual(['Loading suggestions…']);
  pending.resolve({ ok: true, suggestions: ['electron app'] });
  await flush();
  expect(notes()).toEqual([]);
  expect(labels()).toContain('electron app');
});

test('a failed suggestion fetch and a failed history lookup are shown, not hidden', async () => {
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  responses['search:suggest'] = () => Promise.resolve({ ok: false, error: 'HTTP 503' });
  responses['history:search'] = () => Promise.reject(new Error('ipc down'));
  type('electron');
  await flush();
  expect(notes()).toEqual(['History search failed', 'Search suggestions are unavailable']);
  expect(err).toHaveBeenCalledWith('[omnibox] history/bookmark lookup failed:', expect.any(Error));
  err.mockRestore();
});

test('with only a note shown the arrows are left to the host', async () => {
  const pending = deferred();
  responses['bookmarks:search'] = () => Promise.resolve([]);
  responses['history:search'] = () => Promise.resolve([]);
  responses['search:suggest'] = () => pending.promise;
  type('electron');
  await flush();
  expect(notes()).toEqual(['Loading suggestions…']);
  expect(key('ArrowDown')).toEqual({ consumed: false, prevented: false });
  expect(key('ArrowUp')).toEqual({ consumed: false, prevented: false });
});

test('no matches and no suggestions keeps the list closed', async () => {
  responses['bookmarks:search'] = () => Promise.resolve([]);
  responses['history:search'] = () => Promise.resolve([]);
  responses['search:suggest'] = () => Promise.resolve({ ok: true, suggestions: [] });
  type('zzzz');
  await flush();
  expect(list().hidden).toBe(true);
  expect(input.getAttribute('aria-expanded')).toBe('false');
});

test('each setting turns its source off without a restart', async () => {
  settings.searchSuggestionsEnabled = false;
  type('electron');
  await flush();
  expect(invoke.mock.calls.map(([c]) => c)).not.toContain('search:suggest');
  expect(labels()).toEqual(['Electron docs', 'Electron releases']);

  settings = { addressBarSearchHistory: false };
  invoke.mockClear();
  type('electron');
  await flush();
  expect(invoke.mock.calls.map(([c]) => c)).toEqual(['search:suggest']);
  expect(labels()).toEqual(['electron app', 'electron forge']);
});

test('a typed URL with a scheme is never sent to the search engine', async () => {
  type('https://intranet.corp.example/secret');
  await flush();
  expect(invoke.mock.calls.map(([c]) => c)).not.toContain('search:suggest');
});

test.each([
  'intranet.corp.example/secret', 'example.com:8080', 'wiki.example?page=1', '192.168.1.20', '8.8.8.8',
  'printer.local', '[::1]',
])('the address %s is never sent to the search engine', async (text) => {
  type(text);
  await flush();
  expect(invoke.mock.calls.map(([c]) => c)).not.toContain('search:suggest');
});

test.each([
  'intranet/secret-path', 'wiki?token=abc123', 'jira/browse/PROJ-42', 'nas#admin',
])('the single-label address %s is never sent to the search engine', async (text) => {
  type(text);
  await flush();
  expect(invoke.mock.calls.map(([c]) => c)).not.toContain('search:suggest');
});

test('plain words, questions and bare domains still get suggestions', async () => {
  type('electron');
  await flush();
  type('why?');
  await flush();
  type('github.com');
  await flush();
  expect(invoke.mock.calls.filter(([c]) => c === 'search:suggest').map(([, a]) => a.query))
    .toEqual(['electron', 'why?', 'github.com']);
});

test('Enter before the debounce fires cancels the pending lookup', async () => {
  input.value = 'electron';
  input.dispatchEvent(new Event('input'));
  expect(key('Enter')).toEqual({ consumed: false, prevented: false });
  jest.advanceTimersByTime(200);
  await flush();
  expect(invoke).not.toHaveBeenCalled();
  expect(list().hidden).toBe(true);
});

test('blur and clearing the text close the list', async () => {
  type('electron');
  await flush();
  input.dispatchEvent(new Event('blur'));
  expect(list().hidden).toBe(true);
  type('electron');
  await flush();
  type('   ');
  expect(list().hidden).toBe(true);
});

test('destroy removes the list and stops listening', async () => {
  omni.destroy();
  expect(root.querySelector('[role="listbox"]')).toBeNull();
  type('electron');
  await flush();
  expect(invoke).not.toHaveBeenCalled();
});
