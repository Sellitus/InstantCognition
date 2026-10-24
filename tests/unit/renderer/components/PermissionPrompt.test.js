/**
 * @jest-environment jsdom
 */

// PermissionPrompt — singleton modal queue driven by the
// 'notifications:permission-prompt' IPC channel; replies on
// 'notifications:permission:resolve'. External boundary: electron.ipcRenderer,
// mocked as a real EventEmitter so the test can deliver requests and observe
// the reply payloads. jest.resetModules() gives each test a fresh singleton.
// Fake timers drive trap()'s deferred setTimeout(0).

const { EventEmitter } = require('events');

let bus;
jest.mock('electron', () => {
  const { EventEmitter: EE } = require('events');
  const em = new EE();
  em.invoke = jest.fn();
  em.__sent = [];
  em.send = jest.fn((channel, payload) => { em.__sent.push({ channel, payload }); });
  global.__permBus = em;
  return { ipcRenderer: em };
});

function fresh() {
  jest.resetModules();
  const prompt = require('../../../../renderer/components/PermissionPrompt');
  bus = global.__permBus;
  return prompt;
}

function deliver(request) {
  bus.emit('notifications:permission-prompt', { sender: bus }, request);
}

describe('PermissionPrompt', () => {
  let prompt;

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.textContent = '';
    prompt = fresh();
    bus.send.mockClear();
    bus.__sent.length = 0;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    bus.removeAllListeners();
    document.body.textContent = '';
  });

  test('initialize() wires the IPC listener exactly once', () => {
    expect(bus.listenerCount('notifications:permission-prompt')).toBe(0);
    prompt.initialize();
    prompt.initialize();
    expect(bus.listenerCount('notifications:permission-prompt')).toBe(1);
  });

  test('known permission renders mapped copy + origin', () => {
    prompt.initialize();
    deliver({ id: 'p1', permission: 'geolocation', origin: 'https://maps.example' });
    const overlay = document.querySelector('.permission-prompt-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.permission-prompt-title').textContent)
      .toBe('Share your location?');
    expect(overlay.querySelector('.permission-prompt-origin').textContent)
      .toBe('https://maps.example');
    expect(overlay.querySelector('.permission-prompt-detail').textContent)
      .toBe('This site wants to access your approximate location.');
  });

  test('unknown permission falls back to a generic title/detail and Unknown site origin', () => {
    prompt.initialize();
    deliver({ id: 'p2', permission: 'bluetooth' });
    const overlay = document.querySelector('.permission-prompt-overlay');
    expect(overlay.querySelector('.permission-prompt-title').textContent).toBe('Allow bluetooth?');
    expect(overlay.querySelector('.permission-prompt-detail').textContent)
      .toBe('This site is requesting the bluetooth permission.');
    expect(overlay.querySelector('.permission-prompt-origin').textContent).toBe('Unknown site');
  });

  test('a request without an id is ignored (no overlay)', () => {
    prompt.initialize();
    deliver({ permission: 'media' });
    expect(document.querySelector('.permission-prompt-overlay')).toBeNull();
  });

  test('a private-tab request offers to remember only for the private session', () => {
    prompt.initialize();
    deliver({ id: 'pp1', origin: 'https://x.com', permission: 'geolocation', ephemeral: true });
    expect(document.querySelector('.permission-prompt-remember').textContent).toMatch(/for this private session/);
    deliver({ id: 'pp2', origin: 'https://y.com', permission: 'geolocation' });
    document.querySelector('.permission-prompt-allow').click();
    expect(document.querySelector('.permission-prompt-remember').textContent).toMatch(/Remember this decision for this site/);
    expect(document.querySelector('.permission-prompt-remember').textContent).not.toMatch(/private/);
  });

  test('Allow resolves with decision=allow and the remember checkbox value', () => {
    prompt.initialize();
    deliver({ id: 'p3', permission: 'notifications', origin: 'https://news.example' });
    document.querySelector('.permission-prompt-allow').click();
    expect(bus.send).toHaveBeenCalledWith(
      'notifications:permission:resolve',
      { id: 'p3', decision: 'allow', remember: true },
    );
    expect(document.querySelector('.permission-prompt-overlay')).toBeNull();
  });

  test('unchecking remember is reflected in the resolve payload', () => {
    prompt.initialize();
    deliver({ id: 'p4', permission: 'notifications', origin: 'https://news.example' });
    document.querySelector('.permission-prompt-remember-cb').checked = false;
    document.querySelector('.permission-prompt-deny').click();
    expect(bus.send).toHaveBeenCalledWith(
      'notifications:permission:resolve',
      { id: 'p4', decision: 'deny', remember: false },
    );
  });

  test('Block resolves deny with the remember value', () => {
    prompt.initialize();
    deliver({ id: 'p5', permission: 'media', origin: 'https://cam.example' });
    document.querySelector('.permission-prompt-deny').click();
    expect(bus.send).toHaveBeenCalledWith(
      'notifications:permission:resolve',
      { id: 'p5', decision: 'deny', remember: true },
    );
  });

  test('Escape denies with remember=false', () => {
    prompt.initialize();
    deliver({ id: 'p6', permission: 'media', origin: 'https://cam.example' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(bus.send).toHaveBeenCalledWith(
      'notifications:permission:resolve',
      { id: 'p6', decision: 'deny', remember: false },
    );
  });

  test('Enter clicks Allow (resolves allow)', () => {
    prompt.initialize();
    deliver({ id: 'p7', permission: 'notifications', origin: 'https://x.example' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(bus.send).toHaveBeenCalledWith(
      'notifications:permission:resolve',
      { id: 'p7', decision: 'allow', remember: true },
    );
  });

  test('Enter while Block is focused never grants: nothing is sent until Block is clicked', () => {
    prompt.initialize();
    deliver({ id: 'p10', permission: 'media', origin: 'https://cam.example' });
    const deny = document.querySelector('.permission-prompt-deny');
    deny.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(bus.send).not.toHaveBeenCalled();
    deny.click();
    expect(bus.send).toHaveBeenCalledWith(
      'notifications:permission:resolve',
      { id: 'p10', decision: 'deny', remember: true },
    );
  });

  test('the close icon denies without remembering', () => {
    prompt.initialize();
    deliver({ id: 'p11', permission: 'geolocation', origin: 'https://map.example' });
    document.querySelector('.permission-prompt-close').click();
    expect(bus.send).toHaveBeenCalledWith(
      'notifications:permission:resolve',
      { id: 'p11', decision: 'deny', remember: false },
    );
    expect(document.querySelector('.permission-prompt-overlay')).toBeNull();
  });

  test('mousedown on the backdrop denies (remember=false)', () => {
    prompt.initialize();
    deliver({ id: 'p8', permission: 'media', origin: 'https://cam.example' });
    const overlay = document.querySelector('.permission-prompt-overlay');
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(bus.send).toHaveBeenCalledWith(
      'notifications:permission:resolve',
      { id: 'p8', decision: 'deny', remember: false },
    );
  });

  test('queued prompts are shown one at a time, in order', () => {
    prompt.initialize();
    deliver({ id: 'q1', permission: 'media', origin: 'https://a.example' });
    deliver({ id: 'q2', permission: 'geolocation', origin: 'https://b.example' });
    // Only one overlay visible.
    expect(document.querySelectorAll('.permission-prompt-overlay')).toHaveLength(1);
    expect(document.querySelector('.permission-prompt-title').textContent)
      .toBe('Use your camera and microphone?');
    document.querySelector('.permission-prompt-allow').click();
    // Next in queue pumps automatically.
    expect(document.querySelectorAll('.permission-prompt-overlay')).toHaveLength(1);
    expect(document.querySelector('.permission-prompt-title').textContent)
      .toBe('Share your location?');
    expect(bus.__sent.map((s) => s.payload.id)).toEqual(['q1']);
  });

  test('no DOM body → auto-denies so the pending promise still resolves', () => {
    prompt.initialize();
    const realBody = document.body;
    Object.defineProperty(document, 'body', { value: null, configurable: true });
    try {
      deliver({ id: 'p9', permission: 'media', origin: 'https://cam.example' });
    } finally {
      Object.defineProperty(document, 'body', { value: realBody, configurable: true });
    }
    expect(bus.send).toHaveBeenCalledWith(
      'notifications:permission:resolve',
      { id: 'p9', decision: 'deny', remember: false },
    );
  });

  test('an external-app prompt names the scheme and shows the target URL as text', () => {
    prompt.initialize();
    deliver({ id: 'x1', origin: 'https://site.example', permission: 'openExternal:mailto', detail: 'mailto:<b>a</b>@b.example' });
    expect(document.querySelector('.permission-prompt-title').textContent).toBe('Open another app?');
    expect(document.querySelector('.permission-prompt').textContent).toContain('"mailto:" link');
    const target = document.querySelector('.permission-prompt-target');
    expect(target.textContent).toBe('mailto:<b>a</b>@b.example');
    expect(target.querySelector('b')).toBeNull();
  });

  test('a prompt main settled on its own is removed, and the next one shows', () => {
    prompt.initialize();
    deliver({ id: 'p1', origin: 'https://a.example', permission: 'geolocation' });
    deliver({ id: 'p2', origin: 'https://b.example', permission: 'geolocation' });
    deliver({ id: 'p3', origin: 'https://c.example', permission: 'geolocation' });
    bus.emit('notifications:permission-resolved', {}, { id: 'p2', decision: 'deny' });
    bus.emit('notifications:permission-resolved', {}, { id: 'p1', decision: 'deny' });
    expect(document.querySelectorAll('.permission-prompt')).toHaveLength(1);
    expect(document.querySelector('.permission-prompt-origin').textContent).toBe('https://c.example');
    expect(bus.send).not.toHaveBeenCalled();
  });
});
