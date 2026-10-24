const { draftSkill, renderTranscript, MAX_TRANSCRIPT_CHARS } = require('../../../../../main/agent/skills/skillDraft');

const TRANSCRIPT = [
  { role: 'user', content: 'Find the cheapest flight from SFO to JFK next Friday' },
  { role: 'assistant', content: 'I searched three sites and the cheapest is $189 on JetBlue.' },
];

const mockLlm = (value, ok = true) => ({
  chatCompletionJson: jest.fn(async () => (ok ? { ok: true, value } : { ok: false, error: 'parse_failed', stage: 'parse' })),
});

describe('skillDraft.draftSkill', () => {
  test('drafts a valid skill and its SKILL.md from the transcript', async () => {
    const llm = mockLlm({
      name: 'Cheapest Flight', description: 'Find the cheapest flight between two airports on a date.',
      instructions: '1. Ask for origin, destination, date.\n2. Compare three sites.', allowedTools: ['WebSearch', 'Read'],
    });
    const res = await draftSkill(llm, TRANSCRIPT, { hint: 'flight finder' });
    expect(res).toMatchObject({ ok: true, skill: { name: 'cheapest-flight', tools: ['browser.web_search', 'fs.read'] } });
    if (res.ok === true) expect(res.markdown).toMatch(/^---\nname: cheapest-flight\n/);
    const [messages, schema] = llm.chatCompletionJson.mock.calls[0];
    expect(schema).toEqual({ name: 'string', description: 'string', instructions: 'string' });
    expect(messages[1].content).toContain('USER: Find the cheapest flight');
    expect(messages[1].content).toContain('flight finder');
  });

  test('malformed LLM output returns an error, not an empty skill', async () => {
    expect(await draftSkill(mockLlm(null, false), TRANSCRIPT)).toEqual({ ok: false, error: 'draft_failed: parse_failed' });
  });

  test.each([
    [{ name: '!!!', description: 'd', instructions: 'x' }, 'draft_invalid_name'],
    [{ name: 'ok', description: '   ', instructions: 'x' }, 'draft_missing_description'],
    [{ name: 'ok', description: 'd', instructions: '  ' }, 'draft_empty_instructions'],
  ])('rejects unusable model output %j', async (value, error) => {
    expect(await draftSkill(mockLlm(value), TRANSCRIPT)).toEqual({ ok: false, error });
  });

  test('a non-list allowedTools adds a warning and no restriction', async () => {
    const res = await draftSkill(mockLlm({ name: 'x', description: 'd', instructions: 'steps', allowedTools: 'Read' }), TRANSCRIPT);
    expect(res).toMatchObject({ ok: true, skill: { tools: null } });
    if (res.ok === true) expect(res.warnings).toHaveLength(1);
  });

  test('refuses an empty transcript or a missing LLM without calling the model', async () => {
    const llm = mockLlm({});
    expect(await draftSkill(llm, [])).toEqual({ ok: false, error: 'empty_transcript' });
    expect(await draftSkill(llm, [{ role: 'bogus', content: 'x' }])).toEqual({ ok: false, error: 'empty_transcript' });
    expect(await draftSkill(llm, /** @type {any} */ ('nope'))).toEqual({ ok: false, error: 'invalid_transcript' });
    expect(await draftSkill(null, TRANSCRIPT)).toEqual({ ok: false, error: 'llm_unavailable' });
    expect(llm.chatCompletionJson).not.toHaveBeenCalled();
  });
});

describe('skillDraft.renderTranscript', () => {
  test('keeps the newest text when over the cap and reads content parts', () => {
    const long = [{ role: 'user', content: 'a'.repeat(MAX_TRANSCRIPT_CHARS) }, { role: 'assistant', content: [{ type: 'text', text: 'LATEST' }] }];
    const out = renderTranscript(long);
    expect(out.length).toBe(MAX_TRANSCRIPT_CHARS);
    expect(out.endsWith('ASSISTANT: LATEST')).toBe(true);
  });
});
