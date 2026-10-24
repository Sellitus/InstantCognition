// AnnotationController against a webview double: a real DOM element (so
// ipc-message events carry a real currentTarget) with Electron's send()
// recorded. The assistant send path and the error toast are injected.
const AnnotationController = require('../../../../../renderer/components/assistant/AnnotationController');

const { formatAnnotation, normalizePick } = AnnotationController;

function mockWebview() {
  const wv = document.createElement('webview');
  wv.send = jest.fn();
  wv.getBoundingClientRect = () => ({ left: 400, top: 50, width: 600, height: 800, right: 1000, bottom: 850 });
  document.body.appendChild(wv);
  return wv;
}

const pick = (extra = {}) => ({
  selector: '#buy', strategy: 'id', role: 'button', name: 'Buy now', tag: 'button', text: 'Buy',
  rect: { x: 100, y: 200, width: 80, height: 20 }, viewport: { width: 1200, height: 1600 },
  htmlSnippet: '<button id="buy">Buy</button>', url: 'https://shop.example/p/1', title: 'Shoe', ...extra,
});

function ipcMessage(wv, channel, ...args) {
  const e = new Event('ipc-message');
  Object.assign(e, { channel, args });
  wv.dispatchEvent(e);
}

let active;
let send;
let onError;
let store;
let ctl;

beforeEach(() => {
  document.body.innerHTML = '';
  active = mockWebview();
  send = jest.fn();
  onError = jest.fn();
  store = { set: jest.fn() };
  ctl = new AnnotationController({ getActiveWebview: () => active, send, onError, store });
});

afterEach(() => ctl.destroy());

const bubble = () => document.querySelector('.annotation-bubble');
const textarea = () => bubble().querySelector('textarea');
const sendBtn = () => bubble().querySelector('.annotation-bubble__btn--primary');

test('start puts only the active webview into pick mode and mirrors ShellStore', () => {
  const other = mockWebview();
  expect(ctl.start()).toBe(true);
  expect(active.send).toHaveBeenCalledWith('ic-annotate:start');
  expect(other.send).not.toHaveBeenCalled();
  expect(store.set).toHaveBeenLastCalledWith('annotating', true);
  expect(ctl.start()).toBe(false);
  expect(active.send).toHaveBeenCalledTimes(1);
});

test('a pick from a webview that is not the active one is ignored', () => {
  const other = mockWebview();
  ctl.start();
  other.addEventListener('ipc-message', (e) => ctl._handleIpc(e));
  ipcMessage(other, 'ic-annotate:picked', pick());
  expect(bubble()).toBeNull();
  active = other;
  ipcMessage(other, 'ic-annotate:picked', pick());
  expect(bubble()).toBeNull();
  expect(ctl.isActive()).toBe(true);
});

test('a pick from the started webview after it stopped being active is ignored', () => {
  const started = active;
  ctl.start();
  active = mockWebview();
  ipcMessage(started, 'ic-annotate:picked', pick());
  expect(bubble()).toBeNull();
});

test('pick → comment → Send delivers the formatted annotation and ends the session', () => {
  ctl.start();
  ipcMessage(active, 'ic-annotate:picked', pick());
  expect(bubble()).not.toBeNull();
  expect(bubble().getAttribute('role')).toBe('dialog');
  expect(document.activeElement).toBe(textarea());
  // 600px on screen for a 1200px page: half scale, below the element.
  expect(bubble().style.left).toBe('450px');
  expect(bubble().style.top).toBe(`${50 + 110 + 8}px`);
  expect(sendBtn().disabled).toBe(true);
  textarea().value = '  Why is this disabled?  ';
  textarea().dispatchEvent(new Event('input'));
  expect(sendBtn().disabled).toBe(false);
  sendBtn().click();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe(formatAnnotation(normalizePick(pick()), 'Why is this disabled?'));
  expect(send.mock.calls[0][0].startsWith('Why is this disabled?\n\n[Annotation on https://shop.example/p/1 — Shoe]')).toBe(true);
  expect(bubble()).toBeNull();
  expect(ctl.isActive()).toBe(false);
  expect(store.set).toHaveBeenLastCalledWith('annotating', false);
  expect(active.send).not.toHaveBeenCalledWith('ic-annotate:stop');
});

test('Enter submits, Shift+Enter does not, an empty comment never sends', () => {
  ctl.start();
  ipcMessage(active, 'ic-annotate:picked', pick());
  textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(send).not.toHaveBeenCalled();
  textarea().value = 'fix';
  textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  expect(send).not.toHaveBeenCalled();
  textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(send).toHaveBeenCalledTimes(1);
});

test('Escape cancels: page told to stop, bubble gone, nothing sent', () => {
  ctl.start();
  ipcMessage(active, 'ic-annotate:picked', pick());
  textarea().value = 'draft';
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(active.send).toHaveBeenLastCalledWith('ic-annotate:stop');
  expect(bubble()).toBeNull();
  expect(send).not.toHaveBeenCalled();
  expect(ctl.isActive()).toBe(false);
  ipcMessage(active, 'ic-annotate:picked', pick());
  expect(bubble()).toBeNull();
});

test('cancel from the page and navigation both end the session', () => {
  ctl.start();
  ipcMessage(active, 'ic-annotate:cancelled');
  expect(ctl.isActive()).toBe(false);
  expect(active.send).not.toHaveBeenCalledWith('ic-annotate:stop');
  ctl.start();
  active.dispatchEvent(new Event('did-start-navigation'));
  expect(ctl.isActive()).toBe(false);
});

test('failures surface: no webview, send throws, unreadable pick, delivery fails', () => {
  active = null;
  expect(ctl.start()).toBe(false);
  expect(onError).toHaveBeenLastCalledWith('Open a page in the browser dock to annotate it.');
  active = mockWebview();
  active.send.mockImplementationOnce(() => { throw new Error('guest gone'); });
  expect(ctl.start()).toBe(false);
  expect(onError).toHaveBeenLastCalledWith('Could not start annotating: guest gone');
  ctl.start();
  ipcMessage(active, 'ic-annotate:picked', { selector: '' });
  expect(onError).toHaveBeenLastCalledWith('The page sent an unreadable selection.');
  expect(ctl.isActive()).toBe(false);
  send.mockImplementation(() => { throw new Error('panel closed'); });
  ctl.start();
  ipcMessage(active, 'ic-annotate:picked', pick());
  textarea().value = 'x';
  expect(ctl.submit()).toBe(false);
  expect(onError).toHaveBeenLastCalledWith('Could not send the annotation: panel closed');
});

describe('formatAnnotation', () => {
  test('the HTML fence outlasts any backtick run in the snippet', () => {
    const text = formatAnnotation(normalizePick(pick({ htmlSnippet: '<code>````</code>' })), 'look');
    expect(text).toContain('`````html\n<code>````</code>\n`````');
  });

  test('omits empty parts', () => {
    const text = formatAnnotation(normalizePick(pick({ name: '', text: '', htmlSnippet: '', url: '', title: '' })), 'hm');
    expect(text).toBe('hm\n\n[Annotation on the current page]\nElement: button (selector: #buy)');
  });
});
