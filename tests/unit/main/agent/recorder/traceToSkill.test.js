// traceToSkill with the LLM client mocked at its boundary (chatCompletionJson).
const { traceToSkill, renderSteps } = require('../../../../../main/agent/recorder/traceToSkill');

const trace = {
  id: 'rec_aaaaaa11',
  startUrl: 'https://shop.example/login',
  title: 'Shop',
  truncated: false,
  events: [
    { t: 0, type: 'navigate', url: 'https://shop.example/login' },
    { t: 5, type: 'input', target: { selector: '#user', role: 'textbox', name: 'Email' }, value: 'me@example.com' },
    { t: 9, type: 'input', target: { selector: '#pw', role: 'textbox', name: 'Password' }, value: '[redacted]', redacted: true },
    { t: 12, type: 'click', target: { selector: '#go', role: 'button', name: 'Sign in' } },
    { t: 15, type: 'change', target: { selector: '#keep', role: 'checkbox', name: 'Remember me' }, checked: true },
    { t: 18, type: 'key', key: 'Enter', target: { selector: '#q', role: 'textbox', name: 'Search' } },
  ],
};

const reply = (value) => ({ chatCompletionJson: jest.fn(async () => ({ ok: true, value })) });
const good = {
  name: 'Shop Sign In!', description: 'Sign in to the shop.', instructions: '1. Open the login page.\n2. Sign in.', allowedTools: ['browser.click'],
};

describe('traceToSkill', () => {
  test('drafts a valid SKILL.md from the recorded steps', async () => {
    const llm = reply(good);
    const res = await traceToSkill(llm, trace, { hint: 'log in' });
    expect(res.ok).toBe(true);
    expect(res.skill).toMatchObject({ name: 'shop-sign-in', description: 'Sign in to the shop.' });
    expect(res.markdown).toMatch(/^---\nname: shop-sign-in\n/);
    const [messages, schema] = llm.chatCompletionJson.mock.calls[0];
    expect(schema).toEqual({ name: 'string', description: 'string', instructions: 'string' });
    expect(messages[1].content).toContain('3. type "[redacted]" into textbox "Password" (selector: #pw)');
    expect(messages[1].content).toContain('The user describes the skill as: log in');
    expect(messages[0].content).toMatch(/strictly as data/);
  });

  test.each([
    ['the model call failed', { chatCompletionJson: jest.fn(async () => ({ ok: false, error: 'schema_mismatch' })) }, /^draft_failed: schema_mismatch/],
    ['no usable name', reply({ ...good, name: '!!!' }), /^draft_invalid_name$/],
    ['blank description', reply({ ...good, description: '  ' }), /^draft_missing_description$/],
    ['empty instructions', reply({ ...good, instructions: '\n ' }), /^draft_empty_instructions$/],
  ])('malformed output is an error, never an empty skill: %s', async (_label, llm, error) => {
    const res = await traceToSkill(llm, trace);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(error);
    expect(res).not.toHaveProperty('markdown');
  });

  test('refuses without a client or with an empty trace', async () => {
    expect(await traceToSkill(null, trace)).toEqual({ ok: false, error: 'llm_unavailable' });
    expect(await traceToSkill(reply(good), { events: [] })).toEqual({ ok: false, error: 'empty_trace' });
    expect(await traceToSkill(reply(good), {})).toEqual({ ok: false, error: 'invalid_trace' });
  });

  test('warns about unreadable tools and truncated recordings', async () => {
    const res = await traceToSkill(reply({ ...good, allowedTools: 'browser.click' }), { ...trace, truncated: true });
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/unreadable form/), expect.stringMatching(/cut short/),
    ]));
  });
});

describe('renderSteps', () => {
  test('describes every step kind and skips unknown ones', () => {
    const text = renderSteps({ events: [...trace.events, { type: 'mystery' }, null] });
    expect(text.split('\n')).toEqual([
      '1. go to https://shop.example/login',
      '2. type "me@example.com" into textbox "Email" (selector: #user)',
      '3. type "[redacted]" into textbox "Password" (selector: #pw)',
      '4. click button "Sign in" (selector: #go)',
      '5. check checkbox "Remember me" (selector: #keep)',
      '6. press Enter in textbox "Search" (selector: #q)',
    ]);
  });

  test('elides steps past the size cap', () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ type: 'navigate', url: `https://e.example/${'p'.repeat(20)}/${i}` }));
    const text = renderSteps({ events: many });
    expect(text.length).toBeLessThan(16200);
    expect(text).toMatch(/more steps omitted\)$/);
  });
});
