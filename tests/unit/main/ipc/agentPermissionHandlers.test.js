// agentPermissionHandlers — IPC contract for permission modes/rules,
// workspace roots and the global instructions file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const mockInvoke = new Map();
const mockDialog = { showOpenDialog: jest.fn() };
const mockPaths = { userData: '' };

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn((ch, fn) => { mockInvoke.set(ch, fn); }) },
  dialog: mockDialog,
  app: { getPath: jest.fn((name) => mockPaths[name]) },
}));

const { register, rootRejection } = require('../../../../main/ipc/agentPermissionHandlers');
const { AgentApprovalService } = require('../../../../main/services/AgentApprovalService');
const { DEFAULT_LLM_SETTINGS } = require('../../../../shared/llmDefaults');

const DEFAULT_DENY = DEFAULT_LLM_SETTINGS.agent.permissions.rules.deny;

// In-memory stand-in for the persisted config file (dotted-path get/set).
function mockConfigStore(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  return {
    data,
    get(key, dflt) {
      let cur = data;
      for (const k of key.split('.')) {
        if (!cur || typeof cur !== 'object' || !(k in cur)) return dflt;
        cur = cur[k];
      }
      return cur;
    },
    set: jest.fn((key, value) => {
      const parts = key.split('.');
      let cur = data;
      for (const k of parts.slice(0, -1)) { cur[k] = cur[k] && typeof cur[k] === 'object' ? cur[k] : {}; cur = cur[k]; }
      cur[parts[parts.length - 1]] = value;
    }),
  };
}

const invoke = (ch, arg) => mockInvoke.get(ch)({}, arg);

let base, userData, project, config, approval;

beforeEach(() => {
  mockInvoke.clear();
  jest.clearAllMocks();
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-permipc-')));
  userData = path.join(base, 'userData');
  project = path.join(base, 'project');
  fs.mkdirSync(userData);
  fs.mkdirSync(project);
  mockPaths.userData = userData;
  config = mockConfigStore({ settings: { llm: { agent: { permissions: { mode: 'ask' } } } } });
  approval = new AgentApprovalService();
  approval.bind(null, null, config);
  register({ isDestroyed: () => false }, { configService: config, approvalService: approval });
});

afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

test('registers every channel, and nothing without a config service', () => {
  expect([...mockInvoke.keys()].sort()).toEqual([
    'instructions:get-global', 'instructions:set-global',
    'permissions:add-rule', 'permissions:get', 'permissions:remove-rule', 'permissions:set-mode',
    'workspace:add-root', 'workspace:list-roots', 'workspace:remove-root',
  ]);
  mockInvoke.clear();
  register({}, {});
  expect(mockInvoke.size).toBe(0);
});

describe('permissions', () => {
  test('set-mode rejects an invalid mode and leaves config untouched', async () => {
    expect(await invoke('permissions:set-mode', { mode: 'yolo' })).toEqual({ ok: false, error: 'invalid_mode' });
    expect(await invoke('permissions:set-mode', {})).toEqual({ ok: false, error: 'invalid_mode' });
    expect(config.set).not.toHaveBeenCalled();
  });

  test('set-mode persists a global mode and get reports it', async () => {
    expect(await invoke('permissions:set-mode', { mode: 'auto-edit' })).toEqual({ ok: true, mode: 'auto-edit' });
    expect(config.data.settings.llm.agent.permissions.mode).toBe('auto-edit');
    expect(await invoke('permissions:get')).toMatchObject({ ok: true, mode: 'auto-edit', effectiveMode: 'auto-edit' });
  });

  test('a per-session mode overrides only that session and is not persisted', async () => {
    expect(await invoke('permissions:set-mode', { mode: 'plan', sessionId: 's1' })).toEqual({ ok: true, mode: 'plan' });
    expect(config.set).not.toHaveBeenCalled();
    expect(await invoke('permissions:get', { sessionId: 's1' })).toMatchObject({ mode: 'ask', effectiveMode: 'plan', sessionModes: { s1: 'plan' } });
    expect(await invoke('permissions:get', { sessionId: 's2' })).toMatchObject({ effectiveMode: 'ask' });
    expect(await invoke('permissions:set-mode', { mode: 'plan', sessionId: '../bad id' })).toEqual({ ok: false, error: 'invalid_session_id' });
  });

  test('add-rule validates, dedupes and persists; remove-rule removes', async () => {
    expect(await invoke('permissions:add-rule', { list: 'deny', rule: 'shell.run:rm *' })).toEqual({ ok: true, rule: 'shell.run:rm *' });
    await invoke('permissions:add-rule', { list: 'deny', rule: 'shell.run:rm *' });
    expect(config.data.settings.llm.agent.permissions.rules.deny).toEqual([...DEFAULT_DENY, 'shell.run:rm *']);
    expect(await invoke('permissions:add-rule', { list: 'deny', rule: 'fs.write:/etc/**' }))
      .toEqual({ ok: false, error: 'invalid_rule:path_spec_must_be_relative' });
    expect(await invoke('permissions:add-rule', { list: 'sometimes', rule: 'fs.read' })).toEqual({ ok: false, error: 'invalid_rule_list' });
    expect(await invoke('permissions:remove-rule', { list: 'deny', rule: 'shell.run:rm *' })).toEqual({ ok: true, removed: true });
    expect(config.data.settings.llm.agent.permissions.rules.deny).toEqual(DEFAULT_DENY);
    expect(await invoke('permissions:remove-rule', { list: 'deny', rule: 'shell.run:rm *' })).toEqual({ ok: true, removed: false });
  });
});

describe('workspace roots', () => {
  const pick = (p) => mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [p] });

  test('add-root rejects the home directory', async () => {
    pick(os.homedir());
    expect(await invoke('workspace:add-root')).toMatchObject({ ok: false, error: 'root_contains_home' });
    expect(config.set).not.toHaveBeenCalled();
  });

  test('add-root rejects "/" and an ancestor of home', async () => {
    pick(path.parse(base).root);
    expect(await invoke('workspace:add-root')).toMatchObject({ ok: false, error: 'root_is_filesystem_root' });
    pick(path.dirname(os.homedir()));
    expect(await invoke('workspace:add-root')).toMatchObject({ ok: false, error: 'root_contains_home' });
    expect(config.set).not.toHaveBeenCalled();
  });

  test('add-root rejects a folder overlapping app data (config.json lives there)', async () => {
    pick(userData);
    expect(await invoke('workspace:add-root')).toMatchObject({ ok: false, error: 'root_overlaps_app_data' });
    pick(base);
    expect(await invoke('workspace:add-root')).toMatchObject({ ok: false, error: 'root_overlaps_app_data' });
  });

  test('add-root takes only the dialog result, stores the realpath once, and remove-root removes it', async () => {
    const link = path.join(base, 'projlink');
    fs.symlinkSync(project, link, 'dir');
    pick(link);
    expect(await invoke('workspace:add-root', { path: '/etc' })).toEqual({ ok: true, path: project, roots: [project] });
    pick(project);
    await invoke('workspace:add-root');
    expect(await invoke('workspace:list-roots')).toEqual({ ok: true, roots: [project] });
    expect(await invoke('workspace:remove-root', { path: '/nope' })).toEqual({ ok: false, error: 'unknown_root' });
    expect(await invoke('workspace:remove-root', { index: 0 })).toEqual({ ok: true, roots: [] });
  });

  test('add-root reports cancel and a file pick', async () => {
    mockDialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke('workspace:add-root')).toEqual({ ok: false, canceled: true });
    const file = path.join(project, 'f.txt');
    fs.writeFileSync(file, 'x');
    pick(file);
    expect(await invoke('workspace:add-root')).toEqual({ ok: false, error: 'not_a_directory' });
  });

  test('rootRejection accepts an ordinary project folder', () => {
    expect(rootRejection(project, userData)).toBeNull();
  });
});

describe('global instructions', () => {
  test('round-trips content through userData/instructions.md', async () => {
    expect(await invoke('instructions:get-global')).toMatchObject({ ok: true, content: '' });
    expect(await invoke('instructions:set-global', { content: '# Rules\nBe brief.' })).toMatchObject({ ok: true, bytes: 17 });
    expect(fs.readFileSync(path.join(userData, 'instructions.md'), 'utf8')).toBe('# Rules\nBe brief.');
    expect(await invoke('instructions:get-global')).toMatchObject({ ok: true, content: '# Rules\nBe brief.', truncated: false });
    expect(fs.readdirSync(userData)).toEqual(['instructions.md']);
  });

  test('rejects oversize and non-string content without writing', async () => {
    config.data.settings.llm.agent.instructions = { maxBytes: 8 };
    expect(await invoke('instructions:set-global', { content: 'way too long' })).toEqual({ ok: false, error: 'too_large', maxBytes: 8 });
    expect(await invoke('instructions:set-global', { content: 5 })).toEqual({ ok: false, error: 'content_must_be_string' });
    expect(fs.existsSync(path.join(userData, 'instructions.md'))).toBe(false);
  });

  test('reads and writes the configured globalFile, not userData/instructions.md', async () => {
    const custom = path.join(project, 'RULES.md');
    fs.writeFileSync(custom, 'from custom');
    config.data.settings.llm.agent.instructions = { globalFile: custom };
    expect(await invoke('instructions:get-global')).toEqual({ ok: true, content: 'from custom', truncated: false, path: custom, maxBytes: DEFAULT_LLM_SETTINGS.agent.instructions.maxBytes, enabled: true });
    expect(await invoke('instructions:set-global', { content: 'edited' })).toMatchObject({ ok: true, path: custom });
    expect(fs.readFileSync(custom, 'utf8')).toBe('edited');
    expect(fs.existsSync(path.join(userData, 'instructions.md'))).toBe(false);
  });

  test('reports when instructions are disabled', async () => {
    config.data.settings.llm.agent.instructions = { enabled: false };
    expect(await invoke('instructions:get-global')).toMatchObject({ ok: true, enabled: false, path: path.join(userData, 'instructions.md') });
  });

  test('a relative globalFile is refused for read and write', async () => {
    config.data.settings.llm.agent.instructions = { globalFile: 'RULES.md' };
    expect(await invoke('instructions:get-global')).toEqual({ ok: false, error: 'instructions_global_file_not_absolute' });
    expect(await invoke('instructions:set-global', { content: 'x' })).toEqual({ ok: false, error: 'instructions_global_file_not_absolute' });
  });

  test('a FIFO globalFile is refused without blocking', async () => {
    const fifo = path.join(project, 'rules.fifo');
    execFileSync('mkfifo', [fifo]);
    config.data.settings.llm.agent.instructions = { globalFile: fifo };
    expect(await invoke('instructions:get-global')).toMatchObject({ ok: false, error: 'not_a_regular_file', path: fifo });
    expect(await invoke('instructions:set-global', { content: 'x' })).toEqual({ ok: false, error: 'not_a_regular_file' });
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
  }, 5000);

  test('writing through a symlinked globalFile updates the link target and keeps the link', async () => {
    const real = path.join(project, 'dotfiles-rules.md');
    const link = path.join(project, 'RULES.md');
    fs.writeFileSync(real, 'old');
    fs.symlinkSync(real, link);
    config.data.settings.llm.agent.instructions = { globalFile: link };
    expect(await invoke('instructions:set-global', { content: 'new' })).toMatchObject({ ok: true, path: real });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('new');
  });
});
