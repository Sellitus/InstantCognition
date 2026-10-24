const AppState = require('../../../../renderer/core/AppState');

describe('AppState', () => {
  let state;

  beforeEach(() => {
    state = new AppState();
  });

  describe('State management', () => {
    test('initializes with default state values', () => {
      expect(state.get('activeSpaces')).toEqual({});
      expect(state.get('currentSpaceId')).toBe('');
      expect(state.get('multiSpace')).toBe(false);
      expect(state.get('browserViewActive')).toBe(false);
      expect(state.get('spaceViewActive')).toBe(true);
      expect(state.get('currentLayout')).toBe('single');
      expect(state.get('sidebarExpanded')).toBe(false);
    });

    test('get(key) returns current value', () => {
      expect(state.get('defaultSpace')).toBe('custom1');
    });

    test('set(key, value) updates value', () => {
      state.set('currentSpaceId', 'custom5');
      expect(state.get('currentSpaceId')).toBe('custom5');
    });

    test('set emits change:key event with new and old value', () => {
      const listener = jest.fn();
      state.on('change:currentSpaceId', listener);

      state.set('currentSpaceId', 'custom3');

      expect(listener).toHaveBeenCalledWith('custom3', '');
    });

    test('set does NOT emit when value is unchanged (reference equality)', () => {
      state.set('multiSpace', false);
      const listener = jest.fn();
      state.on('change:multiSpace', listener);

      state.set('multiSpace', false);

      expect(listener).not.toHaveBeenCalled();
    });

    test('getAll() returns shallow copy of state', () => {
      const all = state.getAll();
      expect(all).toHaveProperty('activeSpaces');
      expect(all).toHaveProperty('currentSpaceId');
    });

    test('getAll() copy does not affect internal state when mutated', () => {
      const copy = state.getAll();
      copy.currentSpaceId = 'MUTATED';
      expect(state.get('currentSpaceId')).not.toBe('MUTATED');
    });

    test('supports all required keys', () => {
      const requiredKeys = [
        'activeSpaces', 'currentSpaceId', 'loadedSpaces',
        'multiSpace', 'browserViewActive', 'spaceViewActive',
        'sidebarExpanded', 'menuExpanded', 'spaces', 'fullNames',
        'defaultSpace', 'currentLayout', 'openLinkExternal',
        'findBarVisible', 'config', 'spaceOrder',
      ];
      requiredKeys.forEach((key) => {
        expect(state.get(key)).toBeDefined();
      });
    });
  });

  describe('Batch updates', () => {
    test('batch(fn) groups multiple sets — emits after batch completes', () => {
      const listener = jest.fn();
      state.on('change:currentSpaceId', listener);
      state.on('change:multiSpace', listener);

      state.batch(() => {
        state.set('currentSpaceId', 'custom2');
        state.set('multiSpace', true);
      });

      // Both changes should fire after batch, not during
      expect(listener).toHaveBeenCalledTimes(2);
    });

    test('batch suppresses duplicate key changes (keeps last)', () => {
      const listener = jest.fn();
      state.on('change:currentSpaceId', listener);

      state.batch(() => {
        state.set('currentSpaceId', 'custom2');
        state.set('currentSpaceId', 'custom3');
        state.set('currentSpaceId', 'custom4');
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('custom4', '');
    });
  });

  describe('Listeners', () => {
    test('on(change:key, fn) fires on key change', () => {
      const listener = jest.fn();
      state.on('change:browserViewActive', listener);

      state.set('browserViewActive', true);

      expect(listener).toHaveBeenCalledWith(true, false);
    });

    test('removeListener works correctly', () => {
      const listener = jest.fn();
      state.on('change:multiSpace', listener);
      state.removeListener('change:multiSpace', listener);

      state.set('multiSpace', true);

      expect(listener).not.toHaveBeenCalled();
    });

    test('multiple listeners on same key all fire', () => {
      const listener1 = jest.fn();
      const listener2 = jest.fn();
      state.on('change:currentSpaceId', listener1);
      state.on('change:currentSpaceId', listener2);

      state.set('currentSpaceId', 'custom5');

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    test('generic change event fires with key details', () => {
      const listener = jest.fn();
      state.on('change', listener);

      state.set('multiSpace', true);

      expect(listener).toHaveBeenCalledWith({
        key: 'multiSpace',
        newValue: true,
        oldValue: false,
      });
    });
  });

  describe('initFromConfig', () => {
    test('initializes state from config object', () => {
      state.initFromConfig({
        spaces: { custom1: { name: 'Test', url: 'https://test.com/', type: 'ai-service' } },
        spaceOrder: ['custom1'],
        settings: {
          multiSpace: true,
          openLinkExternal: true,
          defaultSpace: 'custom3',
        },
        state: {
          activeSpaces: ['custom2'],
        },
      });

      expect(state.get('multiSpace')).toBe(true);
      expect(state.get('openLinkExternal')).toBe(true);
      expect(state.get('defaultSpace')).toBe('custom3');
      expect(state.get('currentSpaceId')).toBe('custom2');
      expect(state.get('spaces').custom1.name).toBe('Test');
    });

    test('handles null config gracefully', () => {
      expect(() => state.initFromConfig(null)).not.toThrow();
    });
  });
});
