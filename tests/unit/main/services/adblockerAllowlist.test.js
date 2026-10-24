// ConfigService is required at module-load time by adblockerAllowlist, so the
// mock must be registered before the require. jest.mock factories can't close
// over outer variables, so we stash the stub on the module and grab it after.
jest.mock('../../../../main/services/ConfigService', () => {
  const stub = jest.fn();
  return { __stub: stub, get: (...args) => stub(...args) };
});

const ConfigService = require('../../../../main/services/ConfigService');
const getConfig = ConfigService.__stub;
const {
  allowlistFilterFor,
  loadAllowlistFromConfig,
  diffAllowlist,
} = require('../../../../main/services/adblockerAllowlist');

describe('adblockerAllowlist', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('allowlistFilterFor', () => {
    test('produces a uBO-style exception rule for the host', () => {
      expect(allowlistFilterFor('example.com')).toBe('@@||example.com^');
    });

    test('does not transform the host string (caller owns normalization)', () => {
      expect(allowlistFilterFor('sub.example.com')).toBe('@@||sub.example.com^');
    });
  });

  describe('loadAllowlistFromConfig', () => {
    test('returns the settings.siteAllowlist array from ConfigService', () => {
      getConfig.mockReturnValue(['a.com', 'b.com']);
      expect(loadAllowlistFromConfig()).toEqual(['a.com', 'b.com']);
      expect(getConfig).toHaveBeenCalledWith('settings.siteAllowlist', []);
    });

    test('defaults to [] when the key is absent', () => {
      getConfig.mockReturnValue(undefined);
      expect(loadAllowlistFromConfig()).toEqual([]);
    });

    test('filters out non-string and empty-string entries', () => {
      getConfig.mockReturnValue(['a.com', '', null, 7, 'b.com']);
      expect(loadAllowlistFromConfig()).toEqual(['a.com', 'b.com']);
    });

    test('returns [] when config returns a non-array', () => {
      getConfig.mockReturnValue('not an array');
      expect(loadAllowlistFromConfig()).toEqual([]);
      getConfig.mockReturnValue({ x: 1 });
      expect(loadAllowlistFromConfig()).toEqual([]);
    });
  });

  describe('diffAllowlist', () => {
    test('added = hosts in next but not prev, as filter rules', () => {
      const { added, removed } = diffAllowlist(['a.com'], ['a.com', 'b.com']);
      expect(added).toEqual(['@@||b.com^']);
      expect(removed).toEqual([]);
    });

    test('removed = hosts in prev but not next, as filter rules', () => {
      const { added, removed } = diffAllowlist(['a.com', 'c.com'], ['a.com']);
      expect(added).toEqual([]);
      expect(removed).toEqual(['@@||c.com^']);
    });

    test('no-op when prev and next are equal as sets', () => {
      const { added, removed } = diffAllowlist(['a.com', 'b.com'], ['b.com', 'a.com']);
      expect(added).toEqual([]);
      expect(removed).toEqual([]);
    });

    test('handles empty inputs', () => {
      expect(diffAllowlist([], [])).toEqual({ added: [], removed: [] });
      expect(diffAllowlist([], ['x.com'])).toEqual({ added: ['@@||x.com^'], removed: [] });
      expect(diffAllowlist(['x.com'], [])).toEqual({ added: [], removed: ['@@||x.com^'] });
    });
  });
});
