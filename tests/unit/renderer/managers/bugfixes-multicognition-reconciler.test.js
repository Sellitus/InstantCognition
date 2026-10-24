// Regression lock-in for the multicognition reconciler — the architectural fix
// that resolved "tabs activated but not showing" and "shown tabs are blank".
//
// Before the fix the renderer carried two parallel visibility models:
//   - `activeSpaces` (a map the layout strategies iterate to decide which
//     wrapper to render)
//   - `hiddenTabs` (a list TabBar reads to mark a tab as hidden)
// Several code paths flipped one without the other, and the visibility-toggle
// path (`toggleTabVisibility`) never lazy-created the DOM wrapper. The result
// was "ghost tabs" — rows in the strip with no webview, and a user-visible
// "shown but blank" symptom.
//
// The fix makes `activeSpaces` strictly derived from canonical inputs
// (`openTabs`, `hiddenTabs`, `multiSpace`, `currentSpaceId`) through a single
// reconciler `_syncActiveSpaces`, and routes every visibility-changing path
// through it. `_ensureWrapper` is the single place a webview is instantiated.
//
// These tests lock in the invariants and the two specific bug scenarios the
// fix was designed to prevent from returning.
//
// Deferred per the 10-test cap:
//   - closeTab multi-mode safety net: after closing the last visible tab when
//     all remaining tabs are hidden, the new focused tab must be unhidden.
//     The safety branch in closeTab covers this; live behavior is exercised
//     end-to-end in the manual contract in the plan file.

jest.mock('electron', () => ({
  ipcRenderer: { send: jest.fn(), on: jest.fn(), invoke: jest.fn() },
}));

const AppState = require('../../../../renderer/core/AppState');
const NavigationManager = require('../../../../renderer/managers/NavigationManager');
const SpaceManager = require('../../../../renderer/managers/SpaceManager');
const LayoutManager = require('../../../../renderer/managers/LayoutManager');

// Canonical setup helper. Builds a real AppState + NavigationManager +
// SpaceManager + LayoutManager wired the same way renderer.js wires them.
// Returns the rig so tests can reach into any layer. The `state` arg lets
// tests inject custom `initFromConfig` payloads (used for boot-replay tests).
function makeRig(initState) {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.id = 'space-container';
  document.body.appendChild(container);

  const state = new AppState();
  state.initFromConfig({
    spaces: {
      custom1: { name: 'ChatGPT',     url: 'https://chatgpt.com/',         type: 'ai-service' },
      custom2: { name: 'Claude',      url: 'https://claude.ai/',           type: 'ai-service' },
      custom3: { name: 'Gemini',      url: 'https://gemini.google.com/',   type: 'ai-service' },
    },
    settings: { multiSpace: false, defaultSpace: 'custom1' },
    state: { activeSpaces: ['custom1'], openTabs: ['custom1'], lastActiveSpaces: [] },
    ...(initState || {}),
  });

  const nav = new NavigationManager(state);
  const layoutManager = new LayoutManager(state);
  const spaceManager = new SpaceManager(state, nav, layoutManager);
  layoutManager.setSpaceManager(spaceManager);
  spaceManager.setSaveCallback(jest.fn());
  layoutManager.initialize();

  return { state, nav, layoutManager, spaceManager, container };
}

afterEach(() => {
  document.body.innerHTML = '';
  jest.clearAllMocks();
});

describe('multicognition reconciler — invariants', () => {
  // The reconciler is the single derivation source for activeSpaces. If this
  // breaks, every visibility-dependent caller (TabBar highlighting, layout
  // rendering, persistence) silently desynchronizes. The CORE contract.
  // Multi: activeSpaces[id] === (id in openTabs && !hiddenTabs.includes(id)).
  // Single: activeSpaces[id] === (id === currentSpaceId).
  test('activeSpaces is strictly derived from canonical inputs in both modes', () => {
    const { state, spaceManager } = makeRig();

    // Multi-mode scenario: three open, one hidden.
    state.set('multiSpace', true);
    state.set('openTabs', ['custom1', 'custom2', 'custom3']);
    state.set('hiddenTabs', ['custom2']);
    state.set('currentSpaceId', 'custom1');
    spaceManager._syncActiveSpaces();
    const multi = state.get('activeSpaces');
    expect(multi.custom1).toBe(true);
    expect(multi.custom2).toBe(false); // in openTabs but hidden
    expect(multi.custom3).toBe(true);

    // Single-mode scenario over the same openTabs: only currentSpaceId active.
    state.set('multiSpace', false);
    state.set('hiddenTabs', []);
    state.set('currentSpaceId', 'custom2');
    spaceManager._syncActiveSpaces();
    const single = state.get('activeSpaces');
    expect(single.custom1).toBe(false);
    expect(single.custom2).toBe(true); // only the focused tab
    expect(single.custom3).toBe(false);
  });
});

describe('multicognition reconciler — lazy wrapper creation', () => {
  // The exact symptom users reported: a tab is "activated" (visible per
  // hiddenTabs) but no wrapper exists in the DOM, so the layout renders
  // nothing for it. The reconciler must lazy-create the wrapper.
  test('toggleTabVisibility un-hide creates the missing DOM wrapper for a ghost tab', () => {
    const { state, spaceManager } = makeRig();
    state.set('multiSpace', true);
    // Tab is open but never had a wrapper (the "ghost tab" — possible after
    // boot replay with openTabs ⊋ activeSpaces). hiddenTabs marks it hidden.
    state.set('openTabs', ['custom1', 'custom2']);
    state.set('hiddenTabs', ['custom2']);
    spaceManager._syncActiveSpaces();
    expect(document.getElementById('custom2')).toBeNull();

    // User clicks the hidden tab to show it.
    spaceManager.toggleTabVisibility('custom2');

    // Wrapper MUST exist now — otherwise the layout has nothing to render
    // for custom2 and the user sees a blank space where the tab should be.
    expect(document.getElementById('custom2')).not.toBeNull();
    expect(state.get('hiddenTabs')).not.toContain('custom2');
    expect(state.get('activeSpaces').custom2).toBe(true);
  });
});

describe('multicognition reconciler — mode transitions', () => {
  // The single→multi path used to restore only `config.state.lastActiveSpaces`.
  // For fresh-boot users with no lastActiveSpaces, multi-mode started with one
  // wrapper while the tab strip showed every open tab as active — the source
  // of the "tab strip says active, layout shows nothing" disagreement.
  test('toggleMulti single→multi makes every open tab active and creates every wrapper', () => {
    const { state, spaceManager } = makeRig();
    // Three open tabs, currently in single-mode focused on custom1.
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    spaceManager.openTab('custom3');
    spaceManager.focusTab('custom1');
    expect(state.get('multiSpace')).toBe(false);

    spaceManager.toggleMulti();

    expect(state.get('multiSpace')).toBe(true);
    expect(state.get('hiddenTabs')).toEqual([]);
    const active = state.get('activeSpaces');
    expect(active.custom1).toBe(true);
    expect(active.custom2).toBe(true);
    expect(active.custom3).toBe(true);
    // Every tab has a DOM wrapper — layouts will render all three.
    expect(document.getElementById('custom1')).not.toBeNull();
    expect(document.getElementById('custom2')).not.toBeNull();
    expect(document.getElementById('custom3')).not.toBeNull();
  });

  // Re-enabling multi after a multi→single→multi cycle must not require a
  // page reload for the tabs that were already loaded. The wrappers must
  // stay attached (display:none) so their webviews keep their navigation.
  test('toggleMulti multi→single leaves non-current wrappers attached for zero-reload re-enable', () => {
    const { state, spaceManager } = makeRig();
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    spaceManager.openTab('custom3');
    spaceManager.toggleMulti(); // enable multi — all three wrappers created
    // openTab('custom3') left currentSpaceId='custom3', so toggleMulti will
    // restore single-mode focus to custom3 (the pre-multi current).

    spaceManager.toggleMulti(); // back to single

    expect(state.get('multiSpace')).toBe(false);
    expect(state.get('hiddenTabs')).toEqual([]);
    // Exactly one tab is active in single-mode — and it must be one of the
    // tabs we opened (the reconciler can't fabricate ids).
    const active = state.get('activeSpaces');
    const activeIds = Object.entries(active).filter(([, v]) => v).map(([id]) => id);
    expect(activeIds.length).toBe(1);
    expect(['custom1', 'custom2', 'custom3']).toContain(activeIds[0]);
    expect(activeIds[0]).toBe(state.get('currentSpaceId'));
    // CRITICAL: every wrapper still mounted. If a webview was destroyed here
    // re-enabling multi would force a reload.
    expect(document.getElementById('custom1')).not.toBeNull();
    expect(document.getElementById('custom2')).not.toBeNull();
    expect(document.getElementById('custom3')).not.toBeNull();
  });
});

describe('multicognition reconciler — TabBar ctrl+click flow', () => {
  // Direct repro of the original headline bug: ctrl+click in single-mode used
  // to call toggleMulti() then toggleTabVisibility(id), and toggleTabVisibility
  // on a tab that was NOT yet in activeSpaces would push it into hiddenTabs —
  // the OPPOSITE of the user's intent. The new TabBar handler calls openTab(id)
  // instead, which goes through _activate and the reconciler.
  test('ctrl+click sequence (toggleMulti + openTab) makes the clicked tab visible alongside current', () => {
    const { state, spaceManager } = makeRig();
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    spaceManager.focusTab('custom1');
    expect(state.get('multiSpace')).toBe(false);
    expect(state.get('currentSpaceId')).toBe('custom1');

    // What TabBar._onClick does on ctrl+click from single-mode now:
    spaceManager.toggleMulti();
    spaceManager.openTab('custom2');

    expect(state.get('multiSpace')).toBe(true);
    const active = state.get('activeSpaces');
    expect(active.custom1).toBe(true);
    expect(active.custom2).toBe(true);
    expect(document.getElementById('custom1')).not.toBeNull();
    expect(document.getElementById('custom2')).not.toBeNull();
    expect(state.get('currentSpaceId')).toBe('custom2');
    // The clicked tab is NOT in hiddenTabs — old bug pushed it there.
    expect(state.get('hiddenTabs')).not.toContain('custom2');
  });
});

describe('multicognition reconciler — boot replay', () => {
  // Persistence loads openTabs and hiddenTabs independently of activeSpaces.
  // The reconciler is responsible for materializing the correct DOM + state
  // from those canonical inputs. If this regresses, users return to the app
  // and find tabs in the strip with no webview behind them.
  test('boot replay with openTabs ⊋ activeSpaces creates wrappers for every visible tab', () => {
    const { state, spaceManager } = makeRig({
      settings: { multiSpace: true, defaultSpace: 'custom1' },
      state: {
        // Old session: three open, custom2 hidden, focused on custom1.
        openTabs: ['custom1', 'custom2', 'custom3'],
        hiddenTabs: ['custom2'],
        activeSpaces: ['custom1'], // intentionally stale — must NOT govern
        currentSpaceId: 'custom1',
        lastActiveSpaces: [],
      },
    });

    // Mirror renderer.js boot replay: one reconcile call.
    spaceManager._syncActiveSpaces();

    const active = state.get('activeSpaces');
    expect(active.custom1).toBe(true);
    expect(active.custom2).toBe(false); // hidden, but in openTabs
    expect(active.custom3).toBe(true);
    // Every VISIBLE tab has a wrapper — the bug was custom3 having no wrapper
    // because the legacy boot only looped over the (stale) activeSpaces list.
    expect(document.getElementById('custom1')).not.toBeNull();
    expect(document.getElementById('custom3')).not.toBeNull();
  });
});

describe('multicognition reconciler — focus + safety nets', () => {
  // The old _deactivate path (called by select() in legacy multi-deselect)
  // had a recursive escape: if every active tab was deselected it called
  // toggleMulti() to drop back to single-mode. That recursion now lives only
  // in old code; closeTab must NEVER end in single-mode unless the user asked.
  test('closeTab in 2-tab multi-mode leaves multiSpace=true (no recursive toggleMulti)', () => {
    const { state, spaceManager } = makeRig();
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    spaceManager.toggleMulti();
    expect(state.get('multiSpace')).toBe(true);

    spaceManager.closeTab('custom2');

    expect(state.get('multiSpace')).toBe(true); // surviving tab stays in multi
    expect(state.get('openTabs')).toEqual(['custom1']);
    expect(state.get('currentSpaceId')).toBe('custom1');
  });

  // Clicking the focused visible tab to hide it must NOT leave focus on a
  // hidden id — that strands the keyboard focus on a tab that's not on
  // screen, which then receives broadcasts/keyboard events the user can't see.
  test('hiding the focused tab moves currentSpaceId to the first still-visible tab', () => {
    const { state, spaceManager } = makeRig();
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    spaceManager.openTab('custom3');
    spaceManager.toggleMulti();
    state.set('currentSpaceId', 'custom2');

    spaceManager.toggleTabVisibility('custom2'); // hide the focused tab

    expect(state.get('hiddenTabs')).toContain('custom2');
    expect(state.get('currentSpaceId')).not.toBe('custom2');
    // The new focus must be a still-visible tab (custom1 is first).
    expect(state.get('currentSpaceId')).toBe('custom1');
  });

  // Allowing the last visible tab to be hidden produces an empty multi-mode
  // (every wrapper display:none) — the layout literally renders blank.
  test('toggleTabVisibility refuses to hide the last visible tab', () => {
    const { state, spaceManager } = makeRig();
    spaceManager.openTab('custom1');
    spaceManager.openTab('custom2');
    spaceManager.toggleMulti();
    spaceManager.toggleTabVisibility('custom2'); // hide one, leaves custom1 visible
    expect(state.get('hiddenTabs')).toEqual(['custom2']);

    // Attempt to hide the only remaining visible tab.
    spaceManager.toggleTabVisibility('custom1');

    // State must NOT change — custom1 is still visible, custom2 still hidden.
    expect(state.get('hiddenTabs')).toEqual(['custom2']);
    expect(state.get('activeSpaces').custom1).toBe(true);
  });
});

describe('multicognition reconciler — LayoutManager defense-in-depth', () => {
  // If any future caller bypasses the reconciler and writes activeSpaces
  // directly, LayoutManager.refresh() must still ensure wrappers exist so
  // the layout doesn't silently skip the new active id. Prevents the
  // original "tab activated in state but missing from DOM" symptom from
  // returning through a different door.
  test('LayoutManager.refresh creates a wrapper when activeSpaces names an id without one', () => {
    const { state, layoutManager } = makeRig();
    expect(document.getElementById('custom3')).toBeNull();

    // Simulate a future bug: someone sets activeSpaces directly without going
    // through _syncActiveSpaces, leaving custom3 in the map but with no wrapper.
    state.set('activeSpaces', { custom3: true });
    layoutManager.refresh();

    // Defence-in-depth created the wrapper.
    expect(document.getElementById('custom3')).not.toBeNull();
  });
});
