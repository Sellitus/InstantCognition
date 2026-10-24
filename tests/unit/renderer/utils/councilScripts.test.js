const { COUNCIL_EXTRACTOR, buildInjectScript, buildResearchTask } = require('../../../../renderer/utils/councilScripts');

describe('councilScripts.COUNCIL_EXTRACTOR', () => {
  test('is an IIFE that probes known assistant-message selectors', () => {
    expect(typeof COUNCIL_EXTRACTOR).toBe('string');
    expect(COUNCIL_EXTRACTOR).toContain('data-message-author-role');
    expect(COUNCIL_EXTRACTOR.trim().startsWith('(function')).toBe(true);
  });
});

describe('councilScripts.buildInjectScript', () => {
  test('embeds the JSON-escaped text and auto-submit flag', () => {
    const script = buildInjectScript('hello "world"', true);
    expect(script).toContain(JSON.stringify('hello "world"'));
    expect(script).toContain('const autoSubmit = true');
    expect(script).toContain('findSendButton');
  });

  test('omits auto-submit when false and tolerates nullish text', () => {
    const script = buildInjectScript(null, false);
    expect(script).toContain('const autoSubmit = false');
    expect(script).toContain('const text = ""');
  });

  test('escapes injection attempts so they cannot break out of the string literal', () => {
    const script = buildInjectScript('"; document.cookie; //', true);
    // The payload survives only as a JSON string literal, never as raw code.
    expect(script).toContain(JSON.stringify('"; document.cookie; //'));
    expect(script).not.toMatch(/const text = "";\s*document\.cookie/);
  });
});

describe('councilScripts.buildResearchTask', () => {
  test('embeds the question and the citation-mapped report instructions', () => {
    const task = buildResearchTask('  what causes inflation?  ');
    expect(task).toContain('Research Report Mode');
    expect(task).toContain('Question: what causes inflation?');
    expect(task).toContain('browser.web_search');
    expect(task).toContain('browser.open_research_sources');
    expect(task).toContain('## Sources');
  });

  test('tolerates a missing question', () => {
    const task = buildResearchTask();
    expect(task).toContain('Question:');
  });
});
