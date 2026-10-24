// Skills settings page. jsdom env. Only electron ipcRenderer (the main-process
// boundary) is mocked; each test scripts the skills:* replies.

jest.mock('electron', () => ({ ipcRenderer: { invoke: jest.fn() } }));

const { ipcRenderer } = require('electron');
const { skills, importSummary } = require('../../../../../renderer/components/settings/modules/skills');

const flush = () => new Promise((r) => setTimeout(r, 0));
const SKILL = { name: 'pdf-extract', description: 'Extract PDFs', enabled: true, warnings: ['allowed-tools: "NotebookEdit" has no equivalent here and was ignored'] };

function route(replies) {
  ipcRenderer.invoke.mockImplementation(async (ch, payload) => {
    const r = replies[ch];
    if (r === undefined) throw new Error(`unexpected channel ${ch}`);
    return typeof r === 'function' ? r(payload) : r;
  });
}

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const teardown = skills({ host });
  return { host, teardown };
}

const button = (host, label) => /** @type {HTMLButtonElement} */ (host.querySelector(`button[aria-label="${label}"]`));
const list = (host) => host.querySelector('[data-role="skills-list"]');

describe('skills settings module', () => {
  beforeEach(() => { document.body.innerHTML = ''; ipcRenderer.invoke.mockReset(); });

  test('shows a loading status, then the empty state', async () => {
    let release;
    route({ 'skills:list': () => new Promise((r) => { release = r; }) });
    const { host } = mount();
    expect(host.querySelector('.sv-validation-status.is-pending').textContent).toBe('Loading skills…');
    release({ ok: true, skills: [], errors: [] });
    await flush();
    expect(host.querySelector('.is-pending')).toBeNull();
    expect(list(host).textContent).toContain('No skills installed yet');
  });

  test('a failed list renders an error row', async () => {
    route({ 'skills:list': { ok: false, error: 'EACCES' } });
    const { host } = mount();
    await flush();
    const err = list(host).querySelector('[role="alert"]');
    expect(err.textContent).toBe("Couldn't load skills: EACCES");
  });

  test('renders installed skills with warnings, broken folders and failed migrations', async () => {
    route({ 'skills:list': { ok: true, skills: [SKILL], errors: [{ dir: 'broken', error: 'missing_description' }], migration: { errors: [{ file: 'old.skill.json', error: 'bad json' }] } } });
    const { host } = mount();
    await flush();
    const row = list(host).querySelector('[data-skill="pdf-extract"]');
    expect(row.textContent).toContain('Extract PDFs');
    expect(row.querySelector('[data-role="skill-warnings"]').textContent).toContain('NotebookEdit');
    expect(/** @type {HTMLInputElement} */ (row.querySelector('input[type=checkbox]')).checked).toBe(true);
    const alerts = Array.from(list(host).querySelectorAll('[role="alert"]')).map((n) => n.textContent);
    expect(alerts).toEqual(['broken: The skill has no description.', 'Old skill old.skill.json could not be converted: bad json']);
  });

  test('the enable toggle reverts and reports when saving fails', async () => {
    route({ 'skills:list': { ok: true, skills: [SKILL] }, 'skills:set-enabled': { ok: false, error: 'not_found' } });
    const { host } = mount();
    await flush();
    const cb = /** @type {HTMLInputElement} */ (host.querySelector('input[aria-label="Enable pdf-extract"]'));
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
    await flush();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('skills:set-enabled', { name: 'pdf-extract', enabled: false });
    expect(cb.checked).toBe(true);
    expect(host.querySelector('[data-skill] .is-error').textContent).toBe('Could not update: not_found');
  });

  test('delete asks in-row first; cancel keeps the skill, confirm deletes and reloads', async () => {
    const replies = { 'skills:list': { ok: true, skills: [SKILL] }, 'skills:delete': { ok: true } };
    route(replies);
    const { host } = mount();
    await flush();
    button(host, 'Delete').click();
    expect(host.textContent).toContain('Delete "pdf-extract" and its files?');
    button(host, 'Cancel').click();
    expect(button(host, 'Delete pdf-extract')).toBeNull();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('skills:delete', expect.anything());

    button(host, 'Delete').click();
    replies['skills:list'] = { ok: true, skills: [] };
    button(host, 'Delete pdf-extract').click();
    await flush(); await flush();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('skills:delete', { name: 'pdf-extract' });
    expect(list(host).textContent).toContain('No skills installed yet');
  });

  test('install refuses a non-https link without calling main, then installs an https one', async () => {
    route({ 'skills:list': { ok: true, skills: [] }, 'skills:install-url': { ok: true, skill: { name: 'from-web' }, warnings: ['w'] } });
    const { host } = mount();
    await flush();
    const input = /** @type {HTMLInputElement} */ (host.querySelector('input[type=url]'));
    input.value = 'http://example.com/SKILL.md';
    button(host, 'Install').click();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('skills:install-url', expect.anything());
    expect(host.textContent).toContain('Only https:// links can be installed.');

    input.value = 'https://example.com/SKILL.md';
    button(host, 'Install').click();
    await flush();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('skills:install-url', { url: 'https://example.com/SKILL.md' });
    expect(host.textContent).toContain('Installed from-web (1 warning)');
    expect(input.value).toBe('');
  });

  test('import shows a per-source summary including failures', async () => {
    route({
      'skills:list': { ok: true, skills: [] },
      'skills:import': { ok: true, dir: '/h/.claude/skills', results: [
        { dir: 'a', status: 'imported' }, { dir: 'b', status: 'exists' }, { dir: 'c', status: 'error', error: 'invalid_name' },
      ] },
    });
    const { host } = mount();
    await flush();
    button(host, 'Import from Claude Code').click();
    await flush();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('skills:import', { source: 'claude' });
    expect(host.querySelector('.is-error').textContent).toMatch(/^Imported 1, 1 already installed, 1 failed \(c: The skill name must be/);
  });

  test('teardown stops a pending load from rendering', async () => {
    let release;
    route({ 'skills:list': () => new Promise((r) => { release = r; }) });
    const { host, teardown } = mount();
    teardown();
    release({ ok: true, skills: [SKILL] });
    await flush();
    expect(list(host).children).toHaveLength(0);
  });
});

describe('importSummary', () => {
  test('reports a missing source folder and an empty one', () => {
    expect(importSummary({ sourceMissing: true, dir: '/h/.codex/skills', results: [] })).toEqual({ kind: 'error', text: 'No skills folder found at /h/.codex/skills.' });
    expect(importSummary({ dir: '/h/.codex/skills', results: [] })).toEqual({ kind: 'ok', text: 'No skills found in /h/.codex/skills.' });
  });
});
