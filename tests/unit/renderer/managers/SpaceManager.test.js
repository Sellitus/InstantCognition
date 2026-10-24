jest.mock('electron', () => ({
  ipcRenderer: { send: jest.fn(), on: jest.fn(), invoke: jest.fn() },
}));

const AppState = require('../../../../renderer/core/AppState');
const NavigationManager = require('../../../../renderer/managers/NavigationManager');
const SpaceManager = require('../../../../renderer/managers/SpaceManager');

describe('SpaceManager', () => {
  let state;
  let nav;
  let spaceManager;
  let mockSave;

  beforeEach(() => {
    state = new AppState();
    nav = new NavigationManager(state);
    spaceManager = new SpaceManager(state, nav, null);
    mockSave = jest.fn();
    spaceManager.setSaveCallback(mockSave);

    // Set up state
    state.initFromConfig({
      spaces: {
        custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/', type: 'ai-service' },
        custom2: { name: 'Claude', url: 'https://claude.ai/', type: 'ai-service' },
        custom3: { name: 'Gemini', url: 'https://gemini.google.com/', type: 'ai-service' },
      },
      settings: { multiSpace: false, defaultSpace: 'custom1' },
      state: { activeSpaces: ['custom1'], lastActiveSpaces: [] },
    });

    // Set up DOM
    const container = document.createElement('div');
    container.id = 'space-container';
    document.body.appendChild(container);

  });

  afterEach(() => {
    document.body.textContent = '';
    jest.clearAllMocks();
  });

  describe('Selection (single mode)', () => {
    test('select(id) updates AppState.currentSpaceId', () => {
      spaceManager.select('custom2', false, true);
      expect(state.get('currentSpaceId')).toBe('custom2');
    });

    test('select(id) creates webview on first selection (lazy loading)', () => {
      spaceManager.select('custom2', false, true);
      const wv = document.getElementById('custom2');
      expect(wv).not.toBeNull();
    });

    test('select(id) reuses existing webview on subsequent selections', () => {
      spaceManager.select('custom2', false, true);
      const wv1 = document.getElementById('custom2');

      // Switch away and back
      spaceManager.select('custom1', false, true);
      spaceManager.select('custom2', false, true);
      const wv2 = document.getElementById('custom2');

      expect(wv1).toBe(wv2); // Same DOM element
    });

    test('select(id) with debounce ignores rapid duplicate calls', () => {
      spaceManager.select('custom2', false, true); // skip timeout for first
      spaceManager._lastSelectTime = Date.now();
      spaceManager.select('custom3'); // within 25ms, should be ignored

      expect(state.get('currentSpaceId')).toBe('custom2');
    });

    test('select(id) persists selection to config via save callback', () => {
      spaceManager.select('custom2', false, true);
      expect(mockSave).toHaveBeenCalled();
    });

    test('select(same id) is a no-op in single mode', () => {
      state.set('currentSpaceId', 'custom1');
      const saveBefore = mockSave.mock.calls.length;
      spaceManager.select('custom1', false, true);
      // Should not trigger save since it's the same space
      expect(mockSave.mock.calls.length).toBe(saveBefore);
    });
  });

  describe('Selection (multi mode)', () => {
    beforeEach(() => {
      state.set('multiSpace', true);
      const config = state.get('config');
      if (config && config.settings) config.settings.multiSpace = true;
    });

    test('select(id) activates additional space', () => {
      spaceManager.select('custom1', false, true);
      spaceManager.select('custom2', false, true);

      const active = state.get('activeSpaces');
      expect(active.custom1).toBe(true);
      expect(active.custom2).toBe(true);
    });

    test('select(id) toggles active state (deselects if active)', () => {
      spaceManager.select('custom1', false, true);
      spaceManager.select('custom2', false, true);

      // custom1 and custom2 are active
      // Now deselect custom1
      spaceManager.select('custom1', false, true);

      const active = state.get('activeSpaces');
      expect(active.custom1).toBe(false);
      expect(active.custom2).toBe(true);
    });

    test('select(id) keeps at least one space active', () => {
      spaceManager.select('custom1', false, true);
      // Only custom1 is active, try to deselect it
      spaceManager.select('custom1', false, true);

      // Should not deselect — still active
      const active = state.get('activeSpaces');
      expect(active.custom1).toBe(true);
    });
  });

  describe('Multi-space toggle', () => {
    test('toggleMulti() updates AppState.multiSpace', () => {
      expect(state.get('multiSpace')).toBe(false);
      spaceManager.toggleMulti();
      expect(state.get('multiSpace')).toBe(true);
    });

    test('toggleMulti() saves config', () => {
      spaceManager.toggleMulti();
      expect(mockSave).toHaveBeenCalled();
    });
  });

  describe('Navigation', () => {
    test('next() selects the next space in order', () => {
      state.set('currentSpaceId', 'custom1');
      spaceManager.next();
      expect(state.get('currentSpaceId')).toBe('custom2');
    });

    test('next() wraps around to first', () => {
      state.set('currentSpaceId', 'custom3');
      spaceManager.next();
      expect(state.get('currentSpaceId')).toBe('custom1');
    });

    test('previous() selects the previous space', () => {
      state.set('currentSpaceId', 'custom2');
      spaceManager.previous();
      expect(state.get('currentSpaceId')).toBe('custom1');
    });

    test('previous() wraps around to last', () => {
      state.set('currentSpaceId', 'custom1');
      spaceManager.previous();
      expect(state.get('currentSpaceId')).toBe('custom3');
    });

    test('next/previous do nothing in multi mode', () => {
      state.set('multiSpace', true);
      state.set('currentSpaceId', 'custom1');

      spaceManager.next();
      expect(state.get('currentSpaceId')).toBe('custom1');

      spaceManager.previous();
      expect(state.get('currentSpaceId')).toBe('custom1');
    });
  });

  describe('Webview lifecycle', () => {
    test('created webview has correct src URL from config', () => {
      spaceManager.select('custom2', false, true);
      const wv = document.getElementById('custom2');
      expect(wv.src || wv.getAttribute('src')).toContain('claude.ai');
    });
  });

  // ─── Branch-coverage extension ────────────────────────────────────────────
  // Targeted tests that exercise BOTH arms of every guard/short-circuit in the
  // public SpaceManager surface. Each asserts a behavioral consequence so a
  // negated condition would fail the test.

  describe('setFindBarManager / setSaveCallback wiring', () => {
    test('setFindBarManager stores the find-bar so _activate can close it', () => {
      const fb = { close: jest.fn() };
      spaceManager.setFindBarManager(fb);
      spaceManager.select('custom2', false, true);
      expect(fb.close).toHaveBeenCalled();
    });

    test('_activate does not call findBarManager.close when none was set', () => {
      // findBarManager defaults to null — the `if (this.findBarManager)` arm
      // must take the false branch without throwing.
      expect(() => spaceManager.select('custom2', false, true)).not.toThrow();
    });

    test('setSaveCallback wires the currentSpaceId persistence listener exactly once', () => {
      // First call wired it in beforeEach. A second call must NOT double-wire.
      const onSpy = jest.spyOn(state, 'on');
      spaceManager.setSaveCallback(mockSave);
      expect(onSpy).not.toHaveBeenCalledWith('change:currentSpaceId', expect.any(Function));
      onSpy.mockRestore();
    });

    test('changing currentSpaceId persists it through the save callback', () => {
      mockSave.mockClear();
      state.set('currentSpaceId', 'custom3');
      // The change:currentSpaceId listener calls _persistCurrentSpaceId → save.
      expect(mockSave).toHaveBeenCalled();
      const saved = mockSave.mock.calls[mockSave.mock.calls.length - 1][0];
      expect(saved.state.currentSpaceId).toBe('custom3');
    });

    test('setSaveCallback is a no-op for state.on wiring when state has no on()', () => {
      const fakeState = {
        get: jest.fn(() => ({})),
        set: jest.fn(),
        // intentionally NO `on` — exercises the typeof !== 'function' arm
      };
      const sm = new SpaceManager(fakeState, nav, null);
      expect(() => sm.setSaveCallback(jest.fn())).not.toThrow();
    });
  });

  describe('select() guards', () => {
    test('select() honors the 25ms debounce unless skipTimeout is true', () => {
      spaceManager.select('custom2', false, true); // skipTimeout → goes through
      expect(state.get('currentSpaceId')).toBe('custom2');
      // No skipTimeout and within 25ms of the last select → early return.
      spaceManager._lastSelectTime = Date.now();
      spaceManager.select('custom3', false, false);
      expect(state.get('currentSpaceId')).toBe('custom2');
    });

    test('select(null) falls back to the current space id', () => {
      state.set('currentSpaceId', 'custom2');
      // toggleOverride=true so the same-id early return is bypassed; null is
      // rewritten to currentId then re-activated.
      spaceManager.select(null, true, true);
      expect(state.get('currentSpaceId')).toBe('custom2');
    });

    test('select() turns on spaceViewActive when it was disabled', () => {
      state.set('spaceViewActive', false);
      spaceManager.select('custom2', false, true);
      expect(state.get('spaceViewActive')).toBe(true);
    });

    test('select() in multi-mode hides an already-visible non-last tab', () => {
      state.set('multiSpace', true);
      const cfg = state.get('config');
      if (cfg && cfg.settings) cfg.settings.multiSpace = true;
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      // Both visible. Selecting custom1 (active, not last) hides it.
      spaceManager.select('custom1', false, true);
      expect(state.get('hiddenTabs')).toContain('custom1');
    });
  });

  describe('next() / previous() empty-space guard', () => {
    test('next() is a no-op when there are zero spaces', () => {
      state.set('spaces', {});
      state.set('currentSpaceId', 'gone');
      spaceManager.next();
      expect(state.get('currentSpaceId')).toBe('gone');
    });

    test('previous() is a no-op when there are zero spaces', () => {
      state.set('spaces', {});
      state.set('currentSpaceId', 'gone');
      spaceManager.previous();
      expect(state.get('currentSpaceId')).toBe('gone');
    });

    test('next() starts at index 0 when current id is not in the space list', () => {
      state.set('currentSpaceId', 'not-a-space');
      spaceManager.next();
      expect(state.get('currentSpaceId')).toBe('custom1');
    });
  });

  describe('close()', () => {
    test('close() with no id resolves the active webview and closes it', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      const wv = document.getElementById('custom2');
      nav.setActiveWebview(wv);
      spaceManager.close();
      expect(state.get('openTabs')).not.toContain('custom2');
    });

    test('close() ignores a non-space id (e.g. browser-webview)', () => {
      spaceManager.openTab('custom1');
      const before = state.get('openTabs').slice();
      spaceManager.close('browser-webview');
      expect(state.get('openTabs')).toEqual(before);
    });

    test('close() with no id and no active webview is a no-op', () => {
      spaceManager.openTab('custom1');
      const before = state.get('openTabs').slice();
      // NavigationManager.getActiveWebview returns the browser-webview fallback
      // (id not in allSpaces) so close() short-circuits.
      spaceManager.close();
      expect(state.get('openTabs')).toEqual(before);
    });
  });

  describe('closing a tab tears down its chrome strip', () => {
    test('the strip is destroyed with the wrapper so its listeners do not leak', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      const wrapper = document.getElementById('custom2').closest('.space-webview-wrapper');
      const destroy = jest.fn();
      wrapper._chromeStrip = { destroy };
      spaceManager.closeTab('custom2');
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(wrapper._chromeStrip).toBeNull();
      expect(document.getElementById('custom2')).toBeNull();
    });
  });

  describe('closeTab()', () => {
    test('refuses to close a pinned tab', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      spaceManager.pinTab('custom2');
      spaceManager.closeTab('custom2');
      expect(state.get('openTabs')).toContain('custom2');
    });

    test('is a no-op for a tab that is not open', () => {
      spaceManager.openTab('custom1');
      const before = state.get('openTabs').slice();
      spaceManager.closeTab('custom3'); // not open → idx === -1
      expect(state.get('openTabs')).toEqual(before);
    });

    test('never closes the last remaining tab', () => {
      spaceManager.openTab('custom1');
      spaceManager.closeTab('custom1');
      expect(state.get('openTabs')).toEqual(['custom1']);
    });

    test('removes the tab, drops it from hiddenTabs, and reassigns current', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      spaceManager.openTab('custom3');
      state.set('hiddenTabs', ['custom2']);
      state.set('currentSpaceId', 'custom2');

      spaceManager.closeTab('custom2');

      expect(state.get('openTabs')).toEqual(['custom1', 'custom3']);
      expect(state.get('hiddenTabs')).not.toContain('custom2');
      // Closed tab was current → neighbor picked (idx 1 → 'custom3').
      expect(state.get('currentSpaceId')).toBe('custom3');
    });

    test('picks the previous neighbor when the last tab is closed', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      spaceManager.openTab('custom3');
      state.set('currentSpaceId', 'custom3');

      spaceManager.closeTab('custom3'); // idx 2 == nextOpen.length → prev

      expect(state.get('currentSpaceId')).toBe('custom2');
    });

    test('keeps currentSpaceId untouched when a non-current tab is closed', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      state.set('currentSpaceId', 'custom1');
      spaceManager.closeTab('custom2');
      expect(state.get('currentSpaceId')).toBe('custom1');
    });

    test('multi-mode: un-hides the new focus when every remaining tab is hidden', () => {
      state.set('multiSpace', true);
      const cfg = state.get('config');
      if (cfg && cfg.settings) cfg.settings.multiSpace = true;
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      // Hide the tab that will remain; close the current one.
      state.set('hiddenTabs', ['custom1']);
      state.set('currentSpaceId', 'custom2');

      spaceManager.closeTab('custom2');

      // custom1 is the only tab left and it was hidden — must be un-hidden.
      expect(state.get('hiddenTabs')).not.toContain('custom1');
      expect(state.get('currentSpaceId')).toBe('custom1');
    });

    test('removes the matching ad-hoc space entry when closing a URL tab', () => {
      const id = spaceManager.openAdHocTab('https://example.com/');
      spaceManager.openTab('custom1');
      spaceManager.closeTab(id);
      expect((state.get('adHocSpaces') || {})[id]).toBeUndefined();
    });
  });

  describe('focusTab()', () => {
    test('is a no-op when the tab is not in openTabs', () => {
      spaceManager.openTab('custom1');
      const spy = jest.fn();
      state.on('change:currentSpaceId', spy);
      spaceManager.focusTab('custom3');
      expect(spy).not.toHaveBeenCalled();
    });

    test('multi-mode: shifts currentSpaceId and focuses the webview, no activate', () => {
      state.set('multiSpace', true);
      const cfg = state.get('config');
      if (cfg && cfg.settings) cfg.settings.multiSpace = true;
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      const focusSpy = jest.spyOn(nav, 'focusWebview');
      spaceManager.focusTab('custom1');
      expect(state.get('currentSpaceId')).toBe('custom1');
      expect(focusSpy).toHaveBeenCalledWith('custom1');
      focusSpy.mockRestore();
    });

    test('multi-mode: tolerates a navigationManager without focusWebview', () => {
      const sm = new SpaceManager(state, { focusWebview: undefined }, null);
      sm.setSaveCallback(jest.fn());
      state.set('multiSpace', true);
      state.set('openTabs', ['custom1', 'custom2']);
      expect(() => sm.focusTab('custom1')).not.toThrow();
      expect(state.get('currentSpaceId')).toBe('custom1');
    });

    test('single-mode: focusTab activates (swaps the visible webview)', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      spaceManager.focusTab('custom1');
      expect(state.get('currentSpaceId')).toBe('custom1');
      expect(state.get('activeSpaces').custom1).toBe(true);
    });
  });

  describe('toggleTabVisibility()', () => {
    test('is a no-op outside multi-mode', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      spaceManager.toggleTabVisibility('custom2');
      expect(state.get('hiddenTabs') || []).toEqual([]);
    });

    test('is a no-op for a tab that is not open', () => {
      state.set('multiSpace', true);
      spaceManager.openTab('custom1');
      spaceManager.toggleTabVisibility('custom3');
      expect(state.get('hiddenTabs') || []).toEqual([]);
    });

    test('hides a visible tab and un-hides a hidden one', () => {
      state.set('multiSpace', true);
      const cfg = state.get('config');
      if (cfg && cfg.settings) cfg.settings.multiSpace = true;
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');

      spaceManager.toggleTabVisibility('custom2'); // hide
      expect(state.get('hiddenTabs')).toContain('custom2');

      spaceManager.toggleTabVisibility('custom2'); // un-hide
      expect(state.get('hiddenTabs')).not.toContain('custom2');
    });

    test('refuses to hide the last visible tab', () => {
      state.set('multiSpace', true);
      const cfg = state.get('config');
      if (cfg && cfg.settings) cfg.settings.multiSpace = true;
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      state.set('hiddenTabs', ['custom1']);
      // custom2 is the only visible one — hiding it must be blocked.
      spaceManager.toggleTabVisibility('custom2');
      expect(state.get('hiddenTabs')).not.toContain('custom2');
    });

    test('moves focus to the first still-visible tab when the focused tab is hidden', () => {
      state.set('multiSpace', true);
      const cfg = state.get('config');
      if (cfg && cfg.settings) cfg.settings.multiSpace = true;
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      state.set('currentSpaceId', 'custom2');

      spaceManager.toggleTabVisibility('custom2'); // hide the focused tab

      expect(state.get('currentSpaceId')).toBe('custom1');
    });
  });

  describe('reorderTabs()', () => {
    test('ignores a non-array argument', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      const before = state.get('openTabs').slice();
      spaceManager.reorderTabs('not-an-array');
      expect(state.get('openTabs')).toEqual(before);
    });

    test('accepts a valid permutation and triggers a layout refresh', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      const layout = { refresh: jest.fn() };
      spaceManager.layoutManager = layout;
      spaceManager.reorderTabs(['custom2', 'custom1']);
      expect(state.get('openTabs')).toEqual(['custom2', 'custom1']);
      expect(layout.refresh).toHaveBeenCalled();
    });

    test('accepts a valid permutation when no layoutManager is set', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      spaceManager.layoutManager = null;
      expect(() => spaceManager.reorderTabs(['custom2', 'custom1'])).not.toThrow();
      expect(state.get('openTabs')).toEqual(['custom2', 'custom1']);
    });
  });

  describe('openAdHocTab()', () => {
    test('returns null and does nothing for a falsy url', () => {
      expect(spaceManager.openAdHocTab('')).toBeNull();
      expect(spaceManager.openAdHocTab(null)).toBeNull();
    });

    test('derives the tab name from the URL hostname', () => {
      const id = spaceManager.openAdHocTab('https://news.ycombinator.com/item?id=1');
      expect((state.get('adHocSpaces') || {})[id].name).toBe('news.ycombinator.com');
    });

    test('falls back to a truncated string for an unparseable url', () => {
      const longGarbage = 'x'.repeat(60);
      const id = spaceManager.openAdHocTab(longGarbage);
      const entry = (state.get('adHocSpaces') || {})[id];
      expect(entry.name.endsWith('...')).toBe(true);
      expect(entry.name.length).toBe(33);
    });

    test('tabs opened in the same millisecond get distinct ids and both survive', () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      try {
        const a = spaceManager.openAdHocTab('https://a.example/');
        const b = spaceManager.openAdHocTab('https://b.example/');
        const c = spaceManager.openAdHocTab('https://c.example/');
        expect(new Set([a, b, c]).size).toBe(3);
        const adHoc = state.get('adHocSpaces');
        expect([adHoc[a].url, adHoc[b].url, adHoc[c].url]).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
      } finally {
        now.mockRestore();
      }
    });

    test('uses the short string as-is when an unparseable url is under 30 chars', () => {
      const id = spaceManager.openAdHocTab('weird:short');
      expect((state.get('adHocSpaces') || {})[id].name).toBe('weird:short');
    });
  });

  describe('pinTab() / unpinTab()', () => {
    test('pinTab adds an id once (idempotent)', () => {
      spaceManager.pinTab('custom1');
      spaceManager.pinTab('custom1');
      expect(state.get('pinnedTabs')).toEqual(['custom1']);
    });

    test('unpinTab removes a pinned id', () => {
      spaceManager.pinTab('custom1');
      spaceManager.unpinTab('custom1');
      expect(state.get('pinnedTabs')).toEqual([]);
    });

    test('unpinTab is a no-op for an id that is not pinned', () => {
      spaceManager.pinTab('custom1');
      spaceManager.unpinTab('custom2'); // idx === -1
      expect(state.get('pinnedTabs')).toEqual(['custom1']);
    });
  });

  describe('view mode', () => {
    test('setViewMode("agent") flips the flag; a repeat is a no-op', () => {
      const spy = jest.fn();
      state.on('change:viewMode', spy);
      spaceManager.setViewMode('agent');
      expect(state.get('viewMode')).toBe('agent');
      expect(spy).toHaveBeenCalledTimes(1);
      spaceManager.setViewMode('agent'); // already agent → no emit
      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('setViewMode coerces any non-"agent" value to "user"', () => {
      spaceManager.setViewMode('agent');
      spaceManager.setViewMode('garbage');
      expect(state.get('viewMode')).toBe('user');
    });

    test('toggleViewMode flips user <-> agent', () => {
      expect(state.get('viewMode')).toBe('user');
      spaceManager.toggleViewMode();
      expect(state.get('viewMode')).toBe('agent');
      spaceManager.toggleViewMode();
      expect(state.get('viewMode')).toBe('user');
    });
  });

  describe('toggleMulti() restore-focus branches', () => {
    test('multi→single restores the remembered single-mode focus', () => {
      state.set('currentSpaceId', 'custom2');
      spaceManager.toggleMulti(); // single → multi remembers custom2
      state.set('currentSpaceId', 'custom3'); // user moved focus in multi
      spaceManager.toggleMulti(); // multi → single restores custom2
      expect(state.get('currentSpaceId')).toBe('custom2');
    });

    test('multi→single clears hiddenTabs only when it is non-empty', () => {
      spaceManager.toggleMulti(); // → multi
      // hiddenTabs empty: the clear branch is skipped.
      spaceManager.toggleMulti(); // → single
      expect(state.get('hiddenTabs')).toEqual([]);
    });

    test('toggleMulti tolerates a config without a settings object', () => {
      state.set('config', { state: {} }); // no .settings
      expect(() => spaceManager.toggleMulti()).not.toThrow();
      expect(state.get('multiSpace')).toBe(true);
    });
  });

  describe('_persistField guard', () => {
    test('persisting is skipped when there is no config', () => {
      state.set('config', null);
      // openTab → _persistOpenTabs → _persistField returns early (no config).
      expect(() => spaceManager.openTab('custom1')).not.toThrow();
    });

    test('persisting is skipped when config has no state slice', () => {
      state.set('config', { settings: {} }); // no .state
      expect(() => spaceManager.openTab('custom1')).not.toThrow();
    });
  });

  describe('_ensureWrapper / _deactivate / overlay branches', () => {
    test('_ensureWrapper returns the existing connected webview without recreating', () => {
      spaceManager.openTab('custom1');
      const wv1 = document.getElementById('custom1');
      const again = spaceManager._ensureWrapper('custom1');
      expect(again).toBe(wv1);
    });

    test('_ensureWrapper returns null for an unknown space id', () => {
      expect(spaceManager._ensureWrapper('not-a-space')).toBeNull();
    });

    test('_ensureWrapper returns null when #space-container is missing', () => {
      document.getElementById('space-container').remove();
      expect(spaceManager._ensureWrapper('custom1')).toBeNull();
    });

    test('_ensureWrapper wires webview events when window._wireWebviewEvents exists', () => {
      const wire = jest.fn();
      window._wireWebviewEvents = wire;
      spaceManager._ensureWrapper('custom2');
      expect(wire).toHaveBeenCalled();
      delete window._wireWebviewEvents;
    });

    test('_showLoadingOverlay attaches a spinner overlay and fades it on did-finish-load', () => {
      spaceManager.openTab('custom1');
      const wv = document.getElementById('custom1');
      const wrapper = wv.closest('.space-webview-wrapper');
      const overlay = wrapper.querySelector('.webview-loading-overlay');
      expect(overlay).not.toBeNull();
      expect(overlay.querySelector('.webview-loading-spinner')).not.toBeNull();
      // Not yet faded — the load event has not fired.
      expect(overlay.classList.contains('fade-out')).toBe(false);
      wv.dispatchEvent(new Event('did-finish-load'));
      // removeOverlay() ran synchronously: fade-out applied (the actual node
      // removal is deferred 300ms via the real jsdom timer and is not asserted).
      expect(overlay.classList.contains('fade-out')).toBe(true);
    });

    test('_showLoadingOverlay also fades on did-fail-load', () => {
      spaceManager.openTab('custom2');
      const wv = document.getElementById('custom2');
      const overlay = wv.closest('.space-webview-wrapper').querySelector('.webview-loading-overlay');
      wv.dispatchEvent(new Event('did-fail-load'));
      expect(overlay.classList.contains('fade-out')).toBe(true);
    });

    test('_showLoadingOverlay is a no-op when the webview has no wrapper', () => {
      const stray = document.createElement('webview');
      stray.id = 'stray';
      // Not inside a .space-webview-wrapper → early return, no overlay created.
      expect(() => spaceManager._showLoadingOverlay(stray)).not.toThrow();
      expect(stray.querySelector('.webview-loading-overlay')).toBeNull();
    });

    test('_deactivate without a save callback or config does not throw', () => {
      spaceManager.openTab('custom1');
      spaceManager.openTab('custom2');
      spaceManager._saveConfig = null;
      state.set('config', null);
      expect(() => spaceManager.closeTab('custom2')).not.toThrow();
    });

    test('_pauseInactiveResumeActive sends activity for active/inactive webviews', () => {
      const ipc = require('electron').ipcRenderer;
      const mkWv = (id, cls) => {
        const w = document.createElement('webview');
        w.id = id; w.className = `space-browser ${cls}`;
        w.getWebContentsId = () => 99;
        document.getElementById('space-container').appendChild(w);
      };
      mkWv('a', 'inactive');
      mkWv('b', 'active');
      ipc.send.mockClear();
      spaceManager._pauseInactiveResumeActive();
      const channels = ipc.send.mock.calls.map((c) => c[0]);
      expect(channels.filter((c) => c === 'space-activity').length).toBeGreaterThanOrEqual(2);
    });
  });
});
