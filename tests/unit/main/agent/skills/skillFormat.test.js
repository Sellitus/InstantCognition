const {
  parseSkill, serializeSkill, mapAllowedTools, splitToolList, toolNamePredicate, slugifyName, MAX_SKILL_BYTES,
} = require('../../../../../main/agent/skills/skillFormat');

const md = (fm, body = '# Steps\n\n1. Do it') => `---\n${fm}\n---\n\n${body}\n`;

describe('skillFormat.parseSkill', () => {
  test('parses frontmatter fields, body, and keeps unknown keys in extra', () => {
    const res = parseSkill(md('name: pdf-extract\ndescription: "Extract: tables from PDFs"\nwhen: the user mentions a PDF\ntriggers: [pdf table, extract pdf]\nlicense: MIT'));
    expect(res.ok).toBe(true);
    if (res.ok !== true) return;
    expect(res.skill).toMatchObject({
      name: 'pdf-extract',
      description: 'Extract: tables from PDFs',
      when: 'the user mentions a PDF',
      triggers: ['pdf table', 'extract pdf'],
      body: '# Steps\n\n1. Do it',
      allowedTools: null,
      tools: null,
      extra: { license: 'MIT' },
    });
    expect(res.warnings).toEqual([]);
  });

  test('accepts CRLF line endings', () => {
    const res = parseSkill('---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n');
    expect(res).toMatchObject({ ok: true, skill: { name: 'a', body: 'body' } });
  });

  test.each([
    ['../x', 'invalid_name'],
    ['Has Caps', 'invalid_name'],
    ['a'.repeat(65), 'invalid_name'],
  ])('rejects name %j', (name, error) => {
    expect(parseSkill(md(`name: "${name}"\ndescription: d`))).toEqual({ ok: false, error });
  });

  test('rejects a file without frontmatter, a missing description and invalid YAML', () => {
    expect(parseSkill('# just markdown')).toEqual({ ok: false, error: 'missing_frontmatter' });
    expect(parseSkill(md('name: a'))).toEqual({ ok: false, error: 'missing_description' });
    expect(parseSkill(md('name: a\nname: b\ndescription: d')).ok).toBe(false);
    expect(parseSkill(md('- a\n- b'))).toEqual({ ok: false, error: 'frontmatter_not_mapping' });
    expect(parseSkill(42)).toEqual({ ok: false, error: 'not_text' });
  });

  test('rejects oversize and binary content', () => {
    expect(parseSkill(md('name: a\ndescription: d', 'x'.repeat(MAX_SKILL_BYTES)))).toEqual({ ok: false, error: 'too_large' });
    expect(parseSkill(md('name: a\ndescription: d', 'a\u0000b'))).toEqual({ ok: false, error: 'binary_content' });
  });
});

describe('skillFormat allowed-tools mapping', () => {
  test('maps Claude Code tool names to this app\'s tools', () => {
    const { rules, warnings } = mapAllowedTools('Read, Write, Edit, Glob, Grep, LS, WebSearch, TodoWrite');
    expect(rules).toEqual(['fs.read', 'fs.write', 'fs.edit', 'fs.search', 'fs.list', 'browser.web_search', 'agent.todo_write']);
    expect(warnings).toEqual([]);
  });

  test('maps Bash specs to argv rules and path specs to workspace-relative globs', () => {
    const { rules } = mapAllowedTools(['Bash(git:*)', 'Bash(git diff:*)', 'Bash(npm test)', 'Read(./src/**)', 'WebFetch(domain:example.com)']);
    expect(rules).toEqual([
      'shell.run:git *', 'shell.run:git diff *', 'shell.run:npm test', 'fs.read:src/**',
      'browser.open_tab:example.com', 'browser.read_tab:example.com',
    ]);
  });

  test('maps Claude MCP names and passes this app\'s own names through', () => {
    const { rules, warnings } = mapAllowedTools('mcp__github__create_issue mcp__linear fs.read browser.*');
    expect(rules).toEqual(['mcp.github.create_issue', 'mcp.linear.*', 'fs.read', 'browser.*']);
    expect(warnings).toEqual([]);
  });

  test('unmapped entries become warnings and grant nothing', () => {
    const { rules, warnings } = mapAllowedTools(['NotebookEdit', 'Read(/etc/passwd)', 'made.up', 'Bash(:*)', 7]);
    expect(rules).toEqual([]);
    expect(warnings).toHaveLength(5);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('NotebookEdit'),
      expect.stringContaining('/etc/passwd'),
      expect.stringContaining('made.up'),
      expect.stringContaining('non-text entry 7'),
    ]));
  });

  test('a non-list allowed-tools value warns and restricts to nothing', () => {
    expect(mapAllowedTools({ Read: true })).toMatchObject({ rules: [], warnings: [expect.stringContaining('allowed-tools')] });
  });

  test('splitToolList keeps spaces inside parentheses', () => {
    expect(splitToolList('Bash(git add:*), Read  Grep')).toEqual(['Bash(git add:*)', 'Read', 'Grep']);
  });

  test('parseSkill surfaces mapping warnings', () => {
    const res = parseSkill(md('name: a\ndescription: d\nallowed-tools: Read, NotebookEdit'));
    expect(res).toMatchObject({ ok: true, skill: { tools: ['fs.read'], allowedTools: ['Read', 'NotebookEdit'] } });
    if (res.ok === true) expect(res.warnings).toEqual([expect.stringContaining('NotebookEdit')]);
  });
});

describe('skillFormat.toolNamePredicate', () => {
  test('null rules mean no restriction', () => {
    expect(toolNamePredicate(null)).toBeNull();
  });

  test('narrows to listed tools and always keeps meta tools', () => {
    const p = /** @type {(n: string) => boolean} */ (toolNamePredicate(['fs.read', 'shell.run:git *']));
    expect(p('fs.read')).toBe(true);
    expect(p('shell.run')).toBe(true);
    expect(p('agent.done')).toBe(true);
    expect(p('fs.write')).toBe(false);
    expect(p('browser.click')).toBe(false);
  });

  test('an empty rule list leaves only meta tools', () => {
    const p = /** @type {(n: string) => boolean} */ (toolNamePredicate([]));
    expect(p('fs.read')).toBe(false);
    expect(p('agent.ask_user')).toBe(true);
  });
});

describe('skillFormat.serializeSkill', () => {
  test('round-trips through parseSkill, including extra keys', () => {
    const first = parseSkill(md('name: demo\ndescription: "Do: things"\nallowed-tools: Read, Bash(git:*)\ntriggers: [go]\nlicense: MIT', 'Body text'));
    if (first.ok !== true) throw new Error('fixture failed to parse');
    const again = parseSkill(serializeSkill(first.skill));
    expect(again).toEqual(first);
  });

  test('refuses to serialize an invalid name or an empty description', () => {
    expect(() => serializeSkill({ name: '../x', description: 'd' })).toThrow('invalid_name');
    expect(() => serializeSkill({ name: 'ok', description: '  ' })).toThrow('missing_description');
  });

  test('slugifyName produces a valid name or empty string', () => {
    expect(slugifyName('  My Cool Skill!! ')).toBe('my-cool-skill');
    expect(slugifyName('../..')).toBe('');
  });
});
