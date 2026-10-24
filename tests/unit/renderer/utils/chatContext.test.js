const { parseSlashAction, routeIntent, parseInlineContext, formatPageBlock, formatBrowsing, formatWebResults, ACTIVE_PAGE_AUTO_LIMIT, SLASH_ACTIONS, CONTEXT_KEYS, CHAT_FEATURE_KEYS, DEFAULT_CHAT_FEATURES } = require('../../../../renderer/utils/chatContext');

describe('chatContext.parseSlashAction', () => {
  test('recognizes the known transform commands', () => {
    expect(parseSlashAction('/summarize')).toEqual({ action: 'summarize', rest: '' });
    expect(parseSlashAction('/explain this part')).toEqual({ action: 'explain', rest: 'this part' });
    expect(parseSlashAction('/compare')).toEqual({ action: 'compare', rest: '' });
  });

  test('recognizes the multi-step council/research commands and captures the question', () => {
    expect(parseSlashAction('/council what is the best db?')).toEqual({ action: 'council', rest: 'what is the best db?' });
    expect(parseSlashAction('/research climate policy 2030')).toEqual({ action: 'research', rest: 'climate policy 2030' });
  });

  test('is case-insensitive and trims surrounding whitespace', () => {
    expect(parseSlashAction('  /SUMMARIZE  ')).toEqual({ action: 'summarize', rest: '' });
  });

  test('returns null for plain text, unknown commands, and mid-string slashes', () => {
    expect(parseSlashAction('summarize the page')).toBeNull();
    expect(parseSlashAction('/unknown do thing')).toBeNull();
    expect(parseSlashAction('tell me about /summarize')).toBeNull();
    expect(parseSlashAction('')).toBeNull();
    expect(parseSlashAction(null)).toBeNull();
  });

  test('exports the canonical action and context key lists', () => {
    expect(SLASH_ACTIONS).toEqual(['summarize', 'explain', 'compare', 'council', 'research']);
    expect(CONTEXT_KEYS).toEqual(['page', 'selection', 'spaces', 'browsing']);
  });
});

describe('chatContext.formatPageBlock', () => {
  test('renders title, url, and clipped body', () => {
    const block = formatPageBlock({ title: 'Hello', url: 'https://ex.com', mainText: 'Body content here' });
    expect(block).toContain('Title: Hello');
    expect(block).toContain('URL: https://ex.com');
    expect(block).toContain('Body content here');
  });

  test('falls back gracefully when fields are missing', () => {
    const block = formatPageBlock({});
    expect(block).toContain('Title: Untitled');
    expect(block).toContain('no readable text');
  });

  test('clips the body to the requested limit', () => {
    const long = 'x'.repeat(500);
    const block = formatPageBlock({ title: 'T', url: 'u', mainText: long }, 50);
    expect(block).toContain('…');
    expect(block.length).toBeLessThan(long.length);
  });
});

describe('chatContext.formatBrowsing', () => {
  test('renders a numbered list of title — url lines', () => {
    const out = formatBrowsing({ results: [
      { title: 'First', url: 'https://a' },
      { title: 'Second', url: 'https://b' },
    ] });
    expect(out).toContain('1. First — https://a');
    expect(out).toContain('2. Second — https://b');
  });

  test('honors the limit and tolerates missing fields', () => {
    const out = formatBrowsing({ results: [
      { url: 'https://a' }, { title: 'B', url: 'https://b' }, { title: 'C', url: 'https://c' },
    ] }, 2);
    expect(out).toContain('(untitled)');
    expect(out).not.toContain('C —');
  });

  test('returns an empty string when there are no results', () => {
    expect(formatBrowsing({ results: [] })).toBe('');
    expect(formatBrowsing(null)).toBe('');
    expect(formatBrowsing({})).toBe('');
  });
});

describe('chatContext.formatWebResults', () => {
  test('renders each result with title, url, and snippet', () => {
    const out = formatWebResults({ ok: true, results: [
      { title: 'Cats', url: 'https://cats.example', snippet: 'Felines are great.' },
      { title: 'Dogs', url: 'https://dogs.example', snippet: 'Canines too.' },
    ] });
    expect(out).toContain('Web search results');
    expect(out).toContain('1. Cats');
    expect(out).toContain('https://cats.example');
    expect(out).toContain('Felines are great.');
    expect(out).toContain('2. Dogs');
  });

  test('appends the top page body when readTop succeeded', () => {
    const out = formatWebResults({
      ok: true,
      results: [{ title: 'Top', url: 'https://top.example', snippet: 'snip' }],
      page: { ok: true, title: 'Top Page', text: 'Full article body.' },
    });
    expect(out).toContain('Top result full text: Top Page');
    expect(out).toContain('Full article body.');
  });

  test('omits the page block when readTop failed or was not requested', () => {
    const out = formatWebResults({
      ok: true,
      results: [{ title: 'Top', url: 'https://top.example', snippet: 'snip' }],
      page: { ok: false, error: 'empty_page' },
    });
    expect(out).not.toContain('Top result full text');
  });

  test('returns empty string when there are no usable results and no page block', () => {
    expect(formatWebResults({ ok: true, results: [] })).toBe('');
    expect(formatWebResults({ ok: false, error: 'x' })).toBe('');
    expect(formatWebResults(null)).toBe('');
  });

  test('still injects the page block when readTop succeeded but no result snippets were usable', () => {
    const out = formatWebResults({
      ok: true,
      results: [{ url: 'https://top.example', title: '' }],
      page: { ok: true, url: 'https://top.example', title: 'Top article', text: 'Full article body.' },
    });
    expect(out).toContain('Top result full text');
    expect(out).toContain('Full article body.');
  });
});

describe('chatContext feature exports', () => {
  test('CHAT_FEATURE_KEYS lists the three composer toggles', () => {
    expect(CHAT_FEATURE_KEYS).toEqual(['webSearch', 'readTopPage', 'thinkStepByStep']);
  });

  test('DEFAULT_CHAT_FEATURES has all three grounding features ON (opt-out in Settings)', () => {
    expect(DEFAULT_CHAT_FEATURES).toEqual({ webSearch: true, readTopPage: true, thinkStepByStep: true });
  });

  test('ACTIVE_PAGE_AUTO_LIMIT caps the always-attached page block at 3000 chars', () => {
    expect(ACTIVE_PAGE_AUTO_LIMIT).toBe(3000);
  });
});

describe('chatContext.routeIntent (auto-mode router)', () => {
  // Positive: unambiguous imperative navigation and multi-step compounds route to agent.
  test.each([
    ['open https://x.com'],                                   // sentence-start open + target
    ['Open GitHub and look at issues'],                       // "open X" prefix wins regardless of the rest
    ['Please launch the installer now'],                      // polite launch variant, case-insensitive
    ['go to settings page please'],                           // go-to navigation phrasing
    ['navigate to billing after checkout completes first?'],  // navigate + a clause (still imperative)
    ['when I go to login what happens next?'],                // "go to" anywhere matches the nav regex — code is the spec
    ['Find reliable sources for this topic and open the best ones side by side.'],   // find ... and open compound
    ['find three articles about mars then open them'],        // find ... then open compound, lowercase
    ['summarize this article and open a follow up tab for it'],  // summariz* ... and open compound
    ['search for the best budget mechanical keyboards'],        // imperative research verb at sentence start
    ['look up the web for reviews of this laptop'],             // search verb aimed at the open web
    ['what do people say on reddit about mechanical keyboards?'], // question naming a browsable source
    ['best threads from hacker news about rust'],               // "from <source>" phrasing
    ['summarize https://example.com/post'],                     // a literal URL has to be fetched
    ['what is the latest news on the mars mission?']            // recency + volatile subject
  ])('routes agent phrasing to %j', (text) => {
    expect(routeIntent(text)).toBe('agent');
  });

  // Negative: plain questions stay on the fast chat path even with grounding on by default.
  test.each([
    'what is quantum computing?',       // plain question — stays chat even with web grounding on by default
    '2+2',                              // math one-liner; thinkStepByStep handles it, not the agent loop
    'Summarize this page',              // single verb: no "and/then ... open" compound
    'bob@example.com sent an invoice today',  // email address is prose, not a command
    'explain how tail recursion works',       // knowledge question the model answers from weights
    'rewrite this paragraph to be shorter'    // a transform on text already in hand
  ])('routes plain chat phrasing to %j', (text) => {
    expect(routeIntent(text)).toBe('chat');
  });

  test('empty and null input route to chat rather than throwing', () => {
    expect(routeIntent('')).toBe('chat');
    expect(routeIntent(null)).toBe('chat');
  });
});

describe('chatContext.parseInlineContext (typed @tokens)', () => {
  test('collects the known keys and strips their tokens from the text', () => {
    const r = parseInlineContext('@page @selection do X');
    expect(r.keys).toEqual(['page', 'selection']);
    expect(r.text).toBe('do X');
  });

  test('matches tokens case-insensitively at word boundaries only', () => {
    // Mixed-case tokens are recognized and deduped into lowercase keys.
    const mixed = parseInlineContext('@SELECTION @Selection explain this please');
    expect(mixed.keys).toEqual(['selection']);
    expect(mixed.text).toBe('explain this please');

    // "@pages" is not a token — the \b after the key word fails on "es".
    const plural = parseInlineContext('@pages are fine here too');
    expect(plural.keys).toEqual([]);
    expect(plural.text).toContain('@pages');

    // Unknown @words pass through untouched.
    const unknown = parseInlineContext('ask @bob about it and then @foo as well');
    expect(unknown.keys).toEqual([]);
    expect(unknown.text).toBe('ask @bob about it and then @foo as well');

    // Email addresses are prose, not context tokens — the '@' is mid-word.
    const email = parseInlineContext('email bob@example.com for details today');
    expect(email.keys).toEqual([]);
    expect(email.text).toContain('bob@example.com');
  });

  test('preserves newlines in runs without a token; a newline hugging a matched token is consumed with it', () => {
    // No token → trim only, so every line break survives the strip.
    const noToken = parseInlineContext('first line\nsecond line');
    expect(noToken.keys).toEqual([]);
    expect(noToken.text).toBe('first line\nsecond line');

    // The boundary whitespace around a matched token (including \n) is part of
    // the match and gets replaced by one space, so only runs free of tokens keep breaks.
    const withBreak = parseInlineContext('@selection\nline two stays intact');
    expect(withBreak.keys).toEqual(['selection']);
    expect(withBreak.text).toBe('line two stays intact');

    // A later newline in the same string that is not adjacent to a token survives.
    const mixed = parseInlineContext('@page hello\ntail line follows here');
    expect(mixed.keys).toEqual(['page']);
    expect(mixed.text.split('\n')).toHaveLength(2);
  });

  test('@page is accepted as a known key even though the page always attaches', () => {
    const r = parseInlineContext('@page what am I looking at?');
    expect(r.keys).toEqual(['page']);
    expect(r.text).toBe('what am I looking at?');
  });

  test('multiple distinct keys are returned in first-occurrence order and deduped', () => {
    const r = parseInlineContext('@browsing plus @spaces again @selection once more, please go');
    expect(new Set(r.keys)).toEqual(new Set(['browsing', 'spaces', 'selection']));
  });

  test('empty and null input yield no keys and empty text without throwing', () => {
    expect(parseInlineContext('')).toEqual({ keys: [], text: '' });
    expect(parseInlineContext(null).keys).toEqual([]);
  });
});