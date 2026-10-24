const { toAgentMessages, toChatMessages, compactionRecap, countTokens, RESULT_MAX_CHARS } = require('../../../../../main/agent/sessions/contextProjection');

const node = (id, role, kind, content, data) => ({ id, parentId: null, role, kind, content, ...(data ? { data } : {}) });

const toolTurn = [
  node('n_1', 'user', 'message', 'open example'),
  node('n_2', 'assistant', 'tool_calls', '', { calls: [{ id: 'c1', name: 'browser.navigate', args: { url: 'https://example.com' } }] }),
  node('n_3', 'tool', 'tool_results', '', { results: [{ id: 'c1', name: 'browser.navigate', content: 'loaded' }] }),
  node('n_4', 'assistant', 'message', 'done'),
];

describe('contextProjection.toAgentMessages', () => {
  test('native mode replays tool_calls and one role:tool message per result', () => {
    expect(toAgentMessages(toolTurn, { mode: 'tools' })).toEqual([
      { role: 'user', content: 'open example' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser.navigate', arguments: '{"url":"https://example.com"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'loaded' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  test('json mode replays calls as text and rolls results into a Results: user turn', () => {
    const out = toAgentMessages(toolTurn, { mode: 'json' });
    expect(out[1]).toEqual({ role: 'assistant', content: JSON.stringify([{ tool: 'browser.navigate', args: { url: 'https://example.com' } }]) });
    expect(out[2]).toEqual({ role: 'user', content: 'Results:\n1. browser.navigate → loaded' });
  });

  test('a tool_calls node whose results never landed is replayed as text even in native mode', () => {
    const out = toAgentMessages(toolTurn.slice(0, 2), { mode: 'tools' });
    expect(out[1].tool_calls).toBeUndefined();
    expect(out[1].content).toContain('browser.navigate');
  });

  test('compaction replaces earlier turns; error and plan nodes never reach the model', () => {
    const nodes = [
      node('n_1', 'user', 'message', 'old'),
      node('n_2', 'assistant', 'compaction', 'we did X'),
      node('n_3', 'assistant', 'error', 'boom'),
      node('n_4', 'assistant', 'plan', '1. step'),
      node('n_5', 'user', 'message', 'new'),
    ];
    expect(toAgentMessages(nodes, {})).toEqual([{ role: 'user', content: 'new' }]);
    expect(compactionRecap(nodes)).toBe('[Compacted earlier turns] Summary of prior progress:\nwe did X');
    expect(compactionRecap(nodes.slice(2))).toBe('');
  });

  test('oversize tool results are truncated with a marker', () => {
    const big = 'x'.repeat(RESULT_MAX_CHARS + 10);
    const out = toAgentMessages([
      node('n_1', 'assistant', 'tool_calls', '', { calls: [{ id: 'c', name: 'fs.read' }] }),
      node('n_2', 'tool', 'tool_results', '', { results: [{ id: 'c', name: 'fs.read', content: big }] }),
    ], { mode: 'tools' });
    expect(out[1].content).toHaveLength(RESULT_MAX_CHARS + '…[truncated 10 bytes]'.length);
  });

  test('tolerates non-array input and malformed call data', () => {
    expect(toAgentMessages(null)).toEqual([]);
    expect(toAgentMessages([node('n_1', 'assistant', 'tool_calls', '', { calls: [null, { args: {} }] })], { mode: 'tools' }))
      .toEqual([{ role: 'assistant', content: '[]' }]);
  });
});

describe('contextProjection.toChatMessages', () => {
  const turns = [
    node('n_1', 'user', 'message', 'a'.repeat(400)),
    node('n_2', 'assistant', 'message', 'b'.repeat(400)),
    node('n_3', 'user', 'message', 'latest question'),
  ];

  test('keeps only user/assistant turns and prepends system and summary', () => {
    const out = toChatMessages([node('n_0', 'assistant', 'compaction', 'sum'), ...turns], { system: 'sys' });
    expect(out.map((m) => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'user']);
    expect(out[1].content).toContain('sum');
  });

  test('drops the oldest turns to fit the budget', () => {
    const out = toChatMessages(turns, { budgetTokens: 120 });
    expect(out.map((m) => m.content)).toEqual(['b'.repeat(400), 'latest question']);
    expect(countTokens(out)).toBeLessThanOrEqual(120);
  });

  test('always keeps the newest turn even when it alone exceeds the budget', () => {
    const out = toChatMessages([node('n_1', 'user', 'message', 'z'.repeat(4000))], { budgetTokens: 10 });
    expect(out).toHaveLength(1);
  });
});

describe('compaction through the session store', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { createSessionStore } = require('../../../../../main/agent/sessions/sessionStore');
  let dir, store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-projection-'));
    store = createSessionStore({ baseDir: dir });
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('the next turn sees only the latest summary plus what follows it, tool replay intact', () => {
    const s = store.create();
    store.append(s.id, { role: 'user', content: 'first question' });
    store.append(s.id, { role: 'assistant', content: 'first answer' });
    store.append(s.id, { role: 'system', kind: 'compaction', content: 'summary one' });
    store.append(s.id, { role: 'user', content: 'second question' });
    store.append(s.id, { role: 'system', kind: 'compaction', content: 'summary two' });
    store.append(s.id, { role: 'user', content: 'open example' });
    store.append(s.id, { role: 'assistant', kind: 'tool_calls', content: '', data: { calls: [{ id: 'c1', name: 'browser.navigate', args: { url: 'https://example.com' } }] } });
    store.append(s.id, { role: 'tool', kind: 'tool_results', content: '', data: { results: [{ id: 'c1', name: 'browser.navigate', content: 'loaded' }] } });
    const nodes = store.getPath(s.id);

    const agent = toAgentMessages(nodes, { mode: 'tools' });
    expect(compactionRecap(nodes)).toBe('[Compacted earlier turns] Summary of prior progress:\nsummary two');
    expect(agent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const text = JSON.stringify(agent);
    for (const gone of ['first question', 'first answer', 'summary one', 'second question']) expect(text).not.toContain(gone);

    const chat = toChatMessages(nodes);
    expect(chat.map((m) => m.content)).toEqual([expect.stringContaining('summary two'), 'open example']);
  });

  test('without a compaction node every turn is replayed', () => {
    const s = store.create();
    store.append(s.id, { role: 'user', content: 'q' });
    store.append(s.id, { role: 'assistant', content: 'a' });
    expect(toAgentMessages(store.getPath(s.id), { mode: 'json' })).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
  });
});
