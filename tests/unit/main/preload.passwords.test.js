/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://a.test/login"}
 */

// Saved-password capture and fill in the webview preload. The host IPC
// (ipcRenderer.send/on) is the external boundary; the DOM is jsdom.
const { install, extractCredentials, fillCredentials } = require('../../../main/preload/passwords');

function mockIpc() {
  const listeners = {};
  return {
    on: jest.fn((ch, fn) => { listeners[ch] = fn; }),
    send: jest.fn(),
    emit: (ch, payload) => listeners[ch]({}, payload),
  };
}

const captured = (ipc) => ipc.send.mock.calls.filter((c) => c[0] === 'passwords:captured').map((c) => c[1]);

function type(el, value) { el.value = value; }

// A real form submission (jsdom marks it trusted, unlike dispatchEvent).
function submit(form) {
  form.addEventListener('submit', (e) => e.preventDefault());
  form.requestSubmit();
}

// jsdom has no trusted keydown or click, so the preload's own listeners are
// called directly with a trusted-shaped event.
let docListeners = {};
function trusted(type, target, extra = {}) {
  for (const fn of docListeners[type] || []) fn({ isTrusted: true, type, target, ...extra });
}
function recordDocListeners() {
  docListeners = {};
  const add = document.addEventListener.bind(document);
  jest.spyOn(document, 'addEventListener').mockImplementation((t, fn, opts) => {
    (docListeners[t] = docListeners[t] || []).push(fn);
    return add(t, fn, opts);
  });
}
afterEach(() => jest.restoreAllMocks());

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('extractCredentials', () => {
  test('picks the nearest preceding visible text input as the username', () => {
    document.body.innerHTML = `
      <form id="f">
        <input type="text" id="search" value="shoes">
        <input type="email" id="user" value="alice@a.test">
        <input type="password" id="pw" value="pw1">
      </form>`;
    expect(extractCredentials(document.getElementById('f'), window)).toEqual({ username: 'alice@a.test', password: 'pw1' });
  });

  test('prefers autocomplete=username over a nearer field', () => {
    document.body.innerHTML = `
      <form id="f">
        <input type="text" autocomplete="username" value="alice">
        <input type="text" name="otp-hint" value="remember-me-label">
        <input type="password" value="pw1">
      </form>`;
    expect(extractCredentials(document.getElementById('f'), window)).toEqual({ username: 'alice', password: 'pw1' });
  });

  test('skips hidden and display:none inputs and inputs after the password', () => {
    document.body.innerHTML = `
      <form id="f">
        <input type="text" value="visible-user">
        <input type="hidden" value="csrf-token">
        <div style="display:none"><input type="text" value="honeypot"></div>
        <input type="password" value="pw1">
        <input type="text" value="after">
      </form>`;
    expect(extractCredentials(document.getElementById('f'), window)).toEqual({ username: 'visible-user', password: 'pw1' });
  });

  test('a form whose password is empty yields nothing', () => {
    document.body.innerHTML = '<form id="f"><input type="text" value="alice"><input type="password" value=""></form>';
    expect(extractCredentials(document.getElementById('f'), window)).toBeNull();
  });

  test('a form without a password field yields nothing', () => {
    document.body.innerHTML = '<form id="f"><input type="text" value="alice"><input type="email" value="a@b.c"></form>';
    expect(extractCredentials(document.getElementById('f'), window)).toBeNull();
  });

  test('a password with no username field gives an empty username', () => {
    document.body.innerHTML = '<form id="f"><input type="password" value="pin"></form>';
    expect(extractCredentials(document.getElementById('f'), window)).toEqual({ username: '', password: 'pin' });
  });

  test.each([
    ['a card security code', 'cc-csc'],
    ['a card number', 'billing cc-number'],
    ['a one-time code', 'one-time-code'],
  ])('a password field holding %s is not a login', (_label, ac) => {
    document.body.innerHTML = `<form id="f"><input type="text" autocomplete="cc-name" value="ALICE SMITH"><input type="password" autocomplete="${ac}" value="123"></form>`;
    expect(extractCredentials(document.getElementById('f'), window)).toBeNull();
  });

  test('a card field is never taken as the username', () => {
    document.body.innerHTML = `
      <form id="f">
        <input type="email" value="alice@a.test">
        <input type="tel" autocomplete="cc-number" value="4111111111111111">
        <input type="password" value="pw1">
      </form>`;
    expect(extractCredentials(document.getElementById('f'), window)).toEqual({ username: 'alice@a.test', password: 'pw1' });
  });

  test('a password step with no visible username takes the hidden autocomplete=username value', () => {
    document.body.innerHTML = `
      <form id="f">
        <input type="text" name="q" value="shoes">
        <input type="hidden" autocomplete="username" value="alice@a.test">
        <input type="password" value="pw1">
      </form>`;
    expect(extractCredentials(document.getElementById('f'), window)).toEqual({ username: 'alice@a.test', password: 'pw1' });
  });

  test('a hidden field without the username hint is still ignored', () => {
    document.body.innerHTML = '<form id="f"><input type="hidden" name="user" value="csrf-123"><input type="password" value="pw1"></form>';
    expect(extractCredentials(document.getElementById('f'), window)).toEqual({ username: '', password: 'pw1' });
  });
});

describe('install: capture', () => {
  let ipc;
  beforeEach(() => {
    ipc = mockIpc();
    recordDocListeners();
    install(ipc, window);
  });

  test('a form submit with a filled password reports username + password', () => {
    document.body.innerHTML = '<form id="f"><input type="text" id="u"><input type="password" id="p"><button>Sign in</button></form>';
    type(document.getElementById('u'), 'alice');
    type(document.getElementById('p'), 'pw1');
    submit(document.getElementById('f'));
    expect(captured(ipc)).toEqual([{ username: 'alice', password: 'pw1' }]);
  });

  test('the payload carries no origin; main reads it from the sender', () => {
    document.body.innerHTML = '<form id="f"><input type="text" value="alice"><input type="password" value="pw1"></form>';
    submit(document.getElementById('f'));
    expect(Object.keys(captured(ipc)[0]).sort()).toEqual(['password', 'username']);
  });

  test('a submit from a form without a filled password reports nothing', () => {
    document.body.innerHTML = '<form id="f"><input type="text" value="query"><button>Go</button></form>';
    submit(document.getElementById('f'));
    expect(captured(ipc)).toEqual([]);
  });

  test('Enter in a formless login (SPA) reports the credentials', () => {
    document.body.innerHTML = '<div><input type="email" value="a@a.test"><input type="password" id="p" value="pw1"></div>';
    trusted('keydown', document.getElementById('p'), { key: 'Enter' });
    expect(captured(ipc)).toEqual([{ username: 'a@a.test', password: 'pw1' }]);
  });

  test('clicking a submit button reports once even though submit also fires', () => {
    document.body.innerHTML = '<form id="f"><input type="text" value="alice"><input type="password" value="pw1"><button id="b" type="submit">Go</button></form>';
    trusted('click', document.getElementById('b'));
    submit(document.getElementById('f'));
    expect(captured(ipc)).toEqual([{ username: 'alice', password: 'pw1' }]);
  });

  test('a type=button control (show-password toggle) reports nothing', () => {
    document.body.innerHTML = '<form id="f"><input type="text" value="alice"><input type="password" value="pw1"><button id="eye" type="button">Show</button></form>';
    trusted('click', document.getElementById('eye'));
    expect(captured(ipc)).toEqual([]);
  });

  test('a script-dispatched submit reports nothing', () => {
    document.body.innerHTML = '<form id="f"><input type="text" value="alice"><input type="password" value="pw1"></form>';
    const form = document.getElementById('f');
    form.addEventListener('submit', (e) => e.preventDefault());
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(captured(ipc)).toEqual([]);
    submit(form);
    expect(captured(ipc)).toEqual([{ username: 'alice', password: 'pw1' }]);
  });

  test('script-dispatched Enter and click events report nothing', () => {
    document.body.innerHTML = '<div><input type="email" value="bob@a.test"><input type="password" id="p" value="pw2"><button id="b" type="submit">Go</button></div>';
    document.getElementById('p').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.getElementById('b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(captured(ipc)).toEqual([]);
    trusted('click', document.getElementById('b'));
    expect(captured(ipc)).toEqual([{ username: 'bob@a.test', password: 'pw2' }]);
  });
});

describe('fillCredentials / passwords:fill', () => {
  test('fills username + password on an origin match and dispatches input and change', () => {
    document.body.innerHTML = '<form><input type="text" id="u"><input type="password" id="p"></form>';
    const seen = [];
    for (const id of ['u', 'p']) {
      for (const ev of ['input', 'change']) document.getElementById(id).addEventListener(ev, (e) => seen.push(`${id}:${e.type}:${e.bubbles}`));
    }
    const res = fillCredentials(window, { origin: 'https://a.test', username: 'alice', password: 'pw1' });
    expect(res).toEqual({ ok: true });
    expect(document.getElementById('u').value).toBe('alice');
    expect(document.getElementById('p').value).toBe('pw1');
    expect(seen).toEqual(['u:input:true', 'u:change:true', 'p:input:true', 'p:change:true']);
  });

  test('refuses when the page origin differs from the expected one', () => {
    document.body.innerHTML = '<form><input type="text" id="u"><input type="password" id="p"></form>';
    const res = fillCredentials(window, { origin: 'https://other.test', username: 'alice', password: 'pw1' });
    expect(res).toEqual({ ok: false, reason: 'origin-mismatch' });
    expect(document.getElementById('u').value).toBe('');
    expect(document.getElementById('p').value).toBe('');
  });

  test('prefers the form holding the focused field', () => {
    document.body.innerHTML = `
      <form><input type="text" id="u1"><input type="password" id="p1"></form>
      <form><input type="text" id="u2"><input type="password" id="p2"></form>`;
    document.getElementById('u2').focus();
    fillCredentials(window, { origin: 'https://a.test', username: 'alice', password: 'pw1' });
    expect(document.getElementById('p1').value).toBe('');
    expect(document.getElementById('u2').value).toBe('alice');
    expect(document.getElementById('p2').value).toBe('pw1');
  });

  test('never fills a card security code field', () => {
    document.body.innerHTML = '<form><input type="tel" autocomplete="cc-number" id="n"><input type="password" autocomplete="cc-csc" id="c"></form>';
    expect(fillCredentials(window, { origin: 'https://a.test', username: 'alice', password: 'pw1' })).toEqual({ ok: false, reason: 'no-form' });
    expect(document.getElementById('n').value).toBe('');
    expect(document.getElementById('c').value).toBe('');
  });

  test('reports no-form when the page has no visible password field', () => {
    document.body.innerHTML = '<form><input type="text"><input type="password" hidden></form>';
    expect(fillCredentials(window, { origin: 'https://a.test', username: 'a', password: 'b' })).toEqual({ ok: false, reason: 'no-form' });
  });

  test('the fill message from main is answered with a fill-result', () => {
    const ipc = mockIpc();
    install(ipc, window);
    document.body.innerHTML = '<form><input type="text" id="u"><input type="password" id="p"></form>';
    ipc.emit('passwords:fill', { origin: 'https://evil.test', username: 'alice', password: 'pw1' });
    expect(ipc.send).toHaveBeenCalledWith('passwords:fill-result', { ok: false, reason: 'origin-mismatch' });
    expect(document.getElementById('p').value).toBe('');
    ipc.emit('passwords:fill', { origin: 'https://a.test', username: 'alice', password: 'pw1' });
    expect(ipc.send).toHaveBeenLastCalledWith('passwords:fill-result', { ok: true });
    expect(document.getElementById('p').value).toBe('pw1');
  });
});
