// typewriter — RAF-driven character feeder.
//
// Writes characters into an `onTick(prefix)` callback at a measured speed,
// clamped to [minCps, maxCps] so the UI stays responsive. Respects
// `prefers-reduced-motion` by dumping the full text immediately.

const DEFAULT_MIN_CPS = 30;
const DEFAULT_MAX_CPS = 180;

function prefersReducedMotion() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) { return false; }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Start a typewriter. Returns a controller {skip, cancel, setSpeed}.
//   text       — full string to type out
//   onTick     — called with current visible prefix as chars are added
//   onDone     — called when the typewriter finishes
//   charsPerSec— initial speed (will be clamped); updatable via setSpeed
/**
 * @param {{ text?: string, onTick?: (visible: string) => void, onDone?: () => void,
 *   charsPerSec?: number, minCps?: number, maxCps?: number }} [opts]
 */
function startTypewriter({ text, onTick, onDone, charsPerSec = 60, minCps = DEFAULT_MIN_CPS, maxCps = DEFAULT_MAX_CPS } = {}) {
  const full = String(text || '');
  if (!full) { if (onTick) onTick(''); if (onDone) onDone(); return noopController(); }

  if (prefersReducedMotion()) {
    if (onTick) onTick(full);
    if (onDone) onDone();
    return noopController();
  }

  let cps = clamp(charsPerSec || 60, minCps, maxCps);
  let cursor = 0;
  let cancelled = false;
  let rafId = null;
  let lastTime = null;

  const step = (time) => {
    if (cancelled) return;
    if (lastTime == null) lastTime = time;
    const dt = (time - lastTime) / 1000;
    lastTime = time;
    const advance = Math.max(1, Math.round(cps * dt));
    cursor = Math.min(full.length, cursor + advance);
    if (onTick) onTick(full.slice(0, cursor));
    if (cursor >= full.length) {
      if (onDone) onDone();
      return;
    }
    rafId = requestAnimationFrame(step);
  };

  rafId = requestAnimationFrame(step);

  return {
    skip() {
      cancelled = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      if (onTick) onTick(full);
      if (onDone) onDone();
    },
    cancel() {
      cancelled = true;
      if (rafId != null) cancelAnimationFrame(rafId);
    },
    setSpeed(next) {
      if (Number.isFinite(next) && next > 0) cps = clamp(next, minCps, maxCps);
    },
    isRunning() { return !cancelled && cursor < full.length; },
  };
}

function noopController() {
  return { skip() {}, cancel() {}, setSpeed() {}, isRunning() { return false; } };
}

module.exports = { startTypewriter, prefersReducedMotion };
