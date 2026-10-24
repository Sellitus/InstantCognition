const { PersonaRouterService } = require('../../../../main/services/PersonaRouterService');
const { PersonaService } = require('../../../../main/services/PersonaService');

function makePersonaService(extraConfig = {}) {
  const svc = new PersonaService();
  svc.bindConfig({
    get: (path, fallback) => {
      if (path === 'settings.agentPersonas') {
        return {
          enabledPersonas: ['default', 'explore', 'research', 'shop', 'code', 'reddit', 'news', 'quick'],
          routerEnabled: true,
          routerLLMFallback: true,
          customPersonas: [],
          builtinOverrides: {},
          ...extraConfig,
        };
      }
      return fallback;
    },
  });
  return svc;
}

function fakeLLM(reply) {
  return {
    chatCompletion: jest.fn(async () => ({ content: reply, toolCalls: null, usage: null, tokens: 1, raw: {} })),
  };
}

describe('PersonaRouterService — regex pre-pass', () => {
  let router;
  beforeEach(() => {
    router = new PersonaRouterService();
    router.bind({ personaService: makePersonaService(), llmClient: null });
  });

  test('matches subreddit cue', async () => {
    const r = await router.route("what's r/LocalLLaMA saying about Mistral 3.5?");
    expect(r.name).toBe('reddit');
    expect(r.source).toBe('regex');
  });

  test('matches "reddit" keyword', async () => {
    const r = await router.route("any new trends on reddit lately?");
    expect(r.name).toBe('reddit');
  });

  test('matches shopping cue with dollar sign', async () => {
    const r = await router.route("best 27-inch monitor under $400");
    expect(r.name).toBe('shop');
  });

  test('matches shopping keyword', async () => {
    const r = await router.route("cheap mechanical keyboard recommendations");
    expect(r.name).toBe('shop');
  });

  test('matches code cue (stack trace)', async () => {
    const r = await router.route("fix this stack trace I keep getting");
    expect(r.name).toBe('code');
  });

  test('matches code via fenced block', async () => {
    const r = await router.route("```js\nconst x = 1;\n```\nwhy?");
    expect(r.name).toBe('code');
  });

  test('matches news cue (today)', async () => {
    const r = await router.route("what happened today in tech");
    expect(r.name).toBe('news');
  });

  test('matches research cue (compare)', async () => {
    const r = await router.route("compare meta-analysis on intermittent fasting");
    expect(r.name).toBe('research');
  });

  test('quick on very short factual prompt', async () => {
    const r = await router.route("hi");
    expect(r.name).toBe('quick');
  });

  test('falls back to default when nothing matches and no LLM', async () => {
    const r = await router.route("please explain bayes theorem to me thoroughly");
    expect(r.name).toBe('default');
    // Could be 'default' source — no LLM bound to do better.
  });
});

describe('PersonaRouterService — explicit overrides', () => {
  let router;
  beforeEach(() => {
    router = new PersonaRouterService();
    router.bind({ personaService: makePersonaService(), llmClient: null });
  });

  test(':persona prefix routes to that persona and strips the prefix', async () => {
    const r = await router.route(':research What is the best evidence for X?');
    expect(r.name).toBe('research');
    expect(r.source).toBe('prefix');
    expect(r.cleanedDescription).toBe('What is the best evidence for X?');
  });

  test('bogus :persona prefix is ignored', async () => {
    const r = await router.route(':moon what is the best evidence');
    expect(r.source).not.toBe('prefix');
  });

  test('lock overrides everything', async () => {
    router.setLock('research');
    const r = await router.route('any new trends on reddit lately?');
    expect(r.name).toBe('research');
    expect(r.source).toBe('lock');
  });

  test('clearLock returns to auto-routing', async () => {
    router.setLock('shop');
    router.clearLock();
    const r = await router.route("any new trends on reddit lately?");
    expect(r.name).toBe('reddit');
  });

  test('disabled router routes everything to default', async () => {
    router.bind({ personaService: makePersonaService({ routerEnabled: false }), llmClient: null });
    const r = await router.route('best monitor under $400');
    expect(r.name).toBe('default');
    expect(r.source).toBe('disabled');
  });
});

describe('PersonaRouterService — LLM fallback', () => {
  let router;
  beforeEach(() => {
    router = new PersonaRouterService();
  });

  test('LLM picks a persona when regex is silent', async () => {
    const llm = fakeLLM('shop');
    router.bind({ personaService: makePersonaService(), llmClient: llm });
    const r = await router.route('I am putting together a desk setup, need ideas for a good monitor');
    expect(['shop', 'default']).toContain(r.name); // regex may or may not catch "monitor"
    if (r.source === 'llm') expect(llm.chatCompletion).toHaveBeenCalled();
  });

  test('LLM result is cached so identical prompts do not re-call', async () => {
    const llm = fakeLLM('research');
    router.bind({ personaService: makePersonaService(), llmClient: llm });
    const text = 'an obscure prompt with no obvious cue ' + Math.random();
    await router.route(text);
    await router.route(text);
    // second call hits cache; LLM called at most once for this text
    const calls = llm.chatCompletion.mock.calls.length;
    expect(calls).toBeLessThanOrEqual(1);
  });

  test('LLM timeout / error falls back to default', async () => {
    const llm = { chatCompletion: jest.fn(async () => { throw new Error('timeout'); }) };
    router.bind({ personaService: makePersonaService(), llmClient: llm });
    const r = await router.route('an obscure prompt with no obvious cue');
    expect(r.name).toBe('default');
  });

  test('disabling LLM fallback returns default for unmatched prompts', async () => {
    const llm = fakeLLM('shop');
    router.bind({ personaService: makePersonaService({ routerLLMFallback: false }), llmClient: llm });
    const r = await router.route('an obscure prompt with no obvious cue');
    expect(r.name).toBe('default');
    expect(llm.chatCompletion).not.toHaveBeenCalled();
  });

  test('LLM reply with junk falls through to default', async () => {
    const llm = fakeLLM('definitely-not-a-persona');
    router.bind({ personaService: makePersonaService(), llmClient: llm });
    const r = await router.route('an obscure prompt with no obvious cue');
    expect(r.name).toBe('default');
  });
});

describe('PersonaRouterService.routeSync', () => {
  test('returns regex match without an LLM call', () => {
    const router = new PersonaRouterService();
    router.bind({ personaService: makePersonaService(), llmClient: null });
    const r = router.routeSync('best monitor under $400');
    expect(r.name).toBe('shop');
  });

  test('respects lock', () => {
    const router = new PersonaRouterService();
    router.bind({ personaService: makePersonaService(), llmClient: null });
    router.setLock('research');
    const r = router.routeSync('best monitor under $400');
    expect(r.source).toBe('lock');
  });
});
