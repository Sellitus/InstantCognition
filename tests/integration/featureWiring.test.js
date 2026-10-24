/**
 * featureWiring.test.js — proves the newly-landed features are wired
 * end-to-end (component → IPC channel → main handler → service/singleton →
 * boundary) and locks in 6 known subtle regression risks.
 *
 * Only external boundaries are substituted: electron's ipcMain (per-file
 * inline mock with a _handlers capture map — the canonical IPC pattern),
 * global fetch, fs, dialog, and the agent's renderer-owned tab bridge. Every
 * line of provider selection, normalization, scheduling, egress policy,
 * citation mapping and persona-pack assembly under test is shipping code.
 *
 * Electron is mocked inline (overriding the moduleNameMapper substitution for
 * this file) so ipcMain.on/handle capture into a _handlers map exactly
 * like tests/unit/main/ipc/configHandlers.test.js.
 */

jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
    dialog: {
      showOpenDialog: jest.fn(),
      showSaveDialog: jest.fn(),
    },
  };
});

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog } = require('electron');

// Singletons + pure modules under test (required directly — they ARE the code
// under test and must not be mocked).
const searchService = require('../../main/services/SearchService');
const [webSearch] = require('../../main/agent/tools/searchTool');
const semanticIndex = require('../../main/services/SemanticIndexService');
const [askBrowsing] = require('../../main/agent/tools/askBrowsingTool');
const historyService = require('../../main/services/HistoryService');
const bookmarkService = require('../../main/services/BookmarkService');
const researchTools = require('../../main/agent/tools/researchReport');
const [openResearchSources] = researchTools;
const { normalizeSources } = researchTools;
const { RoutineService } = require('../../main/services/RoutineService');
const ttsMod = require('../../renderer/utils/tts');
const personaPacks = require('../../shared/personaPacks');
const { AgentApprovalService } = require('../../main/services/AgentApprovalService');
const policy = require('../../main/agent/approvalPolicy');

// --- shared helpers -------------------------------------------------------

// Reset the ipcMain handler-capture map between describe blocks so each
// register() starts from a clean channel namespace (no order dependence).
function resetIpc() {
  for (const k of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[k];
}

// A fs-shim whose existsSync(file) is always false → forces History /
// Bookmark / SemanticIndex to their empty-corpus cold-start path without
// touching the real config dir.
function emptyFsShim() {
  return {
    existsSync: () => false,
    readFileSync: () => { throw new Error('should_not_read'); },
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
}

// A config-shim backed by a Map (same shape ConfigService exposes: get/set).
function fakeConfig(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: (k, d) => (map.has(k) ? map.get(k) : d),
    set: jest.fn((k, v) => map.set(k, v)),
    _map: map,
  };
}

// A mainWindow whose webContents.send records every (channel,payload).
function fakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

// =========================================================================
// FEATURE 1 — Web Search: tool → SearchService → provider
// =========================================================================
describe('Feature: Web Search (browser.web_search → SearchService)', () => {
  afterEach(() => {
    searchService._setConfig(require('../../main/services/ConfigService'));
    searchService._setFetch(typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  });

  test('brave provider maps native shape into normalized ranked results', async () => {
    searchService._setConfig(fakeConfig({
      'settings.search': { provider: 'brave', braveApiKey: 'k-123', resultCount: 6 },
    }));
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        web: {
          results: [
            { title: 'Rust Book', url: 'https://doc.rust-lang.org/book/', description: 'The book.' },
            { title: 'Dup', url: 'https://doc.rust-lang.org/book/', description: 'dup' },
            { title: '', url: 'https://no-title.example/', description: 'dropped: blank title' },
            { title: 'Tokio', url: 'https://tokio.rs/', description: 'Async runtime.' },
          ],
        },
      }),
    }));
    searchService._setFetch(fetchMock);

    const res = await webSearch.handler({ query: 'rust async', count: 5 }, {});

    // Tool delegated to SearchService with the brave provider; native
    // {description} mapped to {snippet}; duplicate URL + blank-title dropped.
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(calledUrl).toBe('https://api.search.brave.com/res/v1/web/search?count=5&q=rust%20async');
    expect(fetchMock.mock.calls[0][1].headers['X-Subscription-Token']).toBe('k-123');
    expect(res).toMatchObject({
      ok: true,
      provider: 'brave',
      query: 'rust async',
      count: 2,
      results: [
        { title: 'Rust Book', url: 'https://doc.rust-lang.org/book/', snippet: 'The book.' },
        { title: 'Tokio', url: 'https://tokio.rs/', snippet: 'Async runtime.' },
      ],
    });
  });

  test('searxng provider unconfigured → explicit fail-loud error (negative)', async () => {
    searchService._setConfig(fakeConfig({ 'settings.search': { provider: 'searxng' } }));
    const res = await webSearch.handler({ query: 'anything' }, {});
    expect(res).toMatchObject({ ok: false, error: 'searxng_not_configured' });
  });

  test('RISK#3a cold-start: inBrowser provider with NO tab ctx → in_browser_unavailable', async () => {
    searchService._setConfig(fakeConfig({
      'settings.search': { provider: 'inBrowser', inBrowserEngine: 'duckduckgo' },
    }));
    // Tool passes ctx={tabOps:undefined, resolveWc:undefined} when invoked
    // without a renderer-backed browser — must degrade visibly, not throw.
    const res = await webSearch.handler({ query: 'no browser here' }, {});
    expect(res).toEqual({ ok: false, error: 'in_browser_unavailable' });
  });
});

// =========================================================================
// FEATURE 2 — Ask-Your-Browsing: tool + ipc → SemanticIndexService
// =========================================================================
describe('Feature: Ask-Your-Browsing (tool + browsing:ask → SemanticIndexService)', () => {
  const browserDataHandlers = require('../../main/ipc/browserDataHandlers');

  beforeEach(() => {
    resetIpc();
    // Empty corpus: point History + Bookmark singletons at a non-existent
    // file so their cold-start path yields zero docs (no real config dir IO).
    historyService._setFs(emptyFsShim());
    historyService._setFilePath('/dev/null/ic-test-history.json');
    bookmarkService._setFs(emptyFsShim());
    bookmarkService._setFilePath('/dev/null/ic-test-bookmarks.json');
    semanticIndex._setFs(emptyFsShim());
    semanticIndex._setFilePath('/dev/null/ic-test-semantic.json');
    semanticIndex._index = null;
    semanticIndex._setConfig(fakeConfig({ 'settings.askBrowsing': { enabled: true } }));
  });

  afterEach(() => {
    historyService._setFs(fs);
    historyService._setFilePath(null);
    historyService._loaded = false;
    bookmarkService._setFs(fs);
    bookmarkService._setFilePath(null);
    bookmarkService._loaded = false;
    semanticIndex._setFs(fs);
    semanticIndex._setFilePath(null);
    semanticIndex._index = null;
    semanticIndex._setConfig(require('../../main/services/ConfigService'));
  });

  test('RISK#3b cold-start: ask_browsing tool over empty corpus → {ok:true,count:0}', async () => {
    const res = await askBrowsing.handler({ query: 'that article about rust' });
    expect(res).toMatchObject({ ok: true, mode: 'lexical', count: 0, results: [] });
    expect(res.hint).toMatch(/Nothing in history or bookmarks/i);
  });

  test('empty query is rejected by the tool before any corpus scan (negative)', async () => {
    const res = await askBrowsing.handler({ query: '   ' });
    expect(res).toEqual({ ok: false, error: 'empty_query' });
  });

  test('browsing:ask IPC handler routes query+limit into SemanticIndexService.search', async () => {
    browserDataHandlers.register(fakeWindow(), {});
    const out = await ipcMain._handlers['browsing:ask']({}, { query: 'anything', limit: 5 });
    expect(out).toMatchObject({ ok: true, count: 0, mode: 'lexical' });
  });
});

// =========================================================================
// FEATURE 3 — Research Report: tool → AgentTabOpsService.openTab per source
// =========================================================================
describe('Feature: Research Report (browser.open_research_sources)', () => {
  test('normalizeSources drops non-http(s) + dupes, defaults title, caps at 8', () => {
    const out = normalizeSources([
      { url: 'https://a.example/x', title: 'Alpha' },
      { url: 'HTTPS://A.example/x', title: 'Dup (case-insensitive URL)' },
      { url: 'ftp://nope.example/' },
      { url: 'https://b.example/' }, // no title → defaults to URL
      ...Array.from({ length: 10 }, (_, i) => ({ url: `https://n${i}.example/`, title: `n${i}` })),
    ]);
    expect(out.length).toBe(8);
    expect(out[0]).toEqual({ url: 'https://a.example/x', title: 'Alpha' });
    expect(out[1]).toEqual({ url: 'https://b.example/', title: 'https://b.example/' });
    expect(out.every((s) => /^https:\/\//.test(s.url))).toBe(true);
  });

  test('handler opens each source via tabOps and returns a 1-based citation map', async () => {
    const opened = [];
    const tabOps = {
      openTab: jest.fn(async (url) => { opened.push(url); return { ok: true, spaceId: `sp_${opened.length}` }; }),
    };
    const res = await openResearchSources.handler(
      { sources: [
        { url: 'https://one.example/', title: 'One' },
        { url: 'https://two.example/', title: 'Two' },
      ] },
      { tabOps },
    );
    expect(opened).toEqual(['https://one.example/', 'https://two.example/']);
    expect(res).toMatchObject({
      ok: true,
      sources: [
        { index: 1, spaceId: 'sp_1', url: 'https://one.example/', title: 'One' },
        { index: 2, spaceId: 'sp_2', url: 'https://two.example/', title: 'Two' },
      ],
    });
    expect(res.errors).toBeUndefined();
  });

  test('no valid sources → fail-loud, no tab opened (negative)', async () => {
    const tabOps = { openTab: jest.fn() };
    const res = await openResearchSources.handler({ sources: [{ url: 'mailto:x@y.z' }] }, { tabOps });
    expect(res).toEqual({ ok: false, error: 'no_valid_sources' });
    expect(tabOps.openTab).not.toHaveBeenCalled();
  });
});

// =========================================================================
// FEATURE 4 — Reader + TTS: pure speech helpers (node-importable)
// =========================================================================
describe('Feature: Reader + TTS (renderer/utils/tts pure helpers)', () => {
  // Trace reduced to the pure helpers: ReaderView.renderArticle + the
  // TtsEngine instance are DOM-bound (window.speechSynthesis) and live in the
  // jsdom renderer project; here we lock the node-importable pure transforms
  // markdownToSpeech + chunkText that the read-aloud feature depends on.
  test('markdownToSpeech strips markdown + [N] citation noise', () => {
    const out = ttsMod.markdownToSpeech(
      '# Title\n\nGrowth slowed [2] per **the** report.\n\n- bullet `code`\n[link](http://x)',
    );
    // headings/bullets/emphasis/links/code stripped, [2] removed, runs of
    // whitespace collapsed, paragraph breaks → single \n.
    expect(out).toBe('Title\nGrowth slowed per the report.\nbullet code\nlink');
  });

  test('chunkText keeps a short paragraph whole but splits when it would exceed the cap', () => {
    // Short single paragraph stays one utterance (no premature splitting).
    expect(ttsMod.chunkText('First sentence. Second sentence.')).toEqual([
      'First sentence. Second sentence.',
    ]);

    // Two long sentences (each ~150 chars) whose combined length exceeds the
    // 220 cap → flushed into two separate chunks at the sentence boundary.
    const s1 = `${'a'.repeat(148)}.`;
    const s2 = `${'b'.repeat(148)}.`;
    expect(ttsMod.chunkText(`${s1} ${s2}`)).toEqual([s1, s2]);
  });

  test('chunkText hard-wraps a single over-long sentence so no utterance stalls the engine', () => {
    const long = 'x'.repeat(500);
    const chunks = ttsMod.chunkText(long);
    expect(chunks.length).toBe(3); // 500 / 220 → 220 + 220 + 60
    expect(chunks.map((c) => c.length)).toEqual([220, 220, 60]);
    expect(chunks.join('')).toBe(long);
  });
});

// =========================================================================
// FEATURE 5 — Scheduled Routines: RoutineService + routineHandlers
// =========================================================================
describe('Feature: Scheduled Routines (RoutineService + routine IPC)', () => {
  const routineHandlers = require('../../main/ipc/routineHandlers');

  beforeEach(() => { resetIpc(); });

  test('full loop: tick dispatches routine:run → renderer routine:ran advances lastRunAt', () => {
    const NOW = 1_000_000;
    const cfg = fakeConfig({
      'settings.routines.enabled': true,
      'settings.routines.items': [{ id: 'r1', name: 'Daily', task: 'do it', schedule: { kind: 'interval' }, lastRunAt: null }],
    });
    const svc = new RoutineService();
    svc.bind({ configService: cfg, agentService: { isRunning: () => false } });
    svc._setNow(() => NOW);
    const win = fakeWindow();
    svc._window = win;

    // routineHandlers wires routine:ran → svc.noteRan; routine:run-now → svc.runNow.
    routineHandlers.register(win, { routineService: svc });

    svc._tickOnce();

    // A due routine dispatched a renderer run request.
    expect(win.sent).toEqual([
      { channel: 'routine:run', payload: { id: 'r1', name: 'Daily', task: 'do it' } },
    ]);
    expect(svc._pending).toMatchObject({ id: 'r1' });
    expect(cfg.set).not.toHaveBeenCalled(); // not advanced until renderer reports OK

    // Renderer reports completion through the real IPC handler.
    ipcMain._handlers['routine:ran']({}, { id: 'r1', ok: true });

    expect(svc._pending).toBeNull();
    expect(cfg.set).toHaveBeenCalledWith(
      'settings.routines.items',
      [expect.objectContaining({ id: 'r1', lastRunAt: NOW })],
    );
  });

  test('RISK#4a single-flight: a pending dispatch blocks a second tick', () => {
    const cfg = fakeConfig({
      'settings.routines.enabled': true,
      'settings.routines.items': [{ id: 'r1', name: 'n', task: 't', schedule: { kind: 'interval' }, lastRunAt: null }],
    });
    const svc = new RoutineService();
    svc.bind({ configService: cfg, agentService: { isRunning: () => false } });
    svc._setNow(() => 5000);
    const win = fakeWindow();
    svc._window = win;

    svc._tickOnce();
    svc._tickOnce(); // _pending gate → no second dispatch

    expect(win.sent.length).toBe(1);
  });

  test('RISK#4b scope filter: noteRan for a non-matching id does NOT clear pending / advance', () => {
    const cfg = fakeConfig({
      'settings.routines.enabled': true,
      'settings.routines.items': [{ id: 'r1', name: 'n', task: 't', schedule: { kind: 'interval' }, lastRunAt: null }],
    });
    const svc = new RoutineService();
    svc.bind({ configService: cfg, agentService: { isRunning: () => false } });
    svc._setNow(() => 7000);
    svc._window = fakeWindow();

    svc._tickOnce();
    expect(svc._pending).toMatchObject({ id: 'r1' });

    // A completion report carrying a DIFFERENT id (wrong scope) must be
    // ignored — otherwise an unrelated agent run would falsely "complete" r1.
    svc.noteRan({ id: 'other', ok: true });
    expect(svc._pending).toMatchObject({ id: 'r1' });
    expect(cfg.set).not.toHaveBeenCalled();

    // A failure report for the right id clears pending but does NOT advance.
    svc.noteRan({ id: 'r1', ok: false });
    expect(svc._pending).toBeNull();
    expect(cfg.set).not.toHaveBeenCalled();
  });

  test('RISK#4c stranded-dispatch retried after the 15-min timeout', () => {
    jest.useFakeTimers();
    try {
      const cfg = fakeConfig({
        'settings.routines.enabled': true,
        // lastRunAt:null at the routine root → always due (first-run path),
        // isolating the _pending stranded-timeout behavior under test.
        'settings.routines.items': [{ id: 'r1', name: 'n', task: 't', schedule: { kind: 'interval' }, lastRunAt: null }],
      });
      const svc = new RoutineService();
      svc.bind({ configService: cfg, agentService: { isRunning: () => false } });
      let clock = 0;
      svc._setNow(() => clock);
      const win = fakeWindow();
      svc._window = win;

      svc._tickOnce(); // dispatch #1 at t=0, _pending.at = 0
      expect(win.sent.length).toBe(1);
      expect(svc._pending).toMatchObject({ id: 'r1', at: 0 });

      // Exactly PENDING_TIMEOUT_MS (900_000) elapsed — NOT strictly greater
      // than the timeout → pending still held, tick is a no-op.
      clock = 900_000;
      svc._tickOnce();
      expect(win.sent.length).toBe(1);
      expect(svc._pending).toMatchObject({ id: 'r1', at: 0 });

      // One ms past the window → stranded dispatch is cleared AND, since the
      // routine is still due, the SAME tick immediately re-dispatches it
      // (the retry, not a no-op — verifies the comment "let it retry").
      clock = 900_001;
      svc._tickOnce();
      expect(win.sent.length).toBe(2);
      expect(svc._pending).toMatchObject({ id: 'r1', at: 900_001 });
    } finally {
      jest.useRealTimers();
    }
  });

  test('runNow returns busy when a dispatch is already pending (negative)', () => {
    const cfg = fakeConfig({
      'settings.routines.enabled': true,
      'settings.routines.items': [{ id: 'r1', name: 'n', task: 't', schedule: { kind: 'interval' }, lastRunAt: null }],
    });
    const svc = new RoutineService();
    svc.bind({ configService: cfg, agentService: { isRunning: () => false } });
    svc._setNow(() => 1);
    svc._window = fakeWindow();
    routineHandlers.register(svc._window, { routineService: svc });

    svc._tickOnce(); // creates _pending
    const out = ipcMain._handlers['routine:run-now']({}, { id: 'r1' });
    return expect(out).resolves.toEqual({ ok: false, error: 'busy' });
  });
});

// =========================================================================
// FEATURE 6 — Persona Packs: personaHandlers (pack:apply / pack:run-task)
// =========================================================================
describe('Feature: Persona Packs (personaHandlers pack:apply / pack:run-task)', () => {
  // personaHandlers calls the REAL personaIo.applyImport against the fake
  // config so the persona is genuinely installed (config store is the only
  // boundary). No jest.resetModules — that would mint a fresh inline electron
  // mock and orphan the _handlers map this file references.
  const personaHandlers = require('../../main/ipc/personaHandlers');

  beforeEach(() => { resetIpc(); });

  function registerWith(cfg) {
    const win = fakeWindow();
    personaHandlers.register(win, {
      personaService: { listAll: () => [], listEnabled: () => [] },
      personaRouter: { getLock: () => null },
      configService: cfg,
    });
    return win;
  }

  test('pack:apply installs the pack persona via the real import path', () => {
    const cfg = fakeConfig({ 'settings.agentPersonas': {} });
    const win = registerWith(cfg);

    const out = ipcMain._handlers['pack:apply']({}, { id: 'job-hunt' });

    expect(out).toMatchObject({ ok: true, added: 1, label: 'Job Hunt' });
    const saved = cfg.get('settings.agentPersonas');
    expect(saved.customPersonas).toEqual([
      expect.objectContaining({ name: 'pack_job_hunt', label: 'Job Hunt', builtin: false }),
    ]);
    expect(saved.enabledPersonas).toEqual(['pack_job_hunt']);
  });

  test('RISK#6 pack:apply emits config:changed {kind:replace} + pack:open-panes', () => {
    const cfg = fakeConfig({ 'settings.agentPersonas': {} });
    const win = registerWith(cfg);

    ipcMain._handlers['pack:apply']({}, { id: 'travel' });

    const replace = win.sent.find((s) => s.channel === 'config:changed');
    expect(replace).toEqual({ channel: 'config:changed', payload: { kind: 'replace' } });
    const panes = win.sent.find((s) => s.channel === 'pack:open-panes');
    expect(panes.payload.label).toBe('Travel');
    expect(panes.payload.panes[0]).toEqual({ label: 'Google Flights', url: 'https://www.google.com/travel/flights' });
  });

  test('RISK#5 pack:run-task: invoke resolves {ok:true} AND renderer-bound send fires', () => {
    const cfg = fakeConfig({ 'settings.agentPersonas': {} });
    const win = registerWith(cfg);

    // ipcMain.handle('pack:run-task') and webContents.send('pack:run-task')
    // are SEPARATE channels (handle vs on). Both directions must work.
    const out = ipcMain._handlers['pack:run-task']({}, { id: 'lit-review' });
    expect(out).toEqual({ ok: true });

    const sent = win.sent.find((s) => s.channel === 'pack:run-task');
    expect(sent).toBeDefined();
    expect(sent.payload).toEqual({ label: 'Lit Review', task: personaPacks.getPack('lit-review').task });
  });

  test('pack:apply unknown id → not_found, nothing installed (negative)', () => {
    const cfg = fakeConfig({ 'settings.agentPersonas': {} });
    const win = registerWith(cfg);
    const out = ipcMain._handlers['pack:apply']({}, { id: 'no-such-pack' });
    expect(out).toEqual({ ok: false, error: 'not_found' });
    expect(win.sent).toEqual([]);
  });
});

// =========================================================================
// FEATURE 7 — Extension Install: extensionHandlers → ExtensionService
// =========================================================================
describe('Feature: Extension Install (extensions:install-prepare / -commit)', () => {
  const extensionHandlers = require('../../main/ipc/extensionHandlers');

  beforeEach(() => { resetIpc(); dialog.showOpenDialog.mockReset(); });

  test('install-prepare with explicit source → ExtensionService.prepareInstall (no dialog)', async () => {
    const extensionService = {
      prepareInstall: jest.fn(async (src) => ({ ok: true, staging: '/tmp/stage', isDirectory: false, name: 'My Ext', permissions: ['tabs'] })),
      commitInstall: jest.fn(),
    };
    extensionHandlers.register(fakeWindow(), { extensionService });

    const out = await ipcMain._handlers['extensions:install-prepare']({}, { source: 'https://host/ext.crx' });

    expect(extensionService.prepareInstall).toHaveBeenCalledWith('https://host/ext.crx');
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, staging: '/tmp/stage', name: 'My Ext' });
  });

  test('install-prepare with no source opens the file picker; cancel → cancelled', async () => {
    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const extensionService = { prepareInstall: jest.fn(), commitInstall: jest.fn() };
    extensionHandlers.register(fakeWindow(), { extensionService });

    const out = await ipcMain._handlers['extensions:install-prepare']({}, {});

    expect(dialog.showOpenDialog).toHaveBeenCalled();
    expect(extensionService.prepareInstall).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: false, cancelled: true });
  });

  test('install-commit forwards the staged opts to ExtensionService.commitInstall', async () => {
    const extensionService = {
      prepareInstall: jest.fn(),
      commitInstall: jest.fn(async (opts) => ({ ok: true, id: 'ext1', name: 'My Ext' })),
    };
    extensionHandlers.register(fakeWindow(), { extensionService });

    const out = await ipcMain._handlers['extensions:install-commit']({}, { staging: '/tmp/stage', isDirectory: false, accept: true });

    expect(extensionService.commitInstall).toHaveBeenCalledWith({ staging: '/tmp/stage', isDirectory: false, accept: true });
    expect(out).toEqual({ ok: true, id: 'ext1', name: 'My Ext' });
  });
});

// =========================================================================
// FEATURE 8 — Agent Egress Control: approvalPolicy + AgentApprovalService
// =========================================================================
describe('Feature: Agent Egress (approvalPolicy + AgentApprovalService.decide)', () => {
  function svcWith(egress, rules) {
    const svc = new AgentApprovalService();
    const map = new Map();
    if (egress) map.set('settings.llm.agent.egress', egress);
    if (rules) map.set('settings.llm.agent.approval', rules);
    svc.bind(
      { isDestroyed: () => true, webContents: { send: () => {} } },
      { on: () => {} },
      { get: (k, d) => (map.has(k) ? map.get(k) : d), set: (k, v) => map.set(k, v) },
    );
    return svc;
  }

  test('egressVerdict: block list always wins; allowlist miss → unlisted', () => {
    const egress = { mode: 'allowlist', allow: ['github.com'], block: ['evil.example'] };
    expect(policy.egressVerdict('https://evil.example/x', egress)).toBe('block');
    expect(policy.egressVerdict('https://api.github.com/x', egress)).toBe('allow'); // subdomain match
    expect(policy.egressVerdict('https://random.example/x', egress)).toBe('unlisted');
    // Non-http(s) destinations are never gated.
    expect(policy.egressVerdict('about:blank', egress)).toBe('allow');
  });

  test('blocked host is denied unconditionally even with onViolation:prompt', () => {
    const svc = svcWith({ mode: 'allowlist', allow: ['ok.example'], block: ['evil.example'], onViolation: 'prompt' });
    const { allowed, denied, prompts } = svc.decide(
      [{ id: '1', name: 'browser.navigate', args: { url: 'https://evil.example/path' } }],
      { mode: { name: 'balanced' } },
    );
    expect(allowed).toEqual([]);
    expect(prompts).toEqual([]);
    expect(denied).toEqual([
      { call: { id: '1', name: 'browser.navigate', args: { url: 'https://evil.example/path' } }, reason: 'egress_blocked:https://evil.example' },
    ]);
  });

  test('allowlist miss prompts when onViolation:prompt, denies when onViolation:deny', () => {
    const navCall = { id: '1', name: 'browser.open_tab', args: { url: 'https://unlisted.example/' } };

    const prompted = svcWith({ mode: 'allowlist', allow: ['ok.example'], onViolation: 'prompt' })
      .decide([navCall], { mode: { name: 'balanced' } });
    expect(prompted.prompts).toEqual([{ call: navCall, class: 'egress', origin: 'https://unlisted.example' }]);
    expect(prompted.denied).toEqual([]);

    const denied = svcWith({ mode: 'allowlist', allow: ['ok.example'], onViolation: 'deny' })
      .decide([navCall], { mode: { name: 'balanced' } });
    expect(denied.denied).toEqual([{ call: navCall, reason: 'egress_unlisted:https://unlisted.example' }]);
    expect(denied.prompts).toEqual([]);
  });

  test('allowlisted destination passes straight through (positive)', () => {
    const svc = svcWith({ mode: 'allowlist', allow: ['github.com'], onViolation: 'deny' });
    const call = { id: '1', name: 'browser.navigate', args: { url: 'https://gist.github.com/x' } };
    const { allowed, denied, prompts } = svc.decide([call], { mode: { name: 'balanced' } });
    expect(allowed).toEqual([call]);
    expect(denied).toEqual([]);
    expect(prompts).toEqual([]);
  });
});

// =========================================================================
// RISK 1 — history:recent signature change (positional → {limit})
// =========================================================================
describe('RISK#1: history:recent uses the {limit} object shape end-to-end', () => {
  const browserDataHandlers = require('../../main/ipc/browserDataHandlers');

  beforeEach(() => { resetIpc(); });

  test('main handler reads opts.limit (object), not a positional number', async () => {
    const getRecent = jest.fn(() => [{ id: 'h1', url: 'https://x', title: 'X' }]);
    browserDataHandlers.register(fakeWindow(), { historyService: { getRecent } });

    await ipcMain._handlers['history:recent']({}, { limit: 200 });
    expect(getRecent).toHaveBeenCalledWith(200);

    // No opts → falls back to the documented default of 50 (not undefined,
    // not NaN — a positional regression would pass `{}` here).
    await ipcMain._handlers['history:recent']({});
    expect(getRecent).toHaveBeenLastCalledWith(50);
  });

  test('every renderer caller of history:recent passes the {limit} object shape', () => {
    // Static guard: the signature change from (limit=50) to ({limit}) is a
    // silent regression risk for any caller still passing a bare number.
    const rendererDir = path.join(__dirname, '..', '..', 'renderer');
    const offenders = [];
    const callRe = /invoke\(\s*['"]history:recent['"]\s*(?:,\s*([^)]*))?\)/g;

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const src = fs.readFileSync(full, 'utf8');
        let m;
        while ((m = callRe.exec(src)) !== null) {
          const arg = (m[1] || '').trim();
          // Acceptable: no second arg, OR an object literal / variable.
          // A bare number literal (e.g. `, 200`) is the regression.
          if (arg && /^-?\d/.test(arg)) offenders.push(`${path.relative(rendererDir, full)}: invoke('history:recent', ${arg})`);
        }
      }
    };
    walk(rendererDir);
    expect(offenders).toEqual([]);
  });
});

// =========================================================================
// FEATURE — Unified chat backbone: chat:ask/chat:token/chat:cancel →
// ChatStreamService → LLMClientService, with the agent single-flight guard.
// =========================================================================
describe('Feature: Unified chat (chat:ask → ChatStreamService → LLMClientService)', () => {
  const chatHandlers = require('../../main/ipc/chatHandlers');
  const chatStream = require('../../main/services/ChatStreamService');
  const llmClient = require('../../main/services/LLMClientService');

  beforeEach(() => { resetIpc(); chatStream.cancelAll(); });
  afterEach(() => { jest.restoreAllMocks(); });

  test('registers chat:ask (invoke) and chat:cancel (on)', () => {
    chatHandlers.register(fakeWindow(), {});
    expect(typeof ipcMain._handlers['chat:ask']).toBe('function');
    expect(typeof ipcMain._handlers['chat:cancel']).toBe('function');
  });

  test('chat:ask streams deltas as chat:token and resolves ok', async () => {
    jest.spyOn(llmClient, 'chatCompletionStream').mockImplementation(async function* gen() {
      yield 'Hel'; yield 'lo'; yield { __final: true, elapsedMs: 9 };
    });
    const win = fakeWindow();
    chatHandlers.register(win, {});
    const out = await ipcMain._handlers['chat:ask']({}, { id: 'c1', messages: [{ role: 'user', content: 'hi' }] });
    expect(out).toEqual({ ok: true, elapsedMs: 9, charCount: 5 });
    expect(win.sent).toEqual([
      { channel: 'chat:token', payload: { id: 'c1', delta: 'Hel' } },
      { channel: 'chat:token', payload: { id: 'c1', delta: 'lo' } },
    ]);
  });

  test('rejects with engine_busy while the agent loop holds the inference slot', async () => {
    const { gate } = require('../../main/agent/sessions/llmGate');
    gate.configure({ limit: () => 1 });
    const spy = jest.spyOn(llmClient, 'chatCompletionStream');
    const agentService = { isRunning: () => true };
    chatHandlers.register(fakeWindow(), { agentService });
    // An agent LLM request in flight holds the only gate slot.
    const release = gate.tryAcquire();
    try {
      const out = await ipcMain._handlers['chat:ask']({}, { id: 'c2', messages: [{ role: 'user', content: 'hi' }] });
      expect(out).toEqual({ ok: false, error: 'engine_busy' });
      expect(spy).not.toHaveBeenCalled();
    } finally { release(); }
  });

  test('a "no model configured" stream error → resolved {ok:false,error}, not a throw', async () => {
    // LLMClientService is the external boundary (it resolves model id /
    // endpoint). Simulate it raising the friendly "no model" error mid-stream.
    jest.spyOn(llmClient, 'chatCompletionStream').mockImplementation(async function* gen() {
      throw new Error('No model configured');
      // eslint-disable-next-line no-unreachable
      yield '';
    });
    chatHandlers.register(fakeWindow(), {});
    const out = await ipcMain._handlers['chat:ask']({}, { id: 'c3', messages: [{ role: 'user', content: 'hi' }] });
    expect(out).toEqual({ ok: false, error: 'No model configured' });
  });

  test('missing request id / empty messages are rejected before any LLM call (negative)', async () => {
    const spy = jest.spyOn(llmClient, 'chatCompletionStream');
    chatHandlers.register(fakeWindow(), {});
    expect(await ipcMain._handlers['chat:ask']({}, {})).toEqual({ ok: false, error: 'missing_request_id' });
    expect(await ipcMain._handlers['chat:ask']({}, { id: 'c', messages: [] })).toEqual({ ok: false, error: 'empty_messages' });
    expect(spy).not.toHaveBeenCalled();
  });
});

// =========================================================================
// RETIRED SURFACES — the unified-chat consolidation removed the copilot:*
// IPC channel and the ic://llm-chat built-in page. Guard against a stray
// caller silently re-introducing a dead channel.
// =========================================================================
// =========================================================================
// Every registered shortcut id must reach a dispatch case. The two halves are
// separate files, so a rename in one silently turns the shortcut into a no-op:
// `view.multispace` in the registry vs `view.multiSpace` in the dispatcher made
// Cmd+M do nothing while still being listed in Settings > Shortcuts.
// =========================================================================
describe('Shortcut ids reach a dispatcher case', () => {
  test('every default shortcut id is handled in renderer.js', () => {
    const shortcutManager = require('../../renderer/utils/shortcuts');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'renderer.js'), 'utf8');
    const cases = new Set([...src.matchAll(/case '([a-zA-Z0-9_.]+)':/g)].map((m) => m[1]));
    const missing = [...shortcutManager.defaultShortcuts.keys()]
      // space.select.N is handled by a startsWith branch, not its own case.
      .filter((id) => !id.startsWith('space.select.'))
      .filter((id) => !cases.has(id));
    expect(missing).toEqual([]);
  });
});

describe('Retired surfaces have no remaining callers', () => {
  const SRC_ROOTS = ['renderer', 'main', 'shared'];
  const collect = (re) => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'ic-pages' || entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!/\.(js|html)$/.test(entry.name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (re.test(src)) offenders.push(path.relative(path.join(__dirname, '..', '..'), full));
      }
    };
    for (const root of SRC_ROOTS) walk(path.join(__dirname, '..', '..', root));
    return offenders;
  };

  test('no source references the retired copilot:ask/token/cancel channels', () => {
    expect(collect(/copilot:(ask|token|cancel)/)).toEqual([]);
  });

  test('no source references the retired ic://llm-chat page', () => {
    expect(collect(/ic:\/\/llm-chat/)).toEqual([]);
  });
});
