// RecordBar state machine against a mocked ipcRenderer (the recorder:* and
// skills:save IPC boundary). Markdown rendering is the real renderer util.
const RecordBar = require('../../../../../renderer/components/assistant/RecordBar');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const MD = '---\nname: shop-login\ndescription: Log in.\n---\n\n1. Open **login**.';

function mockIpc(overrides = {}) {
  const listeners = {};
  const routes = {
    'recorder:start': jest.fn(() => ({ ok: true, id: 'rec_aaaaaa11', count: 1 })),
    'recorder:stop': jest.fn(() => ({ ok: true, recording: { id: 'rec_aaaaaa11', eventCount: 4 }, warnings: ['cleanup: x'] })),
    'recorder:to-skill': jest.fn(() => ({ ok: true, markdown: MD, skill: { name: 'shop-login' }, warnings: [] })),
    'recorder:delete': jest.fn(() => ({ ok: true })),
    'skills:save': jest.fn(() => ({ ok: true, skill: { name: 'shop-login' } })),
    ...overrides,
  };
  return {
    routes,
    invoke: jest.fn((ch, arg) => Promise.resolve().then(() => routes[ch](arg))),
    on: jest.fn((ch, fn) => { listeners[ch] = fn; }),
    removeListener: jest.fn((ch) => { delete listeners[ch]; }),
    push: (payload) => listeners['recorder:event']({}, payload),
    listening: () => typeof listeners['recorder:event'] === 'function',
  };
}

let ipc;
let store;
let onSaved;
let bar;
let wv;

function make(overrides) {
  ipc = mockIpc(overrides);
  bar = new RecordBar({ ipc, store, getActiveWebview: () => wv, onSaved });
  return bar;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="tab-bar-wrap"></div>';
  store = { set: jest.fn() };
  onSaved = jest.fn();
  wv = { getWebContentsId: () => 42 };
});

afterEach(() => bar.destroy());

const status = () => bar.el.querySelector('.record-bar__status').textContent;
const btn = (label) => Array.from(bar.el.querySelectorAll('button')).find((b) => b.textContent === label);

async function toPreview() {
  await bar.start();
  ipc.push({ id: 'rec_aaaaaa11', count: 4, truncated: false });
  await bar.stop();
  await flush();
}

test('idle → recording with a live count → generating → preview → saved and trace deleted', async () => {
  make();
  expect(bar.el.hidden).toBe(true);
  const states = [];
  bar._onStateChange = (s) => states.push(s);
  await bar.toggle();
  expect(ipc.routes['recorder:start']).toHaveBeenCalledWith({ webContentsId: 42 });
  expect(bar.state).toBe('recording');
  expect(store.set).toHaveBeenLastCalledWith('recording', true);
  expect(status()).toBe('Recording · 1 action');
  ipc.push({ id: 'rec_aaaaaa11', count: 5, truncated: false });
  ipc.push({ id: 'rec_other0001', count: 99 });
  expect(status()).toBe('Recording · 5 actions');
  ipc.push({ id: 'rec_aaaaaa11', count: 500, truncated: true });
  expect(status()).toBe('Recording · 500 actions (limit reached)');
  btn('Stop').click();
  await flush();
  expect(states).toEqual(['starting', 'recording', 'stopping', 'generating', 'preview']);
  expect(store.set).toHaveBeenLastCalledWith('recording', false);
  expect(status()).toBe('Draft skill: shop-login');
  expect(bar.el.querySelector('.record-bar__preview strong').textContent).toBe('login');
  expect(bar.el.querySelector('.record-bar__notes').textContent).toBe('cleanup: x');
  btn('Save').click();
  await flush();
  expect(ipc.routes['skills:save']).toHaveBeenCalledWith({ skill: { markdown: MD }, overwrite: false });
  expect(onSaved).toHaveBeenCalledWith({ name: 'shop-login' });
  expect(ipc.routes['recorder:delete']).toHaveBeenCalledWith({ id: 'rec_aaaaaa11' });
  expect(bar.state).toBe('idle');
  expect(bar.el.hidden).toBe(true);
});

test('Raw toggles between rendered preview and SKILL.md source', async () => {
  make();
  await toPreview();
  const preview = bar.el.querySelector('.record-bar__preview');
  const source = bar.el.querySelector('.record-bar__source');
  expect([preview.hidden, source.hidden]).toEqual([false, true]);
  btn('Raw').click();
  expect([preview.hidden, source.hidden]).toEqual([true, false]);
  expect(source.textContent).toBe(MD);
  expect(btn('Rendered').getAttribute('aria-pressed')).toBe('true');
});

test('a name clash offers Replace, which saves with overwrite', async () => {
  make({ 'skills:save': jest.fn(({ overwrite }) => (overwrite ? { ok: true, skill: { name: 'shop-login' } } : { ok: false, error: 'exists' })) });
  await toPreview();
  await bar.save();
  expect(bar.state).toBe('error');
  expect(status()).toBe('A skill with this name already exists.');
  btn('Replace it').click();
  await flush();
  expect(ipc.routes['skills:save']).toHaveBeenLastCalledWith({ skill: { markdown: MD }, overwrite: true });
  expect(bar.state).toBe('idle');
});

test('a failed draft can be retried and the error says why', async () => {
  const toSkill = jest.fn()
    .mockReturnValueOnce({ ok: false, error: 'draft_empty_instructions' })
    .mockReturnValueOnce({ ok: true, markdown: MD, skill: { name: 'shop-login' } });
  make({ 'recorder:to-skill': toSkill });
  await toPreview();
  expect(bar.state).toBe('error');
  expect(status()).toBe('Could not turn the recording into a skill: draft_empty_instructions');
  btn('Retry').click();
  await flush();
  expect(bar.state).toBe('preview');
});

test('Discard deletes the saved recording; a trace already gone is fine', async () => {
  make({ 'recorder:delete': jest.fn(() => ({ ok: false, error: 'not_found' })) });
  await toPreview();
  btn('Discard').click();
  await flush();
  expect(ipc.routes['recorder:delete']).toHaveBeenCalledWith({ id: 'rec_aaaaaa11' });
  expect(bar.state).toBe('idle');
  expect(ipc.routes['skills:save']).not.toHaveBeenCalled();
});

test('a delete failure keeps the bar in error with a retry', async () => {
  make({ 'recorder:delete': jest.fn(() => ({ ok: false, error: 'EACCES' })) });
  await toPreview();
  await bar.discard();
  expect(bar.state).toBe('error');
  expect(status()).toBe('Could not delete the recording: EACCES');
  expect(btn('Back to draft')).toBeTruthy();
});

test('start failures: no page, IPC error, IPC rejection', async () => {
  make({ 'recorder:start': jest.fn(() => ({ ok: false, error: 'webcontents_unavailable' })) });
  wv = null;
  await bar.start();
  expect([bar.state, status()]).toEqual(['error', 'Open a page in the browser dock to record.']);
  wv = { getWebContentsId: () => 42 };
  await bar.toggle();
  expect(status()).toBe('Could not start recording: webcontents_unavailable');
  ipc.routes['recorder:start'].mockImplementation(() => { throw new Error('channel closed'); });
  await bar.start();
  expect(status()).toBe('Could not start recording: channel closed');
  btn('Close').click();
  await flush();
  expect(bar.state).toBe('idle');
  expect(ipc.routes['recorder:delete']).not.toHaveBeenCalled();
});

test('an empty recording is an error, never an empty skill', async () => {
  make({ 'recorder:stop': jest.fn(() => ({ ok: true, recording: { id: 'rec_aaaaaa11', eventCount: 0 } })) });
  await bar.start();
  await bar.stop();
  expect(bar.state).toBe('error');
  expect(ipc.routes['recorder:to-skill']).not.toHaveBeenCalled();
});

test('the tab closing mid-recording stops and drafts what was captured', async () => {
  make();
  await bar.start();
  ipc.push({ id: 'rec_aaaaaa11', count: 3, ended: 'destroyed' });
  await flush();
  expect(ipc.routes['recorder:stop']).toHaveBeenCalledWith({ id: 'rec_aaaaaa11' });
  expect(bar.state).toBe('preview');
});

test('the bar tracks the dock box and destroy unhooks everything', async () => {
  make();
  document.getElementById('tab-bar-wrap').getBoundingClientRect = () => ({ left: 700, top: 40, width: 500, height: 900 });
  await bar.start();
  expect([bar.el.style.left, bar.el.style.top, bar.el.style.width]).toEqual(['700px', '40px', '500px']);
  bar.destroy();
  expect(ipc.listening()).toBe(false);
  expect(bar.el.isConnected).toBe(false);
});
