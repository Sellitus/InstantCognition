// ArtifactsPane — list/empty/error states, version switching, copy/save and
// session-filtered artifact:upserted pushes, against a mocked IPC boundary.

const ArtifactsPane = require('../../../../../renderer/components/assistant/ArtifactsPane');

const flush = () => new Promise((r) => setTimeout(r, 0));

// Main's artifact-frame:stage / :release, which back every preview.
const stagedDocs = new Map();
function frameRoutes() {
  let n = 0;
  return {
    'artifact-frame:stage': (html) => {
      n += 1;
      const url = `ic-artifact://frame/${String(n).padStart(32, '0')}`;
      stagedDocs.set(url, html);
      return url;
    },
    'artifact-frame:release': (url) => { stagedDocs.delete(url); },
  };
}

function mockIpc(routes) {
  const listeners = new Map();
  const all = { ...frameRoutes(), ...routes };
  return {
    invoke: jest.fn((ch, args) => Promise.resolve().then(() => all[ch](args))),
    on: jest.fn((ch, fn) => listeners.set(ch, fn)),
    removeListener: jest.fn((ch, fn) => { if (listeners.get(ch) === fn) listeners.delete(ch); }),
    emit: (ch, payload) => { const fn = listeners.get(ch); if (fn) fn({}, payload); },
    listeners,
  };
}

const V1 = { id: 'a_page01', version: 1, type: 'html', title: 'Page', content: '<p>one</p>', createdAt: '2026-01-01T00:00:00Z' };
const V2 = { ...V1, version: 2, content: '<p>two</p>', createdAt: '2026-01-02T00:00:00Z' };
const SUMMARY = { id: 'a_page01', type: 'html', title: 'Page', version: 2, versions: [1, 2], updatedAt: V2.createdAt };

function storeRoutes() {
  return {
    'artifact:list': jest.fn(() => ({ ok: true, artifacts: [SUMMARY] })),
    'artifact:get': jest.fn(({ version }) => ({ ok: true, artifact: { ...(version === 1 ? V1 : V2), versions: [1, 2] } })),
    'artifact:save': jest.fn(() => ({ ok: true, path: '/Users/me/page.html' })),
  };
}

let container, pane;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  if (pane) pane.destroy();
  pane = null;
  container.remove();
});

const status = () => container.querySelector('.artifacts-pane__status');
const notice = () => container.querySelector('.artifacts-pane__notice');
const frame = () => container.querySelector('iframe.artifact-frame');
const shownDoc = () => stagedDocs.get(frame().getAttribute('src')) || '';
const items = () => [...container.querySelectorAll('.artifacts-pane__item-btn')];

test('shows the empty state for a session with no artifacts', async () => {
  const ipc = mockIpc({ 'artifact:list': () => ({ ok: true, artifacts: [] }) });
  pane = new ArtifactsPane({ container, ipc });
  expect(status().textContent).toBe('No session selected.');
  await pane.setSession('s_empty1');
  expect(ipc.invoke).toHaveBeenCalledWith('artifact:list', { sessionId: 's_empty1' });
  expect(status().textContent).toMatch(/No artifacts yet/);
  expect(status().getAttribute('role')).toBe('status');
  expect(container.querySelector('.artifacts-pane__viewer').hidden).toBe(true);
  expect(container.querySelector('.artifacts-pane').getAttribute('aria-label')).toBe('Artifacts');
});

test('shows an error with Retry when listing fails, and recovers on retry', async () => {
  const routes = storeRoutes();
  routes['artifact:list'].mockReturnValueOnce({ ok: false, error: 'invalid_session_id' });
  const ipc = mockIpc(routes);
  pane = new ArtifactsPane({ container, ipc });
  await pane.setSession('s_err001');
  expect(status().getAttribute('role')).toBe('alert');
  expect(status().textContent).toBe('Could not load artifacts: invalid_session_id');
  const retry = container.querySelector('.artifacts-pane__retry');
  expect(retry.hidden).toBe(false);
  retry.click();
  await flush(); await flush();
  expect(status().hidden).toBe(true);
  expect(retry.hidden).toBe(true);
  expect(items()).toHaveLength(1);
});

test('an IPC rejection is shown as an error, not swallowed', async () => {
  const ipc = mockIpc({ 'artifact:list': () => { throw new Error('channel closed'); } });
  pane = new ArtifactsPane({ container, ipc });
  await pane.setSession('s_err002');
  expect(status().textContent).toBe('Could not load artifacts: channel closed');
});

test('lists artifacts, opens the newest version and switches versions', async () => {
  const routes = storeRoutes();
  const ipc = mockIpc(routes);
  pane = new ArtifactsPane({ container, ipc });
  await pane.setSession('s_list01');
  await flush();
  expect(items().map((b) => b.textContent)).toEqual(['PagePage · v2']);
  expect(items()[0].getAttribute('aria-current')).toBe('true');
  expect(shownDoc()).toContain('<p>two</p>');
  const select = container.querySelector('.artifacts-pane__version');
  expect(select.getAttribute('aria-label')).toBe('Artifact version');
  expect([...select.options].map((o) => o.value)).toEqual(['2', '1']);
  expect(select.disabled).toBe(false);

  select.value = '1';
  select.dispatchEvent(new Event('change'));
  await flush(); await flush();
  expect(routes['artifact:get']).toHaveBeenLastCalledWith({ sessionId: 's_list01', artifactId: 'a_page01', version: 1 });
  expect(shownDoc()).toContain('<p>one</p>');
  expect(select.value).toBe('1');
});

test('a failed open shows an error notice', async () => {
  const routes = storeRoutes();
  routes['artifact:get'].mockReturnValue({ ok: false, error: 'artifact_corrupt' });
  pane = new ArtifactsPane({ container, ipc: mockIpc(routes) });
  await pane.setSession('s_bad001');
  await flush(); await flush();
  expect(notice().textContent).toBe('Could not open artifact: artifact_corrupt');
  expect(notice().getAttribute('role')).toBe('alert');
});

test('a preview that cannot be staged shows an error notice instead of a stale frame', async () => {
  const routes = storeRoutes();
  routes['artifact-frame:stage'] = () => { throw new Error('stage refused'); };
  pane = new ArtifactsPane({ container, ipc: mockIpc(routes) });
  await pane.setSession('s_stage1');
  await flush(); await flush(); await flush();
  expect(notice().textContent).toBe('Could not show artifact: stage refused');
  expect(notice().getAttribute('role')).toBe('alert');
  expect(frame().hasAttribute('src')).toBe(false);
});

test('upserts for other sessions are ignored; the shown session updates live', async () => {
  const ipc = mockIpc({ 'artifact:list': () => ({ ok: true, artifacts: [] }) });
  pane = new ArtifactsPane({ container, ipc });
  await pane.setSession('s_mine01');
  ipc.emit('artifact:upserted', { sessionId: 's_other1', artifact: { ...V1, title: 'Foreign' } });
  expect(items()).toHaveLength(0);
  expect(status().textContent).toMatch(/No artifacts yet/);

  ipc.emit('artifact:upserted', { sessionId: 's_mine01', artifact: V1 });
  ipc.emit('artifact:upserted', { sessionId: 's_mine01', artifact: V2 });
  expect(items()).toHaveLength(1);
  expect(items()[0].textContent).toBe('PagePage · v2');
  expect(status().hidden).toBe(true);
  await flush(); await flush();
  expect(shownDoc()).toContain('<p>two</p>');
  expect([...container.querySelector('.artifacts-pane__version').options].map((o) => o.value)).toEqual(['2', '1']);
});

test('a reply for a previous session is dropped', async () => {
  let release;
  const ipc = mockIpc({
    'artifact:list': ({ sessionId }) => (sessionId === 's_slow01'
      ? new Promise((r) => { release = () => r({ ok: true, artifacts: [SUMMARY] }); })
      : { ok: true, artifacts: [] }),
  });
  pane = new ArtifactsPane({ container, ipc });
  const slow = pane.setSession('s_slow01');
  await flush();
  await pane.setSession('s_fast01');
  release();
  await slow;
  expect(items()).toHaveLength(0);
  expect(status().textContent).toMatch(/No artifacts yet/);
});

test('clearing the session returns to the no-session state', async () => {
  pane = new ArtifactsPane({ container, ipc: mockIpc(storeRoutes()) });
  await pane.setSession('s_list02');
  await flush();
  await pane.setSession(null);
  expect(items()).toHaveLength(0);
  expect(status().textContent).toBe('No session selected.');
  expect(container.querySelector('.artifacts-pane__viewer').hidden).toBe(true);
});

describe('copy and save', () => {
  let routes;
  beforeEach(async () => {
    routes = storeRoutes();
    pane = new ArtifactsPane({ container, ipc: mockIpc(routes) });
    await pane.setSession('s_act001');
    await flush();
  });
  afterEach(() => { delete navigator.clipboard; });

  const button = (label) => container.querySelector(`[aria-label="${label}"]`);

  test('copy writes the shown version source to the clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: jest.fn(() => Promise.resolve()) }, configurable: true });
    expect(await pane._copySource()).toBe(true);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('<p>two</p>');
    expect(button('Copy artifact source').textContent).toBe('Copied');
  });

  test('a clipboard failure is reported', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: jest.fn(() => Promise.reject(new Error('denied'))) }, configurable: true });
    expect(await pane._copySource()).toBe(false);
    expect(notice().textContent).toBe('Copy failed: denied');
    expect(notice().getAttribute('role')).toBe('alert');
  });

  test('save sends ids only and reports the chosen path', async () => {
    button('Save artifact to a file').click();
    await flush(); await flush();
    expect(routes['artifact:save']).toHaveBeenCalledWith({ sessionId: 's_act001', artifactId: 'a_page01', version: 2 });
    expect(notice().textContent).toBe('Saved to /Users/me/page.html');
  });

  test('a cancelled save is silent; a failed save is an alert', async () => {
    routes['artifact:save'].mockReturnValueOnce({ ok: false, error: 'cancelled' });
    await pane._saveToFile();
    expect(notice().textContent).toBe('');
    routes['artifact:save'].mockReturnValueOnce({ ok: false, error: 'EACCES: permission denied' });
    await pane._saveToFile();
    expect(notice().textContent).toBe('Save failed: EACCES: permission denied');
    expect(notice().getAttribute('role')).toBe('alert');
  });
});

test('destroy unsubscribes and removes the pane', () => {
  const ipc = mockIpc(storeRoutes());
  pane = new ArtifactsPane({ container, ipc });
  expect(ipc.listeners.has('artifact:upserted')).toBe(true);
  pane.destroy();
  pane = null;
  expect(ipc.listeners.has('artifact:upserted')).toBe(false);
  expect(container.querySelector('.artifacts-pane')).toBeNull();
});

test('requires a container', () => {
  expect(() => new ArtifactsPane({ ipc: mockIpc({}) })).toThrow(TypeError);
});
