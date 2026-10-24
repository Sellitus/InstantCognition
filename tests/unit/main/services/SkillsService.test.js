const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { SkillsService } = require('../../../../main/services/SkillsService');
const { QualityModeService, MODES } = require('../../../../main/services/QualityModeService');
const { decide } = require('../../../../main/agent/permissions/permissionEngine');
const { compileList } = require('../../../../main/agent/permissions/ruleMatch');

function makeDir(prefix = 'skills-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function mockAgent() {
  return { startTask: jest.fn(async (args) => ({ ok: true, args })) };
}

function mockConfig(skills) {
  return { get: jest.fn((key, fb) => (key === 'settings.llm.agent.skills' ? skills : fb)), set: jest.fn() };
}

function makeService(extra = {}) {
  const baseDir = makeDir();
  const svc = new SkillsService();
  const agent = mockAgent();
  const configService = mockConfig({ autoTrigger: true, matchThreshold: 0.35 });
  svc.bind({ agentService: agent, configService, baseDir, homeDir: makeDir('skills-home-'), ...extra });
  return { svc, agent, baseDir, configService };
}

const skillMd = (name, description, extraFm = '') => `---\nname: ${name}\ndescription: ${description}\n${extraFm}---\n\nSteps for ${name}.\n`;

function writeExternal(root, dir, content, files = {}) {
  const d = path.join(root, dir);
  fs.mkdirSync(d, { recursive: true });
  if (content !== null) fs.writeFileSync(path.join(d, 'SKILL.md'), content);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), body);
  }
  return d;
}

describe('SkillsService store', () => {
  test('save + list + get round-trips a skill as <name>/SKILL.md', () => {
    const { svc, baseDir } = makeService();
    const res = svc.save({ name: 'my-skill', description: 'do the thing', body: 'Step 1', allowedTools: ['Read'] });
    expect(res).toMatchObject({ ok: true, skill: { name: 'my-skill', body: 'Step 1', tools: ['fs.read'], enabled: true } });
    expect(fs.readFileSync(path.join(baseDir, 'my-skill', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: my-skill\n/);
    expect(svc.list().skills.map((s) => s.name)).toEqual(['my-skill']);
    expect(svc.get('my-skill')).toMatchObject({ ok: true, skill: { description: 'do the thing' } });
  });

  test('save from raw markdown, and refuses to clobber an existing skill unless overwrite', () => {
    const { svc } = makeService();
    expect(svc.save({ markdown: skillMd('alpha', 'first') }).ok).toBe(true);
    expect(svc.save({ markdown: skillMd('alpha', 'second') })).toEqual({ ok: false, error: 'exists' });
    expect(svc.get('alpha')).toMatchObject({ skill: { description: 'first' } });
    expect(svc.save({ markdown: skillMd('alpha', 'second') }, { overwrite: true }).ok).toBe(true);
    expect(svc.get('alpha')).toMatchObject({ skill: { description: 'second' } });
  });

  test('save rejects invalid skills without writing', () => {
    const { svc, baseDir } = makeService();
    expect(svc.save({ description: 'no name' })).toEqual({ ok: false, error: 'invalid_name' });
    expect(svc.save({ name: '../x', description: 'd' })).toEqual({ ok: false, error: 'invalid_name' });
    expect(svc.save({ name: 'ok', description: '' })).toEqual({ ok: false, error: 'missing_description' });
    expect(svc.save({ markdown: '# no frontmatter' })).toEqual({ ok: false, error: 'missing_frontmatter' });
    expect(fs.readdirSync(baseDir).filter((f) => !f.startsWith('.'))).toEqual([]);
  });

  test('delete removes the skill folder and rejects bad names', () => {
    const { svc, baseDir } = makeService();
    svc.save({ name: 'doomed', description: 'x' });
    expect(svc.delete('doomed')).toEqual({ ok: true });
    expect(fs.existsSync(path.join(baseDir, 'doomed'))).toBe(false);
    expect(svc.delete('doomed')).toEqual({ ok: false, error: 'not_found' });
    expect(svc.delete('../etc')).toEqual({ ok: false, error: 'invalid_name' });
  });

  test('list reports a broken skill folder instead of hiding or throwing', () => {
    const { svc, baseDir } = makeService();
    writeExternal(baseDir, 'broken', '---\nname: broken\n---\nno description');
    writeExternal(baseDir, 'renamed', skillMd('other-name', 'mismatch'));
    svc.save({ name: 'good', description: 'fine' });
    const res = svc.list();
    expect(res.skills.map((s) => s.name)).toEqual(['good']);
    expect(res.errors).toEqual(expect.arrayContaining([
      { dir: 'broken', error: 'missing_description' },
      { dir: 'renamed', error: 'name_mismatch:other-name' },
    ]));
  });

  test('setEnabled persists outside SKILL.md and is reflected in list/get', () => {
    const { svc, baseDir } = makeService();
    svc.save({ name: 'toggle-me', description: 'x' });
    const before = fs.readFileSync(path.join(baseDir, 'toggle-me', 'SKILL.md'), 'utf8');
    expect(svc.setEnabled('toggle-me', false)).toEqual({ ok: true, name: 'toggle-me', enabled: false });
    expect(svc.list().skills[0].enabled).toBe(false);
    expect(fs.readFileSync(path.join(baseDir, 'toggle-me', 'SKILL.md'), 'utf8')).toBe(before);
    expect(svc.setEnabled('missing', true)).toEqual({ ok: false, error: 'not_found' });
  });

  test('an unbound service fails loudly', () => {
    expect(() => new SkillsService().list()).toThrow('skills_not_bound');
  });
});

describe('SkillsService legacy migration', () => {
  test('converts *.skill.json once and is idempotent', () => {
    const baseDir = makeDir();
    fs.writeFileSync(path.join(baseDir, 'explore.skill.json'), JSON.stringify({
      name: 'Explore', description: 'explore {{topic}}', startUrl: 'https://example.com', qualityMode: 'ultra',
      toolsAllowlist: ['browser.navigate'], inputs: [{ name: 'topic', required: true }],
    }));
    fs.writeFileSync(path.join(baseDir, 'broken.skill.json'), '{not json');
    const svc = new SkillsService();
    svc.bind({ agentService: mockAgent(), baseDir, homeDir: baseDir });
    const first = svc.list();
    expect(first.migration.migrated).toEqual([{ file: 'explore.skill.json', name: 'explore', existed: false }]);
    expect(first.migration.errors).toEqual([{ file: 'broken.skill.json', error: expect.any(String) }]);
    expect(svc.get('explore')).toMatchObject({ ok: true, skill: { tools: ['browser.navigate'], extra: { 'quality-mode': 'ultra' } } });
    expect(svc.get('explore').skill.body).toContain('Start at https://example.com.');
    expect(fs.existsSync(path.join(baseDir, 'explore.skill.json.migrated'))).toBe(true);

    const again = new SkillsService();
    again.bind({ agentService: mockAgent(), baseDir, homeDir: baseDir });
    const second = again.list();
    expect(second.migration.migrated).toEqual([]);
    expect(second.skills.map((s) => s.name)).toEqual(['explore']);
    expect(second.migration.errors).toHaveLength(1);
  });
});

describe('SkillsService import from Claude Code / Codex', () => {
  test('copy-imports valid skills with resources, skips nested symlinks, reports per-skill results', () => {
    const home = makeDir('skills-home-');
    const root = path.join(home, '.claude', 'skills');
    const secret = path.join(makeDir('skills-secret-'), 'id_rsa');
    fs.writeFileSync(secret, 'PRIVATE');
    const src = writeExternal(root, 'pdf', skillMd('pdf-extract', 'Extract PDFs', 'allowed-tools: Read, NotebookEdit\n'), { 'scripts/run.py': 'print(1)' });
    fs.symlinkSync(secret, path.join(src, 'leak'));
    writeExternal(root, 'bad', '---\nname: ../x\ndescription: d\n---\n');
    writeExternal(root, 'nofile', null);
    const { svc, baseDir } = makeService({ homeDir: home });

    const res = svc.importFrom('claude');
    expect(res.ok).toBe(true);
    const byDir = Object.fromEntries(res.results.map((r) => [r.dir, r]));
    expect(byDir.pdf).toMatchObject({ ok: true, status: 'imported', name: 'pdf-extract' });
    expect(byDir.pdf.warnings).toEqual(expect.arrayContaining([expect.stringContaining('NotebookEdit'), 'Skipped symbolic link leak']));
    expect(byDir.bad).toMatchObject({ ok: false, status: 'error', error: 'invalid_name' });
    expect(byDir.nofile).toMatchObject({ ok: false, status: 'error', error: 'missing_skill_md' });
    expect(fs.readFileSync(path.join(baseDir, 'pdf-extract', 'scripts', 'run.py'), 'utf8')).toBe('print(1)');
    expect(fs.existsSync(path.join(baseDir, 'pdf-extract', 'leak'))).toBe(false);
    expect(fs.existsSync(path.join(src, 'SKILL.md'))).toBe(true);

    const second = svc.importFrom('claude');
    expect(second.results.find((r) => r.dir === 'pdf')).toMatchObject({ ok: false, status: 'exists' });
  });

  test('a missing source folder is reported, an unknown source rejected', () => {
    const { svc } = makeService();
    expect(svc.importFrom('codex')).toMatchObject({ ok: true, sourceMissing: true, results: [] });
    expect(svc.importFrom(/** @type {any} */ ('../../etc'))).toEqual({ ok: false, error: 'invalid_source' });
  });
});

describe('SkillsService allowed-tools narrowing', () => {
  test('narrows the offered tools but never bypasses the permission engine', () => {
    const { svc, configService } = makeService();
    svc.save({ name: 'git-helper', description: 'git things', allowedTools: ['Bash(git:*)', 'Read'] });
    const skill = svc.use('git-helper');
    if (skill.ok !== true) throw new Error('fixture failed');
    const filter = /** @type {(n: string) => boolean} */ (svc.toolFilterFor(skill.skill));
    expect(['shell.run', 'fs.read', 'fs.write', 'agent.done'].filter(filter)).toEqual(['shell.run', 'fs.read', 'agent.done']);

    const rules = { allow: compileList([]), ask: compileList([]), deny: compileList([]) };
    const shell = decide({ name: 'shell.run', args: { argv: ['git', 'push'] } }, { mode: 'ask', rules, allowedTools: filter });
    expect(shell.verdict).toBe('ask');
    const write = decide({ name: 'fs.write', args: { path: 'a.txt' } }, { mode: 'bypass', rules, allowedTools: filter });
    expect(write).toMatchObject({ verdict: 'deny', reason: 'tool_not_available' });
    expect(configService.set).not.toHaveBeenCalled();
  });

  test('a skill without allowed-tools does not restrict tools', () => {
    const { svc } = makeService();
    svc.save({ name: 'free', description: 'x' });
    const res = svc.use('free');
    expect(res.ok === true && svc.toolFilterFor(res.skill)).toBeNull();
  });

  test('a disabled skill cannot be used', () => {
    const { svc } = makeService();
    svc.save({ name: 'off', description: 'x' });
    svc.setEnabled('off', false);
    expect(svc.use('off')).toEqual({ ok: false, error: 'skill_disabled' });
  });
});

describe('SkillsService run / match / install / draft', () => {
  test('run forwards to agentService.startTask with the skill body, quality override and allowed tools', async () => {
    const { svc, agent } = makeService();
    svc.save({ name: 'explore', description: 'explore things', body: 'Look around.', allowedTools: ['WebSearch'], extra: { 'quality-mode': 'ultra' } });
    const res = await svc.run({ name: 'explore', task: 'quantum cats', webContentsId: 1 });
    expect(res.ok).toBe(true);
    const call = agent.startTask.mock.calls[0][0];
    expect(call.description).toContain('Look around.');
    expect(call.description).toContain('Task: quantum cats');
    expect(call.qualitySkillOverride).toEqual({
      judges: { policy: 'all_mutating' }, shadowFork: { policy: 'every_decision' }, draftVerify: { verify: 'every_step' },
    });
    expect(call.allowedTools).toEqual(['browser.web_search']);
    expect(call.webContentsId).toBe(1);
  });

  test('a skill quality override may only tighten the active mode', async () => {
    const { svc, agent } = makeService();
    svc.save({
      name: 'loosen', description: 'tries to loosen', body: 'Go.',
      extra: { 'quality-override': { judges: { policy: 'payment_auth' }, budget: { maxSteps: 5, maxTokens: 0 }, sampling: { bestOf: 50 } } },
    });
    await svc.run({ name: 'loosen', webContentsId: 1 });
    const override = agent.startTask.mock.calls[0][0].qualitySkillOverride;
    expect(override).toEqual({ budget: { maxSteps: 5 } });
    const applied = new QualityModeService().resolve(override);
    expect(applied.judges.policy).toBe('destructive');
    expect(applied.budget).toEqual({ ...MODES.balanced.budget, maxSteps: 5 });
    expect(applied.sampling.bestOf).toBe(MODES.balanced.sampling.bestOf);
  });

  test('tightening is measured against the configured mode', async () => {
    const qualityMode = new QualityModeService();
    qualityMode.bindConfig({ get: (k, d) => (k === 'settings.llm.agent' ? { qualityMode: 'efficient' } : d) });
    const { svc, agent } = makeService({ qualityMode });
    svc.save({ name: 'steps', description: 'steps', body: 'Go.', extra: { 'quality-override': { budget: { maxSteps: 20 } } } });
    await svc.run({ name: 'steps', webContentsId: 1 });
    expect(agent.startTask.mock.calls[0][0].qualitySkillOverride).toBeNull();
  });

  test('an unknown quality-mode is ignored; a known one applies only where it is stricter', async () => {
    const { svc, agent } = makeService();
    svc.save({ name: 'turbo', description: 'turbo', body: 'Go.', extra: { 'quality-mode': 'turbo' } });
    svc.save({ name: 'eff', description: 'eff', body: 'Go.', extra: { 'quality-mode': 'efficient', 'quality-override': { judges: { policy: 'all_mutating' } } } });
    await svc.run({ name: 'turbo', webContentsId: 1 });
    await svc.run({ name: 'eff', webContentsId: 1 });
    expect(agent.startTask.mock.calls[0][0].qualitySkillOverride).toBeNull();
    const override = agent.startTask.mock.calls[1][0].qualitySkillOverride;
    expect(override).toEqual({ budget: { ...MODES.efficient.budget }, judges: { policy: 'all_mutating' } });
    expect(override).not.toHaveProperty('name');
    const applied = new QualityModeService().resolve(override);
    expect(applied.name).toBe('balanced');
    expect(applied.shadowFork).toEqual(MODES.balanced.shadowFork);
  });

  test('a looser quality-mode never relabels or loosens the active mode', async () => {
    const qualityMode = new QualityModeService();
    qualityMode.bindConfig({ get: (k, d) => (k === 'settings.llm.agent' ? { qualityMode: 'ultra' } : d) });
    const { svc, agent } = makeService({ qualityMode });
    svc.save({ name: 'cheap', description: 'cheap', body: 'Go.', extra: { 'quality-mode': 'efficient', 'quality-override': { budget: { maxSteps: 500 } } } });
    await svc.run({ name: 'cheap', webContentsId: 1 });
    const override = agent.startTask.mock.calls[0][0].qualitySkillOverride;
    expect(override).toEqual({ budget: { maxSteps: 12, maxTokens: 150000, maxSeconds: 600, maxNavigations: 10 } });
    const applied = qualityMode.resolve(override);
    expect(applied.name).toBe('ultra');
    expect(applied.judges.policy).toBe('all_mutating');
  });

  test('run in a session sends /<name> <task> as the turn and the skill body as instructions', async () => {
    const { svc, agent } = makeService();
    svc.save({ name: 'explore', description: 'explore things', body: 'Look around.', allowedTools: ['WebSearch'] });
    await svc.run({ name: 'explore', task: ' quantum cats ', webContentsId: 1, sessionId: 's_abc123' });
    const call = agent.startTask.mock.calls[0][0];
    expect(call).toMatchObject({ sessionId: 's_abc123', description: '/explore quantum cats', webContentsId: 1, allowedTools: ['browser.web_search'] });
    expect(call.instructions).toContain('Follow the "explore" skill.');
    expect(call.instructions).toContain('Look around.');
    await svc.run({ name: 'explore', webContentsId: 1, sessionId: 's_abc123' });
    expect(agent.startTask.mock.calls[1][0].description).toBe('/explore');
  });

  test('run without a session keeps the whole skill prompt as the task and no instructions', async () => {
    const { svc, agent } = makeService();
    svc.save({ name: 'explore', description: 'explore things', body: 'Look around.' });
    await svc.run({ name: 'explore', task: 'quantum cats', webContentsId: 1 });
    const call = agent.startTask.mock.calls[0][0];
    expect(call.description).toBe('Follow the "explore" skill.\n\nLook around.\n\nTask: quantum cats');
    expect(call).not.toHaveProperty('sessionId');
    expect(call).not.toHaveProperty('instructions');
  });

  test('run on a missing skill returns an error and starts nothing', async () => {
    const { svc, agent } = makeService();
    expect(await svc.run({ name: 'missing', webContentsId: 1 })).toEqual({ ok: false, error: 'not_found' });
    expect(agent.startTask).not.toHaveBeenCalled();
  });

  test('match returns enabled skills only, and nothing when autoTrigger is off', () => {
    const { svc } = makeService();
    svc.save({ name: 'git-commit-msg', description: 'Write a conventional git commit message from the staged diff' });
    svc.save({ name: 'travel-plan', description: 'Plan a trip itinerary with flights and hotels' });
    expect(svc.match('write a commit message for the staged diff').map((m) => m.name)).toEqual(['git-commit-msg']);
    svc.setEnabled('git-commit-msg', false);
    expect(svc.match('write a commit message for the staged diff')).toEqual([]);

    const off = makeService({ configService: mockConfig({ autoTrigger: false, matchThreshold: 0.35 }) });
    off.svc.save({ name: 'travel-plan', description: 'Plan a trip itinerary with flights and hotels' });
    expect(off.svc.match('plan a trip with flights and hotels')).toEqual([]);
  });

  test('installFromUrl writes the fetched skill; an http: URL writes nothing', async () => {
    const { svc, baseDir } = makeService();
    const mockGet = jest.fn((_url, _opts, cb) => {
      const req = Object.assign(new EventEmitter(), { setTimeout: jest.fn(), destroy: jest.fn() });
      const res = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
      setImmediate(() => { cb(res); res.end(skillMd('from-web', 'downloaded')); });
      return req;
    });
    expect(await svc.installFromUrl('http://example.com/SKILL.md', { get: mockGet })).toEqual({ ok: false, error: 'https_only' });
    const res = await svc.installFromUrl('https://example.com/SKILL.md', { get: mockGet });
    expect(res).toMatchObject({ ok: true, url: 'https://example.com/SKILL.md', skill: { name: 'from-web' } });
    expect(fs.existsSync(path.join(baseDir, 'from-web', 'SKILL.md'))).toBe(true);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  test('draftFromTranscript drafts without saving; a model failure is an error', async () => {
    const mockLlm = { chatCompletionJson: jest.fn(async () => ({ ok: true, value: { name: 'flight-finder', description: 'Find flights', instructions: '1. Search' } })) };
    const { svc, baseDir } = makeService({ llm: mockLlm });
    const res = await svc.draftFromTranscript([{ role: 'user', content: 'find flights' }]);
    expect(res).toMatchObject({ ok: true, skill: { name: 'flight-finder' } });
    expect(fs.existsSync(path.join(baseDir, 'flight-finder'))).toBe(false);

    mockLlm.chatCompletionJson.mockResolvedValueOnce({ ok: false, error: 'schema_mismatch' });
    expect(await svc.draftFromTranscript([{ role: 'user', content: 'x' }])).toEqual({ ok: false, error: 'draft_failed: schema_mismatch' });
  });
});
