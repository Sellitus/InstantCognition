// agentPermissions settings module — rule lists, workspace folders and the
// global instructions editor against a mocked permissions/workspace/
// instructions IPC boundary: loading, error and empty states, add/remove
// round-trips, and refusals surfaced as readable text.

jest.mock('electron', () => ({
  ipcRenderer: { send: jest.fn(), on: jest.fn(), invoke: jest.fn() },
}));

const { ipcRenderer } = require('electron');
const {
  agentPermissionRules,
  agentWorkspaceRoots,
  agentGlobalInstructions,
} = require('../../../../../renderer/components/settings/modules/agentPermissions');

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

let host, teardown, routes;

function route(handlers) {
  routes = handlers;
  ipcRenderer.invoke.mockImplementation((ch, arg) => {
    const h = routes[ch];
    if (!h) return Promise.reject(new Error(`unexpected channel ${ch}`));
    return Promise.resolve().then(() => h(arg));
  });
}
const calls = (ch) => ipcRenderer.invoke.mock.calls.filter((c) => c[0] === ch).map((c) => c[1]);
const mount = (render) => { teardown = render({ host, configBridge: {} }); };
const section = (list) => host.querySelector(`.sv-perm-list[data-list="${list}"]`);
const statusOf = (scope) => scope.querySelector('.sv-validation-status');

beforeEach(() => {
  ipcRenderer.invoke.mockReset();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => { if (teardown) teardown(); teardown = null; });

describe('agentPermissionRules()', () => {
  let rules;
  beforeEach(() => {
    rules = { allow: ['shell.run:git status'], ask: [], deny: ['fs.write:.env'] };
    route({
      'permissions:get': () => ({ ok: true, mode: 'ask', effectiveMode: 'ask', sessionModes: {}, rules }),
      'permissions:add-rule': ({ list, rule }) => { rules = { ...rules, [list]: [...rules[list], rule] }; return { ok: true, rules }; },
      'permissions:remove-rule': ({ list, rule }) => { rules = { ...rules, [list]: rules[list].filter((r) => r !== rule) }; return { ok: true, rules }; },
    });
  });

  test('shows a loading row, then deny/ask/allow lists in that order', async () => {
    mount(agentPermissionRules);
    expect(host.querySelector('.sv-perm-rules [role="status"]').textContent).toBe('Loading…');
    await flush();
    expect([...host.querySelectorAll('.sv-perm-list')].map((s) => s.dataset.list)).toEqual(['deny', 'ask', 'allow']);
    expect(section('allow').querySelector('.sv-perm-rule').textContent).toBe('shell.run:git status');
    expect(section('deny').querySelector('.sv-perm-rule').textContent).toBe('fs.write:.env');
    expect(section('ask').querySelector('.sv-perm-items').textContent).toBe('None.');
  });

  test('a load failure shows an error row instead of the lists', async () => {
    route({ 'permissions:get': () => ({ ok: false, error: 'config_unavailable' }) });
    mount(agentPermissionRules);
    await flush();
    const err = host.querySelector('.sv-empty-row--error');
    expect(err.textContent).toBe("Couldn't load the permission rules: config_unavailable");
    expect(err.getAttribute('role')).toBe('alert');
    expect(host.querySelector('.sv-perm-list')).toBeNull();
  });

  test('adding a rule sends it to main and shows the reloaded list', async () => {
    mount(agentPermissionRules);
    await flush();
    const input = section('ask').querySelector('input');
    input.value = '  shell.run:npm *  ';
    section('ask').querySelector('button[aria-label="Add ask rule"]').click();
    await flush();
    expect(calls('permissions:add-rule')).toEqual([{ list: 'ask', rule: 'shell.run:npm *' }]);
    expect(section('ask').querySelector('.sv-perm-rule').textContent).toBe('shell.run:npm *');
  });

  test('Enter in the field submits the rule', async () => {
    mount(agentPermissionRules);
    await flush();
    const input = section('allow').querySelector('input');
    input.value = 'mcp.github.*';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(calls('permissions:add-rule')).toEqual([{ list: 'allow', rule: 'mcp.github.*' }]);
  });

  test('a rule main refuses shows the reason and keeps the typed text', async () => {
    routes['permissions:add-rule'] = () => ({ ok: false, error: 'invalid_rule:tool_part' });
    mount(agentPermissionRules);
    await flush();
    const sec = section('deny');
    const input = sec.querySelector('input');
    input.value = 'not a tool!';
    sec.querySelector('button[aria-label="Add deny rule"]').click();
    await flush();
    expect(statusOf(sec).textContent).toBe('Not added: The tool part is not valid. Use a tool name or glob such as fs.write or mcp.github.*.');
    expect(statusOf(sec).classList.contains('is-error')).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.value).toBe('not a tool!');
    expect(sec.querySelector('button[aria-label="Add deny rule"]').disabled).toBe(false);
    expect(calls('permissions:get')).toHaveLength(1);
  });

  test('an empty rule is refused locally without IPC', async () => {
    mount(agentPermissionRules);
    await flush();
    const sec = section('allow');
    sec.querySelector('input').value = '   ';
    sec.querySelector('button[aria-label="Add allow rule"]').click();
    await flush();
    expect(calls('permissions:add-rule')).toHaveLength(0);
    expect(statusOf(sec).textContent).toBe('Enter a rule first.');
  });

  test('Remove deletes the rule from its list', async () => {
    mount(agentPermissionRules);
    await flush();
    section('deny').querySelector('button[aria-label="Remove deny rule fs.write:.env"]').click();
    await flush();
    expect(calls('permissions:remove-rule')).toEqual([{ list: 'deny', rule: 'fs.write:.env' }]);
    expect(section('deny').querySelector('.sv-perm-rule')).toBeNull();
  });

  test('a failed remove re-enables the button and says why', async () => {
    routes['permissions:remove-rule'] = () => ({ ok: false, error: 'write_failed' });
    mount(agentPermissionRules);
    await flush();
    const btn = section('allow').querySelector('button[aria-label^="Remove allow rule"]');
    btn.click();
    await flush();
    expect(btn.disabled).toBe(false);
    expect(statusOf(section('allow')).textContent).toBe("Couldn't remove shell.run:git status: write_failed");
  });
});

describe('agentWorkspaceRoots()', () => {
  let roots;
  beforeEach(() => {
    roots = ['/Users/me/proj'];
    route({
      'workspace:list-roots': () => ({ ok: true, roots }),
      'workspace:add-root': () => { roots = [...roots, '/Users/me/other']; return { ok: true, path: '/Users/me/other', roots }; },
      'workspace:remove-root': ({ index }) => { roots = roots.filter((_, i) => i !== index); return { ok: true, roots }; },
    });
  });
  const listed = () => [...host.querySelectorAll('.sv-workspace-root')].map((n) => n.textContent);
  const addBtn = () => host.querySelector('button[aria-label="Add folder"]');

  test('lists the folders, and says so when there are none', async () => {
    mount(agentWorkspaceRoots);
    await flush();
    expect(listed()).toEqual(['/Users/me/proj']);
    teardown();
    host.innerHTML = '';
    roots = [];
    mount(agentWorkspaceRoots);
    await flush();
    expect(host.querySelector('.sv-workspace-roots').textContent).toMatch(/No workspace folders/);
  });

  test('Add folder appends the chosen folder', async () => {
    mount(agentWorkspaceRoots);
    await flush();
    addBtn().click();
    await flush();
    expect(calls('workspace:add-root')).toEqual([{}]);
    expect(listed()).toEqual(['/Users/me/proj', '/Users/me/other']);
    expect(host.querySelector('.sv-validation-status').textContent).toBe('Added /Users/me/other');
    expect(addBtn().disabled).toBe(false);
  });

  test('a canceled picker changes nothing and leaves no message', async () => {
    routes['workspace:add-root'] = () => ({ ok: false, canceled: true });
    mount(agentWorkspaceRoots);
    await flush();
    addBtn().click();
    await flush();
    expect(listed()).toEqual(['/Users/me/proj']);
    expect(host.querySelector('.sv-validation-status').textContent).toBe('');
  });

  test('a refused folder names the path and the reason', async () => {
    routes['workspace:add-root'] = () => ({ ok: false, error: 'root_contains_home', path: '/Users/me' });
    mount(agentWorkspaceRoots);
    await flush();
    addBtn().click();
    await flush();
    const status = host.querySelector('.sv-validation-status');
    expect(status.textContent).toBe('Not added (/Users/me): Your home folder (or a folder that contains it) cannot be a workspace. Pick a project folder.');
    expect(status.getAttribute('role')).toBe('alert');
    expect(listed()).toEqual(['/Users/me/proj']);
  });

  test('Remove sends the index and shows the remaining folders', async () => {
    mount(agentWorkspaceRoots);
    await flush();
    host.querySelector('button[aria-label="Remove workspace folder /Users/me/proj"]').click();
    await flush();
    expect(calls('workspace:remove-root')).toEqual([{ index: 0 }]);
    expect(listed()).toEqual([]);
  });

  test('a load failure shows an error row', async () => {
    route({ 'workspace:list-roots': () => { throw new Error('ipc down'); } });
    mount(agentWorkspaceRoots);
    await flush();
    expect(host.querySelector('.sv-empty-row--error').textContent).toBe("Couldn't load the workspace folders: ipc down");
  });
});

describe('agentGlobalInstructions()', () => {
  beforeEach(() => {
    route({
      'instructions:get-global': () => ({ ok: true, content: 'Be terse.', truncated: false, path: '/x/INSTRUCTIONS.md', maxBytes: 20 }),
      'instructions:set-global': () => ({ ok: true }),
    });
  });
  const area = () => host.querySelector('textarea.sv-instructions');
  const save = () => host.querySelector('button[aria-label="Save instructions"]');
  const type = (text) => { area().value = text; area().dispatchEvent(new Event('input')); };

  test('loads the file into an editor that starts disabled', async () => {
    mount(agentGlobalInstructions);
    expect(area().disabled).toBe(true);
    expect(save().disabled).toBe(true);
    await flush();
    expect(area().disabled).toBe(false);
    expect(area().value).toBe('Be terse.');
    expect(host.textContent).toContain('9 of 20 bytes');
  });

  test('Save sends the content and confirms', async () => {
    mount(agentGlobalInstructions);
    await flush();
    type('Cite sources.');
    save().click();
    await flush();
    expect(calls('instructions:set-global')).toEqual([{ content: 'Cite sources.' }]);
    expect(host.querySelector('.sv-validation-status').textContent).toBe('Saved.');
  });

  test('over the byte limit (multi-byte counted) disables Save', async () => {
    mount(agentGlobalInstructions);
    await flush();
    type('ééééééééééé');
    expect(host.textContent).toContain('22 of 20 bytes');
    expect(save().disabled).toBe(true);
    expect(area().getAttribute('aria-invalid')).toBe('true');
    type('short');
    expect(save().disabled).toBe(false);
    expect(area().hasAttribute('aria-invalid')).toBe(false);
  });

  test('a refused save says why', async () => {
    routes['instructions:set-global'] = () => ({ ok: false, error: 'too_large' });
    mount(agentGlobalInstructions);
    await flush();
    save().click();
    await flush();
    expect(host.querySelector('.sv-validation-status').textContent).toBe('Not saved: The instructions are larger than the size limit.');
    expect(save().disabled).toBe(false);
  });

  test('a truncated file warns that only part is used', async () => {
    routes['instructions:get-global'] = () => ({ ok: true, content: 'x'.repeat(20), truncated: true, maxBytes: 20 });
    mount(agentGlobalInstructions);
    await flush();
    expect(host.querySelector('.sv-validation-status').textContent).toMatch(/larger than 20 bytes; only the first part/);
  });

  test('disabled instructions show a notice while the editor stays usable', async () => {
    routes['instructions:get-global'] = () => ({ ok: true, content: 'Be terse.', truncated: false, maxBytes: 20, enabled: false });
    mount(agentGlobalInstructions);
    await flush();
    const notice = host.querySelector('.sv-instructions-off');
    expect(notice.textContent).toMatch(/turned off.*not sent to the agent/);
    expect(notice.getAttribute('role')).toBe('note');
    expect(area().disabled).toBe(false);
  });

  test('enabled instructions show no notice', async () => {
    routes['instructions:get-global'] = () => ({ ok: true, content: '', truncated: false, maxBytes: 20, enabled: true });
    mount(agentGlobalInstructions);
    await flush();
    expect(host.querySelector('.sv-instructions-off')).toBeNull();
  });

  test('an unreadable instructions file says why', async () => {
    route({ 'instructions:get-global': () => ({ ok: false, error: 'not_a_regular_file' }) });
    mount(agentGlobalInstructions);
    await flush();
    expect(host.querySelector('.sv-empty-row--error').textContent).toBe("Couldn't load the instructions: The instructions path is not a regular file.");
  });

  test('a load failure shows an error and keeps the editor locked', async () => {
    route({ 'instructions:get-global': () => ({ ok: false, error: 'read_failed' }) });
    mount(agentGlobalInstructions);
    await flush();
    expect(host.querySelector('.sv-empty-row--error').textContent).toBe("Couldn't load the instructions: read_failed");
    expect(area().disabled).toBe(true);
    expect(save().disabled).toBe(true);
    expect(calls('instructions:set-global')).toHaveLength(0);
  });
});
