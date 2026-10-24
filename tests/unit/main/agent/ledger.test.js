const { init, patch, render } = require('../../../../main/agent/ledger');

describe('ledger', () => {
  test('init produces an empty well-formed ledger with the task set', () => {
    const l = init({ task: 'Buy tickets' });
    expect(l).toEqual({ task: 'Buy tickets', facts_known: [], facts_to_verify: [], plan: [], progress: '', blockers: [] });
  });

  test('patch replaces facts_known wholesale', () => {
    const l = init({ task: 't' });
    const next = patch(l, { facts_known: ['A', 'B'] });
    expect(next.facts_known).toEqual(['A', 'B']);
    expect(l.facts_known).toEqual([]); // immutable
  });

  test('patch supports additive facts_known_add', () => {
    const l = patch(init({ task: 't' }), { facts_known: ['A'] });
    const next = patch(l, { facts_known_add: ['B', 'C'] });
    expect(next.facts_known).toEqual(['A', 'B', 'C']);
  });

  test('patch.steps maps string[] to plan entries with status=todo', () => {
    const l = patch(init({ task: 't' }), { steps: ['one', 'two'] });
    expect(l.plan).toEqual([{ step: 'one', status: 'todo' }, { step: 'two', status: 'todo' }]);
  });

  test('patch.plan.set replaces the plan and accepts object entries', () => {
    const l = patch(init({ task: 't' }), { plan: { set: [{ step: 'a', status: 'doing' }, 'b'] } });
    expect(l.plan).toEqual([{ step: 'a', status: 'doing' }, { step: 'b', status: 'todo' }]);
  });

  test('patch.plan.append adds to end', () => {
    const l = patch(init({ task: 't' }), { steps: ['a'] });
    const next = patch(l, { plan: { append: ['b', { step: 'c', status: 'blocked' }] } });
    expect(next.plan.map((p) => p.step)).toEqual(['a', 'b', 'c']);
    expect(next.plan[2].status).toBe('blocked');
  });

  test('patch.plan.update flips a step status by index', () => {
    const l = patch(init({ task: 't' }), { steps: ['a', 'b', 'c'] });
    const next = patch(l, { plan: { update: { index: 1, status: 'done', note: 'ok' } } });
    expect(next.plan[1]).toEqual({ step: 'b', status: 'done', note: 'ok' });
    expect(next.plan[0].status).toBe('todo');
  });

  test('patch.plan.remove drops a step by index', () => {
    const l = patch(init({ task: 't' }), { steps: ['a', 'b', 'c'] });
    const next = patch(l, { plan: { remove: 1 } });
    expect(next.plan.map((p) => p.step)).toEqual(['a', 'c']);
  });

  test('patch.plan.update rejects unknown statuses by clamping to todo', () => {
    const l = patch(init({ task: 't' }), { steps: ['a'] });
    const next = patch(l, { plan: { update: { index: 0, status: 'nonsense' } } });
    expect(next.plan[0].status).toBe('todo');
  });

  test('render produces a compact block with status markers', () => {
    const l = patch(init({ task: 'Find tickets' }), {
      progress: 'viewed results',
      facts_known: ['Date is Friday'],
      facts_to_verify: ['price'],
      steps: ['search', 'filter', 'checkout'],
    });
    const withDone = patch(l, { plan: { update: { index: 0, status: 'done' } } });
    const out = render(withDone);
    expect(out).toContain('Find tickets');
    expect(out).toContain('Progress: viewed results');
    expect(out).toMatch(/Date is Friday/);
    expect(out).toMatch(/\[x] search/);
    expect(out).toMatch(/\[ ] filter/);
  });

  test('render on empty ledger returns just the task line', () => {
    const out = render(init({ task: 'do stuff' }));
    expect(out).toBe('Ledger for task: do stuff');
  });
});
