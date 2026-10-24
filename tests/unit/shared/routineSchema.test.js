// Pure schema/scheduling logic — no timers, all clock values injected.

const {
  validateRoutine, normalizeRoutine, isDue, computeNextRun, describeSchedule,
} = require('../../../shared/routineSchema');

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

describe('validateRoutine', () => {
  test('requires name + task', () => {
    expect(validateRoutine({}).ok).toBe(false);
    expect(validateRoutine({ name: 'x', task: 'y', schedule: { kind: 'interval', everyMinutes: 30 } }).ok).toBe(true);
    const v = validateRoutine({ name: '  ', task: '', schedule: { kind: 'interval', everyMinutes: 30 } });
    expect(v.errors).toEqual(expect.arrayContaining(['missing:name', 'missing:task']));
  });

  test('rejects bad schedules', () => {
    expect(validateRoutine({ name: 'a', task: 'b' }).errors).toContain('missing:schedule');
    expect(validateRoutine({ name: 'a', task: 'b', schedule: { kind: 'weekly' } }).errors).toContain('enum:schedule.kind');
    expect(validateRoutine({ name: 'a', task: 'b', schedule: { kind: 'interval', everyMinutes: 1 } }).errors).toContain('range:everyMinutes');
    expect(validateRoutine({ name: 'a', task: 'b', schedule: { kind: 'daily', atHour: 25, atMinute: 0 } }).errors).toContain('range:atHour');
    expect(validateRoutine({ name: 'a', task: 'b', schedule: { kind: 'daily', atHour: 8, atMinute: 99 } }).errors).toContain('range:atMinute');
  });
});

describe('normalizeRoutine', () => {
  test('fills defaults and derives an id from the name when missing', () => {
    const r = normalizeRoutine({ name: 'Morning Digest', task: ' do it ' });
    expect(r.id).toBe('morning-digest');
    expect(r.task).toBe('do it');
    expect(r.enabled).toBe(true);
    expect(r.lastRunAt).toBeNull();
    expect(r.schedule).toEqual({ kind: 'interval', everyMinutes: 60 });
  });

  test('clamps daily fields and preserves an explicit id', () => {
    const r = normalizeRoutine({ id: 'keep', name: 'n', task: 't', schedule: { kind: 'daily', atHour: 30, atMinute: -5 } });
    expect(r.id).toBe('keep');
    expect(r.schedule).toEqual({ kind: 'daily', atHour: 23, atMinute: 0 });
  });

  test('enforces the 5-minute interval floor', () => {
    expect(normalizeRoutine({ name: 'n', task: 't', schedule: { kind: 'interval', everyMinutes: 1 } }).schedule.everyMinutes).toBe(5);
  });
});

describe('isDue — interval', () => {
  const base = { name: 'n', task: 't', schedule: { kind: 'interval', everyMinutes: 30 }, enabled: true };

  test('first run (no lastRunAt) is due immediately', () => {
    expect(isDue({ ...base, lastRunAt: null }, 1_000_000)).toBe(true);
  });

  test('not due until the interval elapses, then due', () => {
    const now = 10 * HOUR;
    expect(isDue({ ...base, lastRunAt: now - 10 * MIN }, now)).toBe(false);
    expect(isDue({ ...base, lastRunAt: now - 31 * MIN }, now)).toBe(true);
  });

  test('disabled routines are never due', () => {
    expect(isDue({ ...base, enabled: false, lastRunAt: null }, 1_000_000)).toBe(false);
  });
});

describe('isDue — daily', () => {
  // 2026-05-16; pick a clear local-time anchor and derive offsets from it.
  const noon = new Date(2026, 4, 16, 12, 0, 0, 0).getTime();
  const eightAm = new Date(2026, 4, 16, 8, 0, 0, 0).getTime();
  const daily = { name: 'n', task: 't', schedule: { kind: 'daily', atHour: 8, atMinute: 0 }, enabled: true };

  test('not due before the scheduled minute', () => {
    expect(isDue({ ...daily, lastRunAt: null }, eightAm - 60000)).toBe(false);
  });

  test('due after the scheduled minute when it has not run today (missed-digest case)', () => {
    expect(isDue({ ...daily, lastRunAt: null }, noon)).toBe(true);
    expect(isDue({ ...daily, lastRunAt: noon - DAY }, noon)).toBe(true); // ran yesterday
  });

  test('not due again once it has run since today\'s scheduled time', () => {
    expect(isDue({ ...daily, lastRunAt: eightAm + 60000 }, noon)).toBe(false);
  });
});

describe('computeNextRun', () => {
  test('interval: lastRunAt + period, or now + period on first run', () => {
    const now = 5 * HOUR;
    expect(computeNextRun({ name: 'n', task: 't', schedule: { kind: 'interval', everyMinutes: 30 }, lastRunAt: null }, now)).toBe(now + 30 * MIN);
    expect(computeNextRun({ name: 'n', task: 't', schedule: { kind: 'interval', everyMinutes: 30 }, lastRunAt: now }, now)).toBe(now + 30 * MIN);
  });

  test('daily: today if upcoming, tomorrow if already passed', () => {
    const r = { name: 'n', task: 't', schedule: { kind: 'daily', atHour: 8, atMinute: 0 } };
    const before = new Date(2026, 4, 16, 7, 0, 0, 0).getTime();
    const after = new Date(2026, 4, 16, 9, 0, 0, 0).getTime();
    const target = new Date(2026, 4, 16, 8, 0, 0, 0).getTime();
    expect(computeNextRun(r, before)).toBe(target);
    expect(computeNextRun(r, after)).toBe(target + DAY);
  });
});

describe('describeSchedule', () => {
  test('humanizes interval and daily', () => {
    expect(describeSchedule({ name: 'n', task: 't', schedule: { kind: 'interval', everyMinutes: 45 } })).toBe('Every 45 minutes');
    expect(describeSchedule({ name: 'n', task: 't', schedule: { kind: 'interval', everyMinutes: 120 } })).toBe('Every 2 hours');
    expect(describeSchedule({ name: 'n', task: 't', schedule: { kind: 'daily', atHour: 8, atMinute: 5 } })).toBe('Daily at 08:05');
  });
});
