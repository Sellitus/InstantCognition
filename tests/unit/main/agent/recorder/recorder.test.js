// Recorder over the real CdpSessionManager; the external boundary is the
// Electron webContents.debugger, replaced by an EventEmitter-backed double.
const { EventEmitter } = require('events');
const { CdpSessionManager } = require('../../../../../main/services/CdpSessionManager');
const { Recorder, sanitizeEvent } = require('../../../../../main/agent/recorder/recorder');
const { BINDING_NAME, CAPTURE_SOURCE, UNINSTALL_SOURCE } = require('../../../../../main/agent/recorder/captureScript');

const MAIN_FRAME = 'F1';
const CTX = 7;

function mockWebContents({ failOn = null, preAttached = false, id = 11 } = {}) {
  const dbg = new EventEmitter();
  let attached = preAttached;
  dbg.attach = jest.fn(() => { attached = true; });
  dbg.detach = jest.fn(() => { attached = false; });
  dbg.isAttached = jest.fn(() => attached);
  dbg.sendCommand = jest.fn(async (method) => {
    if (method === failOn) throw new Error(`${method} refused`);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: MAIN_FRAME, url: 'https://shop.example/login' } } };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
    return {};
  });
  const wc = new EventEmitter();
  Object.assign(wc, { id, debugger: dbg, isDestroyed: jest.fn(() => false), getTitle: () => 'Shop login' });
  return wc;
}

function mainContext(wc) {
  wc.debugger.emit('message', {}, 'Runtime.executionContextCreated', {
    context: { id: CTX, auxData: { isDefault: true, frameId: MAIN_FRAME } },
  });
}

function bind(wc, payload, executionContextId = CTX) {
  wc.debugger.emit('message', {}, 'Runtime.bindingCalled', {
    name: BINDING_NAME, executionContextId, payload: JSON.stringify(payload),
  });
}

const target = (selector, extra = {}) => ({ selector, strategy: 'name', tag: 'input', role: 'textbox', name: '', text: '', ...extra });
const methods = (wc) => wc.debugger.sendCommand.mock.calls.map((c) => c[0]);

describe('Recorder', () => {
  let cdp;
  let onEvent;
  let recorder;
  beforeEach(() => {
    cdp = new CdpSessionManager();
    onEvent = jest.fn();
    let t = 1000;
    recorder = new Recorder({ cdp, onEvent, now: () => (t += 10) });
  });

  test('start installs the binding and capture script and records the start page', async () => {
    const wc = mockWebContents();
    const res = await recorder.start(wc);
    expect(res.id).toMatch(/^rec_[a-f0-9]{16}$/);
    expect(res).toMatchObject({ startUrl: 'https://shop.example/login', count: 1 });
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Runtime.addBinding', { name: BINDING_NAME });
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SOURCE });
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', { expression: CAPTURE_SOURCE });
    expect(recorder.isRecording(wc.id)).toBe(true);
  });

  test('a password typed in the page is stored redacted even if the page sent it in clear', async () => {
    const wc = mockWebContents();
    const { id } = await recorder.start(wc);
    mainContext(wc);
    bind(wc, { type: 'input', target: target('#pw'), field: { type: 'password' }, value: 'hunter2' });
    const { trace } = await recorder.stop(id);
    const ev = trace.events.find((e) => e.type === 'input');
    expect(ev.value).toBe('[redacted]');
    expect(ev.redacted).toBe(true);
    expect(JSON.stringify(trace)).not.toContain('hunter2');
  });

  test.each([
    ['autocomplete cc-number', { field: { type: 'text', autocomplete: 'cc-number' }, target: target('#card') }],
    ['autocomplete with section prefix', { field: { type: 'text', autocomplete: 'section-pay cc-csc' }, target: target('#c') }],
    ['cc field name in the selector', { field: { type: 'text' }, target: target('input[name="cc-exp"]') }],
  ])('payment card fields are redacted (%s)', async (_label, extra) => {
    const wc = mockWebContents();
    const { id } = await recorder.start(wc);
    mainContext(wc);
    bind(wc, { type: 'input', value: '4111111111111111', ...extra });
    const { trace } = await recorder.stop(id);
    expect(trace.events.find((e) => e.type === 'input').value).toBe('[redacted]');
  });

  test('ordinary fields keep their value; consecutive typing collapses to the last value', async () => {
    const wc = mockWebContents();
    const { id } = await recorder.start(wc);
    mainContext(wc);
    bind(wc, { type: 'input', target: target('#q'), field: { type: 'search' }, value: 'sho' });
    bind(wc, { type: 'input', target: target('#q'), field: { type: 'search' }, value: 'shoes' });
    bind(wc, { type: 'click', target: target('#go', { tag: 'button', role: 'button', name: 'Search' }) });
    const { trace } = await recorder.stop(id);
    expect(trace.events.map((e) => e.type)).toEqual(['navigate', 'input', 'click']);
    expect(trace.events[1].value).toBe('shoes');
  });

  test('binding calls from other frames, other bindings and malformed payloads are ignored', async () => {
    const wc = mockWebContents();
    const { id } = await recorder.start(wc);
    mainContext(wc);
    bind(wc, { type: 'click', target: target('#ad') }, 99);
    wc.debugger.emit('message', {}, 'Runtime.bindingCalled', { name: 'other', executionContextId: CTX, payload: '{}' });
    wc.debugger.emit('message', {}, 'Runtime.bindingCalled', { name: BINDING_NAME, executionContextId: CTX, payload: 'not json' });
    bind(wc, { type: 'eval', target: target('#x') });
    bind(wc, { type: 'click', target: { selector: '' } });
    const { trace } = await recorder.stop(id);
    expect(trace.events.map((e) => e.type)).toEqual(['navigate']);
  });

  test('main-frame navigations are recorded once; subframe navigations are not', async () => {
    const wc = mockWebContents();
    const { id } = await recorder.start(wc);
    wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'sub', parentId: MAIN_FRAME, url: 'https://ads.example/' } });
    wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: MAIN_FRAME, url: 'https://shop.example/cart' } });
    wc.debugger.emit('message', {}, 'Page.navigatedWithinDocument', { frameId: MAIN_FRAME, url: 'https://shop.example/cart' });
    wc.debugger.emit('message', {}, 'Page.navigatedWithinDocument', { frameId: MAIN_FRAME, url: 'https://shop.example/cart#pay' });
    const { trace } = await recorder.stop(id);
    expect(trace.events.map((e) => e.url)).toEqual([
      'https://shop.example/login', 'https://shop.example/cart', 'https://shop.example/cart#pay',
    ]);
  });

  test('the event cap truncates the trace and reports it once', async () => {
    recorder = new Recorder({ cdp, onEvent, maxEvents: 3 });
    const wc = mockWebContents();
    const { id } = await recorder.start(wc);
    mainContext(wc);
    for (let i = 0; i < 5; i += 1) bind(wc, { type: 'click', target: target(`#b${i}`) });
    const { trace } = await recorder.stop(id);
    expect(trace.events).toHaveLength(3);
    expect(trace.truncated).toBe(true);
    expect(onEvent.mock.calls.filter(([e]) => e.truncated && e.event === null)).toHaveLength(1);
  });

  test('stop removes the script, uninstalls, removes the binding and detaches what it attached', async () => {
    const wc = mockWebContents();
    const { id } = await recorder.start(wc);
    const { warnings } = await recorder.stop(id);
    expect(warnings).toEqual([]);
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Page.removeScriptToEvaluateOnNewDocument', { identifier: 'script-1' });
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', { expression: UNINSTALL_SOURCE });
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Runtime.removeBinding', { name: BINDING_NAME });
    expect(wc.debugger.detach).toHaveBeenCalledTimes(1);
    expect(wc.debugger.listenerCount('message')).toBe(0);
    expect(recorder.isRecording(wc.id)).toBe(false);
  });

  test('a debugger the agent already attached is left attached', async () => {
    const wc = mockWebContents({ preAttached: true });
    cdp.attach(wc);
    const { id } = await recorder.start(wc);
    await recorder.stop(id);
    expect(wc.debugger.detach).not.toHaveBeenCalled();
  });

  test('a CDP failure during start releases the session and rethrows', async () => {
    const wc = mockWebContents({ failOn: 'Page.addScriptToEvaluateOnNewDocument' });
    await expect(recorder.start(wc)).rejects.toThrow(/recorder_start_failed: Page.addScriptToEvaluateOnNewDocument refused/);
    expect(methods(wc)).toContain('Runtime.removeBinding');
    expect(wc.debugger.detach).toHaveBeenCalledTimes(1);
    expect(wc.debugger.listenerCount('message')).toBe(0);
    expect(recorder.isRecording(wc.id)).toBe(false);
    await expect(recorder.start(mockWebContents({ id: wc.id }))).resolves.toMatchObject({ count: 1 });
  });

  test('cleanup failures on stop come back as warnings, with the trace intact', async () => {
    const wc = mockWebContents();
    const { id } = await recorder.start(wc);
    wc.debugger.sendCommand.mockImplementation(async (m) => { if (m === 'Runtime.removeBinding') throw new Error('gone'); return {}; });
    const { trace, warnings } = await recorder.stop(id);
    expect(warnings).toEqual(['remove_binding: gone']);
    expect(trace.events).toHaveLength(1);
  });

  test('a destroyed tab ends the recording without CDP calls; stop still returns the trace', async () => {
    const wc = mockWebContents();
    const { id } = await recorder.start(wc);
    wc.isDestroyed.mockReturnValue(true);
    wc.emit('destroyed');
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ id, ended: 'destroyed' }));
    const before = wc.debugger.sendCommand.mock.calls.length;
    const { trace } = await recorder.stop(id);
    expect(trace.endReason).toBe('destroyed');
    expect(wc.debugger.sendCommand.mock.calls.length).toBe(before);
  });

  test('rejects a second recording on the same tab and unknown ids', async () => {
    const wc = mockWebContents();
    await recorder.start(wc);
    await expect(recorder.start(wc)).rejects.toThrow('already_recording');
    await expect(recorder.stop('rec_missing1')).rejects.toThrow('not_recording');
    await expect(recorder.start({ id: 3 })).rejects.toThrow('webcontents_unavailable');
  });
});

describe('sanitizeEvent', () => {
  test('caps long strings and drops unknown keys', () => {
    const ev = sanitizeEvent(JSON.stringify({
      type: 'input', target: target('#q', { name: 'n'.repeat(500) }), field: { type: 'text' }, value: 'v'.repeat(900), extra: 'x',
    }));
    expect(ev.value).toHaveLength(500);
    expect(ev.target.name).toHaveLength(80);
    expect(ev).not.toHaveProperty('extra');
  });

  test('only Enter and Escape key events are kept', () => {
    expect(sanitizeEvent(JSON.stringify({ type: 'key', key: 'a', target: target('#q') }))).toBeNull();
    expect(sanitizeEvent(JSON.stringify({ type: 'key', key: 'Enter', target: target('#q') }))).toMatchObject({ key: 'Enter' });
  });

  test('rejects oversized and non-string payloads', () => {
    expect(sanitizeEvent('x'.repeat(9000))).toBeNull();
    expect(sanitizeEvent({ type: 'click' })).toBeNull();
  });
});
