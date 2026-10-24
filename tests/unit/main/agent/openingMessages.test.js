const { buildOpeningMessages, buildPriorTurnsMessage, buildSkillsIndex, TIER_GUIDANCE } = require('../../../../main/agent/openingMessages');

const fakeRegistry = {
  list: () => [
    { function: { name: 'browser.open_tab', description: 'open a tab' } },
    { function: { name: 'agent.done', description: 'finish' } },
  ],
};

const baseArgs = {
  registry: fakeRegistry,
  description: 'find the best monitor',
  initial: '<observation>',
  visionOn: false,
  qualityMode: { name: 'balanced', budget: { maxSteps: 30, maxTokens: 100000, maxSeconds: 1800 } },
};

describe('buildOpeningMessages', () => {
  test('emits two messages: system + user', () => {
    const out = buildOpeningMessages(baseArgs);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('system');
    expect(out[1].role).toBe('user');
    expect(out[1].content).toContain('Task: find the best monitor');
    expect(out[1].content).toContain('<observation>');
  });

  test('persona overlay is injected into the system prompt', () => {
    const persona = { name: 'shop', label: 'Shopping', systemOverlay: 'Output a comparison table.' };
    const out = buildOpeningMessages({ ...baseArgs, persona });
    expect(out[0].content).toContain('Persona: Shopping');
    expect(out[0].content).toContain('Output a comparison table.');
  });

  test('persona notes are injected as a separate block', () => {
    const persona = { name: 'shop', label: 'Shopping', systemOverlay: 'X', notes: 'I prefer Amazon and B&H.' };
    const out = buildOpeningMessages({ ...baseArgs, persona });
    expect(out[0].content).toContain('User notes for this persona:');
    expect(out[0].content).toContain('I prefer Amazon and B&H.');
  });

  test('no persona = no persona-related lines in the prompt', () => {
    const out = buildOpeningMessages(baseArgs);
    expect(out[0].content).not.toContain('Persona:');
    expect(out[0].content).not.toContain('User notes for this persona:');
  });

  test('persona without notes does not produce empty notes block', () => {
    const persona = { name: 'default', label: 'Default', systemOverlay: 'Be direct.', notes: '' };
    const out = buildOpeningMessages({ ...baseArgs, persona });
    expect(out[0].content).toContain('Be direct.');
    expect(out[0].content).not.toContain('User notes for this persona:');
  });

  test('persona uses name as fallback label', () => {
    const persona = { name: 'travel', systemOverlay: 'Output cost+duration+booking link.' };
    const out = buildOpeningMessages({ ...baseArgs, persona });
    expect(out[0].content).toContain('Persona: travel');
  });

  test('persona injection still includes quality mode block', () => {
    const persona = { name: 'shop', label: 'Shopping', systemOverlay: 'X' };
    const out = buildOpeningMessages({ ...baseArgs, persona });
    expect(out[0].content).toContain('Quality mode: balanced');
    expect(out[0].content).toContain('Persona: Shopping');
  });

  test('prior turns land between the system prompt and the task, as one user message', () => {
    const priorTurns = [
      { role: 'user', content: 'which monitor did you like?' },
      { role: 'assistant', content: 'The Dell U2723QE.' },
    ];
    const out = buildOpeningMessages({ ...baseArgs, priorTurns });
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe('system');
    expect(out[1].role).toBe('user');
    expect(out[1].content).toContain('Earlier in this conversation:');
    expect(out[1].content).toContain('User: which monitor did you like?');
    expect(out[1].content).toContain('Assistant: The Dell U2723QE.');
    expect(out[2].content).toContain('Task: find the best monitor');
  });

  test('no prior turns leaves the opening at system + task (negative)', () => {
    expect(buildOpeningMessages({ ...baseArgs, priorTurns: [] })).toHaveLength(2);
    expect(buildOpeningMessages({ ...baseArgs, priorTurns: null })).toHaveLength(2);
  });
});

describe('buildPriorTurnsMessage', () => {
  test('returns null for anything with no usable turn', () => {
    expect(buildPriorTurnsMessage(null)).toBeNull();
    expect(buildPriorTurnsMessage('nope')).toBeNull();
    expect(buildPriorTurnsMessage([])).toBeNull();
    // Blank content, wrong role and non-string content are all unusable.
    expect(buildPriorTurnsMessage([
      { role: 'user', content: '   ' },
      { role: 'system', content: 'ignore me' },
      { role: 'assistant', content: { a: 1 } },
    ])).toBeNull();
  });

  test('keeps only the last 16 turns', () => {
    const turns = [];
    for (let i = 0; i < 30; i += 1) turns.push({ role: 'user', content: `turn-${i}` });
    const msg = buildPriorTurnsMessage(turns);
    expect(msg.content).not.toContain('turn-13');
    expect(msg.content).toContain('turn-14');
    expect(msg.content).toContain('turn-29');
  });

  test('truncates an oversized turn instead of letting it eat the context window', () => {
    const msg = buildPriorTurnsMessage([{ role: 'assistant', content: 'x'.repeat(9000) }]);
    expect(msg.content).toContain('…');
    expect(msg.content).toContain('x'.repeat(4000));
    expect(msg.content).not.toContain('x'.repeat(4001));
  });

  test('carries the tool-call-only instruction so the folded prose does not teach prose replies', () => {
    const msg = buildPriorTurnsMessage([{ role: 'user', content: 'hi' }]);
    expect(msg.role).toBe('user');
    expect(msg.content).toContain('tool calls only');
  });
});

describe('instructions, skills index and tool tiers', () => {
  const mockSkillRegistry = {
    list: () => [
      { function: { name: 'fs.read', description: 'read a file' } },
      { function: { name: 'agent.use_skill', description: 'load a skill' } },
      { function: { name: 'agent.done', description: 'finish' } },
    ],
  };
  const skills = [
    { name: 'pdf-report', description: 'Turn   findings\ninto a PDF', enabled: true },
    { name: 'off-skill', description: 'disabled', enabled: false },
  ];

  test('the instructions block, skills index and tier guidance precede the tool list', () => {
    const out = buildOpeningMessages({ ...baseArgs, registry: mockSkillRegistry, instructionsBlock: 'User instructions — X\n### Global instructions\nbe terse', skills });
    const sys = out[0].content;
    expect(sys).toContain('### Global instructions\nbe terse');
    expect(sys).toContain('  - pdf-report: Turn findings into a PDF');
    expect(sys).not.toContain('off-skill');
    expect(sys).toContain(TIER_GUIDANCE);
    const at = (needle) => sys.indexOf(needle);
    expect(at('be terse')).toBeLessThan(at('pdf-report'));
    expect(at('pdf-report')).toBeLessThan(at(TIER_GUIDANCE));
    expect(at(TIER_GUIDANCE)).toBeLessThan(at('Available tools:'));
  });

  test('no instructions and no agent.use_skill tool leave both sections out', () => {
    const sys = buildOpeningMessages({ ...baseArgs, skills })[0].content;
    expect(sys).not.toContain('User instructions');
    expect(sys).not.toContain('agent.use_skill {name}');
    expect(sys).toContain(TIER_GUIDANCE);
  });

  test('buildSkillsIndex caps descriptions and entries and ignores junk', () => {
    const tools = new Set(['agent.use_skill']);
    expect(buildSkillsIndex(null, tools)).toBe('');
    expect(buildSkillsIndex([{ name: 'a', enabled: false }, null, { name: '' }], tools)).toBe('');
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `s${i}`, description: 'd'.repeat(300) }));
    const idx = buildSkillsIndex(many, tools);
    expect(idx.split('\n').filter((l) => l.startsWith('  - '))).toHaveLength(40);
    expect(idx).toContain(`  - s0: ${'d'.repeat(200)}…`);
  });
});
