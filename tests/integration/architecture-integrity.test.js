const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function getJsFiles(dir, exclude = []) {
  const files = [];
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (exclude.some((ex) => fullPath.includes(ex))) continue;

    if (entry.isDirectory()) {
      files.push(...getJsFiles(fullPath, exclude));
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function countLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n').length;
}

describe('Architecture Integrity', () => {
  describe('File size constraints', () => {
    // The cap exists to force decomposition, not to be satisfied by shaving.
    // Several services had converged on exactly 265, at which point every
    // addition was paid for by compressing unrelated code — the opposite of
    // what the cap is for. 300 restores headroom; a service that needs more
    // than that is a service that needs splitting.
    test('no new service file in main/services/ exceeds 300 lines', () => {
      const servicesDir = path.join(ROOT, 'main', 'services');
      const files = getJsFiles(servicesDir);
      const violations = [];

      files.forEach((f) => {
        const lines = countLines(f);
        if (lines > 300) {
          violations.push(`${path.relative(ROOT, f)}: ${lines} lines`);
        }
      });

      expect(violations).toEqual([]);
    });

    test('no new IPC handler file in main/ipc/ exceeds 100 lines', () => {
      const ipcDir = path.join(ROOT, 'main', 'ipc');
      const files = getJsFiles(ipcDir);
      const violations = [];

      files.forEach((f) => {
        const lines = countLines(f);
        if (lines > 100) {
          violations.push(`${path.relative(ROOT, f)}: ${lines} lines`);
        }
      });

      expect(violations).toEqual([]);
    });

    test('no renderer manager file exceeds 700 lines', () => {
      // SpaceManager is transitionally larger during the Phase 1-6 tab model
      // refactor (legacy activeSpaces paths coexist with new openTabs verbs).
      // Target returns to ≤400 once legacy paths are deleted in later phases.
      const managersDir = path.join(ROOT, 'renderer', 'managers');
      const files = getJsFiles(managersDir);
      const violations = [];

      files.forEach((f) => {
        const lines = countLines(f);
        if (lines > 700) {
          violations.push(`${path.relative(ROOT, f)}: ${lines} lines`);
        }
      });

      expect(violations).toEqual([]);
    });

    test('no renderer layout file exceeds 100 lines', () => {
      const layoutsDir = path.join(ROOT, 'renderer', 'layouts');
      const files = getJsFiles(layoutsDir);
      const violations = [];

      files.forEach((f) => {
        const lines = countLines(f);
        if (lines > 100) {
          violations.push(`${path.relative(ROOT, f)}: ${lines} lines`);
        }
      });

      expect(violations).toEqual([]);
    });

    test('App.js is under 120 lines', () => {
      const appPath = path.join(ROOT, 'main', 'App.js');
      if (fs.existsSync(appPath)) {
        expect(countLines(appPath)).toBeLessThanOrEqual(120);
      }
    });

    test('renderer/core/AppState.js is under 175 lines', () => {
      const statePath = path.join(ROOT, 'renderer', 'core', 'AppState.js');
      if (fs.existsSync(statePath)) {
        expect(countLines(statePath)).toBeLessThanOrEqual(175);
      }
    });
  });

  describe('IPC handler structure', () => {
    test('new IPC handler files exist and export register function', () => {
      const ipcDir = path.join(ROOT, 'main', 'ipc');
      const files = getJsFiles(ipcDir).filter((f) => !f.endsWith('index.js'));

      expect(files.length).toBeGreaterThanOrEqual(7);
      files.forEach((f) => {
        const content = fs.readFileSync(f, 'utf8');
        expect(content).toContain('function register');
        expect(content).toContain('module.exports');
      });
    });

    test('renderer ipcBridge exists and exports registerAll', () => {
      const bridgePath = path.join(ROOT, 'renderer', 'ipc', 'ipcBridge.js');
      expect(fs.existsSync(bridgePath)).toBe(true);
      const content = fs.readFileSync(bridgePath, 'utf8');
      expect(content).toContain('function registerAll');
      expect(content).toContain('module.exports');
    });
  });

  describe('New module structure', () => {
    test('shared/ directory contains configDefaults.js and configPaths.js', () => {
      expect(fs.existsSync(path.join(ROOT, 'shared', 'configDefaults.js'))).toBe(true);
      expect(fs.existsSync(path.join(ROOT, 'shared', 'configPaths.js'))).toBe(true);
    });

    test('main/services/ contains all expected service files', () => {
      const expected = [
        'ConfigService.js',
        'AdblockerService.js',
        'CertificateService.js',
        'ShortcutService.js',
        'MemoryService.js',
        'TrayService.js',
        'MenuService.js',
      ];
      expected.forEach((file) => {
        expect(fs.existsSync(path.join(ROOT, 'main', 'services', file))).toBe(true);
      });
    });

    test('main/ipc/ contains handler files', () => {
      const expected = [
        'index.js',
        'configHandlers.js',
        'navigationHandlers.js',
        'spaceHandlers.js',
        'viewHandlers.js',
        'windowHandlers.js',
        'shortcutHandlers.js',
        'settingsHandlers.js',
        'findHandlers.js',
      ];
      expected.forEach((file) => {
        expect(fs.existsSync(path.join(ROOT, 'main', 'ipc', file))).toBe(true);
      });
    });

    test('main/App.js exists', () => {
      expect(fs.existsSync(path.join(ROOT, 'main', 'App.js'))).toBe(true);
    });

    test('renderer/core/AppState.js exists', () => {
      expect(fs.existsSync(path.join(ROOT, 'renderer', 'core', 'AppState.js'))).toBe(true);
    });

    test('renderer/layouts/ contains layout strategy files', () => {
      const expected = [
        'LayoutStrategy.js',
        'SingleLayout.js',
        'SideBySideLayout.js',
        'GridLayout.js',
        'LayoutRegistry.js',
      ];
      expected.forEach((file) => {
        expect(fs.existsSync(path.join(ROOT, 'renderer', 'layouts', file))).toBe(true);
      });
    });

    test('renderer/managers/ contains all expected manager files', () => {
      const expected = [
        'NavigationManager.js',
        'FindBarManager.js',
        'BrowserViewManager.js',
        'SpaceManager.js',
        'LayoutManager.js',
      ];
      expected.forEach((file) => {
        expect(fs.existsSync(path.join(ROOT, 'renderer', 'managers', file))).toBe(true);
      });
    });

    test('renderer/ipc/ipcBridge.js exists', () => {
      expect(fs.existsSync(path.join(ROOT, 'renderer', 'ipc', 'ipcBridge.js'))).toBe(true);
    });

    test('renderer/components/settings/ contains the v2 modules', () => {
      const expected = ['SettingsView.js', 'registry.js', 'searchIndex.js', 'controls.js', 'customModules.js'];
      expected.forEach((file) => {
        expect(fs.existsSync(path.join(ROOT, 'renderer', 'components', 'settings', file))).toBe(true);
      });
    });

    test('legacy settings menu and per-tab components have been retired', () => {
      const removed = [
        ['renderer', 'components', 'SettingsMenu.js'],
        ['renderer', 'components', 'settings', 'GeneralTab.js'],
        ['renderer', 'components', 'settings', 'AppearanceTab.js'],
      ];
      removed.forEach((parts) => {
        expect(fs.existsSync(path.join(ROOT, ...parts))).toBe(false);
      });
    });
  });

  describe('Dead code removal', () => {
    test('main/utils/config.js has been deleted (dead ConfigManager)', () => {
      expect(fs.existsSync(path.join(ROOT, 'main', 'utils', 'config.js'))).toBe(false);
    });
  });
});
