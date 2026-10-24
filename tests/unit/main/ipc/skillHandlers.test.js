// ipcMain is the external boundary (mocked); captured handlers are invoked to
// check input validation and delegation to the skills service.
const invokeHandlers = {};

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn((ch, fn) => { invokeHandlers[ch] = fn; }) },
}));

const skillHandlers = require('../../../../main/ipc/skillHandlers');
const { SLASH_ACTIONS } = require('../../../../renderer/utils/chatContext');

function mockSkillsService() {
  return {
    list: jest.fn(() => ({ ok: true, skills: [
      { name: 'on-skill', description: 'enabled one', enabled: true },
      { name: 'off-skill', description: 'disabled one', enabled: false },
    ], errors: [] })),
    get: jest.fn(() => ({ ok: true })),
    save: jest.fn(() => ({ ok: true })),
    delete: jest.fn(() => ({ ok: true })),
    setEnabled: jest.fn(() => ({ ok: true })),
    importFrom: jest.fn(() => ({ ok: true, results: [] })),
    installFromUrl: jest.fn(async () => ({ ok: true })),
    draftFromTranscript: jest.fn(async () => ({ ok: true })),
    run: jest.fn(async () => ({ ok: true })),
  };
}

const call = (ch, arg) => invokeHandlers[ch]({}, arg);

describe('skillHandlers', () => {
  let svc;
  beforeEach(() => {
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
    svc = mockSkillsService();
    skillHandlers.register({}, { skillsService: svc });
  });

  test('registers nothing without a skills service', () => {
    Object.keys(invokeHandlers).forEach((k) => delete invokeHandlers[k]);
    skillHandlers.register({}, {});
    expect(Object.keys(invokeHandlers)).toEqual([]);
  });

  test.each([
    ['skills:get', { name: '../x' }, 'invalid_name'],
    ['skills:get', 'pdf', 'invalid_name'],
    ['skills:delete', { name: 'Bad Name' }, 'invalid_name'],
    ['skills:save', { skill: 'text' }, 'invalid_skill'],
    ['skills:save', { skill: [] }, 'invalid_skill'],
    ['skills:set-enabled', { name: 'x', enabled: 'yes' }, 'invalid_enabled'],
    ['skills:set-enabled', { name: '', enabled: true }, 'invalid_name'],
    ['skills:import', { source: '../../etc' }, 'invalid_source'],
    ['skills:install-url', { url: 42 }, 'invalid_url'],
    ['skills:install-url', { url: '   ' }, 'invalid_url'],
    ['skills:install-url', { url: `https://e.com/${'a'.repeat(2048)}` }, 'invalid_url'],
    ['skills:draft-from-session', { messages: [] }, 'invalid_transcript'],
    ['skills:draft-from-session', { messages: new Array(501).fill({ role: 'user', content: 'x' }) }, 'invalid_transcript'],
    ['skills:run', { name: 'x', task: 7, webContentsId: 1 }, 'invalid_task'],
    ['skills:run', { name: 'x', task: 'a'.repeat(20001), webContentsId: 1 }, 'invalid_task'],
    ['skills:run', { name: 'x', webContentsId: '1' }, 'invalid_webcontents'],
    ['skills:run', { name: 'x', webContentsId: 1, sessionId: '../s_abc123' }, 'invalid_session_id'],
    ['skills:run', { name: 'x', webContentsId: 1, sessionId: 'S_ABC123' }, 'invalid_session_id'],
    ['skills:run', { name: 'x', webContentsId: 1, sessionId: 42 }, 'invalid_session_id'],
  ])('%s rejects %j', async (ch, arg, error) => {
    expect(await call(ch, arg)).toEqual({ ok: false, error });
    for (const fn of Object.values(svc)) if (fn !== svc.list) expect(fn).not.toHaveBeenCalled();
  });

  test('valid payloads delegate with normalized options', async () => {
    await call('skills:save', { skill: { markdown: 'x' }, overwrite: 'yes' });
    expect(svc.save).toHaveBeenCalledWith({ markdown: 'x' }, { overwrite: false });
    await call('skills:set-enabled', { name: 'pdf', enabled: false });
    expect(svc.setEnabled).toHaveBeenCalledWith('pdf', false);
    await call('skills:import', { source: 'codex', overwrite: true });
    expect(svc.importFrom).toHaveBeenCalledWith('codex', { overwrite: true });
    await call('skills:install-url', { url: ' https://e.com/SKILL.md ' });
    expect(svc.installFromUrl).toHaveBeenCalledWith('https://e.com/SKILL.md', { overwrite: false });
    await call('skills:draft-from-session', { messages: [{ role: 'user', content: 'x' }], hint: 9 });
    expect(svc.draftFromTranscript).toHaveBeenCalledWith([{ role: 'user', content: 'x' }], { hint: undefined });
    await call('skills:run', { name: 'pdf', webContentsId: 3 });
    expect(svc.run).toHaveBeenCalledWith({ name: 'pdf', task: undefined, webContentsId: 3 });
    await call('skills:run', { name: 'pdf', task: 'go', webContentsId: 3, sessionId: 's_abc123' });
    expect(svc.run).toHaveBeenLastCalledWith({ name: 'pdf', task: 'go', webContentsId: 3, sessionId: 's_abc123' });
    await call('skills:run', { name: 'pdf', webContentsId: 3, sessionId: null });
    expect(svc.run).toHaveBeenLastCalledWith({ name: 'pdf', task: undefined, webContentsId: 3 });
  });

  test('a thrown service error comes back as {ok:false}', async () => {
    svc.list.mockImplementation(() => { throw new Error('EACCES: permission denied'); });
    expect(await call('skills:list')).toEqual({ ok: false, error: 'EACCES: permission denied' });
  });

  test('commands:list merges built-ins with enabled skills only', async () => {
    const res = await call('commands:list');
    expect(res.ok).toBe(true);
    expect(res.commands.filter((c) => c.kind === 'skill')).toEqual([{ name: 'on-skill', description: 'enabled one', kind: 'skill' }]);
    expect(res.commands.filter((c) => c.kind === 'builtin').map((c) => c.name)).toEqual(skillHandlers.BUILTIN_COMMANDS.map((c) => c.name));
  });

  test('built-in commands cover every composer slash action', () => {
    const names = skillHandlers.BUILTIN_COMMANDS.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(SLASH_ACTIONS));
    expect(names.filter((n) => !SLASH_ACTIONS.includes(n))).toEqual(['compact']);
  });
});
