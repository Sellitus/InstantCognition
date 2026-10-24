// AgentApprovalService ↔ permission engine: decide() context, the
// agent:approval-request payload, and the allow_rule_always decision.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AgentApprovalService } = require('../../../../main/services/AgentApprovalService');

function mockConfigStore(agent) {
  const data = { settings: { llm: { agent } } };
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

function mockWindow() {
  const sent = [];
  return { sent, isDestroyed: () => false, webContents: { send: jest.fn((ch, payload) => sent.push({ ch, payload })) } };
}

function mockIpcMain() {
  const on = new Map();
  return { on: jest.fn((ch, fn) => on.set(ch, fn)), respond: (payload) => on.get('agent:approval-response')({}, payload) };
}

let base, root, config, svc, win, ipc;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-approval-')));
  root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 1;\n');
  config = mockConfigStore({ permissions: { mode: 'ask' }, workspace: { roots: [root] } });
  svc = new AgentApprovalService();
  win = mockWindow();
  ipc = mockIpcMain();
  svc.bind(win, ipc, config);
});

afterEach(() => {
  svc._reset();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('decide()', () => {
  test('a path escape is denied before any prompt, in every mode', () => {
    for (const mode of ['ask', 'bypass']) {
      config.data.settings.llm.agent.permissions.mode = mode;
      const r = svc.decide([{ name: 'fs.write', args: { path: '../x', content: '' } }], {});
      expect(r.denied).toEqual([{ call: expect.any(Object), reason: 'path_outside_workspace' }]);
      expect(r.prompts).toEqual([]);
    }
  });

  test('.env writes prompt in Auto-edit; ordinary writes are allowed', () => {
    config.data.settings.llm.agent.permissions.mode = 'auto-edit';
    const r = svc.decide([
      { name: 'fs.write', args: { path: 'src/b.js', content: 'x' } },
      { name: 'fs.write', args: { path: '.env', content: 'K=v' } },
    ], {});
    expect(r.allowed.map((c) => c.args.path)).toEqual(['src/b.js']);
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toMatchObject({ class: 'edit', origin: '', facts: { rel: '.env', protected: true } });
  });

  test('a per-session Plan mode denies writes only in that session', () => {
    svc.setSessionMode('s1', 'plan');
    const c = { name: 'fs.write', args: { path: 'src/b.js', content: 'x' } };
    expect(svc.decide([c], { sessionId: 's1' }).denied[0].reason).toBe('plan_mode_read_only');
    expect(svc.decide([c], { sessionId: 's2' }).prompts).toHaveLength(1);
    expect(() => svc.setSessionMode('s1', 'turbo')).toThrow('invalid_mode');
  });

  test('ctx.allowedTools denies tools outside the session tool filter', () => {
    const r = svc.decide([{ name: 'shell.run', args: { argv: ['ls'] } }], { allowedTools: ['fs.read'] });
    expect(r.denied[0].reason).toBe('tool_not_available');
  });
});

describe('approval request payload', () => {
  test('fs.edit carries kind, path, a unified diff and the suggested rule', async () => {
    const { prompts } = svc.decide([{ name: 'fs.edit', args: { path: 'src/a.js', old_string: '1', new_string: '2' } }], { sessionId: 's1' });
    const pending = svc.requestApproval(prompts[0]);
    const { ch, payload } = win.sent[0];
    expect(ch).toBe('agent:approval-request');
    expect(payload).toMatchObject({
      requestId: expect.stringMatching(/^approval_/),
      class: 'edit', origin: '', sessionId: 's1', kind: 'fs_edit', toolName: 'fs.edit',
      path: 'src/a.js', suggestedRule: 'fs.edit:src/**',
    });
    expect(payload.diff).toContain('-const a = 1;');
    expect(payload.diff).toContain('+const a = 2;');
    expect(JSON.parse(payload.argsPreview)).toEqual({ path: 'src/a.js', old_string: '1', new_string: '2' });
    ipc.respond({ requestId: payload.requestId, decision: 'reject' });
    expect(await pending).toMatchObject({ decision: 'reject' });
  });

  test('shell.run carries argv and the resolved cwd; long args are truncated in the preview', async () => {
    const long = 'x'.repeat(500);
    const { prompts } = svc.decide([{ name: 'shell.run', args: { argv: ['echo', long], cwd: 'src' } }], {});
    const pending = svc.requestApproval(prompts[0]);
    const { payload } = win.sent[0];
    expect(payload).toMatchObject({ kind: 'shell', toolName: 'shell.run', argv: ['echo', long], cwd: path.join(root, 'src'), sessionId: null });
    expect(payload.argsPreview.length).toBeLessThan(400);
    ipc.respond({ requestId: payload.requestId, decision: 'reject' });
    await pending;
  });
});

describe('allow_rule_always', () => {
  test('approves the call and persists only the main-side suggested rule', async () => {
    const { prompts } = svc.decide([{ name: 'shell.run', args: { argv: ['git', 'status'] } }], {});
    const pending = svc.requestApproval(prompts[0]);
    const { payload } = win.sent[0];
    ipc.respond({ requestId: payload.requestId, decision: 'allow_rule_always', suggestedRule: 'shell.run:*' });
    const resp = await pending;
    expect(resp.decision).toBe('approve_rule_always');
    svc.applyDecision(prompts[0], resp.decision);
    expect(config.data.settings.llm.agent.permissions.rules.allow).toEqual(['shell.run:git status']);
    expect(svc.decide([{ name: 'shell.run', args: { argv: ['git', 'status'] } }], {}).allowed).toHaveLength(1);
    expect(svc.decide([{ name: 'shell.run', args: { argv: ['git', 'push'] } }], {}).prompts).toHaveLength(1);
  });

  test('without a suggested rule it approves once and persists nothing', async () => {
    const prompt = { call: { name: 'shell.run', args: { argv: ['my tool'] } }, class: 'exec', origin: '' };
    const pending = svc.requestApproval(prompt);
    ipc.respond({ requestId: win.sent[0].payload.requestId, decision: 'allow_rule_always' });
    expect((await pending).decision).toBe('approve');
    expect(config.set).not.toHaveBeenCalled();
  });

  test('a failed save is reported via persist-failed, not thrown', () => {
    config.set.mockImplementationOnce(() => { throw new Error('disk_full'); });
    const onFail = jest.fn();
    svc.on('persist-failed', onFail);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    svc.applyDecision({ call: { name: 'fs.write' }, class: 'edit', origin: '', suggestedRule: 'fs.write:src/**' }, 'approve_rule_always');
    expect(onFail).toHaveBeenCalledWith({ rule: 'fs.write:src/**', error: 'disk_full' });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('approve_session on a non-browser call grants a session rule, not a persisted one', () => {
    const { prompts } = svc.decide([{ name: 'fs.write', args: { path: 'src/b.js', content: 'x' } }], { sessionId: 's9' });
    svc.applyDecision(prompts[0], 'approve_session');
    expect(config.set).not.toHaveBeenCalled();
    expect(svc.decide([{ name: 'fs.write', args: { path: 'src/c.js', content: 'y' } }], { sessionId: 's9' }).allowed).toHaveLength(1);
    expect(svc.decide([{ name: 'fs.write', args: { path: 'src/c.js', content: 'y' } }], { sessionId: 's8' }).prompts).toHaveLength(1);
  });
});
