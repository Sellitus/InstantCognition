// ContextMeter — the composer's context ring against a mocked IPC boundary:
// thresholds, tooltip text, usage from agent:tokens / session:event /
// session:context-usage, compaction on click, and surfaced failures.

const { EventEmitter } = require('events');
const ContextMeter = require('../../../../../renderer/components/assistant/ContextMeter');
const { levelFor } = ContextMeter;

const flush = () => new Promise((r) => setTimeout(r, 0));

let meter, ipc, routes, errors;

function mockIpc(r) {
  const em = new EventEmitter();
  return {
    invoke: jest.fn((ch, arg) => Promise.resolve().then(() => r[ch](arg))),
    on: jest.fn((ch, fn) => em.on(ch, fn)),
    removeListener: jest.fn((ch, fn) => em.removeListener(ch, fn)),
    fire: (ch, payload) => em.emit(ch, {}, payload),
    count: (ch) => em.listenerCount(ch),
  };
}

function make(r = {}, opts = {}) {
  routes = {
    'session:context-usage': jest.fn(() => ({ ok: true, tokens: 1000, contextSize: 8000, ratio: 0.125, messages: 4 })),
    'session:compact': jest.fn(() => ({ ok: true, nodeId: 'n_9', coveredMessages: 4 })),
    ...r,
  };
  ipc = mockIpc(routes);
  errors = [];
  meter = new ContextMeter({ ipc, onError: (m) => errors.push(m), ...opts });
  document.body.appendChild(meter.el);
  return meter;
}

afterEach(() => { if (meter) meter.destroy(); });

describe('levelFor thresholds', () => {
  test.each([
    [null, 'unknown'], [NaN, 'unknown'], [0, 'ok'], [0.799, 'ok'], [0.8, 'warn'], [0.949, 'warn'], [0.95, 'danger'], [1.4, 'danger'],
  ])('%p → %s', (ratio, level) => { expect(levelFor(ratio)).toBe(level); });
});

describe('ContextMeter rendering', () => {
  test('starts unknown, then shows tokens / context size in the tooltip and ring', () => {
    make();
    expect(meter.el.dataset.level).toBe('unknown');
    expect(meter.el.title).toContain('Context usage unknown');
    meter.update({ tokens: 6500, contextSize: 8000 });
    expect(meter.el.dataset.level).toBe('warn');
    expect(meter.el.title).toBe('6,500 / 8,000 tokens (81%). Click to compact the conversation');
    expect(meter.el.getAttribute('aria-label')).toContain('6,500 / 8,000 tokens');
    const arc = meter.el.querySelector('.context-meter__arc');
    const circ = Number(arc.getAttribute('stroke-dasharray').split(' ')[0]);
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(circ * (1 - 0.8125), 5);
  });

  test('red at 95% and the ring never overfills past 100%', () => {
    make();
    meter.update({ tokens: 7600, contextSize: 8000 });
    expect(meter.el.dataset.level).toBe('danger');
    meter.update({ tokens: 9000 });
    expect(Number(meter.el.querySelector('.context-meter__arc').getAttribute('stroke-dashoffset'))).toBe(0);
  });

  test('negative or non-numeric usage is ignored', () => {
    make();
    meter.update({ tokens: 100, contextSize: 1000 });
    meter.update({ tokens: -5, contextSize: 'x' });
    expect(meter.ratio()).toBeCloseTo(0.1);
  });
});

describe('ContextMeter usage sources', () => {
  test('agent:tokens adopts the run session and shows contextTokens, not cumulative tokensUsed', () => {
    make();
    ipc.fire('agent:tokens', { sessionId: 's_aaaa1111', tokensUsed: 50000, contextTokens: 3000, contextSize: 4000, step: 3 });
    expect(meter.sessionId).toBe('s_aaaa1111');
    expect(meter.el.title).toContain('3,000 / 4,000 tokens (75%)');
    ipc.fire('agent:tokens', { sessionId: 's_aaaa1111', tokensUsed: 51000, contextTokens: 0, contextSize: 4000 });
    expect(meter.el.title).toContain('3,000 / 4,000');
  });

  test('events for another session or another panel scope are ignored', async () => {
    make({}, { scopeMatches: (p) => p.scope !== 'tab' });
    await meter.setSessionId('s_mine0001');
    ipc.fire('agent:tokens', { sessionId: 's_other001', contextTokens: 3900, contextSize: 4000 });
    ipc.fire('agent:tokens', { sessionId: 's_mine0001', scope: 'tab', contextTokens: 3900, contextSize: 4000 });
    ipc.fire('session:event', { sessionId: 's_other001', channel: 'agent-tokens', payload: { contextTokens: 3900, contextSize: 4000 } });
    expect(meter.el.title).toContain('1,000 / 8,000');
  });

  test('a background run updates through session:event agent-tokens', async () => {
    make();
    await meter.setSessionId('s_bg000001');
    ipc.fire('session:event', { sessionId: 's_bg000001', channel: 'agent-tokens', payload: { contextTokens: 7700, contextSize: 8000 } });
    expect(meter.level()).toBe('danger');
  });

  test('a run starting in this scope switches the meter to its session and refreshes', async () => {
    make();
    ipc.fire('agent:task-started', { sessionId: 's_new00001' });
    await flush();
    expect(meter.sessionId).toBe('s_new00001');
    expect(routes['session:context-usage']).toHaveBeenCalledWith({ sessionId: 's_new00001' });
    expect(meter.el.title).toContain('1,000 / 8,000');
  });

  test('a compaction elsewhere refreshes the usage', async () => {
    make();
    await meter.setSessionId('s_cmp00001');
    routes['session:context-usage'].mockReturnValue({ ok: true, tokens: 200, contextSize: 8000 });
    ipc.fire('session:event', { sessionId: 's_cmp00001', channel: 'compacted', payload: {} });
    await flush();
    expect(meter.el.title).toContain('200 / 8,000');
  });

  test('a failed usage read is surfaced', async () => {
    make({ 'session:context-usage': jest.fn(() => ({ ok: false, error: 'invalid_session_id' })) });
    await meter.setSessionId('s_bad00001');
    expect(errors).toEqual(['Couldn’t read the context size: invalid_session_id']);
  });

  test('destroy removes every listener', () => {
    make();
    meter.destroy();
    for (const ch of ['agent:tokens', 'agent:task-started', 'agent:compacted', 'session:event']) expect(ipc.count(ch)).toBe(0);
    meter = null;
  });
});

describe('ContextMeter compaction', () => {
  test('click sends session:compact for the session, then re-reads the usage', async () => {
    make();
    await meter.setSessionId('s_cc000001');
    routes['session:context-usage'].mockReturnValue({ ok: true, tokens: 300, contextSize: 8000 });
    meter.el.click();
    expect(meter.el.getAttribute('aria-busy')).toBe('true');
    await flush();
    expect(routes['session:compact']).toHaveBeenCalledWith({ sessionId: 's_cc000001' });
    expect(meter.el.title).toContain('300 / 8,000');
    expect(meter.el.getAttribute('aria-busy')).toBe('false');
    expect(errors).toEqual([]);
  });

  test('a second click while compacting does not send again', async () => {
    make();
    await meter.setSessionId('s_cc000002');
    meter.el.click();
    meter.el.click();
    await flush();
    expect(routes['session:compact']).toHaveBeenCalledTimes(1);
  });

  test('a refused compaction is surfaced and resolves false', async () => {
    make({ 'session:compact': jest.fn(() => ({ ok: false, error: 'session_busy' })) });
    await meter.setSessionId('s_cc000003');
    await expect(meter.compact()).resolves.toBe(false);
    expect(errors).toEqual(['Couldn’t compact the conversation: session_busy']);
  });

  test('with no session it reports instead of calling the main process', async () => {
    make();
    await expect(meter.compact()).resolves.toBe(false);
    expect(routes['session:compact']).not.toHaveBeenCalled();
    expect(errors[0]).toMatch(/Nothing to compact/);
  });
});
