// visibilityThrottling — the main-window resource coordinator.
//
// Pure logic test: the window, session, and AgentService are stubbed at the
// boundary. Two policies are verified.
//
// 1. setBackgroundThrottling is NEVER called against a hidden window. Electron
//    force-calls RenderWidgetHostImpl::WasShown() on a hidden widget, which
//    clears is_hidden_ while the widget is really still hidden; the FrameEvictor
//    then evicts the compositor frames on its ~5 min timer and every webview
//    pane renders blank until the app restarts. Hiding must therefore push
//    nothing — Chromium's own page-visibility path already throttles hidden
//    pages, which is where the CPU savings come from.
//
// 2. The agent override still lifts throttling for an in-flight run, but only
//    while the window is visible; a push that cannot run safely now is deferred
//    to the next show.

const { VisibilityThrottling } = require('../../../../main/services/visibilityThrottling');

// Build a stubbed webContents that records setBackgroundThrottling calls.
function stubWebContents(ownerWindow) {
  const calls = [];
  return {
    setBackgroundThrottling(v) { calls.push(v); },
    getOwnerBrowserWindow() { return ownerWindow; },
    _calls: calls,
  };
}

function makeHarness() {
  const mainWc = stubWebContents();
  const tabWc = stubWebContents(); // a webview tab hosted by the main window
  const popupWc = stubWebContents(); // a different, visible popup window
  const popupWin = { isVisible: () => true };

  // fireWindow keeps this in step with the events it dispatches, so the
  // controller sees the same visibility a real BrowserWindow would report.
  const visibility = { visible: true };

  const mainWindow = {
    webContents: mainWc,
    on: jest.fn(),
    removeListener: jest.fn(),
    isDestroyed: () => false,
    isVisible: () => visibility.visible,
  };

  // All webContents in the session: main + tab + popup.
  const session = {
    getAllWebContents: () => [mainWc, tabWc, popupWc],
  };

  // Patch tabWc to claim the main window as owner; popupWc claims popupWin.
  mainWc.getOwnerBrowserWindow = () => mainWindow;
  tabWc.getOwnerBrowserWindow = () => mainWindow;
  popupWc.getOwnerBrowserWindow = () => popupWin;

  const agentListeners = {};
  const agentService = {
    on(evt, fn) { (agentListeners[evt] ||= []).push(fn); },
    removeListener(evt, fn) {
      agentListeners[evt] = (agentListeners[evt] || []).filter((f) => f !== fn);
    },
  };

  return { mainWindow, session, agentService, mainWc, tabWc, popupWc, agentListeners, visibility };
}

function stubWebContentsWithAudio(ownerWindow, wasMuted) {
  const calls = { throttle: [], mute: [] };
  return {
    setBackgroundThrottling(v) { calls.throttle.push(v); },
    setAudioMuted(v) { calls.mute.push(v); },
    isAudioMuted() { return !!wasMuted; },
    getOwnerBrowserWindow() { return ownerWindow; },
    _calls: calls,
  };
}

function fireWindow(harness, event) {
  if (harness.visibility) {
    if (event === 'show' || event === 'restore') harness.visibility.visible = true;
    if (event === 'hide' || event === 'minimize') harness.visibility.visible = false;
  }
  const handler = harness.mainWindow.on.mock.calls.find((c) => c[0] === event);
  if (handler) handler[1]();
}

function fireAgent(harness, event) {
  for (const fn of (harness.agentListeners[event] || [])) fn();
}

describe('VisibilityThrottling', () => {
  let harness;
  let ctrl;

  beforeEach(() => {
    jest.useFakeTimers();
    harness = makeHarness();
    ctrl = new VisibilityThrottling();
    ctrl.bind({ mainWindow: harness.mainWindow, session: harness.session, agentService: harness.agentService });
    harness.mainWc._calls.length = 0;
    harness.tabWc._calls.length = 0;
    harness.popupWc._calls.length = 0;
  });

  afterEach(() => {
    ctrl.dispose();
    jest.useRealTimers();
  });

  // The regression the module exists to avoid: a throttling call landing on a
  // hidden widget desyncs Chromium's visibility state and the FrameEvictor
  // blanks every pane ~5 minutes later.
  test('hiding the window never calls setBackgroundThrottling', () => {
    fireWindow(harness, 'hide');
    jest.advanceTimersByTime(60 * 1000);

    expect(harness.mainWc._calls).toEqual([]);
    expect(harness.tabWc._calls).toEqual([]);
  });

  test('showing the window again never calls setBackgroundThrottling', () => {
    fireWindow(harness, 'hide');
    fireWindow(harness, 'show');
    jest.advanceTimersByTime(60 * 1000);

    expect(harness.mainWc._calls).toEqual([]);
    expect(harness.tabWc._calls).toEqual([]);
  });

  test('minimize and restore never call setBackgroundThrottling', () => {
    fireWindow(harness, 'minimize');
    fireWindow(harness, 'restore');
    jest.advanceTimersByTime(60 * 1000);

    expect(harness.mainWc._calls).toEqual([]);
    expect(harness.tabWc._calls).toEqual([]);
  });

  test('an agent run starting while visible lifts throttling exactly once', () => {
    fireAgent(harness, 'task-started');
    jest.advanceTimersByTime(60 * 1000);

    expect(harness.mainWc._calls).toEqual([false]);
    expect(harness.tabWc._calls).toEqual([false]);
  });

  test('a visible popup window is never targeted', () => {
    fireAgent(harness, 'task-started');
    jest.advanceTimersByTime(60 * 1000);

    expect(harness.popupWc._calls).toEqual([]);
  });

  test('ending the run while visible restores throttling', () => {
    fireAgent(harness, 'task-started');
    jest.advanceTimersByTime(60 * 1000);
    harness.tabWc._calls.length = 0;

    fireAgent(harness, 'task-completed');
    jest.advanceTimersByTime(60 * 1000);

    expect(harness.tabWc._calls).toEqual([true]);
  });

  test('task-failed also clears the agent-active override', () => {
    fireAgent(harness, 'task-started');
    jest.advanceTimersByTime(60 * 1000);
    harness.tabWc._calls.length = 0;

    fireAgent(harness, 'task-failed');
    jest.advanceTimersByTime(60 * 1000);

    expect(harness.tabWc._calls).toEqual([true]);
  });

  test('a run starting while hidden defers the lift to the next show', () => {
    fireWindow(harness, 'hide');
    fireAgent(harness, 'task-started');
    jest.advanceTimersByTime(60 * 1000);

    // Nothing may be pushed while hidden — this is the blank-pane guard.
    expect(harness.tabWc._calls).toEqual([]);

    fireWindow(harness, 'show');
    jest.advanceTimersByTime(60 * 1000);

    expect(harness.tabWc._calls).toEqual([false]);
  });

  test('a run that starts and ends while hidden pushes nothing at all', () => {
    fireWindow(harness, 'hide');
    fireAgent(harness, 'task-started');
    fireAgent(harness, 'task-completed');
    jest.advanceTimersByTime(60 * 1000);

    fireWindow(harness, 'show');
    jest.advanceTimersByTime(60 * 1000);

    expect(harness.tabWc._calls).toEqual([]);
  });

  test('dispose cancels a push that has not fired yet', () => {
    fireAgent(harness, 'task-started');
    expect(() => ctrl.dispose()).not.toThrow();
    jest.advanceTimersByTime(60 * 1000);

    expect(harness.tabWc._calls).toEqual([]);
  });
});

describe('VisibilityThrottling — suspend/resume pub-sub', () => {
  test('hide fires suspend handlers; show fires resume handlers', () => {
    const mainWindow = { webContents: stubWebContents(), on: jest.fn(), removeListener: jest.fn() };
    const tabWc = stubWebContents();
    mainWindow.webContents.getOwnerBrowserWindow = () => mainWindow;
    tabWc.getOwnerBrowserWindow = () => mainWindow;
    const session = { getAllWebContents: () => [mainWindow.webContents, tabWc] };
    const agentService = { on: jest.fn(), removeListener: jest.fn() };

    const ctrl = new VisibilityThrottling();
    ctrl.bind({ mainWindow, session, agentService });

    let suspendFires = 0;
    let resumeFires = 0;
    ctrl.onSuspend(() => { suspendFires += 1; });
    ctrl.onResume(() => { resumeFires += 1; });

    const hide = mainWindow.on.mock.calls.find((c) => c[0] === 'hide')[1];
    const show = mainWindow.on.mock.calls.find((c) => c[0] === 'show')[1];

    hide();
    expect(suspendFires).toBe(1);
    expect(resumeFires).toBe(0);

    show();
    expect(suspendFires).toBe(1);
    expect(resumeFires).toBe(1);
  });

  test('suspend does NOT fire while an agent run is active (override matches throttling)', () => {
    const mainWindow = { webContents: stubWebContents(), on: jest.fn(), removeListener: jest.fn() };
    const tabWc = stubWebContents();
    mainWindow.webContents.getOwnerBrowserWindow = () => mainWindow;
    tabWc.getOwnerBrowserWindow = () => mainWindow;
    const session = { getAllWebContents: () => [mainWindow.webContents, tabWc] };

    const agentListeners = {};
    const agentService = {
      on(evt, fn) { (agentListeners[evt] ||= []).push(fn); },
      removeListener() {},
    };

    const ctrl = new VisibilityThrottling();
    ctrl.bind({ mainWindow, session, agentService });

    let suspendFires = 0;
    ctrl.onSuspend(() => { suspendFires += 1; });

    agentListeners['task-started'].forEach((fn) => fn());
    const hide = mainWindow.on.mock.calls.find((c) => c[0] === 'hide')[1];
    hide();

    // Throttling must NOT engage while an agent run is in flight.
    expect(tabWc._calls).not.toContain(true);
    // The suspend signal must be gated by the same agent-active override —
    // a running agent keeps its LLM subprocess alive, so pausing the engine
    // on top of that would only cause a stop/start cycle mid-task.
    expect(suspendFires).toBe(0);
  });

  test('a subscriber that throws does not break sibling subscribers', () => {
    const mainWindow = { webContents: stubWebContents(), on: jest.fn(), removeListener: jest.fn() };
    mainWindow.webContents.getOwnerBrowserWindow = () => mainWindow;
    const session = { getAllWebContents: () => [mainWindow.webContents] };

    const ctrl = new VisibilityThrottling();
    ctrl.bind({ mainWindow, session, agentService: { on: jest.fn(), removeListener: jest.fn() } });

    let secondFired = false;
    ctrl.onSuspend(() => { throw new Error('boom'); });
    ctrl.onSuspend(() => { secondFired = true; });

    const hide = mainWindow.on.mock.calls.find((c) => c[0] === 'hide')[1];
    expect(() => hide()).not.toThrow();
    expect(secondFired).toBe(true);
  });

  test('returned unsubscriber detaches the callback', () => {
    const mainWindow = { webContents: stubWebContents(), on: jest.fn(), removeListener: jest.fn() };
    mainWindow.webContents.getOwnerBrowserWindow = () => mainWindow;
    const session = { getAllWebContents: () => [mainWindow.webContents] };

    const ctrl = new VisibilityThrottling();
    ctrl.bind({ mainWindow, session, agentService: { on: jest.fn(), removeListener: jest.fn() } });

    let fires = 0;
    const off = ctrl.onSuspend(() => { fires += 1; });
    off();
    const hide = mainWindow.on.mock.calls.find((c) => c[0] === 'hide')[1];
    hide();
    expect(fires).toBe(0);
  });
});

describe('VisibilityThrottling — audio mute on hide', () => {
  function makeAudioHarness(wasMuted) {
    const mainWc = stubWebContentsWithAudio(null, wasMuted);
    const tabWc = stubWebContentsWithAudio(null, wasMuted);
    const mainWindow = { webContents: mainWc, on: jest.fn(), removeListener: jest.fn() };
    mainWc.getOwnerBrowserWindow = () => mainWindow;
    tabWc.getOwnerBrowserWindow = () => mainWindow;
    const session = { getAllWebContents: () => [mainWc, tabWc] };
    return { mainWindow, mainWc, tabWc, session };
  }

  test('hide mutes unmuted webContents; show restores', () => {
    const { mainWindow, mainWc, tabWc, session } = makeAudioHarness(false);
    const ctrl = new VisibilityThrottling();
    ctrl.bind({ mainWindow, session, agentService: { on: jest.fn(), removeListener: jest.fn() } });

    const hide = mainWindow.on.mock.calls.find((c) => c[0] === 'hide')[1];
    const show = mainWindow.on.mock.calls.find((c) => c[0] === 'show')[1];

    hide();
    expect(mainWc._calls.mute).toContain(true);
    expect(tabWc._calls.mute).toContain(true);

    show();
    expect(mainWc._calls.mute).toContain(false);
    expect(tabWc._calls.mute).toContain(false);
  });

  test('already-muted webContents are not re-muted on hide', () => {
    const { mainWindow, mainWc, session } = makeAudioHarness(true);
    const ctrl = new VisibilityThrottling();
    ctrl.bind({ mainWindow, session, agentService: { on: jest.fn(), removeListener: jest.fn() } });

    const hide = mainWindow.on.mock.calls.find((c) => c[0] === 'hide')[1];
    hide();
    // setAudioMuted(true) should NOT be called when already muted.
    expect(mainWc._calls.mute).not.toContain(true);
  });
});
