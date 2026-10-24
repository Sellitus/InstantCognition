/**
 * @jest-environment jsdom
 */

// Page text from a private tab must never ride along on a chat message: the
// message is saved under userData/sessions and sent to the model. Boundary
// mocked: electron.ipcRenderer. Webviews are jsdom <webview> elements whose
// executeJavaScript stands in for the guest page.

jest.mock('electron', () => ({ ipcRenderer: { invoke: jest.fn(async () => null) } }));

const ChatLane = require('../../../../../renderer/components/assistant/lanes/ChatLane');

function makeWebview(id, { privateTab = false, text = `text of ${id}`, selection = '' } = {}) {
  const wv = /** @type {any} */ (document.createElement('webview'));
  wv.id = id;
  if (privateTab) wv.setAttribute('partition', 'private');
  wv.executeJavaScript = jest.fn(async (src) => (
    String(src).includes('getSelection') ? selection : { title: id, url: `https://${id}.example/`, mainText: text }
  ));
  document.body.appendChild(wv);
  return wv;
}

function makeLane(active, openTabs) {
  const state = { get: (key) => (key === 'openTabs' ? openTabs : key === 'hiddenTabs' ? [] : undefined) };
  return new ChatLane(/** @type {any} */ ({
    _projectComposer: null,
    _agentLane: { resolveTargetWebview: () => active },
    contextProvider: () => ({ state }),
  }));
}

afterEach(() => { document.body.innerHTML = ''; });

describe('ChatLane context from private tabs', () => {
  test('a normal active tab is attached to the message', async () => {
    const wv = makeWebview('normal');
    const blocks = await makeLane(wv, ['normal']).gatherContextBlocks('what is this?');
    expect(blocks).toContain('--- Active page ---');
    expect(blocks).toContain('text of normal');
  });

  test('a private active tab attaches nothing and its page is never read', async () => {
    const wv = makeWebview('secret', { privateTab: true, selection: 'secret selection' });
    const blocks = await makeLane(wv, ['secret']).gatherContextBlocks('@selection what is this?');
    expect(blocks).toBe('');
    expect(wv.executeJavaScript).not.toHaveBeenCalled();
  });

  test('@spaces leaves private panes out and keeps the normal ones', async () => {
    const normal = makeWebview('normal');
    const secret = makeWebview('secret', { privateTab: true });
    const blocks = await makeLane(normal, ['normal', 'secret']).gatherContextBlocks('@spaces compare');
    expect(blocks).toContain('text of normal');
    expect(blocks).not.toContain('text of secret');
    expect(secret.executeJavaScript).not.toHaveBeenCalled();
  });

  test('/summarize on a private tab explains why instead of reading it', async () => {
    const wv = makeWebview('secret', { privateTab: true });
    const res = await makeLane(wv, ['secret']).composeActionMessages({ action: 'summarize' });
    expect(res.error).toMatch(/private tab/i);
    expect(wv.executeJavaScript).not.toHaveBeenCalled();
  });
});
