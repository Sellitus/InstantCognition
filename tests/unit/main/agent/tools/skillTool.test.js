const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRegistry } = require('../../../../../main/agent/toolRegistry');
const { createUseSkillTool, registerSkillTools } = require('../../../../../main/agent/tools/skillTool');
const { SkillsService } = require('../../../../../main/services/SkillsService');

function makeSkills() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilltool-'));
  const svc = new SkillsService();
  svc.bind({ agentService: { startTask: jest.fn() }, baseDir, homeDir: baseDir });
  svc.save({ name: 'git-helper', description: 'git things', body: 'Run git status first.', allowedTools: ['Bash(git:*)', 'Read', 'NotebookEdit'] });
  svc.save({ name: 'free', description: 'anything goes', body: 'Do it.' });
  return svc;
}

const TOOL_NAMES = ['fs.read', 'fs.write', 'shell.run', 'browser.click', 'agent.done', 'agent.use_skill'];

describe('agent.use_skill', () => {
  test('returns the instructions and narrows tools to the skill\'s allowed-tools plus meta tools', async () => {
    const tool = createUseSkillTool({ skillsService: makeSkills(), listToolNames: () => TOOL_NAMES });
    const res = await tool.handler({ name: 'git-helper' }, {}, {});
    expect(res).toMatchObject({ ok: true, skill: 'git-helper', instructions: 'Run git status first.' });
    expect(res.tools).toEqual(['fs.read', 'shell.run', 'agent.done', 'agent.use_skill']);
    expect(res.warnings).toEqual([expect.stringContaining('NotebookEdit')]);
  });

  test('never widens past the run\'s current tool filter', async () => {
    const tool = createUseSkillTool({ skillsService: makeSkills(), listToolNames: () => TOOL_NAMES });
    const toolFilter = jest.fn((n) => n !== 'shell.run');
    const res = await tool.handler({ name: 'git-helper' }, {}, { toolFilter });
    expect(res.tools).toEqual(['fs.read', 'agent.done', 'agent.use_skill']);
    expect(toolFilter).toHaveBeenCalledWith('shell.run', null);
  });

  test('a skill without allowed-tools returns tools: null (no restriction)', async () => {
    const tool = createUseSkillTool({ skillsService: makeSkills(), listToolNames: () => TOOL_NAMES });
    expect(await tool.handler({ name: 'free' }, {}, {})).toMatchObject({ ok: true, tools: null });
  });

  test('rejects bad names, unknown and disabled skills', async () => {
    const svc = makeSkills();
    const tool = createUseSkillTool({ skillsService: svc, listToolNames: () => TOOL_NAMES });
    expect(await tool.handler({ name: '../x' }, {}, {})).toEqual({ ok: false, error: 'invalid_skill_name' });
    expect(await tool.handler({}, {}, {})).toEqual({ ok: false, error: 'invalid_skill_name' });
    expect(await tool.handler({ name: 'missing' }, {}, {})).toEqual({ ok: false, error: 'not_found' });
    svc.setEnabled('free', false);
    expect(await tool.handler({ name: 'free' }, {}, {})).toEqual({ ok: false, error: 'skill_disabled' });
  });
});

describe('registerSkillTools', () => {
  test('registers agent.use_skill on a real registry, listing registered tools through it', async () => {
    const registry = createRegistry();
    registry.register({ name: 'fs.read', handler: async () => ({ ok: true }) });
    registry.register({ name: 'fs.write', handler: async () => ({ ok: true }) });
    registerSkillTools(registry, { skillsService: makeSkills() });
    expect(registry.has('agent.use_skill')).toBe(true);
    const res = await registry.invoke('agent.use_skill', { name: 'git-helper' }, {}, {});
    expect([...res.tools].sort()).toEqual(['agent.use_skill', 'fs.read']);
    expect(await registry.invoke('agent.use_skill', {}, {}, {})).toMatchObject({ ok: false, error: 'invalid_args' });
  });

  test('throws without a skills service', () => {
    expect(() => registerSkillTools(createRegistry(), /** @type {any} */ ({}))).toThrow('skillsService required');
  });
});
