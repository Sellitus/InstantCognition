// agent.done's short-summary handling: rejects up to DONE_MAX_SHORT_RETRIES (2)
// times to push the model toward a real answer, then accepts whatever it has so
// the user gets *something* instead of a max_steps_exceeded failure.

const ledgerModule = require('../../../../../main/agent/ledger');

const tools = require('../../../../../main/agent/tools/agentCore');
const done = tools.find((t) => t.name === 'agent.done');
const askUser = tools.find((t) => t.name === 'agent.ask_user');
const setPlan = tools.find((t) => t.name === 'agent.set_plan');
const updateLedger = tools.find((t) => t.name === 'agent.update_ledger');

describe('agent.done short-summary handling', () => {
  test('accepts a long enough summary on first call', async () => {
    const r = await done.handler({ summary: 'Reddit front page is dominated by ai discussion today.' }, {}, {});
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/Reddit/);
  });

  test('rejects a too-short summary on first attempt and bumps the counter', async () => {
    const ctx = {};
    const r = await done.handler({ summary: 'done' }, ctx, { taskDescription: 'tell me about reddit' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('summary_too_short');
    // Hint includes the user's task verbatim so the next attempt has guidance.
    expect(r.hint).toMatch(/tell me about reddit/);
    expect(ctx._doneShortAttempts).toBe(1);
  });

  test('second short attempt still rejects but with stronger "final retry" hint', async () => {
    const ctx = { _doneShortAttempts: 1 };
    const r = await done.handler({ summary: 'ok' }, ctx, { taskDescription: 't' });
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/final retry/i);
    expect(ctx._doneShortAttempts).toBe(2);
  });

  test('third short attempt is ACCEPTED so the runtime exits gracefully instead of looping until max_steps', async () => {
    const ctx = { _doneShortAttempts: 2 };
    const r = await done.handler({ summary: 'too brief' }, ctx, { taskDescription: 't' });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('too brief');
    expect(r.shortAcceptedAfterRetries).toBe(true);
  });

  test('long summary on retry is accepted normally and not flagged as short-accepted', async () => {
    const ctx = { _doneShortAttempts: 1 };
    const r = await done.handler({ summary: 'Top of Reddit today: an AI policy thread, two sports recaps, and a viral programming joke.' }, ctx, {});
    expect(r.ok).toBe(true);
    expect(r.shortAcceptedAfterRetries).toBe(false);
  });

  test('handles a missing/empty summary argument without throwing', async () => {
    const r = await done.handler(undefined, { _doneShortAttempts: 2 }, undefined);
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('');
  });
});

describe('agent.ask_user', () => {
  test('returns an awaitingUser pause signal with the question', async () => {
    const r = await askUser.handler({ question: 'Which account?' });
    expect(r).toEqual({ ok: true, awaitingUser: true, question: 'Which account?' });
  });

  test('coerces a missing question to an empty string', async () => {
    const r = await askUser.handler({});
    expect(r.question).toBe('');
  });
});

describe('agent.set_plan', () => {
  test('maps a steps array into the ledger and emits plan-updated', async () => {
    const ledger = ledgerModule.init({ task: 'demo' });
    const emit = jest.fn();
    const r = await setPlan.handler({ steps: ['one', 'two'] }, { ledger }, { emit });
    expect(r).toEqual({ ok: true, steps: ['one', 'two'] });
    // Ledger mutated in place so later turns observe the plan.
    expect(ledger.plan.length).toBe(2);
    expect(emit).toHaveBeenCalledWith('plan-updated', { steps: ['one', 'two'] });
  });

  test('stringifies non-string step entries and tolerates a missing ledger/emit', async () => {
    const r = await setPlan.handler({ steps: [1, true] }, {}, {});
    expect(r).toEqual({ ok: true, steps: ['1', 'true'] });
  });

  test('non-array steps degrade to an empty plan', async () => {
    const r = await setPlan.handler({ steps: 'nope' }, null, null);
    expect(r).toEqual({ ok: true, steps: [] });
  });
});

describe('agent.update_ledger', () => {
  test('returns no_ledger when toolCtx has no ledger', async () => {
    const r = await updateLedger.handler({ progress: 'x' }, {}, {});
    expect(r).toEqual({ ok: false, error: 'no_ledger' });
  });

  test('patches the ledger in place and emits the ledger snapshot', async () => {
    const ledger = ledgerModule.init({ task: 'demo' });
    const emit = jest.fn();
    const r = await updateLedger.handler(
      { progress: 'halfway', facts_known_add: ['fact A'] },
      { ledger },
      { emit },
    );
    expect(r.ok).toBe(true);
    expect(ledger.progress).toBe('halfway');
    expect(ledger.facts_known).toContain('fact A');
    expect(emit).toHaveBeenCalledWith('plan-updated', { ledger: expect.objectContaining({ progress: 'halfway' }) });
  });

  test('tolerates a missing args object and a missing emit', async () => {
    const ledger = ledgerModule.init({ task: 'demo' });
    const r = await updateLedger.handler(undefined, { ledger }, {});
    expect(r.ok).toBe(true);
  });
});
