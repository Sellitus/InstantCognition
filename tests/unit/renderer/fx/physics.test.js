// Pure geometry/physics helpers behind the canvas effects.
const { spawnBurst, stepParticles, drawParticles } = require('../../../../renderer/fx/particles');
const { perimeterPoint } = require('../../../../renderer/fx/summon');
const { arcPoint } = require('../../../../renderer/fx/comets');
const { makeStars, stepStars } = require('../../../../renderer/fx/starfield');
const { orbRadius } = require('../../../../renderer/fx/voiceOrb');
const { similarity } = require('../../../../renderer/fx/council');

function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('fx/particles', () => {
  test('spawnBurst creates count particles inside the source rect', () => {
    const ps = spawnBurst({ x: 10, y: 20, w: 100, h: 30, count: 12, rng: seq([0.1, 0.5, 0.9, 0.3]) });
    expect(ps).toHaveLength(12);
    for (const p of ps) {
      expect(p.x).toBeGreaterThanOrEqual(10);
      expect(p.x).toBeLessThanOrEqual(110);
      expect(p.y).toBeGreaterThanOrEqual(20);
      expect(p.y).toBeLessThanOrEqual(50);
      expect(p.life).toBe(p.max);
    }
  });

  test('stepParticles integrates gravity and drops expired particles in place', () => {
    const ps = [
      { x: 0, y: 0, vx: 10, vy: 0, life: 1, max: 1, size: 1, color: '#fff' },
      { x: 0, y: 0, vx: 0, vy: 0, life: 0.01, max: 1, size: 1, color: '#fff' },
    ];
    const live = stepParticles(ps, 0.1, { gravity: 100, drag: 0 });
    expect(live).toBe(1);
    expect(ps).toHaveLength(1);
    expect(ps[0].vy).toBeCloseTo(10, 6);
    expect(ps[0].x).toBeCloseTo(1, 6);
    expect(stepParticles(ps, 2)).toBe(0);
  });

  test('drawParticles restores globalAlpha after drawing', () => {
    const ctx = { globalAlpha: 1, fillStyle: '', beginPath: jest.fn(), arc: jest.fn(), fill: jest.fn() };
    drawParticles(ctx, [{ x: 1, y: 2, life: 0.5, max: 1, size: 2, color: '#f00' }]);
    expect(ctx.fill).toHaveBeenCalledTimes(1);
    expect(ctx.globalAlpha).toBe(1);
  });
});

describe('fx/summon perimeterPoint', () => {
  test('walks clockwise from top centre', () => {
    expect(perimeterPoint(0, 100, 50)).toEqual({ x: 50, y: 0 });
    expect(perimeterPoint(50, 100, 50)).toEqual({ x: 100, y: 0 });
    expect(perimeterPoint(100, 100, 50)).toEqual({ x: 100, y: 50 });
    expect(perimeterPoint(300, 100, 50)).toEqual({ x: 50, y: 0 });
  });

  test('negative arc runs counter-clockwise and both heads meet at bottom centre', () => {
    expect(perimeterPoint(-50, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(perimeterPoint(150, 100, 50)).toEqual({ x: 50, y: 50 });
    expect(perimeterPoint(-150, 100, 50)).toEqual({ x: 50, y: 50 });
  });
});

describe('fx/comets arcPoint', () => {
  test('starts at a and ends at b', () => {
    const a = { x: 0, y: 100 };
    const b = { x: 200, y: 100 };
    expect(arcPoint(a, b, 0)).toEqual(a);
    expect(arcPoint(a, b, 1)).toEqual(b);
  });

  test('arc lifts above the chord by a quarter of the distance, capped at 160px', () => {
    // Quadratic Bézier midpoint sits at half the control-point lift.
    expect(arcPoint({ x: 0, y: 100 }, { x: 100, y: 100 }, 0.5).y).toBeCloseTo(100 - 25 / 2, 6);
    expect(arcPoint({ x: 0, y: 500 }, { x: 2000, y: 500 }, 0.5).y).toBeCloseTo(500 - 160 / 2, 6);
  });
});

describe('fx/starfield', () => {
  test('makeStars places n stars inside the unit cube in front of the camera', () => {
    const stars = makeStars(50, seq([0, 0.25, 0.5, 0.75, 0.999]));
    expect(stars).toHaveLength(50);
    for (const s of stars) {
      expect(Math.abs(s.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(s.y)).toBeLessThanOrEqual(1);
      expect(s.z).toBeGreaterThan(0);
      expect(s.z).toBeLessThanOrEqual(1);
    }
  });

  test('stepStars moves stars toward the viewer and recycles those that pass it', () => {
    const stars = [{ x: 0.2, y: 0.2, z: 0.5, tint: '#fff' }, { x: 0.1, y: 0.1, z: 0.04, tint: '#fff' }];
    stepStars(stars, 0.02, () => 0.75);
    expect(stars[0].z).toBeCloseTo(0.48, 6);
    expect(stars[0].x).toBe(0.2);
    expect(stars[1]).toMatchObject({ x: 0.5, y: 0.5, z: 1 });
  });
});

describe('fx/voiceOrb orbRadius', () => {
  const sample = (level) => {
    const out = [];
    for (let i = 0; i < 360; i++) for (const t of [0, 0.7, 2.3]) out.push(orbRadius(10, (i / 360) * Math.PI * 2, t, level));
    return out;
  };

  test('blob never leaves its canvas box', () => {
    expect(Math.max(...sample(1))).toBeLessThanOrEqual(10);
    expect(Math.min(...sample(1))).toBeGreaterThan(0);
  });

  test('louder input ripples the outline more', () => {
    const spread = (xs) => Math.max(...xs) - Math.min(...xs);
    expect(spread(sample(1))).toBeGreaterThan(spread(sample(0)) * 3);
  });
});

describe('fx/council similarity', () => {
  test('identical answers agree fully; disjoint answers not at all', () => {
    expect(similarity('Paris is the capital of France', 'paris is the CAPITAL of france')).toBe(1);
    expect(similarity('quantum entanglement photons', 'banana smoothie recipe')).toBe(0);
  });

  test('partial overlap is the Jaccard ratio of content words', () => {
    // {paris, capital, france} vs {paris, capital, city} -> 2 / 4
    expect(similarity('paris capital france', 'paris capital city')).toBeCloseTo(0.5, 6);
    expect(similarity('a b c', 'paris capital city')).toBe(0);
  });

  test('stopwords and empty answers never count as agreement', () => {
    expect(similarity('the and for that', 'the and for that')).toBe(0);
    expect(similarity('', 'paris')).toBe(0);
    expect(similarity(null, undefined)).toBe(0);
  });
});
