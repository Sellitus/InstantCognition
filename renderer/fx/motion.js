// Motion level resolution and spring easing. Pure: no DOM, safe to unit test.

const LEVELS = ['full', 'subtle', 'off'];

// 'full'   — every effect, including canvas particles, comets, starfields, orb.
// 'subtle' — CSS/WAAPI-only effects (rims, springs, spotlight, stream fade).
// 'off'    — nothing. Any global "no motion" signal wins over the user's level.
function resolveMotionLevel(settings, { prefersReducedMotion = false } = {}) {
  const s = settings || {};
  if (s.enableAnimations === false || s.forceReducedMotion === true || prefersReducedMotion) return 'off';
  return LEVELS.includes(s.motionEffects) ? s.motionEffects : 'full';
}

// Software compositing (hardware acceleration off — the Windows default) gets
// a reduced budget: fewer particles, no continuously rotating layers.
function isLowPower(settings, platform) {
  const hw = (settings && settings.hardwareAcceleration) || 'auto';
  if (hw === 'off') return true;
  if (hw === 'on') return false;
  return platform === 'win32';
}

// Damped harmonic oscillator step response, normalised to settle at 1.
function springAt(t, { stiffness, damping, mass }) {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + (zeta * w0 / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}

const _springCache = new Map();

// Physical spring expressed as a CSS `linear()` easing so the compositor runs
// it (CSS transitions and WAAPI alike) with no per-frame JS.
function springEasing({ stiffness = 210, damping = 22, mass = 1 } = {}) {
  const key = `${stiffness}/${damping}/${mass}`;
  const hit = _springCache.get(key);
  if (hit) return hit;
  const params = { stiffness, damping, mass };
  const dt = 1 / 120;
  let settle = 0;
  for (let t = dt; t < 2; t += dt) {
    if (Math.abs(1 - springAt(t, params)) > 0.002) settle = t;
  }
  const duration = Math.max(0.2, Math.min(1.6, settle + dt));
  const samples = 48;
  const points = [];
  for (let i = 0; i <= samples; i++) {
    const v = i === samples ? 1 : springAt((i / samples) * duration, params);
    points.push(Number(v.toFixed(4)));
  }
  const result = { easing: `linear(${points.join(', ')})`, duration: Math.round(duration * 1000) };
  _springCache.set(key, result);
  return result;
}

module.exports = { LEVELS, resolveMotionLevel, isLowPower, springAt, springEasing };
