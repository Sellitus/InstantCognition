const { resolveMotionLevel, isLowPower, springAt, springEasing } = require('../../../../renderer/fx/motion');

function points(easing) {
  return easing.slice('linear('.length, -1).split(',').map(Number);
}

describe('fx/motion', () => {
  describe('resolveMotionLevel', () => {
    test('honors each valid user level', () => {
      expect(resolveMotionLevel({ motionEffects: 'full' })).toBe('full');
      expect(resolveMotionLevel({ motionEffects: 'subtle' })).toBe('subtle');
      expect(resolveMotionLevel({ motionEffects: 'off' })).toBe('off');
    });

    test('missing or unknown level falls back to full', () => {
      expect(resolveMotionLevel({})).toBe('full');
      expect(resolveMotionLevel(null)).toBe('full');
      expect(resolveMotionLevel({ motionEffects: 'max' })).toBe('full');
    });

    test('every global no-motion signal forces off, even over full', () => {
      expect(resolveMotionLevel({ motionEffects: 'full', enableAnimations: false })).toBe('off');
      expect(resolveMotionLevel({ motionEffects: 'full', forceReducedMotion: true })).toBe('off');
      expect(resolveMotionLevel({ motionEffects: 'full' }, { prefersReducedMotion: true })).toBe('off');
    });

    test('enableAnimations true does not override a subtle choice', () => {
      expect(resolveMotionLevel({ motionEffects: 'subtle', enableAnimations: true })).toBe('subtle');
    });
  });

  describe('isLowPower', () => {
    test('explicit hardware acceleration setting wins over platform', () => {
      expect(isLowPower({ hardwareAcceleration: 'off' }, 'darwin')).toBe(true);
      expect(isLowPower({ hardwareAcceleration: 'on' }, 'win32')).toBe(false);
    });

    test('auto means low power only on Windows (GPU disabled by default)', () => {
      expect(isLowPower({ hardwareAcceleration: 'auto' }, 'win32')).toBe(true);
      expect(isLowPower({}, 'darwin')).toBe(false);
      expect(isLowPower(undefined, 'linux')).toBe(false);
    });
  });

  describe('springs', () => {
    test('spring starts at 0 and settles at 1', () => {
      const p = { stiffness: 210, damping: 24, mass: 1 };
      expect(springAt(0, p)).toBeCloseTo(0, 6);
      expect(springAt(3, p)).toBeCloseTo(1, 3);
    });

    test('springEasing emits a CSS linear() with 49 stops from 0 to 1', () => {
      const { easing, duration } = springEasing({ stiffness: 210, damping: 24 });
      expect(easing).toMatch(/^linear\([-0-9., ]+\)$/);
      const pts = points(easing);
      expect(pts).toHaveLength(49);
      expect(pts[0]).toBe(0);
      expect(pts[pts.length - 1]).toBe(1);
      expect(duration).toBeGreaterThanOrEqual(200);
      expect(duration).toBeLessThanOrEqual(1600);
    });

    test('underdamped spring overshoots past 1', () => {
      expect(Math.max(...points(springEasing({ stiffness: 260, damping: 15 }).easing))).toBeGreaterThan(1.02);
    });

    test('critically damped spring never overshoots', () => {
      // zeta = damping / (2 * sqrt(k * m)) = 20 / (2 * 10) = 1
      expect(Math.max(...points(springEasing({ stiffness: 100, damping: 20 }).easing))).toBeLessThanOrEqual(1);
    });

    test('identical parameters return the memoized result', () => {
      expect(springEasing({ stiffness: 333, damping: 21 })).toBe(springEasing({ stiffness: 333, damping: 21 }));
    });
  });
});
