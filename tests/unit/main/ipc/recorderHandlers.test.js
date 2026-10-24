// recorderHandlers: ipcMain is the external boundary (captured handlers are
// invoked directly). The recorder and trace store are real; the webContents
// lookup is an injected double whose debugger mirrors Electron's.
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const invokeHandlers = {};
jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn((ch, fn) => { invokeHandlers[ch] = fn; }) },
}));

const recorderHandlers = require('../../../../main/ipc/recorderHandlers');
const { Recorder } = require('../../../../main/agent/recorder/recorder');
const { TraceStore } = require('../../../../main/agent/recorder/traceStore');
const { CdpSessionManager } = require('../../../../main/services/CdpSessionManager');
const tabRegistry = require('../../../../main/services/tabRegistry');

function mockWebContents(id) {
  const dbg = new EventEmitter();
  let attached = false;
  Object.assign(dbg, {
    attach: jest.fn(() => { attached = true; }),
    detach: jest.fn(() => { attached = false; }),
    isAttached: () => attached,
    sendCommand: jest.fn(async (m) => (m === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'F', url: 'https://a.example/' } } } : {})),
  });
  const wc = new EventEmitter();
  return Object.assign(wc, { id, debugger: dbg, isDestroyed: () => false, getTitle: () => 'A' });
}

const call = (ch, arg) => invokeHandlers[ch]({}, arg);

describe('recorderHandlers', () => {
  let dir;
  let send;
  let wcs;
  let llmClient;
  beforeEach(() => {
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-rec-ipc-'));
    send = jest.fn();
    wcs = new Map([[5, mockWebContents(5)]]);
    llmClient = { chatCompletionJson: jest.fn(async () => ({ ok: true, value: { name: 'a', description: 'd', instructions: '1. go' } })) };
    const mainWindow = { isDestroyed: () => false, webContents: { send } };
    recorderHandlers.register(mainWindow, {
      recorder: new Recorder({ cdp: new CdpSessionManager(), onEvent: (p) => send('recorder:event', p) }),
      traceStore: new TraceStore({ baseDir: dir }),
      webContentsFromId: (id) => wcs.get(id) || null,
      llmClient,
    });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    tabRegistry.remove('space-1');
  });

  test('registers the five channels', () => {
    expect(Object.keys(invokeHandlers).sort()).toEqual(['recorder:delete', 'recorder:list', 'recorder:start', 'recorder:stop', 'recorder:to-skill']);
  });

  test('start → stop saves the trace; list, to-skill and delete use it', async () => {
    const started = await call('recorder:start', { webContentsId: 5 });
    expect(started).toMatchObject({ ok: true, count: 1 });
    expect(send).toHaveBeenCalledWith('recorder:event', expect.objectContaining({ id: started.id, count: 1 }));
    const stopped = await call('recorder:stop', { id: started.id });
    expect(stopped).toMatchObject({ ok: true, recording: { id: started.id, eventCount: 1 }, warnings: [] });
    expect((await call('recorder:list')).recordings.map((r) => r.id)).toEqual([started.id]);
    const draft = await call('recorder:to-skill', { id: started.id, hint: 'open a' });
    expect(draft).toMatchObject({ ok: true, skill: { name: 'a' } });
    expect(llmClient.chatCompletionJson.mock.calls[0][0][1].content).toContain('1. go to https://a.example/');
    expect(await call('recorder:delete', { id: started.id })).toEqual({ ok: true });
    expect((await call('recorder:list')).recordings).toEqual([]);
  });

  test('start resolves a spaceId through the tab registry', async () => {
    tabRegistry.set('space-1', 5, true);
    expect(await call('recorder:start', { spaceId: 'space-1' })).toMatchObject({ ok: true });
  });

  test.each([
    ['recorder:stop', { id: '../x' }, 'invalid_id'],
    ['recorder:stop', {}, 'invalid_id'],
    ['recorder:delete', { id: 'rec_UPPER123' }, 'invalid_id'],
    ['recorder:to-skill', { id: 'rec_/etc/pa' }, 'invalid_id'],
    ['recorder:to-skill', { id: 'rec_aaaaaa11', hint: 7 }, 'invalid_hint'],
    ['recorder:start', { webContentsId: '5' }, 'invalid_webcontents'],
    ['recorder:start', { webContentsId: -1 }, 'invalid_webcontents'],
    ['recorder:start', { webContentsId: 99 }, 'webcontents_unavailable'],
    ['recorder:start', { spaceId: '../../x y' }, 'invalid_space'],
    ['recorder:start', { spaceId: 'nope' }, 'unknown_space'],
    ['recorder:start', [5], 'invalid_webcontents'],
  ])('%s %j → %s', async (ch, arg, error) => {
    expect(await call(ch, arg)).toEqual({ ok: false, error });
  });

  test('errors from the recorder and store reach the caller', async () => {
    expect(await call('recorder:stop', { id: 'rec_aaaaaa11' })).toEqual({ ok: false, error: 'not_recording' });
    expect(await call('recorder:to-skill', { id: 'rec_aaaaaa11' })).toEqual({ ok: false, error: 'not_found' });
    const { id } = await call('recorder:start', { webContentsId: 5 });
    expect(await call('recorder:start', { webContentsId: 5 })).toEqual({ ok: false, error: 'already_recording' });
    await call('recorder:stop', { id });
  });

  test('no push after the window is gone', async () => {
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
    const winSend = jest.fn();
    recorderHandlers.register({ isDestroyed: () => true, webContents: { send: winSend } }, {
      traceStore: new TraceStore({ baseDir: dir }), webContentsFromId: (id) => wcs.get(id) || null,
    });
    const { id } = await call('recorder:start', { webContentsId: 5 });
    await call('recorder:stop', { id });
    expect(winSend).not.toHaveBeenCalled();
  });
});
