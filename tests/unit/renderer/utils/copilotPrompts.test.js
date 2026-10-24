const { buildMessages, MAX_PAGE_CHARS, MAX_COMPARE_CHARS } = require('../../../../renderer/utils/copilotPrompts');

const page = { title: 'Rust Async', url: 'https://ex.com/a', mainText: 'Futures are lazy. Tokio drives them.' };

describe('copilotPrompts.buildMessages', () => {
  test('summarize: system + a single user turn carrying the page block', () => {
    const msgs = buildMessages('summarize', { page });
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/summariz/i);
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('Title: Rust Async');
    expect(msgs[1].content).toContain('https://ex.com/a');
    expect(msgs[1].content).toContain('Futures are lazy');
  });

  test('unknown mode falls back to summarize (never throws)', () => {
    const msgs = buildMessages('no-such-mode', { page });
    expect(msgs[0].content).toBe(buildMessages('summarize', { page })[0].content);
  });

  test('ask: question is embedded and the page content is included', () => {
    const msgs = buildMessages('ask', { question: 'Are futures eager?', page });
    expect(msgs[0].content).toMatch(/question/i);
    expect(msgs[1].content).toContain('Question: Are futures eager?');
    expect(msgs[1].content).toContain('Futures are lazy');
  });

  test('explain: selection is quoted and bounded page context attached', () => {
    const msgs = buildMessages('explain', { selection: 'lazy futures', page });
    expect(msgs[1].content).toContain('lazy futures');
    expect(msgs[1].content).toContain('Rust Async');
  });

  test('compare: every page appears, labelled, under the compare system prompt', () => {
    const b = { title: 'Go Routines', url: 'https://ex.com/b', mainText: 'Goroutines are cheap.' };
    const msgs = buildMessages('compare', { pages: [page, b] });
    expect(msgs[0].content).toMatch(/compare/i);
    expect(msgs[1].content).toContain('=== Page 1 ===');
    expect(msgs[1].content).toContain('=== Page 2 ===');
    expect(msgs[1].content).toContain('Rust Async');
    expect(msgs[1].content).toContain('Go Routines');
  });

  test('page body is clamped to the per-mode budget', () => {
    const huge = { title: 'T', url: 'u', mainText: 'x'.repeat(MAX_PAGE_CHARS + 5000) };
    const summary = buildMessages('summarize', { page: huge });
    expect(summary[1].content.length).toBeLessThan(MAX_PAGE_CHARS + 500);

    const cmp = buildMessages('compare', { pages: [huge, huge] });
    // Two pages each clamped to the smaller compare budget.
    expect(cmp[1].content.length).toBeLessThan(2 * MAX_COMPARE_CHARS + 1000);
  });

  test('missing page text degrades to an explicit placeholder, not a crash', () => {
    const msgs = buildMessages('summarize', { page: { title: 'Empty' } });
    expect(msgs[1].content).toMatch(/no readable text/i);
  });

  test('council: every councillor answer is labelled by name under a synthesis system prompt', () => {
    const msgs = buildMessages('council', {
      question: 'Best DB for time series?',
      answers: [
        { name: 'ChatGPT', text: 'TimescaleDB is a solid choice.' },
        { name: 'Claude', text: 'Consider InfluxDB or Timescale.' },
      ],
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toMatch(/agreements/i);
    expect(msgs[0].content).toMatch(/disagree|conflict/i);
    expect(msgs[1].content).toContain('Best DB for time series?');
    expect(msgs[1].content).toContain('### ChatGPT');
    expect(msgs[1].content).toContain('### Claude');
    expect(msgs[1].content).toContain('TimescaleDB is a solid choice.');
  });

  test('council: tolerates a missing question and unnamed councillors', () => {
    const msgs = buildMessages('council', { answers: [{ text: 'A' }, { text: 'B' }] });
    expect(msgs[1].content).not.toMatch(/Question asked/);
    expect(msgs[1].content).toContain('### Councillor 1');
    expect(msgs[1].content).toContain('### Councillor 2');
  });

  test('council: each answer clamped to the compare budget', () => {
    const big = 'z'.repeat(MAX_COMPARE_CHARS + 4000);
    const msgs = buildMessages('council', { question: 'q', answers: [{ name: 'X', text: big }, { name: 'Y', text: big }] });
    expect(msgs[1].content.length).toBeLessThan(2 * MAX_COMPARE_CHARS + 1000);
  });

  test('council: item count is capped and the overflow is disclosed, not dropped silently', () => {
    const answers = Array.from({ length: 12 }, (_, i) => ({ name: `C${i}`, text: `answer ${i}` }));
    const msgs = buildMessages('council', { question: 'q', answers });
    expect(msgs[1].content).toContain('### C0');
    expect(msgs[1].content).toContain('### C7');
    expect(msgs[1].content).not.toContain('### C8');
    expect(msgs[1].content).toMatch(/4 additional councillors?/i);
  });

  test('compare: item count is capped when more panes are open than the budget', () => {
    const pages = Array.from({ length: 20 }, (_, i) => ({ title: `Page ${i}`, url: `https://ex.com/${i}`, mainText: `body ${i}` }));
    const msgs = buildMessages('compare', { pages });
    expect(msgs[1].content).toContain('=== Page 8 ===');
    expect(msgs[1].content).not.toContain('=== Page 9 ===');
    expect(msgs[1].content).toMatch(/Compare the following 8 pages/);
  });
});
