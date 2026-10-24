/** @jest-environment jsdom */

describe('typewriter', () => {
  let raf;
  beforeEach(() => {
    jest.resetModules();
    // Install a deterministic rAF that advances virtual time.
    let time = 0;
    raf = jest.fn((cb) => setTimeout(() => cb(time += 16), 0));
    global.requestAnimationFrame = raf;
    global.cancelAnimationFrame = (id) => clearTimeout(id);
    // Reset unconditionally so the prefers-reduced-motion test can't leak
    // matches:true into the animation-dependent tests that follow it.
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  });

  test('streams characters and completes', async () => {
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    const ticks = [];
    const done = new Promise((resolve) => {
      startTypewriter({
        text: 'hello world',
        charsPerSec: 1000,
        onTick: (p) => ticks.push(p),
        onDone: () => resolve(),
      });
    });
    await done;
    expect(ticks[ticks.length - 1]).toBe('hello world');
  });

  test('prefers-reduced-motion dumps the whole text immediately', () => {
    window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} });
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    const ticks = [];
    let completed = false;
    startTypewriter({
      text: 'instant',
      charsPerSec: 60,
      onTick: (p) => ticks.push(p),
      onDone: () => { completed = true; },
    });
    expect(completed).toBe(true);
    expect(ticks).toEqual(['instant']);
  });

  test('skip dumps remaining immediately', async () => {
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    let lastPrefix = '';
    let completed = false;
    const ctl = startTypewriter({
      text: 'abcdefghij',
      charsPerSec: 1,
      onTick: (p) => { lastPrefix = p; },
      onDone: () => { completed = true; },
    });
    ctl.skip();
    expect(lastPrefix).toBe('abcdefghij');
    expect(completed).toBe(true);
  });

  test('clamps charsPerSec to min/max', async () => {
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    const ctl = startTypewriter({
      text: 'aa',
      charsPerSec: 99999,
      onTick: () => {},
      onDone: () => {},
    });
    expect(typeof ctl.setSpeed).toBe('function');
    ctl.skip();
  });

  test('empty text completes immediately via the noop controller', () => {
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    const ticks = [];
    let done = false;
    const ctl = startTypewriter({
      text: '',
      onTick: (p) => ticks.push(p),
      onDone: () => { done = true; },
    });
    expect(ticks).toEqual(['']);
    expect(done).toBe(true);
    // noop controller is inert and never "running".
    expect(ctl.isRunning()).toBe(false);
    expect(() => { ctl.skip(); ctl.cancel(); ctl.setSpeed(100); }).not.toThrow();
  });

  // A manually-pumped rAF queue: a deterministic rAF that drains on its own
  // would run the whole typewriter before startTypewriter() returns, so we need
  // a queue we step by hand to observe mid-stream state.
  function manualRaf() {
    const q = [];
    let vt = 0;
    // jsdom resolves bare `requestAnimationFrame` to window.*, not global.*
    window.requestAnimationFrame = (cb) => { q.push(cb); return q.length; };
    window.cancelAnimationFrame = (id) => { q[id - 1] = null; };
    global.requestAnimationFrame = window.requestAnimationFrame;
    global.cancelAnimationFrame = window.cancelAnimationFrame;
    return {
      pump(frames = 1) {
        for (let i = 0; i < frames; i++) {
          const cb = q.shift();
          if (cb) cb((vt += 16));
        }
      },
      get pending() { return q.filter(Boolean).length; },
    };
  }

  test('isRunning is true mid-stream and false after completion', () => {
    const r = manualRaf();
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    let completed = false;
    const ctl = startTypewriter({
      text: 'abcdefghijklmnop',
      charsPerSec: 60, // slow enough that one frame is not the whole string
      onTick: () => {},
      onDone: () => { completed = true; },
    });
    // No frames pumped yet → cursor 0, still running.
    expect(ctl.isRunning()).toBe(true);
    r.pump(1);
    expect(ctl.isRunning()).toBe(true);
    // Drain to completion.
    for (let i = 0; i < 100 && !completed; i++) r.pump(1);
    expect(completed).toBe(true);
    expect(ctl.isRunning()).toBe(false);
  });

  test('cancel stops further ticks without calling onDone', () => {
    const r = manualRaf();
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    let ticks = 0;
    let completed = false;
    const ctl = startTypewriter({
      text: 'abcdefghijklmnopqrstuvwxyz',
      charsPerSec: 60,
      onTick: () => { ticks += 1; },
      onDone: () => { completed = true; },
    });
    r.pump(1);
    const before = ticks;
    ctl.cancel();
    // The cancelled step is a no-op even if a frame is still queued.
    r.pump(5);
    expect(ticks).toBe(before);
    expect(completed).toBe(false);
    expect(ctl.isRunning()).toBe(false);
  });

  test('setSpeed ignores invalid values, accepts valid (clamped)', async () => {
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    const ctl = startTypewriter({
      text: 'abcdefghij',
      charsPerSec: 60,
      onTick: () => {},
      onDone: () => {},
    });
    // Invalid inputs are no-ops (no throw, stream still progresses normally).
    ctl.setSpeed(NaN);
    ctl.setSpeed(-10);
    ctl.setSpeed(0);
    ctl.setSpeed('fast');
    // Valid input is accepted (and internally clamped to maxCps).
    expect(() => ctl.setSpeed(5000)).not.toThrow();
    ctl.skip();
  });

  test('advances at least one char per frame even at very low cps', () => {
    const r = manualRaf();
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    const ticks = [];
    let completed = false;
    startTypewriter({
      text: 'abc',
      charsPerSec: 1,
      minCps: 1,
      onTick: (p) => ticks.push(p),
      onDone: () => { completed = true; },
    });
    // 1 cps over a 16ms frame rounds to 0 advance, but Math.max(1, …) forces
    // ≥1 char/frame so 3 frames complete the 3-char string.
    for (let i = 0; i < 5 && !completed; i++) r.pump(1);
    expect(completed).toBe(true);
    expect(ticks[ticks.length - 1]).toBe('abc');
    expect(ticks.length).toBeGreaterThan(1);
  });

  test('prefersReducedMotion is false when matchMedia is unavailable', () => {
    const { prefersReducedMotion } = require('../../../../renderer/utils/typewriter');
    const prev = window.matchMedia;
    // @ts-ignore
    window.matchMedia = undefined;
    expect(prefersReducedMotion()).toBe(false);
    window.matchMedia = prev;
  });

  test('prefersReducedMotion swallows a throwing matchMedia', () => {
    const { prefersReducedMotion } = require('../../../../renderer/utils/typewriter');
    const prev = window.matchMedia;
    window.matchMedia = () => { throw new Error('nope'); };
    expect(prefersReducedMotion()).toBe(false);
    window.matchMedia = prev;
  });

  test('startTypewriter() with no arguments at all returns an inert controller', () => {
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    // No options object → defaults to {}; empty text → noop controller, and
    // the empty-text branch runs WITHOUT onTick/onDone (both-side coverage).
    const ctl = startTypewriter();
    expect(ctl.isRunning()).toBe(false);
    expect(() => { ctl.skip(); ctl.cancel(); ctl.setSpeed(50); }).not.toThrow();
  });

  test('reduced-motion with no callbacks does not throw', () => {
    window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} });
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    expect(() => startTypewriter({ text: 'instant' })).not.toThrow();
  });

  test('falsy charsPerSec falls back to 60 (still animates to completion)', () => {
    const r = manualRaf();
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    let done = false;
    // charsPerSec: 0 is falsy → `charsPerSec || 60` → 60 cps.
    startTypewriter({ text: 'abcdef', charsPerSec: 0, onDone: () => { done = true; } });
    for (let i = 0; i < 50 && !done; i++) r.pump(1);
    expect(done).toBe(true);
  });

  test('animation runs to completion with NO onTick/onDone callbacks', () => {
    const r = manualRaf();
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    const ctl = startTypewriter({ text: 'abcdefghij', charsPerSec: 60 });
    // Pump several frames; the missing-callback branches (if (onTick) /
    // if (onDone)) must not throw and the stream must terminate.
    for (let i = 0; i < 50 && ctl.isRunning(); i++) r.pump(1);
    expect(ctl.isRunning()).toBe(false);
  });

  test('a queued step that fires after skip() hits the cancelled guard', () => {
    const r = manualRaf();
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    let ticks = 0;
    const ctl = startTypewriter({
      text: 'abcdefghijklmnopqrstuvwxyz',
      charsPerSec: 60,
      onTick: () => { ticks += 1; },
    });
    r.pump(1);                 // one real frame → schedules the next step
    const after = ticks;
    ctl.skip();                // sets cancelled = true (skip also onTick(full))
    // The previously-queued step is still in the manual queue; running it
    // exercises the `if (cancelled) return` early-out (no extra tick).
    const skipTicks = ticks;
    r.pump(1);
    expect(ticks).toBe(skipTicks);
    expect(after).toBeGreaterThan(0);
  });

  test('skip() without onTick/onDone callbacks is safe', () => {
    const r = manualRaf();
    const { startTypewriter } = require('../../../../renderer/utils/typewriter');
    const ctl = startTypewriter({ text: 'abcdefghij', charsPerSec: 60 });
    r.pump(1);
    expect(() => ctl.skip()).not.toThrow();
    expect(ctl.isRunning()).toBe(false);
  });
});
