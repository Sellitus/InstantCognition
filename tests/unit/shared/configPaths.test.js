const path = require('path');
const os = require('os');

// configPaths.js does `require('electron')` lazily inside getConfigDir(),
// catches failures, and falls back to ~/.instant-cognition. To exercise both
// branches we mock 'electron' per-test — jest.resetModules() clears the module
// registry so each loadWith installs a fresh mock without cross-test leak.
function loadWith(electronImpl) {
  jest.resetModules();
  jest.unmock('electron');
  if (electronImpl === 'throws') {
    jest.doMock('electron', () => { throw new Error('not available'); });
  } else if (electronImpl !== undefined) {
    jest.doMock('electron', () => electronImpl);
  }
  return require('../../../shared/configPaths');
}

afterEach(() => {
  jest.resetModules();
  jest.unmock('electron');
});

describe('shared/configPaths', () => {
  describe('getConfigDir', () => {
    test('returns Electron userData when app.getPath is callable', () => {
      const { getConfigDir } = loadWith({
        app: { getPath: jest.fn((key) => key === 'userData' ? '/electron/userData' : null) },
      });
      expect(getConfigDir()).toBe('/electron/userData');
    });

    test('falls back to ~/.instant-cognition when app.getPath is missing', () => {
      const { getConfigDir } = loadWith({ app: {} });
      expect(getConfigDir()).toBe(path.join(os.homedir(), '.instant-cognition'));
    });

    test('falls back when require(electron) throws', () => {
      const { getConfigDir } = loadWith('throws');
      expect(getConfigDir()).toBe(path.join(os.homedir(), '.instant-cognition'));
    });
  });

  describe('derived paths', () => {
    let mod;
    beforeEach(() => {
      mod = loadWith({ app: { getPath: () => '/cfg' } });
    });

    test('getConfigPath = configDir/config.json', () => {
      expect(mod.getConfigPath()).toBe(path.join('/cfg', 'config.json'));
    });

    test('getBackupPath = configPath + .bak', () => {
      expect(mod.getBackupPath()).toBe(path.join('/cfg', 'config.json') + '.bak');
    });

    test('getTrustedCertificatesPath = configDir/trusted_certificates.json', () => {
      expect(mod.getTrustedCertificatesPath()).toBe(path.join('/cfg', 'trusted_certificates.json'));
    });

    test('getAdblockerCachePath = configDir/adblocker_cache.bin', () => {
      expect(mod.getAdblockerCachePath()).toBe(path.join('/cfg', 'adblocker_cache.bin'));
    });
  });

  describe('getLegacyPathCandidates', () => {
    test('returns the fallback dir + project-root candidate for arbitrary fileName', () => {
      const { getLegacyPathCandidates } = loadWith({ app: { getPath: () => '/cfg' } });
      const candidates = getLegacyPathCandidates('legacy.json');
      expect(candidates).toContain(path.join(os.homedir(), '.instant-cognition', 'legacy.json'));
      // project-root candidate is ../<fileName> relative to shared/configPaths.js
      const projectRootCandidate = path.join(__dirname, '..', '..', '..', 'legacy.json');
      expect(candidates).toContain(projectRootCandidate);
    });

    test('includes process.resourcesPath/app candidate when set', () => {
      const originalResourcesPath = process.resourcesPath;
      process.resourcesPath = '/electron/resources';
      try {
        const { getLegacyPathCandidates } = loadWith({ app: { getPath: () => '/cfg' } });
        const candidates = getLegacyPathCandidates('config.json');
        expect(candidates).toContain(path.join('/electron/resources', 'app', 'config.json'));
      } finally {
        if (originalResourcesPath === undefined) delete process.resourcesPath;
        else process.resourcesPath = originalResourcesPath;
      }
    });

    test('omits the resourcesPath candidate when process.resourcesPath is unset', () => {
      const originalResourcesPath = process.resourcesPath;
      delete process.resourcesPath;
      try {
        const { getLegacyPathCandidates } = loadWith({ app: { getPath: () => '/cfg' } });
        const candidates = getLegacyPathCandidates('config.json');
        const resourcesEntry = candidates.find((c) => c.includes('resources'));
        expect(resourcesEntry).toBeUndefined();
      } finally {
        if (originalResourcesPath !== undefined) process.resourcesPath = originalResourcesPath;
      }
    });

    test('deduplicates identical candidate paths', () => {
      const { getLegacyPathCandidates } = loadWith({ app: { getPath: () => '/cfg' } });
      const candidates = getLegacyPathCandidates('x.json');
      expect(new Set(candidates).size).toBe(candidates.length);
    });
  });

  describe('exports', () => {
    test('exports the documented public API only', () => {
      const mod = loadWith({ app: { getPath: () => '/cfg' } });
      expect(Object.keys(mod).sort()).toEqual([
        'getAdblockerCachePath',
        'getBackupPath',
        'getConfigDir',
        'getConfigPath',
        'getLegacyPathCandidates',
        'getTrustedCertificatesPath',
      ]);
    });
  });
});
