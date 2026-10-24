/**
 * @jest-environment jsdom
 */

// Annotation mode in the webview preload. The host IPC (ipcRenderer.on /
// sendToHost) is the external boundary. jsdom has no layout, so
// elementsFromPoint and getBoundingClientRect are supplied per test, and the
// closed shadow root is captured as it is attached so the catcher can be
// clicked the way a user would.
const { install, buildPick, MAX_TEXT, MAX_HTML } = require('../../../main/preload/annotate');

function mockIpc() {
  const listeners = {};
  return {
    on: jest.fn((ch, fn) => { listeners[ch] = fn; }),
    sendToHost: jest.fn(),
    emit: (ch) => listeners[ch](),
  };
}

let ipc;
let ctl;
let shadowRoots;
let hit;

beforeEach(() => {
  document.documentElement.querySelectorAll('[data-ic-annotate]').forEach((n) => n.remove());
  document.body.innerHTML = '';
  document.title = 'Shop';
  shadowRoots = [];
  const realAttach = HTMLElement.prototype.attachShadow;
  jest.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function attach(init) {
    const root = realAttach.call(this, init);
    shadowRoots.push(root);
    return root;
  });
  hit = null;
  document.elementsFromPoint = jest.fn(() => (hit ? [hit, document.body, document.documentElement] : []));
  ipc = mockIpc();
  ctl = install(ipc, window);
});

afterEach(() => {
  ctl.stop();
  jest.restoreAllMocks();
});

const catcher = () => shadowRoots[shadowRoots.length - 1].querySelector('.catcher');
const overlayHost = () => document.querySelector('[data-ic-annotate]');

function rectOf(node, r) {
  node.getBoundingClientRect = () => ({ left: r.x, top: r.y, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h });
}

test('inactive by default: no overlay, no listeners on the page, nothing sent', () => {
  expect(ctl.isActive()).toBe(false);
  expect(overlayHost()).toBeNull();
  expect(ipc.on.mock.calls.map((c) => c[0])).toEqual(['ic-annotate:start', 'ic-annotate:stop']);
  document.body.innerHTML = '<button id="b">Buy</button>';
  const clicked = jest.fn();
  document.getElementById('b').addEventListener('click', clicked);
  document.getElementById('b').click();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(clicked).toHaveBeenCalledTimes(1);
  expect(ipc.sendToHost).not.toHaveBeenCalled();
});

test('start mounts the overlay; a click reports the element under the pointer and exits', () => {
  document.body.innerHTML = '<main><button id="buy" aria-label="Buy now">Buy</button></main>';
  hit = document.getElementById('buy');
  rectOf(hit, { x: 10.4, y: 20.6, w: 100, h: 30 });
  const pageClick = jest.fn();
  document.addEventListener('click', pageClick);
  ipc.emit('ic-annotate:start');
  expect(ctl.isActive()).toBe(true);
  expect(overlayHost()).not.toBeNull();
  catcher().dispatchEvent(new MouseEvent('mousemove', { clientX: 15, clientY: 25, bubbles: true }));
  catcher().dispatchEvent(new MouseEvent('click', { clientX: 15, clientY: 25, bubbles: true, cancelable: true }));
  expect(pageClick).not.toHaveBeenCalled();
  expect(ctl.isActive()).toBe(false);
  expect(overlayHost()).toBeNull();
  expect(ipc.sendToHost).toHaveBeenCalledTimes(1);
  const [channel, payload] = ipc.sendToHost.mock.calls[0];
  expect(channel).toBe('ic-annotate:picked');
  expect(payload).toEqual({
    selector: '#buy', strategy: 'id', role: 'button', name: 'Buy now', tag: 'button',
    rect: { x: 10, y: 21, width: 100, height: 30 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    text: 'Buy', htmlSnippet: '<button id="buy" aria-label="Buy now">Buy</button>',
    url: window.location.href, title: 'Shop',
  });
  document.removeEventListener('click', pageClick);
});

test('Escape cancels and tells the host; host stop exits silently', () => {
  ipc.emit('ic-annotate:start');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
  expect(ctl.isActive()).toBe(true);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  expect(ctl.isActive()).toBe(false);
  expect(ipc.sendToHost).toHaveBeenCalledWith('ic-annotate:cancelled');
  ipc.emit('ic-annotate:start');
  ipc.emit('ic-annotate:start');
  expect(document.querySelectorAll('[data-ic-annotate]')).toHaveLength(1);
  ipc.emit('ic-annotate:stop');
  expect(overlayHost()).toBeNull();
  expect(ipc.sendToHost).toHaveBeenCalledTimes(1);
});

test('a click over empty space reports nothing and stays in pick mode', () => {
  ipc.emit('ic-annotate:start');
  catcher().dispatchEvent(new MouseEvent('click', { clientX: 1, clientY: 1, bubbles: true }));
  expect(ipc.sendToHost).not.toHaveBeenCalled();
  expect(ctl.isActive()).toBe(true);
});

test('text and HTML are capped', () => {
  document.body.innerHTML = `<div id="big">${'word '.repeat(400)}<span>${'x'.repeat(3000)}</span></div>`;
  const pick = buildPick(document.getElementById('big'), window);
  expect(pick.text.length).toBe(MAX_TEXT);
  expect(pick.htmlSnippet.length).toBe(MAX_HTML);
});

test('a prefilled secret never reaches the snippet', () => {
  document.body.innerHTML = '<form id="f"><input name="user" value="me"><input type="password" value="hunter2">'
    + '<input autocomplete="cc-number" value="4111111111111111"></form>';
  const pick = buildPick(document.getElementById('f'), window);
  expect(pick.htmlSnippet).toContain('value="me"');
  expect(pick.htmlSnippet).not.toContain('hunter2');
  expect(pick.htmlSnippet).not.toContain('4111');
  expect(document.querySelector('[type="password"]').getAttribute('value')).toBe('hunter2');
});

test('install refuses without a page or an ipc', () => {
  expect(install(ipc, null)).toBeNull();
  expect(install(null, window)).toBeNull();
});
