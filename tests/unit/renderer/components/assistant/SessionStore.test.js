// SessionStore against an ipcRenderer double: lazy session creation, the
// session:get snapshot, and routing of session:event / agent:* pushes by
// session id (other sessions' events are ignored, subagent approvals count).
const { SessionStore, isSessionId } = require('../../../../../renderer/components/assistant/SessionStore');

const SID = 's_abc123';
const OTHER = 's_zzz999';
const CHILD = 's_child01';

function mockIpc(handlers = {}) {
  const listeners = {};
  return {
    listeners,
    invoke: jest.fn(async (ch, arg) => (handlers[ch] ? handlers[ch](arg) : undefined)),
    on: jest.fn((ch, fn) => { listeners[ch] = fn; }),
    fire: (ch, payload) => listeners[ch]({}, payload),
  };
}

const snapshot = (over = {}) => ({
  ok: true,
  meta: { id: SID, headId: 'n2' },
  nodes: [
    { id: 'n1', parentId: null, role: 'user', kind: 'message', content: 'hi' },
    { id: 'n2', parentId: 'n1', role: 'assistant', kind: 'message', content: 'hello' },
  ],
  path: ['n1', 'n2'],
  branches: { n1: { index: 0, count: 2, siblingIds: ['n1', 'n1b'] } },
  pendingPlan: null,
  ...over,
});

let errSpy;
beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => errSpy.mockRestore());

describe('isSessionId', () => {
  test('accepts main-issued ids and rejects anything else', () => {
    expect(isSessionId(SID)).toBe(true);
    expect(isSessionId('abc123')).toBe(false);
    expect(isSessionId('s_ab')).toBe(false);
    expect(isSessionId('s_ABC123')).toBe(false);
    expect(isSessionId(null)).toBe(false);
  });
});

describe('lazy creation', () => {
  test('creates the session once, even for overlapping sends', async () => {
    const ipc = mockIpc({ 'session:create': () => ({ ok: true, session: { id: SID } }) });
    const store = new SessionStore({ ipc });
    const onSession = jest.fn();
    store.on('session', onSession);
    expect(store.activeSessionId).toBeNull();
    const [a, b] = await Promise.all([store.ensureSession(), store.ensureSession()]);
    expect(a).toBe(SID);
    expect(b).toBe(SID);
    expect(ipc.invoke.mock.calls.filter((c) => c[0] === 'session:create')).toHaveLength(1);
    expect(onSession).toHaveBeenCalledWith(SID);
    await store.ensureSession();
    expect(ipc.invoke.mock.calls.filter((c) => c[0] === 'session:create')).toHaveLength(1);
  });

  test('a refused create resolves null and reports persist-failed', async () => {
    const ipc = mockIpc({ 'session:create': () => ({ ok: false, error: 'disk_full' }) });
    const store = new SessionStore({ ipc });
    const failed = jest.fn();
    store.on('persist-failed', failed);
    await expect(store.ensureSession()).resolves.toBeNull();
    expect(failed).toHaveBeenCalledWith({ error: 'disk_full' });
    expect(store.activeSessionId).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  test('a create that returns a malformed id is a failure, not an active session', async () => {
    const ipc = mockIpc({ 'session:create': () => ({ ok: true, session: { id: '../etc' } }) });
    const store = new SessionStore({ ipc });
    await expect(store.ensureSession()).resolves.toBeNull();
    expect(store.activeSessionId).toBeNull();
  });
});

describe('snapshot', () => {
  test('open() validates the id before any IPC', async () => {
    const ipc = mockIpc();
    const store = new SessionStore({ ipc });
    await expect(store.open('nope')).rejects.toThrow(TypeError);
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  test('open() fetches session:get and exposes path nodes and branches', async () => {
    const ipc = mockIpc({ 'session:get': () => snapshot() });
    const store = new SessionStore({ ipc });
    const onSnap = jest.fn();
    store.on('snapshot', onSnap);
    await store.open(SID);
    expect(ipc.invoke).toHaveBeenCalledWith('session:get', { sessionId: SID });
    expect(store.pathNodes().map((n) => n.content)).toEqual(['hi', 'hello']);
    expect(store.branchOf('n1')).toEqual({ index: 0, count: 2, siblingIds: ['n1', 'n1b'] });
    expect(store.node('missing')).toBeNull();
    expect(onSnap).toHaveBeenCalledTimes(1);
  });

  test('refresh() rejects when main fails', async () => {
    const ipc = mockIpc({ 'session:get': () => ({ ok: false, error: 'session_not_found' }) });
    const store = new SessionStore({ ipc });
    await expect(store.open(SID)).rejects.toThrow('session_not_found');
  });

  test('a failed open() leaves the previously shown session active with its snapshot', async () => {
    const ipc = mockIpc({
      'session:get': ({ sessionId }) => (sessionId === SID ? snapshot() : { ok: false, error: 'session_not_found' }),
    });
    const store = new SessionStore({ ipc });
    await store.open(SID);
    const onSession = jest.fn();
    store.on('session', onSession);
    await expect(store.open(OTHER)).rejects.toThrow('session_not_found');
    expect(store.activeSessionId).toBe(SID);
    expect(store.pathNodes().map((n) => n.content)).toEqual(['hi', 'hello']);
    expect(onSession).not.toHaveBeenCalled();
  });

  test('of two overlapping open() calls the later one wins, whichever replies first', async () => {
    const replies = {};
    const ipc = mockIpc({
      'session:get': ({ sessionId }) => new Promise((resolve) => { replies[sessionId] = resolve; }),
    });
    const store = new SessionStore({ ipc });
    const first = store.open(SID);
    const second = store.open(OTHER);
    await Promise.resolve(); await Promise.resolve();
    replies[OTHER](snapshot({ meta: { id: OTHER, headId: 'n2' } }));
    await second;
    replies[SID](snapshot());
    await first;
    expect(store.activeSessionId).toBe(OTHER);
    expect(store.snapshot.meta.id).toBe(OTHER);
  });

  test('a snapshot for another session is not applied', () => {
    const store = new SessionStore({ ipc: mockIpc() });
    store.setActive(SID);
    expect(store.setSnapshot(snapshot({ meta: { id: OTHER, headId: 'x' } }))).toBe(false);
    expect(store.snapshot).toBeNull();
  });

  test('a pending plan in the snapshot is announced once', () => {
    const store = new SessionStore({ ipc: mockIpc() });
    store.setActive(SID);
    const proposed = jest.fn();
    store.on('plan-proposed', proposed);
    const pendingPlan = { plan: { summary: 'Ship it', todos: [{ content: 'a', status: 'pending' }] } };
    store.setSnapshot(snapshot({ pendingPlan }));
    store.setSnapshot(snapshot({ pendingPlan }));
    expect(proposed).toHaveBeenCalledTimes(1);
    expect(proposed.mock.calls[0][0]).toEqual({ sessionId: SID, plan: pendingPlan.plan });
  });
});

describe('event routing', () => {
  test("another session's session:event is ignored", () => {
    const ipc = mockIpc();
    const store = new SessionStore({ ipc });
    store.wire();
    store.setActive(SID);
    const onEvent = jest.fn();
    const onPlan = jest.fn();
    store.on('event', onEvent);
    store.on('plan', onPlan);
    ipc.fire('session:event', { sessionId: OTHER, channel: 'plan-updated', payload: { steps: ['x'] } });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onPlan).not.toHaveBeenCalled();
    expect(store.plan).toBeNull();
    ipc.fire('session:event', { sessionId: SID, channel: 'assistant-chunk', payload: { text: 'a' } });
    expect(onEvent).toHaveBeenCalledWith({ channel: 'assistant-chunk', payload: { text: 'a', sessionId: SID } });
  });

  test('session:event is ignored while no session is active', () => {
    const ipc = mockIpc();
    const store = new SessionStore({ ipc });
    store.wire();
    const onEvent = jest.fn();
    store.on('event', onEvent);
    ipc.fire('session:event', { sessionId: SID, channel: 'task-started', payload: {} });
    expect(onEvent).not.toHaveBeenCalled();
  });

  test('plan-updated from the foreground stream sets the plan; another session does not', () => {
    const ipc = mockIpc();
    const store = new SessionStore({ ipc });
    store.wire();
    store.setActive(SID);
    const onPlan = jest.fn();
    store.on('plan', onPlan);
    ipc.fire('agent:plan-updated', { sessionId: OTHER, steps: ['nope'] });
    expect(onPlan).not.toHaveBeenCalled();
    ipc.fire('agent:plan-updated', { sessionId: SID, steps: ['read', 'write'] });
    expect(onPlan).toHaveBeenCalledWith({ sessionId: SID, steps: ['read', 'write'] });
    expect(store.plan).toEqual({ sessionId: SID, steps: ['read', 'write'] });
  });

  test('plan-updated over session:event (background run) also sets the plan', () => {
    const ipc = mockIpc();
    const store = new SessionStore({ ipc });
    store.wire();
    store.setActive(SID);
    ipc.fire('session:event', { sessionId: SID, channel: 'plan-updated', payload: { ledger: { plan: [] } } });
    expect(store.plan).toEqual({ ledger: { plan: [] }, sessionId: SID });
  });

  test('a deleted session resets the store; a head move refreshes and flags headChanged', async () => {
    const ipc = mockIpc({ 'session:get': () => snapshot() });
    const store = new SessionStore({ ipc });
    store.wire();
    store.setActive(SID);
    const onSnap = jest.fn();
    store.on('snapshot', onSnap);
    ipc.fire('session:list-changed', { sessionId: SID, reason: 'head' });
    await store.refresh();
    expect(onSnap).toHaveBeenCalledWith(expect.objectContaining({ headId: 'n2' }), { headChanged: true });
    ipc.fire('session:list-changed', { sessionId: OTHER, reason: 'deleted' });
    expect(store.activeSessionId).toBe(SID);
    ipc.fire('session:list-changed', { sessionId: SID, reason: 'deleted' });
    expect(store.activeSessionId).toBeNull();
  });
});

describe('approvals', () => {
  const queue = (ids) => ({ has: (id) => ids.includes(id) });

  test("a subagent's approval counts for the active session; an unrelated one does not", () => {
    const ipc = mockIpc();
    const store = new SessionStore({ ipc });
    store.wire();
    store.setActive(SID);
    store.setApprovalQueue(queue(['r1', 'r2', 'r3']));
    ipc.fire('agent:approval-request', { requestId: 'r1', sessionId: CHILD });
    expect(store.approvalState().pending).toBe(0);
    ipc.fire('session:event', {
      sessionId: SID, channel: 'subagent-started',
      payload: { childSessionId: CHILD, task: 'scan', depth: 1, readOnly: true },
    });
    expect(store.isChildSession(CHILD)).toBe(true);
    ipc.fire('agent:approval-request', { requestId: 'r2', sessionId: CHILD });
    ipc.fire('agent:approval-request', { requestId: 'r3', sessionId: OTHER });
    expect(store.approvalState()).toEqual({ pending: 1, requestIds: ['r2'] });
    ipc.fire('session:event', { sessionId: SID, channel: 'subagent-completed', payload: { childSessionId: CHILD, ok: true } });
    expect(store.isChildSession(CHILD)).toBe(false);
  });

  test('requests the queue no longer holds drop out of the count', () => {
    const ipc = mockIpc();
    const store = new SessionStore({ ipc });
    store.wire();
    store.setActive(SID);
    const held = ['r1', 'r2'];
    store.setApprovalQueue(queue(held));
    ipc.fire('agent:approval-request', { requestId: 'r1', sessionId: SID });
    ipc.fire('agent:approval-request', { requestId: 'r2', sessionId: SID });
    ipc.fire('agent:approval-request', { requestId: 'r2', sessionId: SID });
    expect(store.approvalState().pending).toBe(2);
    held.splice(0, 1);
    expect(store.approvalState()).toEqual({ pending: 1, requestIds: ['r2'] });
  });

  test('a resolved request is released from either channel; unknown ids change nothing', () => {
    const ipc = mockIpc();
    const store = new SessionStore({ ipc });
    store.wire();
    store.setActive(SID);
    store.setApprovalQueue(queue(['r1', 'r2', 'r3']));
    for (const id of ['r1', 'r2', 'r3']) ipc.fire('agent:approval-request', { requestId: id, sessionId: SID });
    ipc.fire('agent:approval-resolved', { requestId: 'r1', sessionId: SID, decision: 'approve' });
    expect(store.approvalState().requestIds).toEqual(['r2', 'r3']);
    ipc.fire('session:event', { sessionId: SID, channel: 'approval-resolved', payload: { requestId: 'r3', decision: 'reject', reason: 'stopped' } });
    expect(store.approvalState().requestIds).toEqual(['r2']);
    ipc.fire('agent:approval-resolved', { requestId: 'r-unknown', sessionId: SID, decision: 'approve' });
    ipc.fire('agent:approval-resolved', null);
    expect(store.releaseApproval({ requestId: 'r-unknown' })).toBe(false);
    expect(store.approvalState()).toEqual({ pending: 1, requestIds: ['r2'] });
  });

  test('switching sessions forgets subagent children', () => {
    const ipc = mockIpc();
    const store = new SessionStore({ ipc });
    store.wire();
    store.setActive(SID);
    ipc.fire('session:event', { sessionId: SID, channel: 'subagent-started', payload: { childSessionId: CHILD } });
    store.setActive(OTHER);
    expect(store.isChildSession(CHILD)).toBe(false);
    expect(() => store.setActive('bad id')).toThrow(TypeError);
  });
});
