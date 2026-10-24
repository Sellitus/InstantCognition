// LauncherView — drives the real launcher.html markup in jsdom; only the IPC
// boundary (invoke/on) is replaced.
const fs = require('fs');
const path = require('path');
const { LauncherView, friendly } = require('../../../../renderer/launcher/LauncherView');

const HTML = fs.readFileSync(path.join(__dirname, '../../../../launcher.html'), 'utf8');
const BODY = HTML.slice(HTML.indexOf('<main'), HTML.indexOf('</main>') + '</main>'.length);

function makeIpc(invokeImpl) {
  const listeners = {};
  return {
    listeners,
    invoke: jest.fn(invokeImpl || (async () => ({ ok: true }))),
    on: jest.fn((ch, fn) => { listeners[ch] = fn; }),
    emit(ch, payload) { listeners[ch]({}, payload); },
  };
}

function mount(ipc, opts = {}) {
  document.body.className = 'launcher-body';
  document.body.innerHTML = BODY;
  return new LauncherView({ doc: document, ipc, platform: 'darwin', ...opts }).mount();
}

const $ = (id) => document.getElementById(id);

async function ask(view, text) {
  view.input.value = text;
  await view.submit();
}

describe('LauncherView', () => {
  test('requires doc and ipc', () => {
    expect(() => new LauncherView({ doc: document })).toThrow(TypeError);
  });

  test('fails loudly when launcher.html lacks an element it needs', () => {
    document.body.innerHTML = '<div></div>';
    expect(() => new LauncherView({ doc: document, ipc: makeIpc() }).mount()).toThrow('#launcher-form missing');
  });

  test('submit sends launcher:submit and renders streamed markdown for that session', async () => {
    const ipc = makeIpc(async () => ({ ok: true, sessionId: 's_aaaaaa1' }));
    const view = mount(ipc);
    await ask(view, '  What is 2+2?  ');
    expect(ipc.invoke).toHaveBeenCalledWith('launcher:submit', { text: 'What is 2+2?' });
    expect($('launcher-open').hidden).toBe(false);
    ipc.emit('launcher:stream', { sessionId: 's_aaaaaa1', type: 'chunk', delta: '**Four**' });
    ipc.emit('launcher:stream', { sessionId: 's_aaaaaa1', type: 'done' });
    expect($('launcher-answer').querySelector('strong').textContent).toBe('Four');
    expect(view.streaming).toBe(false);
    expect($('launcher-status').hidden).toBe(true);
  });

  test('stream events for another session are ignored', async () => {
    const ipc = makeIpc(async () => ({ ok: true, sessionId: 's_current1' }));
    const view = mount(ipc);
    await ask(view, 'second question');
    ipc.emit('launcher:stream', { sessionId: 's_previous', type: 'chunk', delta: 'stale answer' });
    ipc.emit('launcher:stream', { sessionId: 's_previous', type: 'error', error: 'boom' });
    ipc.emit('launcher:stream', { sessionId: 's_current1', type: 'chunk', delta: 'fresh' });
    expect($('launcher-answer').textContent).toBe('fresh');
    expect($('launcher-status').classList.contains('is-error')).toBe(false);
  });

  test('events that beat the submit reply are replayed once the session is known', async () => {
    let resolveSubmit;
    const ipc = makeIpc(() => new Promise((r) => { resolveSubmit = r; }));
    const view = mount(ipc);
    view.input.value = 'hi';
    const pending = view.submit();
    ipc.emit('launcher:stream', { sessionId: 's_early001', type: 'error', error: 'engine_busy' });
    ipc.emit('launcher:stream', { sessionId: 's_other01', type: 'chunk', delta: 'not mine' });
    resolveSubmit({ ok: true, sessionId: 's_early001' });
    await pending;
    expect($('launcher-status').textContent).toBe(friendly('engine_busy'));
    expect($('launcher-status').classList.contains('is-error')).toBe(true);
    expect($('launcher-answer').textContent).toBe('');
    // engine_busy deletes the session in main, so there is nothing to open.
    expect($('launcher-open').hidden).toBe(true);
  });

  test('a rejected submit shows the error and never opens a session', async () => {
    const ipc = makeIpc(async () => ({ ok: false, error: 'invalid_text' }));
    const view = mount(ipc);
    await ask(view, 'x');
    expect($('launcher-status').textContent).toBe('Type a question first.');
    expect($('launcher-open').hidden).toBe(true);
    expect(view.sessionId).toBeNull();
  });

  test('a thrown invoke is surfaced, not swallowed', async () => {
    const ipc = makeIpc(async () => { throw new Error('No handler registered'); });
    const view = mount(ipc);
    await ask(view, 'x');
    expect($('launcher-status').textContent).toBe('Something went wrong: No handler registered');
  });

  test('empty input does not submit', async () => {
    const ipc = makeIpc();
    const view = mount(ipc);
    await ask(view, '   ');
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  test('Open in Assistant sends the current session; Mod+Enter does the same', async () => {
    const ipc = makeIpc(async (ch) => (ch === 'launcher:submit' ? { ok: true, sessionId: 's_open0001' } : { ok: true }));
    const view = mount(ipc);
    await ask(view, 'hi');
    $('launcher-open').click();
    view.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await Promise.resolve();
    const opens = ipc.invoke.mock.calls.filter((c) => c[0] === 'launcher:open-in-assistant');
    expect(opens).toEqual([['launcher:open-in-assistant', { sessionId: 's_open0001' }], ['launcher:open-in-assistant', { sessionId: 's_open0001' }]]);
  });

  test('Open in Assistant does nothing before any session exists', async () => {
    const ipc = makeIpc();
    const view = mount(ipc);
    await view.openInAssistant();
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  test('a failed open-in-assistant is shown', async () => {
    const ipc = makeIpc(async (ch) => (ch === 'launcher:submit' ? { ok: true, sessionId: 's_gone0001' } : { ok: false, error: 'session_not_found' }));
    const view = mount(ipc);
    await ask(view, 'hi');
    await view.openInAssistant();
    expect($('launcher-status').textContent).toBe('That conversation no longer exists.');
  });

  test('launcher:shown applies the theme and focuses the input', () => {
    const ipc = makeIpc();
    const view = mount(ipc, { prefersDark: () => false });
    ipc.emit('launcher:shown', { theme: 'light' });
    expect(document.body.classList.contains('theme-light')).toBe(true);
    expect(document.activeElement).toBe(view.input);
    ipc.emit('launcher:shown', { theme: 'system' });
    expect(document.body.classList.contains('theme-light')).toBe(true);
    expect(document.body.classList.contains('theme-dark')).toBe(false);
  });

  test('the hint hides once the user types', () => {
    const view = mount(makeIpc());
    view.input.value = 'a';
    view.input.dispatchEvent(new Event('input'));
    expect($('launcher-hint').hidden).toBe(true);
    view.input.value = '';
    view.input.dispatchEvent(new Event('input'));
    expect($('launcher-hint').hidden).toBe(false);
  });

  test('shows the platform modifier in the key hints', () => {
    mount(makeIpc(), { platform: 'win32' });
    expect($('launcher-mod-key').textContent).toBe('Ctrl');
  });

  test('malformed stream payloads are ignored', async () => {
    const ipc = makeIpc(async () => ({ ok: true, sessionId: 's_aaaaaa1' }));
    const view = mount(ipc);
    await ask(view, 'q');
    ipc.emit('launcher:stream', null);
    ipc.emit('launcher:stream', { sessionId: 's_aaaaaa1', type: 'chunk', delta: 5 });
    expect($('launcher-answer').textContent).toBe('');
    expect(view.streaming).toBe(true);
  });
});
