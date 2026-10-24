const {
  DEFAULT_CONFIG,
  DEFAULT_SETTINGS,
  CURRENT_CONFIG_VERSION,
  migrateConfig,
  getDefaultShortcuts,
  fillDefaults,
} = require('../../../shared/configDefaults');

describe('shared/configDefaults', () => {
  describe('DEFAULT_CONFIG shape', () => {
    test('has required top-level keys: settings, state, spaces, _version', () => {
      expect(DEFAULT_CONFIG).toHaveProperty('settings');
      expect(DEFAULT_CONFIG).toHaveProperty('state');
      expect(DEFAULT_CONFIG).toHaveProperty('spaces');
      expect(DEFAULT_CONFIG).toHaveProperty('_version');
    });

    test('settings has all expected keys with correct types', () => {
      const s = DEFAULT_CONFIG.settings;
      expect(typeof s.preventMenuExpansion).toBe('boolean');
      expect(typeof s.enableAdblocker).toBe('boolean');
      expect(typeof s.launchAtStartup).toBe('boolean');
      expect(typeof s.enableDefaultSpace).toBe('boolean');
      expect(typeof s.defaultSpace).toBe('string');
      expect(typeof s.openLinkExternal).toBe('boolean');
      expect(typeof s.browserHomeUrl).toBe('string');
      expect(typeof s.multiSpace).toBe('boolean');
      expect(typeof s.autoDenyCertErrors).toBe('boolean');
      expect(typeof s.theme).toBe('string');
      expect(typeof s.enableAnimations).toBe('boolean');
      expect(typeof s.enableRippleEffects).toBe('boolean');
      expect(typeof s.sidebarExpandedWidth).toBe('number');
    });

    test('state.windowBounds has width and height', () => {
      expect(DEFAULT_CONFIG.state.windowBounds).toHaveProperty('width');
      expect(DEFAULT_CONFIG.state.windowBounds).toHaveProperty('height');
      expect(typeof DEFAULT_CONFIG.state.windowBounds.width).toBe('number');
      expect(typeof DEFAULT_CONFIG.state.windowBounds.height).toBe('number');
    });

    test('state.activeSpaces is a non-empty array of strings', () => {
      expect(Array.isArray(DEFAULT_CONFIG.state.activeSpaces)).toBe(true);
      expect(DEFAULT_CONFIG.state.activeSpaces.length).toBeGreaterThan(0);
      DEFAULT_CONFIG.state.activeSpaces.forEach((id) => {
        expect(typeof id).toBe('string');
      });
    });

    test('spaces has at least 10 entries with name, url, and type', () => {
      const entries = Object.entries(DEFAULT_CONFIG.spaces);
      expect(entries.length).toBeGreaterThanOrEqual(10);
      entries.forEach(([key, value]) => {
        expect(typeof key).toBe('string');
        expect(value).toHaveProperty('name');
        expect(value).toHaveProperty('url');
        expect(value).toHaveProperty('type');
        expect(typeof value.name).toBe('string');
        expect(typeof value.url).toBe('string');
        expect(['ai-service', 'web-page', 'local-llm']).toContain(value.type);
      });
    });

    test('all space URLs use http/https or the ic:// built-in scheme', () => {
      Object.values(DEFAULT_CONFIG.spaces).forEach((entry) => {
        expect(entry.url).toMatch(/^(https?|ic):\/\//);
      });
    });

    test('local-llm spaces use ic:// scheme', () => {
      Object.values(DEFAULT_CONFIG.spaces).forEach((entry) => {
        if (entry.type === 'local-llm') {
          expect(entry.url).toMatch(/^ic:\/\//);
        }
      });
    });

    test('browser space entry exists', () => {
      expect(DEFAULT_CONFIG.spaces.browser).toBeDefined();
      expect(DEFAULT_CONFIG.spaces.browser.name).toBe('Browser');
      expect(DEFAULT_CONFIG.spaces.browser.type).toBe('web-page');
    });

    test('_version matches CURRENT_CONFIG_VERSION', () => {
      expect(DEFAULT_CONFIG._version).toBe(CURRENT_CONFIG_VERSION);
    });
  });

  describe('getDefaultShortcuts', () => {
    test('returns Alt+Space for macOS', () => {
      const shortcuts = getDefaultShortcuts('darwin');
      expect(shortcuts.toggle).toBe('Alt+Space');
    });

    test('returns CmdOrCtrl+Space for Windows/Linux', () => {
      expect(getDefaultShortcuts('win32').toggle).toBe('CmdOrCtrl+Space');
      expect(getDefaultShortcuts('linux').toggle).toBe('CmdOrCtrl+Space');
    });

    test('returns CmdOrCtrl+Alt+L as lock shortcut on all platforms', () => {
      expect(getDefaultShortcuts('darwin').lock).toBe('CmdOrCtrl+Alt+L');
      expect(getDefaultShortcuts('win32').lock).toBe('CmdOrCtrl+Alt+L');
      expect(getDefaultShortcuts('linux').lock).toBe('CmdOrCtrl+Alt+L');
    });
  });

  describe('fillDefaults', () => {
    test('adds missing keys from defaults', () => {
      const target = { a: 1 };
      fillDefaults(target, { a: 99, b: 2 });
      expect(target.a).toBe(1); // not overwritten
      expect(target.b).toBe(2); // added
    });

    test('deep-merges nested objects', () => {
      const target = { nested: { a: 1 } };
      fillDefaults(target, { nested: { a: 99, b: 2 } });
      expect(target.nested.a).toBe(1);
      expect(target.nested.b).toBe(2);
    });

    test('does not overwrite arrays', () => {
      const target = { arr: [1, 2] };
      fillDefaults(target, { arr: [3, 4, 5] });
      expect(target.arr).toEqual([1, 2]);
    });
  });

  describe('migrateConfig', () => {
    test('v28 → v29 backfills motionEffects as full and keeps a user choice', () => {
      expect(DEFAULT_SETTINGS.motionEffects).toBe('full');
      const backfilled = migrateConfig({ _version: 28, settings: { theme: 'dark' }, state: {} });
      expect(backfilled._version).toBe(CURRENT_CONFIG_VERSION);
      expect(backfilled.settings.motionEffects).toBe('full');
      const kept = migrateConfig({ _version: 28, settings: { motionEffects: 'subtle' }, state: {} });
      expect(kept.settings.motionEffects).toBe('subtle');
    });

    test('v29 → v30 moves the old 150px sidebar default to 220 and keeps a user-picked width', () => {
      expect(DEFAULT_SETTINGS.sidebarExpandedWidth).toBe(220);
      const moved = migrateConfig({ _version: 29, settings: { sidebarExpandedWidth: 150 }, state: {} });
      expect(moved._version).toBe(CURRENT_CONFIG_VERSION);
      expect(moved.settings.sidebarExpandedWidth).toBe(220);
      const kept = migrateConfig({ _version: 29, settings: { sidebarExpandedWidth: 175 }, state: {} });
      expect(kept.settings.sidebarExpandedWidth).toBe(175);
      // Already-current configs are not re-migrated: 150 chosen at v30 stays.
      const current = migrateConfig({ _version: 30, settings: { sidebarExpandedWidth: 150 }, state: {} });
      expect(current.settings.sidebarExpandedWidth).toBe(150);
    });

    test('v30 → v31 backfills chromeAmbient and keeps a user choice', () => {
      expect(DEFAULT_SETTINGS.chromeAmbient).toEqual({ scene: 'cycle', intensity: 'soft' });
      const backfilled = migrateConfig({ _version: 30, settings: { theme: 'dark' }, state: {} });
      expect(backfilled._version).toBe(CURRENT_CONFIG_VERSION);
      expect(backfilled.settings.chromeAmbient).toEqual({ scene: 'cycle', intensity: 'soft' });
      const kept = migrateConfig({ _version: 30, settings: { chromeAmbient: { scene: 'aurora' } }, state: {} });
      expect(kept.settings.chromeAmbient).toEqual({ scene: 'aurora', intensity: 'soft' });
    });

    test('v31 → v32 backfills the pending app update and the offered runtime versions', () => {
      const backfilled = migrateConfig({ _version: 31, settings: { llm: { mode: 'local' } }, state: {} });
      expect(backfilled._version).toBe(CURRENT_CONFIG_VERSION);
      expect(backfilled.settings.pendingUpdate).toBeNull();
      expect(backfilled.settings.llm.engineUpdatePrompted).toEqual({ llamaCpp: null, mlx: null, omlx: null, vllm: null });
      const kept = migrateConfig({ _version: 31, settings: { llm: { engineUpdatePrompted: { mlx: 'mlx-lm 0.32.0' } } }, state: {} });
      expect(kept.settings.llm.engineUpdatePrompted).toEqual({ llamaCpp: null, mlx: 'mlx-lm 0.32.0', omlx: null, vllm: null });
    });

    describe('v32 → v33 (oMLX replaces mlx_lm.server; vLLM tool parser)', () => {
      const v32 = (llm) => ({ _version: 32, settings: { llm }, state: {} });

      test('moves an mlxLm selection and per-model overrides to mlxOpenAi and drops the mlxLm block', () => {
        const out = migrateConfig(v32({
          activeBackend: 'mlxLm',
          mlxLm: { pythonPath: '/venv/bin/python3', temperature: 0.4 },
          perModelOverrides: {
            '/m/a': { backend: 'mlxLm', flags: { contextLength: 4096 } },
            '/m/b': { backend: 'llamaCpp' },
          },
        }));
        expect(out.settings.llm.activeBackend).toBe('mlxOpenAi');
        expect(out.settings.llm.perModelOverrides['/m/a']).toEqual({ backend: 'mlxOpenAi', flags: { contextLength: 4096 } });
        expect(out.settings.llm.perModelOverrides['/m/b']).toEqual({ backend: 'llamaCpp' });
        expect(out.settings.llm).not.toHaveProperty('mlxLm');
      });

      test('leaves other backends alone, including ids it does not know', () => {
        expect(migrateConfig(v32({ activeBackend: 'llamaCpp' })).settings.llm.activeBackend).toBe('llamaCpp');
        expect(migrateConfig(v32({ activeBackend: 'mlxOpenAi' })).settings.llm.activeBackend).toBe('mlxOpenAi');
        const unknown = migrateConfig(v32({ activeBackend: 'someFutureEngine', perModelOverrides: { '/m': { backend: 'someFutureEngine' } } }));
        expect(unknown.settings.llm.activeBackend).toBe('someFutureEngine');
        expect(unknown.settings.llm.perModelOverrides['/m'].backend).toBe('someFutureEngine');
      });

      test('backfills the omlx block and the new engines in engineUpdatePrompted', () => {
        const out = migrateConfig(v32({ engineUpdatePrompted: { llamaCpp: 'b5000', mlx: null } }));
        expect(out.settings.llm.omlx).toEqual({ pythonPath: null, contextLength: 65536, maxConcurrentRequests: 8, memoryGuard: 'balanced' });
        expect(out.settings.llm.engineUpdatePrompted).toEqual({ llamaCpp: 'b5000', mlx: null, omlx: null, vllm: null });
      });

      test('drops vllm.enableAutoToolChoice and moves the old 0.9 GPU share to 0.92', () => {
        const out = migrateConfig(v32({ vllm: { enableAutoToolChoice: true, gpuMemoryUtilization: 0.9 } }));
        expect(out.settings.llm.vllm).not.toHaveProperty('enableAutoToolChoice');
        expect(out.settings.llm.vllm.gpuMemoryUtilization).toBe(0.92);
        expect(out.settings.llm.vllm.toolParser).toBe('auto');
      });

      test('keeps a GPU share the user picked', () => {
        const out = migrateConfig(v32({ vllm: { gpuMemoryUtilization: 0.8 } }));
        expect(out.settings.llm.vllm.gpuMemoryUtilization).toBe(0.8);
      });

      test('an already-v33 config is not re-migrated', () => {
        const out = migrateConfig({ _version: 33, settings: { llm: { vllm: { gpuMemoryUtilization: 0.9 } } }, state: {} });
        expect(out.settings.llm.vllm.gpuMemoryUtilization).toBe(0.9);
      });
    });

    describe('v33 → v34 (assistant platform)', () => {
      const v33 = () => ({
        _version: 33,
        settings: {
          theme: 'dark',
          llm: {
            activeBackend: 'llamaCpp',
            agent: {
              maxSteps: 20,
              approval: { deny: ['browser.click', 'browser.type', 'browser.click'], perOrigin: { 'a.com': { click: 'deny' } } },
              egress: { mode: 'allowlist', allow: ['a.com'], block: [], onViolation: 'deny' },
              permissions: { mode: 'plan' },
            },
          },
          routines: { enabled: false, items: [{ id: 'r1' }] },
          assistant: { sidebarWidth: 600 },
        },
        state: { openTabs: ['custom1'] },
      });

      test('migrates to the current version and keeps every existing key and user value', () => {
        const out = migrateConfig(v33());
        expect(CURRENT_CONFIG_VERSION).toBe(35);
        expect(out._version).toBe(35);
        expect(out.settings.theme).toBe('dark');
        expect(out.settings.llm.activeBackend).toBe('llamaCpp');
        expect(out.settings.llm.agent.maxSteps).toBe(20);
        expect(out.settings.llm.agent.approval.perOrigin).toEqual({ 'a.com': { click: 'deny' } });
        expect(out.settings.llm.agent.egress).toEqual({ mode: 'allowlist', allow: ['a.com'], block: [], onViolation: 'deny' });
        expect(out.settings.llm.agent.permissions.mode).toBe('plan');
        expect(out.settings.routines.enabled).toBe(false);
        expect(out.settings.routines.items).toEqual([{ id: 'r1' }]);
        expect(out.settings.assistant.sidebarWidth).toBe(600);
        expect(out.state.openTabs).toEqual(['custom1']);
      });

      test('backfills the new agent, assistant and routine keys', () => {
        const out = migrateConfig(v33());
        const agent = out.settings.llm.agent;
        expect(agent.permissions.rules).toEqual({ allow: [], ask: [], deny: ['shell.run:sudo *', 'shell.run:su *'] });
        expect(agent.workspace).toEqual({
          roots: [], protectedGlobs: ['**/.git', '**/.git/**', '**/.env', '**/.env.*'], maxReadBytes: 262144, maxWriteBytes: 1048576,
        });
        expect(agent.shell).toEqual({
          enabled: true, defaultTimeoutMs: 60000, maxTimeoutMs: 600000, maxOutputBytes: 65536,
          envAllow: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'USER', 'TMPDIR'],
        });
        expect(agent.checkpoints).toEqual({ enabled: true, retentionDays: 30, maxBytesPerSession: 209715200 });
        expect(agent.subagents).toEqual({ enabled: true, maxConcurrent: 2, maxDepth: 1, defaultMaxSteps: 8 });
        expect(agent.sessions).toEqual({ maxConcurrent: 2, llmConcurrency: 'auto', notifyOnComplete: true, backgroundApprovalTimeoutMs: 0 });
        expect(agent.skills).toEqual({ autoTrigger: true, matchThreshold: 0.35 });
        expect(agent.instructions).toEqual({
          enabled: true, globalFile: '', workspaceFiles: ['AGENTS.md', 'INSTRUCTIONS.md'], maxBytes: 16384,
        });
        expect(agent.harness).toEqual({ profiles: [] });
        expect(agent.streamSteps).toBe('auto');
        expect(agent.compaction).toEqual({ auto: true, threshold: 0.8 });
        expect(out.settings.routines.runInBackground).toBe(true);
        expect(out.settings.assistant).toEqual({
          startMode: 'last', lastMode: 'browser', sidebarWidth: 600, dockWidth: 520, shiftTabCycles: true,
          launcher: { enabled: true, hotkey: 'Alt+Shift+Space' },
        });
      });

      test('backfilled arrays are copies, not shared with the defaults', () => {
        const out = migrateConfig(v33());
        out.settings.llm.agent.permissions.rules.deny.push('shell.run:rm *');
        out.settings.llm.agent.shell.envAllow.length = 0;
        const again = migrateConfig(v33());
        expect(again.settings.llm.agent.permissions.rules.deny).toEqual(['shell.run:sudo *', 'shell.run:su *']);
        expect(again.settings.llm.agent.shell.envAllow).toHaveLength(7);
      });

      test('dedupes approval.deny keeping first-occurrence order', () => {
        const out = migrateConfig(v33());
        expect(out.settings.llm.agent.approval.deny).toEqual(['browser.click', 'browser.type']);
      });

      test('leaves a non-array approval.deny and a v34 config untouched', () => {
        const bad = v33();
        bad.settings.llm.agent.approval.deny = 'browser.click';
        expect(migrateConfig(bad).settings.llm.agent.approval.deny).toBe('browser.click');
        const current = v33();
        current._version = 34;
        expect(migrateConfig(current).settings.llm.agent.approval.deny)
          .toEqual(['browser.click', 'browser.type', 'browser.click']);
      });

      test('a config without settings.llm still migrates', () => {
        const out = migrateConfig({ _version: 33, settings: {}, state: {} });
        expect(out._version).toBe(35);
        expect(out.settings.llm.agent.approval.deny).toEqual([]);
        expect(out.settings.llm.agent.permissions.mode).toBe('ask');
      });
    });

    describe('saved passwords setting', () => {
      test('offers to save passwords by default', () => {
        expect(DEFAULT_CONFIG.settings.passwords).toEqual({ offerToSave: true });
      });

      test('a current-version config without the key is backfilled, and a user choice is kept', () => {
        const out = migrateConfig({ _version: CURRENT_CONFIG_VERSION, settings: {}, state: {} });
        expect(out.settings.passwords.offerToSave).toBe(true);
        const off = migrateConfig({ _version: CURRENT_CONFIG_VERSION, settings: { passwords: { offerToSave: false } }, state: {} });
        expect(off.settings.passwords.offerToSave).toBe(false);
      });
    });

    describe('v34 → v35 nested .git protection', () => {
      const v34 = (protectedGlobs) => ({
        _version: 34,
        settings: { llm: { agent: { workspace: { roots: ['/w'], protectedGlobs } } } },
        state: {},
      });
      const globsOf = (cfg) => migrateConfig(cfg).settings.llm.agent.workspace.protectedGlobs;

      test('the old root-only default is replaced in place by the nested-repo pair', () => {
        expect(globsOf(v34(['.git/**', '**/.env', '**/.env.*', 'secrets/**'])))
          .toEqual(['**/.git', '**/.git/**', '**/.env', '**/.env.*', 'secrets/**']);
      });

      test('user-added globs, including other .git globs, are left alone', () => {
        expect(globsOf(v34(['.git/hooks/**', 'build/**']))).toEqual(['.git/hooks/**', 'build/**']);
        expect(globsOf(v34([]))).toEqual([]);
      });

      test('an entry already present is not duplicated', () => {
        expect(globsOf(v34(['**/.git/**', '.git/**']))).toEqual(['**/.git/**', '**/.git']);
      });

      test('a non-array protectedGlobs and a v35 config are untouched', () => {
        expect(globsOf(v34('.git/**'))).toBe('.git/**');
        const current = v34(['.git/**']);
        current._version = 35;
        expect(globsOf(current)).toEqual(['.git/**']);
      });
    });

    test('returns fresh defaults for configs with version < 3', () => {
      const v0 = migrateConfig({ _version: 0 });
      const v1 = migrateConfig({ _version: 1 });
      const v2 = migrateConfig({ _version: 2 });

      [v0, v1, v2].forEach((result) => {
        expect(result._version).toBe(CURRENT_CONFIG_VERSION);
        expect(result.spaces).toBeDefined();
        expect(result.settings).toBeDefined();
        expect(result.state).toBeDefined();
      });
    });

    test('returns fresh defaults for configs with no version', () => {
      const result = migrateConfig({});
      expect(result._version).toBe(CURRENT_CONFIG_VERSION);
      expect(result.spaces).toBeDefined();
      expect(Object.keys(result.spaces).length).toBeGreaterThan(0);
    });

    test('preserves already-migrated v3 config', () => {
      const config = {
        _version: CURRENT_CONFIG_VERSION,
        settings: {
          theme: 'light',
          multiSpace: true,
          shortcuts: {
            'window.toggle': { key: 'Alt+T', description: 'Toggle Window' },
            'window.lock': { key: 'Alt+L', description: 'Lock Shortcuts' },
          },
        },
        state: {
          activeSpaces: ['custom3'],
          windowBounds: { width: 800, height: 600 },
        },
        spaces: { custom1: { name: 'Test', url: 'https://test.com/', type: 'ai-service' } },
      };
      const result = migrateConfig(JSON.parse(JSON.stringify(config)));
      expect(result.settings.theme).toBe('light');
      expect(result.settings.multiSpace).toBe(true);
      expect(result.state.activeSpaces).toEqual(['custom3']);
      expect(result.settings.shortcuts['window.toggle'].key).toBe('Alt+T');
    });

    test('adds missing settings keys with defaults for v3 config', () => {
      const config = {
        _version: CURRENT_CONFIG_VERSION,
        settings: { theme: 'light' },
        state: {},
        spaces: { custom1: { name: 'Test', url: 'https://test.com/', type: 'ai-service' } },
      };
      const result = migrateConfig(config);
      expect(result.settings.enableAdblocker).toBe(false);
      expect(result.settings.multiSpace).toBe(false);
      expect(result.settings.sidebarExpandedWidth).toBe(220);
      expect(result.settings.theme).toBe('light'); // preserved, not overwritten
    });

    test('backfills agent egress control for a pre-v18 config (additive, mode=open)', () => {
      const config = {
        _version: 17,
        settings: { llm: { agent: { maxSteps: 9, approval: { deny: [], perOrigin: {} } } } },
        state: {},
        spaces: { custom1: { name: 'Test', url: 'https://test.com/', type: 'ai-service' } },
      };
      const result = migrateConfig(config);
      expect(result._version).toBe(CURRENT_CONFIG_VERSION);
      expect(result.settings.llm.agent.maxSteps).toBe(9); // user value preserved
      expect(result.settings.llm.agent.egress).toEqual({
        mode: 'open', allow: [], block: [], onViolation: 'prompt',
      });
    });

    test('backfills askBrowsing settings for a pre-v19 config (additive)', () => {
      const config = {
        _version: 18,
        settings: { search: { provider: 'inBrowser' } },
        state: {},
        spaces: { custom1: { name: 'Test', url: 'https://test.com/', type: 'ai-service' } },
      };
      const result = migrateConfig(config);
      expect(result._version).toBe(CURRENT_CONFIG_VERSION);
      expect(result.settings.search.provider).toBe('inBrowser'); // user value preserved
      expect(result.settings.askBrowsing).toEqual({
        enabled: true, embeddingsEndpoint: '', embeddingsModel: '', blend: 0.5, maxResults: 8, indexContent: false,
      });
    });

    test('backfills text-to-speech settings for a pre-v20 config (additive)', () => {
      const config = {
        _version: 19,
        settings: { tts: { rate: 1.5 } },
        state: {},
        spaces: { custom1: { name: 'Test', url: 'https://test.com/', type: 'ai-service' } },
      };
      const result = migrateConfig(config);
      expect(result._version).toBe(CURRENT_CONFIG_VERSION);
      expect(result.settings.tts.rate).toBe(1.5); // user value preserved
      expect(result.settings.tts.enabled).toBe(true);
      expect(result.settings.tts.voiceURI).toBe('');
    });

    test('backfills scheduled-routines settings for a pre-v21 config (additive)', () => {
      const config = {
        _version: 20,
        settings: { routines: { enabled: false } },
        state: {},
        spaces: { custom1: { name: 'Test', url: 'https://test.com/', type: 'ai-service' } },
      };
      const result = migrateConfig(config);
      expect(result._version).toBe(CURRENT_CONFIG_VERSION);
      expect(result.settings.routines.enabled).toBe(false); // user value preserved
      expect(result.settings.routines.items).toEqual([]);
    });

    test('backfills askBrowsing.indexContent for a pre-v23 config (additive, default off)', () => {
      const config = {
        _version: 22,
        settings: { askBrowsing: { enabled: true, maxResults: 5 } },
        state: {},
        spaces: { custom1: { name: 'Test', url: 'https://test.com/', type: 'ai-service' } },
      };
      const result = migrateConfig(config);
      expect(result._version).toBe(CURRENT_CONFIG_VERSION);
      expect(result.settings.askBrowsing.maxResults).toBe(5); // user value preserved
      expect(result.settings.askBrowsing.indexContent).toBe(false); // backfilled, opt-in
    });

    test('migrates macOS users off CmdOrCtrl+Space', () => {
      const config = {
        _version: CURRENT_CONFIG_VERSION,
        settings: {
          shortcuts: {
            'window.toggle': { key: 'CmdOrCtrl+Space', description: 'Toggle Window' },
          },
        },
      };
      const result = migrateConfig(config, 'darwin');
      expect(result.settings.shortcuts['window.toggle'].key).toBe('CmdOrCtrl+Space');
    });

    test('v15 → v16: strips malformed shortcut entries left by the rebind-UI path-split bug', () => {
      // The prior recorder called configBridge.set('settings.shortcuts.window.toggle', ...)
      // which split on '.' and produced a nested orphan alongside the flat key.
      const config = {
        _version: 15,
        settings: {
          shortcuts: {
            'window.toggle': { key: 'Alt+Space', description: 'Toggle Window' },
            window: { toggle: 'Ctrl+ ' },
            'space.previous': null,
            broken: { description: 'no key field' },
          },
        },
        state: {},
        spaces: {},
      };
      const result = migrateConfig(config, 'darwin');
      const sc = result.settings.shortcuts;
      expect(sc).not.toHaveProperty('window');
      expect(sc).not.toHaveProperty('broken');
      // Orphan-shaped entries are dropped; default backfill restores cleared shortcuts.
      expect(sc['window.toggle']).toEqual({ key: 'Alt+Space', description: 'Toggle Window' });
      expect(sc['space.previous']).toBeUndefined();
      expect(result._version).toBe(CURRENT_CONFIG_VERSION);
    });

    test('does not migrate CmdOrCtrl+Space on non-macOS', () => {
      const config = {
        _version: CURRENT_CONFIG_VERSION,
        settings: {
          shortcuts: {
            'window.toggle': { key: 'CmdOrCtrl+Space', description: 'Toggle Window' },
          },
        },
      };
      const result = migrateConfig(config, 'win32');
      expect(result.settings.shortcuts['window.toggle'].key).toBe('CmdOrCtrl+Space');
    });

    test('updates _version to CURRENT_CONFIG_VERSION', () => {
      const config = { _version: CURRENT_CONFIG_VERSION, settings: {}, state: {} };
      const result = migrateConfig(config);
      expect(result._version).toBe(CURRENT_CONFIG_VERSION);
    });

    test('handles empty/null config without throwing', () => {
      expect(() => migrateConfig(null)).not.toThrow();
      expect(() => migrateConfig(undefined)).not.toThrow();
      expect(() => migrateConfig({})).not.toThrow();

      const result = migrateConfig(null);
      expect(result._version).toBe(CURRENT_CONFIG_VERSION);
      expect(result.settings).toBeDefined();
      expect(result.state).toBeDefined();
      expect(result.spaces).toBeDefined();
    });

    test('fills default state.windowBounds when missing in v3 config', () => {
      const config = { _version: CURRENT_CONFIG_VERSION, state: {}, settings: {} };
      const result = migrateConfig(config);
      expect(result.state.windowBounds).toEqual({ width: 1600, height: 900 });
    });

    test('v7 → v8: seeds notifications settings + empty inbox', () => {
      const config = {
        _version: 7,
        settings: { theme: 'dark' },
        state: {},
        spaces: { custom1: { name: 'Test', url: 'https://test.com/', type: 'ai-service' } },
      };
      const result = migrateConfig(config);
      expect(result._version).toBe(CURRENT_CONFIG_VERSION);
      expect(result.settings.notifications).toEqual(
        expect.objectContaining({ enabled: true, showToasts: true, maxInbox: 200 })
      );
      expect(result.state.notifications).toEqual({ inbox: [] });
    });

    test('v7 → v8: preserves existing notifications config if already set', () => {
      const config = {
        _version: 7,
        settings: {
          theme: 'dark',
          notifications: { enabled: false, showToasts: false, maxInbox: 50 },
        },
        state: { notifications: { inbox: [{ id: 'notif-old' }] } },
        spaces: { custom1: { name: 'Test', url: 'https://test.com/', type: 'ai-service' } },
      };
      const result = migrateConfig(config);
      expect(result.settings.notifications.enabled).toBe(false);
      expect(result.settings.notifications.maxInbox).toBe(50);
      expect(result.state.notifications.inbox).toHaveLength(1);
    });

    test('v7 → v8: repairs non-array inbox to []', () => {
      const config = {
        _version: 7,
        settings: {},
        state: { notifications: { inbox: 'not an array' } },
        spaces: {},
      };
      const result = migrateConfig(config);
      expect(result.state.notifications.inbox).toEqual([]);
    });

    // v9 split mlx into mlxOpenAi/mlxLm; v33 then retires mlxLm, so a legacy
    // config migrated end to end lands on mlxOpenAi with no mlxLm block.
    test('v8 → current: legacy mlx serverImpl="legacy" + activeBackend="mlx" → mlxOpenAi (via mlxLm)', () => {
      const config = {
        _version: 8,
        settings: {
          llm: {
            activeBackend: 'mlx',
            mlx: {
              serverImpl: 'legacy',
              pythonPath: '/venv/bin/python3',
              temperature: 0.5,
              topP: 0.9,
              forceTextOnly: true,
            },
          },
        },
        state: {},
        spaces: {},
      };
      const result = migrateConfig(config);
      expect(result._version).toBe(CURRENT_CONFIG_VERSION);
      expect(result.settings.llm.activeBackend).toBe('mlxOpenAi');
      expect(result.settings.llm).not.toHaveProperty('mlxLm');
      expect(result.settings.llm.mlxOpenAi.pythonPath).toBe('/venv/bin/python3');
      expect(result.settings.llm.mlxOpenAi.forceTextOnly).toBe(true);
      expect(result.settings.llm.mlx).toEqual({ fallbackEnabled: true });
    });

    test('v8 → v9: legacy mlx serverImpl="openai" (or unset) + activeBackend="mlx" → mlxOpenAi', () => {
      const config = {
        _version: 8,
        settings: {
          llm: {
            activeBackend: 'mlx',
            mlx: { pythonPath: '/venv/bin/python3', contextLength: 8192, enableAutoToolChoice: false },
          },
        },
        state: {},
        spaces: {},
      };
      const result = migrateConfig(config);
      expect(result.settings.llm.activeBackend).toBe('mlxOpenAi');
      expect(result.settings.llm.mlxOpenAi.contextLength).toBe(8192);
      expect(result.settings.llm.mlxOpenAi.enableAutoToolChoice).toBe(false);
      expect(result.settings.llm.mlxOpenAi.pythonPath).toBe('/venv/bin/python3');
      expect(result.settings.llm).not.toHaveProperty('mlxLm');
    });

    test('v8 → v9: leaves non-mlx activeBackend alone', () => {
      const config = {
        _version: 8,
        settings: { llm: { activeBackend: 'llamaCpp', mlx: { pythonPath: '/p' } } },
        state: {},
        spaces: {},
      };
      const result = migrateConfig(config);
      expect(result.settings.llm.activeBackend).toBe('llamaCpp');
      expect(result.settings.llm.mlxOpenAi.pythonPath).toBe('/p');
      expect(result.settings.llm).not.toHaveProperty('mlxLm');
    });

    describe('v9 → v10: chromeLayout enum extended to four positions', () => {
      function makeV9(chromeLayout) {
        return {
          _version: 9,
          settings: { chromeLayout },
          state: {},
          spaces: {},
        };
      }

      test('sidebar → left', () => {
        const result = migrateConfig(makeV9('sidebar'));
        expect(result.settings.chromeLayout).toBe('left');
        expect(result._version).toBe(CURRENT_CONFIG_VERSION);
      });

      test('topBar → top', () => {
        const result = migrateConfig(makeV9('topBar'));
        expect(result.settings.chromeLayout).toBe('top');
      });

      test('preserves valid four-position values', () => {
        for (const value of ['top', 'bottom', 'left', 'right']) {
          const result = migrateConfig(makeV9(value));
          expect(result.settings.chromeLayout).toBe(value);
        }
      });

      test('falls back to "left" for unknown / corrupt values', () => {
        const result = migrateConfig(makeV9('garbage'));
        expect(result.settings.chromeLayout).toBe('left');
      });

      test('falls back to "left" when chromeLayout is missing entirely', () => {
        const result = migrateConfig({
          _version: 9,
          settings: {},
          state: {},
          spaces: {},
        });
        expect(result.settings.chromeLayout).toBe('left');
      });
    });

    describe('v25 → v26: first-run welcome overlay', () => {
      test('an upgraded config is marked as already welcomed', () => {
        const result = migrateConfig({ _version: 25, settings: {}, state: {}, spaces: {} });
        expect(result.state.hasSeenWelcome).toBe(true);
      });

      test('a fresh config starts unwelcomed so the overlay shows once', () => {
        const result = migrateConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
        expect(result.state.hasSeenWelcome).toBe(false);
      });
    });
  });
});
