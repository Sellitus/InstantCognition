const { matchSkills, readSkillSettings } = require('../../../../../main/agent/skills/skillMatcher');

const SKILLS = [
  { name: 'pdf-extract', description: 'Extract tables and text from PDF files', triggers: ['pdf table'] },
  { name: 'git-commit-msg', description: 'Write a conventional git commit message from the staged diff' },
  { name: 'travel-plan', description: 'Plan a trip itinerary with flights and hotels' },
];

describe('skillMatcher.matchSkills', () => {
  test('ranks the skill whose description shares rare terms with the request', () => {
    const res = matchSkills('write a commit message for my staged changes', SKILLS, { threshold: 0.35 });
    expect(res.map((r) => r.name)).toEqual(['git-commit-msg']);
    expect(res[0].reason).toBe('similarity');
    expect(res[0].score).toBeGreaterThanOrEqual(0.35);
  });

  test('a trigger phrase in the request scores 1', () => {
    expect(matchSkills('pull the PDF table out please', SKILLS, { threshold: 0.99 }))
      .toEqual([{ name: 'pdf-extract', score: 1, reason: 'trigger' }]);
  });

  test('an unrelated request matches nothing at the default threshold', () => {
    expect(matchSkills('what is the weather tomorrow', SKILLS)).toEqual([]);
  });

  test('a higher threshold drops a weaker match', () => {
    const q = 'book flights and hotels for my trip to rome';
    expect(matchSkills(q, SKILLS, { threshold: 0.35 }).map((r) => r.name)).toEqual(['travel-plan']);
    expect(matchSkills(q, SKILLS, { threshold: 0.95 })).toEqual([]);
  });

  test('empty inputs return no matches', () => {
    expect(matchSkills('', SKILLS)).toEqual([]);
    expect(matchSkills('commit message', [])).toEqual([]);
    expect(matchSkills('commit message', /** @type {any} */ (null))).toEqual([]);
  });
});

describe('skillMatcher.readSkillSettings', () => {
  const cs = (v) => ({ get: jest.fn(() => v) });

  test('reads the configured values', () => {
    expect(readSkillSettings(cs({ autoTrigger: false, matchThreshold: 0.6 }))).toEqual({ autoTrigger: false, matchThreshold: 0.6 });
  });

  test('falls back to defaults for missing or out-of-range values', () => {
    expect(readSkillSettings(cs({ autoTrigger: 'yes', matchThreshold: 7 }))).toEqual({ autoTrigger: true, matchThreshold: 0.35 });
    expect(readSkillSettings(null)).toEqual({ autoTrigger: true, matchThreshold: 0.35 });
  });
});
