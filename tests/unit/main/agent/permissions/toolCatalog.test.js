const { CLASSES, classify, knownNames } = require('../../../../../main/agent/permissions/toolCatalog');

const BUILTIN_TOOL_MODULES = [
  'advancedTools', 'browser', 'agentCore', 'askBrowsingTool', 'cdpTools', 'cognitizers',
  'tabsTools', 'historyTool', 'projectTools', 'researchReport', 'searchTool',
];

function builtinToolNames() {
  const names = [];
  for (const mod of BUILTIN_TOOL_MODULES) {
    const tools = require(`../../../../../main/agent/tools/${mod}`);
    for (const t of tools) names.push(t.name);
  }
  return names;
}

describe('toolCatalog.classify', () => {
  test('every built-in tool registered by AgentService is mapped (none classify as unknown)', () => {
    const names = builtinToolNames();
    expect(names.length).toBeGreaterThanOrEqual(41);
    const unmapped = names.filter((n) => classify(n).cls === 'unknown');
    expect(unmapped).toEqual([]);
    for (const n of names) expect(knownNames()).toContain(n);
  });

  test('an unknown tool classifies as unknown, never click', () => {
    expect(classify('browser.teleport')).toEqual({ cls: 'unknown', tier: 2, planSafe: false });
    expect(classify('somethingelse')).toMatchObject({ cls: 'unknown', planSafe: false });
    expect(classify('browser.teleport').cls).not.toBe('click');
  });

  test('non-string and empty names classify as unknown', () => {
    for (const bad of [undefined, null, '', 42, {}, ['browser.click']]) {
      expect(classify(bad).cls).toBe('unknown');
    }
  });

  test('inherited object keys are not treated as catalog entries', () => {
    expect(classify('constructor').cls).toBe('unknown');
    expect(classify('__proto__').cls).toBe('unknown');
    expect(classify('toString').cls).toBe('unknown');
  });

  test('mcp.* is external tier 1 and not plan-safe; a bare prefix is unknown', () => {
    expect(classify('mcp.github.create_issue')).toEqual({ cls: 'external', tier: 1, planSafe: false });
    expect(classify('mcp.').cls).toBe('unknown');
  });

  test('project.* is read tier 1 and plan-safe', () => {
    expect(classify('project.search')).toEqual({ cls: 'read', tier: 1, planSafe: true });
    expect(classify('project.read_file')).toEqual({ cls: 'read', tier: 1, planSafe: true });
    expect(classify('project.future_tool')).toEqual({ cls: 'read', tier: 1, planSafe: true });
  });

  test('workspace file and shell tools', () => {
    for (const n of ['fs.list', 'fs.read', 'fs.search', 'fs.diff']) {
      expect(classify(n)).toEqual({ cls: 'read', tier: 1, planSafe: true });
    }
    expect(classify('fs.write')).toEqual({ cls: 'edit', tier: 1, planSafe: false });
    expect(classify('fs.edit')).toEqual({ cls: 'edit', tier: 1, planSafe: false });
    expect(classify('shell.run')).toEqual({ cls: 'exec', tier: 1, planSafe: false });
  });

  test('new agent and artifact tools', () => {
    expect(classify('agent.todo_write')).toMatchObject({ cls: 'meta', planSafe: true });
    expect(classify('agent.exit_plan')).toMatchObject({ cls: 'meta', planSafe: true });
    expect(classify('agent.use_skill')).toMatchObject({ cls: 'meta', planSafe: true });
    expect(classify('agent.spawn_subagent')).toMatchObject({ cls: 'delegate', planSafe: true });
    expect(classify('artifact.create')).toMatchObject({ cls: 'meta', tier: 1 });
    expect(classify('artifact.update')).toMatchObject({ cls: 'meta', tier: 1 });
  });

  test('broadcast to cognitizers is external, never auto-safe in plan mode', () => {
    expect(classify('agent.broadcast_to_cognitizers')).toMatchObject({ cls: 'external', planSafe: false });
  });

  test('screenshots are tier 3; DOM reads tier 2', () => {
    expect(classify('browser.screenshot_tabs')).toEqual({ cls: 'read', tier: 3, planSafe: true });
    expect(classify('browser.snapshot_ax').tier).toBe(2);
    expect(classify('browser.read_tab').tier).toBe(2);
  });

  test('interaction classes and plan-mode safety', () => {
    expect(classify('browser.click')).toEqual({ cls: 'click', tier: 2, planSafe: false });
    expect(classify('browser.click_idx').planSafe).toBe(false);
    expect(classify('browser.scroll')).toEqual({ cls: 'click', tier: 2, planSafe: true });
    expect(classify('browser.type_text')).toEqual({ cls: 'type', tier: 2, planSafe: false });
    expect(classify('browser.fill_form').cls).toBe('type');
    expect(classify('browser.close_tab')).toEqual({ cls: 'destructive', tier: 2, planSafe: false });
    expect(classify('browser.navigate')).toEqual({ cls: 'navigate', tier: 2, planSafe: true });
  });

  test('every classification uses a declared class and tier 1-3', () => {
    for (const n of [...knownNames(), 'mcp.a.b', 'project.x', 'nope']) {
      const c = classify(n);
      expect(CLASSES).toContain(c.cls);
      expect([1, 2, 3]).toContain(c.tier);
      expect(typeof c.planSafe).toBe('boolean');
    }
  });

  test('returned objects are fresh, so callers cannot corrupt the catalog', () => {
    const a = classify('fs.write');
    a.cls = 'read'; a.planSafe = true;
    expect(classify('fs.write')).toEqual({ cls: 'edit', tier: 1, planSafe: false });
  });
});
