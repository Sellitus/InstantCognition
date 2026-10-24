// BrowserDock page tools: Record and Annotate buttons next to the dock
// toggle. IPC and the webview are external boundaries and are mocked;
// RecordBar and AnnotationController are the real components.
const BrowserDock = require('../../../../../renderer/components/assistant/BrowserDock');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function mockIpc() {
  return {
    invoke: jest.fn(async (ch) => (ch === 'recorder:start' ? { ok: true, id: 'rec_aaaaaa11', count: 1 } : { ok: true })),
    on: jest.fn(),
    removeListener: jest.fn(),
  };
}

let dock;
let ipc;
let store;
let wv;

beforeEach(() => {
  document.body.innerHTML = '<nav id="rail"></nav><div id="tab-bar-wrap"></div>';
  ipc = mockIpc();
  store = { set: jest.fn() };
  wv = document.createElement('webview');
  wv.send = jest.fn();
  wv.getWebContentsId = () => 9;
  document.body.appendChild(wv);
  dock = new BrowserDock({ onToggle: jest.fn(), ipc, store, getActiveWebview: () => wv, sendAnnotation: jest.fn() });
  document.getElementById('rail').appendChild(dock.el);
});

afterEach(() => dock.destroy());

test('the tools follow the toggle once it is placed', () => {
  expect(dock.recordBtn.isConnected).toBe(false);
  dock.sync({ appMode: 'assistant', dockOpen: true });
  expect(Array.from(document.getElementById('rail').children)).toEqual([dock.el, dock.recordBtn, dock.annotateBtn]);
  dock.sync({ appMode: 'assistant', dockOpen: true });
  expect(document.getElementById('rail').children).toHaveLength(3);
});

test('Record starts a recording on the active tab and reflects it', async () => {
  dock.sync({ appMode: 'assistant', dockOpen: true });
  dock.recordBtn.click();
  await flush();
  expect(ipc.invoke).toHaveBeenCalledWith('recorder:start', { webContentsId: 9 });
  expect(dock.recordBtn.getAttribute('aria-pressed')).toBe('true');
  expect(dock.recordBtn.getAttribute('aria-label')).toBe('Stop recording');
  expect(store.set).toHaveBeenCalledWith('recording', true);
});

test('Annotate enters pick mode; collapsing the dock cancels it and disables the tool', () => {
  dock.sync({ appMode: 'assistant', dockOpen: true });
  dock.annotateBtn.click();
  expect(wv.send).toHaveBeenCalledWith('ic-annotate:start');
  expect(dock.annotateBtn.getAttribute('aria-pressed')).toBe('true');
  expect(store.set).toHaveBeenLastCalledWith('annotating', true);
  dock.sync({ appMode: 'assistant', dockOpen: false });
  expect(wv.send).toHaveBeenLastCalledWith('ic-annotate:stop');
  expect(dock.annotateBtn.getAttribute('aria-pressed')).toBe('false');
  expect(dock.annotateBtn.disabled).toBe(true);
  expect(dock.recordBtn.disabled).toBe(true);
});

test('a live recording stays stoppable from a collapsed dock', async () => {
  dock.sync({ appMode: 'assistant', dockOpen: true });
  dock.recordBtn.click();
  await flush();
  dock.sync({ appMode: 'assistant', dockOpen: false });
  expect(dock.recordBtn.disabled).toBe(false);
  expect(dock.annotateBtn.disabled).toBe(true);
});

test('destroy removes the tools and the record bar', () => {
  dock.sync({ appMode: 'assistant', dockOpen: true });
  dock.recorder();
  dock.destroy();
  expect(dock.recordBtn.isConnected).toBe(false);
  expect(document.querySelector('.record-bar')).toBeNull();
  expect(ipc.removeListener).toHaveBeenCalledWith('recorder:event', expect.any(Function));
});

test('a modal opened before the dock collapsed does not un-inert the collapsed wrap when it closes', () => {
  const { trap } = require('../../../../../renderer/utils/focusTrap');
  const wrap = document.getElementById('tab-bar-wrap');
  const modal = document.createElement('div');
  modal.innerHTML = '<button>ok</button>';
  document.body.appendChild(modal);
  const release = trap(modal);
  expect(wrap.hasAttribute('inert')).toBe(true);
  dock.sync({ appMode: 'assistant', dockOpen: false });
  release();
  expect(wrap.hasAttribute('inert')).toBe(true);
  expect(wrap.getAttribute('aria-hidden')).toBe('true');
  dock.sync({ appMode: 'assistant', dockOpen: true });
  expect(wrap.hasAttribute('inert')).toBe(false);
  expect(wrap.hasAttribute('data-inert-hold')).toBe(false);
});

test('without a collapse in between, closing the modal frees the wrap', () => {
  const { trap } = require('../../../../../renderer/utils/focusTrap');
  const wrap = document.getElementById('tab-bar-wrap');
  const modal = document.createElement('div');
  modal.innerHTML = '<button>ok</button>';
  document.body.appendChild(modal);
  const release = trap(modal);
  dock.sync({ appMode: 'browser', dockOpen: false });
  release();
  expect(wrap.hasAttribute('inert')).toBe(false);
});
