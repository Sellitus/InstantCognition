const {
  QualityModeService, resolveMode, withOverride, listModes, isMode, MODES, tightenOverride,
} = require('../../../../main/services/QualityModeService');

describe('QualityModeService', () => {
  test('lists efficient, balanced, ultra modes', () => {
    expect(listModes().sort()).toEqual(['balanced', 'efficient', 'ultra']);
  });

  test('efficient has tightest budget and single-sample', () => {
    const m = resolveMode('efficient');
    expect(m.budget.maxSteps).toBeLessThan(MODES.balanced.budget.maxSteps);
    expect(m.sampling.bestOf).toBe(1);
    expect(m.vision).toBe('off');
    expect(m.worldModel).toBe(false);
  });

  test('ultra enables best-of-5, world-model, forced vision, and uncapped tokens', () => {
    const m = resolveMode('ultra');
    expect(m.sampling.bestOf).toBe(5);
    expect(m.worldModel).toBe(true);
    expect(m.vision).toBe('forced');
    expect(m.budget.maxTokens).toBe(0); // uncapped
    expect(m.judges.policy).toBe('all_mutating');
  });

  test('unknown mode falls back to balanced', () => {
    const m = resolveMode('moon');
    expect(m.name).toBe('balanced');
  });

  test('withOverride shallow-merges sub-objects', () => {
    const m = resolveMode('balanced');
    const ovr = withOverride(m, { budget: { maxSteps: 7 }, vision: 'forced' });
    expect(ovr.budget.maxSteps).toBe(7);
    expect(ovr.budget.maxTokens).toBe(MODES.balanced.budget.maxTokens); // untouched
    expect(ovr.vision).toBe('forced');
  });

  test('service.resolve reads config and applies override', () => {
    const svc = new QualityModeService();
    const config = new Map();
    config.set('settings.llm.agent', { qualityMode: 'efficient', qualityOverride: { budget: { maxSteps: 5 } } });
    svc.bindConfig({ get: (k, fallback) => (config.has(k) ? config.get(k) : fallback) });
    const m = svc.resolve();
    expect(m.name).toBe('efficient');
    expect(m.budget.maxSteps).toBe(5);
  });

  test('resolve keeps the configured qualityOverride under a skill override', () => {
    const svc = new QualityModeService();
    svc.bindConfig({ get: (k, d) => (k === 'settings.llm.agent' ? { qualityMode: 'balanced', qualityOverride: { budget: { maxSteps: 5 }, vision: 'forced' } } : d) });
    const m = svc.resolve({ judges: { policy: 'all_mutating' }, budget: { maxSeconds: 60 } });
    expect(m.name).toBe('balanced');
    expect(m.vision).toBe('forced');
    expect(m.budget).toEqual({ ...MODES.balanced.budget, maxSteps: 5, maxSeconds: 60 });
    expect(m.judges.policy).toBe('all_mutating');
  });

  test('withOverride layers onto the given mode, not a fresh preset', () => {
    const tuned = withOverride(resolveMode('balanced'), { budget: { maxSteps: 3 } });
    const out = withOverride({ ...tuned, name: 'balanced' }, { sampling: { bestOf: 2 } });
    expect(out.budget.maxSteps).toBe(3);
    expect(out.sampling.bestOf).toBe(2);
    expect(withOverride({ name: 'efficient' }, {}).budget).toEqual(MODES.efficient.budget);
  });

  test('skillOverride layers on top of config', () => {
    const svc = new QualityModeService();
    const config = new Map();
    config.set('settings.llm.agent', { qualityMode: 'balanced' });
    svc.bindConfig({ get: (k, fallback) => (config.has(k) ? config.get(k) : fallback) });
    const m = svc.resolve({ sampling: { bestOf: 3 } });
    expect(m.name).toBe('balanced');
    expect(m.sampling.bestOf).toBe(3);
    expect(m.sampling.confidenceThreshold).toBe(MODES.balanced.sampling.confidenceThreshold);
  });

  test('isMode guards against typos', () => {
    expect(isMode('efficient')).toBe(true);
    expect(isMode('Efficient')).toBe(false);
    expect(isMode(null)).toBe(false);
  });
});

describe('tightenOverride', () => {
  test('keeps only lowered budgets and stricter policies', () => {
    const base = resolveMode('balanced');
    expect(tightenOverride(base, {
      budget: { maxSteps: 5, maxTokens: 0, maxSeconds: 99999, maxNavigations: -1 },
      judges: { policy: 'all_mutating' },
      shadowFork: { policy: 'off' },
      draftVerify: { drafts: 'remote', verify: 'every_step' },
      sampling: { bestOf: 50 },
      vision: 'forced',
      name: 'ultra',
    })).toEqual({ budget: { maxSteps: 5 }, judges: { policy: 'all_mutating' }, draftVerify: { verify: 'every_step' } });
  });

  test('a policy cannot be lowered or switched off', () => {
    const base = resolveMode('balanced');
    expect(tightenOverride(base, { judges: { policy: 'payment_auth' }, shadowFork: { policy: 'off' } })).toEqual({});
    expect(tightenOverride(base, { judges: { policy: 'none' }, draftVerify: { verify: 'never' } })).toEqual({});
    expect(tightenOverride(base, { judges: { policy: 'destructive' } })).toEqual({});
  });

  test('an uncapped base budget accepts any positive ceiling; fractions that floor to 0 are dropped', () => {
    const ultra = resolveMode('ultra');
    expect(tightenOverride(ultra, { budget: { maxTokens: 1000 } })).toEqual({ budget: { maxTokens: 1000 } });
    expect(tightenOverride(ultra, { budget: { maxTokens: 0.5, maxSteps: '5', maxSeconds: Infinity } })).toEqual({});
  });

  test('junk overrides yield nothing', () => {
    const base = resolveMode('balanced');
    for (const junk of [null, undefined, 'x', [], { budget: [1, 2] }, { judges: 'all_mutating' }]) {
      expect(tightenOverride(base, junk)).toEqual({});
    }
  });
});
