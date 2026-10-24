/**
 * @jest-environment jsdom
 */
// Ambient chrome background: pure scheduling/scene physics plus the DOM
// controller. requestAnimationFrame, ResizeObserver, canvas contexts and layout
// metrics are browser boundaries: stubbed.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function recordingCtx() {
  const log = { alphas: [], ops: [], calls: {}, trace: [] };
  const gradient = () => ({ addColorStop() {} });
  const ctx = {
    log,
    _alpha: 1,
    get globalAlpha() { return this._alpha; },
    set globalAlpha(v) { this._alpha = v; log.alphas.push(v); },
    get globalCompositeOperation() { return log.ops[log.ops.length - 1]; },
    set globalCompositeOperation(v) { log.ops.push(v); },
    createLinearGradient: gradient,
    createRadialGradient: gradient,
  };
  for (const m of ['setTransform', 'clearRect', 'translate', 'rotate', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'fillRect', 'arc']) {
    ctx[m] = (...args) => {
      log.calls[m] = (log.calls[m] || 0) + 1;
      log.trace.push(`${m}(${args.map((n) => n.toFixed(3)).join(',')})`);
    };
  }
  return ctx;
}

const PALETTE = { colors: [[47, 185, 214], [0, 220, 255], [255, 36, 134], [128, 128, 195]] };

describe('fx/ambient pure helpers', () => {
  const amb = require('../../../../renderer/fx/ambient');

  test('normalizeAmbientSettings keeps valid values and rejects everything else', () => {
    expect(amb.normalizeAmbientSettings({ scene: 'nebula', intensity: 'normal' })).toEqual({ scene: 'nebula', intensity: 'normal' });
    expect(amb.normalizeAmbientSettings({ scene: 'off', intensity: 'soft' })).toEqual({ scene: 'off', intensity: 'soft' });
    expect(amb.normalizeAmbientSettings({ scene: 'lava', intensity: 'max' })).toEqual({ scene: 'cycle', intensity: 'soft' });
    expect(amb.normalizeAmbientSettings(null)).toEqual({ scene: 'cycle', intensity: 'soft' });
    expect(amb.normalizeAmbientSettings('aurora')).toEqual({ scene: 'cycle', intensity: 'soft' });
  });

  test('resolveMode maps motion level and scene to canvas, drift or off', () => {
    expect(amb.resolveMode('full', 'cycle')).toBe('canvas');
    expect(amb.resolveMode('full', 'aurora')).toBe('canvas');
    expect(amb.resolveMode('subtle', 'cycle')).toBe('drift');
    expect(amb.resolveMode('off', 'cycle')).toBe('off');
    expect(amb.resolveMode('full', 'off')).toBe('off');
    expect(amb.resolveMode('subtle', 'off')).toBe('off');
  });

  test('peakAlpha caps at 0.35 dark and 0.2 light; soft is quieter', () => {
    expect(amb.peakAlpha('dark', 'normal')).toBeCloseTo(0.35);
    expect(amb.peakAlpha('light', 'normal')).toBeCloseTo(0.2);
    expect(amb.peakAlpha('dark', 'soft')).toBeLessThan(amb.peakAlpha('dark', 'normal'));
    expect(amb.peakAlpha('light', 'soft')).toBeLessThan(amb.peakAlpha('light', 'normal'));
  });

  test('parseRgb accepts CSS channel triples only', () => {
    expect(amb.parseRgb(' 0, 220, 255 ')).toEqual([0, 220, 255]);
    expect(amb.parseRgb('')).toBeNull();
    expect(amb.parseRgb('0, 220')).toBeNull();
    expect(amb.parseRgb('0, 300, 1')).toBeNull();
    expect(amb.parseRgb('red, 1, 2')).toBeNull();
  });
});

describe('fx/ambient createRotation', () => {
  const { createRotation, SCENE_NAMES } = require('../../../../renderer/fx/ambient');

  test('holds 40-60s, then crossfades over 3s before switching', () => {
    const r = createRotation(SCENE_NAMES, mulberry32(7));
    const first = r.current;
    expect(r.holdFor).toBeGreaterThanOrEqual(40);
    expect(r.holdFor).toBeLessThanOrEqual(60);
    const hold = r.holdFor;
    let event = null;
    let t = 0;
    while (!event) { event = r.advance(0.5); t += 0.5; }
    expect(event).toBe('fade');
    expect(t).toBeGreaterThanOrEqual(hold);
    expect(t).toBeLessThan(hold + 0.5);
    expect(r.next).not.toBe(first);
    const mixes = [];
    while ((event = r.advance(0.5)) !== 'switch') mixes.push(r.mix);
    expect(mixes.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < mixes.length; i++) expect(mixes[i]).toBeGreaterThan(mixes[i - 1]);
    expect(Math.max(...mixes)).toBeLessThan(1);
    expect(r.current).not.toBe(first);
    expect(r.next).toBeNull();
    expect(r.mix).toBe(0);
  });

  test('never repeats a scene back to back and plays every scene in each round', () => {
    const r = createRotation(SCENE_NAMES, mulberry32(42), { hold: [1, 1], fade: 1 });
    const order = [r.current];
    while (order.length < 40) {
      if (r.advance(0.25) === 'switch') order.push(r.current);
    }
    for (let i = 1; i < order.length; i++) expect(order[i]).not.toBe(order[i - 1]);
    for (let round = 0; round + SCENE_NAMES.length <= order.length; round += SCENE_NAMES.length) {
      expect(new Set(order.slice(round, round + SCENE_NAMES.length)).size).toBe(SCENE_NAMES.length);
    }
  });

  test('a single scene still re-seeds itself each hold', () => {
    const r = createRotation(['nebula'], mulberry32(3), { hold: [1, 1], fade: 1 });
    expect(r.advance(1)).toBe('fade');
    expect(r.next).toBe('nebula');
    expect(r.advance(1)).toBe('switch');
    expect(r.current).toBe('nebula');
  });
});

describe('fx/ambient scenes', () => {
  const { SCENES, SCENE_NAMES } = require('../../../../renderer/fx/ambient');

  test.each(SCENE_NAMES)('%s never draws brighter than the alpha it is given', (name) => {
    const scene = SCENES[name].create(mulberry32(11), PALETTE);
    const ctx = recordingCtx();
    for (let i = 0; i < 120; i++) {
      scene.step(1 / 30);
      scene.draw(ctx, 900, 42, 0.3);
    }
    const drawn = ctx.log.alphas.filter((a) => a !== 1);
    expect(drawn.length).toBeGreaterThan(0);
    expect(Math.max(...drawn)).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(ctx.log.alphas[ctx.log.alphas.length - 1]).toBe(1);
  });

  test.each(SCENE_NAMES)('%s is deterministic per seed and varies between seeds', (name) => {
    const run = (seed) => {
      const scene = SCENES[name].create(mulberry32(seed), PALETTE);
      const ctx = recordingCtx();
      for (let i = 0; i < 30; i++) { scene.step(0.1); scene.draw(ctx, 600, 40, 0.3); }
      return ctx.log.trace.join(' ') + ctx.log.alphas.map((a) => a.toFixed(6)).join(' ');
    };
    expect(run(5)).toBe(run(5));
    expect(run(5)).not.toBe(run(6));
  });

  test('flowlines streamers stay inside the strip and restart their trail on wrap', () => {
    const { create, TRAIL } = require('../../../../renderer/fx/scenes/flowlines');
    const scene = create(mulberry32(9), PALETTE);
    let wraps = 0;
    const bad = [];
    for (let i = 0; i < 3000; i++) {
      const before = scene.streamers.map((s) => s.u);
      scene.step(0.1);
      scene.streamers.forEach((s, k) => {
        if (s.v < 0.04 || s.v > 0.96 || s.trail.length > TRAIL * 2) bad.push([i, k, s.v, s.trail.length]);
        if (Math.abs(s.u - before[k]) > 0.5) {
          wraps++;
          if (s.trail.length !== 0) bad.push([i, k, 'trail kept across wrap']);
        }
      });
    }
    expect(bad).toEqual([]);
    expect(wraps).toBeGreaterThan(0);
  });

  test('drift motes wrap along the strip and a glint sweeps periodically', () => {
    const { create, wrap } = require('../../../../renderer/fx/scenes/drift');
    expect(wrap(1.25)).toBeCloseTo(0.25);
    expect(wrap(-0.25)).toBeCloseTo(0.75);
    const scene = create(mulberry32(4), PALETTE);
    let glints = 0;
    let wasIdle = true;
    for (let i = 0; i < 900; i++) {
      scene.step(0.1);
      if (scene.motes.some((m) => m.u < 0 || m.u >= 1)) throw new Error(`mote left the strip at step ${i}`);
      const active = scene.glint.u >= 0 && scene.glint.u <= 1.2;
      if (active && wasIdle) glints++;
      wasIdle = !active;
    }
    expect(glints).toBeGreaterThanOrEqual(4);
  });

  test('aurora ribbons and nebula clouds move over time', () => {
    const { create: aurora, ribbonY } = require('../../../../renderer/fx/scenes/aurora');
    const { create: nebula, cloudAt } = require('../../../../renderer/fx/scenes/nebula');
    const r = aurora(mulberry32(1), PALETTE).ribbons[0];
    expect(ribbonY(r, 0.3, 0)).not.toBeCloseTo(ribbonY(r, 0.3, 2));
    const c = nebula(mulberry32(1), PALETTE).clouds[0];
    const a = cloudAt(c, 0);
    const b = cloudAt(c, 10);
    expect([a.u, a.v, a.scale]).not.toEqual([b.u, b.v, b.scale]);
  });
});

describe('fx/ambient controller', () => {
  let frames;
  let ctx;
  let now;

  function runFrames(n) {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      const due = frames;
      frames = [];
      due.forEach((cb) => cb(now));
    }
  }

  function chrome(layout) {
    document.body.innerHTML = '';
    document.body.className = '';
    document.body.dataset.chromeLayout = layout;
    const sidebar = document.createElement('div');
    sidebar.id = 'chrome-sidebar';
    sidebar.innerHTML = '<div class="chrome-sidebar-header"></div>';
    const wrap = document.createElement('div');
    wrap.id = 'tab-bar-wrap';
    const bar = document.createElement('div');
    bar.id = 'tab-bar';
    Object.defineProperties(bar, {
      offsetTop: { value: 0, configurable: true },
      offsetLeft: { value: 0, configurable: true },
      offsetWidth: { value: 1200, configurable: true },
      offsetHeight: { value: 42, configurable: true },
    });
    // Horizontal layouts keep the bar on body as a strip just before the wrap.
    document.body.append(sidebar, bar, wrap);
    return { sidebar, wrap, bar };
  }

  let createAmbient;
  beforeEach(() => {
    jest.resetModules();
    frames = [];
    now = 0;
    ctx = recordingCtx();
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    window.ResizeObserver = class { observe() {} disconnect() {} };
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
    jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(42);
    ({ createAmbient } = require('../../../../renderer/fx/ambient'));
  });

  // The assistant header strip; IntersectionObserver is a browser boundary.
  let views;
  function panelHeader() {
    const shell = document.createElement('div');
    shell.id = 'assistant-shell';
    const header = document.createElement('header');
    header.className = 'agent-panel-header';
    header.innerHTML = '<button class="agent-panel-history-toggle"></button>';
    shell.appendChild(header);
    document.body.appendChild(shell);
    return header;
  }
  const locateHeader = () => {
    const header = document.querySelector('#assistant-shell .agent-panel-header');
    return header && { parent: header, anchor: header.firstChild, overlay: null, vertical: false };
  };
  beforeEach(() => {
    views = [];
    window.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; this.targets = []; views.push(this); }
      observe(el) { this.targets.push(el); }
      disconnect() { this.targets = []; }
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete window.IntersectionObserver;
    delete window.ResizeObserver;
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  test('off level or scene "off" mounts nothing and draws nothing', () => {
    chrome('left');
    const amb = createAmbient({ rng: mulberry32(1) });
    amb.apply({ level: 'off', lowPower: false, chromeAmbient: { scene: 'cycle' } });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: { scene: 'off' } });
    expect(document.querySelector('.fx-ambient')).toBeNull();
    expect(document.body.classList.contains('fx-ambient-on')).toBe(false);
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });

  test('left layout: fills the sidebar under its content and draws rotated', () => {
    const { sidebar } = chrome('left');
    const amb = createAmbient({ rng: mulberry32(1) });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: { scene: 'aurora' } });
    const host = sidebar.firstChild;
    expect(host.classList.contains('fx-ambient')).toBe(true);
    expect(host.classList.contains('fx-ambient--vertical')).toBe(true);
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(document.body.classList.contains('fx-ambient-on')).toBe(true);
    runFrames(30);
    expect(ctx.log.calls.rotate).toBeGreaterThan(0);
    expect(ctx.log.calls.stroke).toBeGreaterThan(0);
    expect(amb.getScene()).toBe('aurora');
    expect(ctx.log.ops).toContain('lighter');
  });

  test('top layout: sits right under the tab bar strip, outside the dock wrap, unrotated', () => {
    const { wrap, bar } = chrome('top');
    const amb = createAmbient({ rng: mulberry32(1) });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: { scene: 'nebula' } });
    const host = bar.previousSibling;
    expect(host.classList.contains('fx-ambient')).toBe(true);
    expect(wrap.querySelector('.fx-ambient')).toBeNull();
    expect(host.classList.contains('fx-ambient--vertical')).toBe(false);
    expect(host.style.height).toBe('42px');
    expect(host.style.width).toBe('1200px');
    runFrames(30);
    expect(ctx.log.calls.fillRect).toBeGreaterThan(0);
    expect(ctx.log.calls.rotate).toBeUndefined();
  });

  test('follows a chrome layout change to the other host', async () => {
    const { sidebar, bar } = chrome('left');
    const amb = createAmbient({ rng: mulberry32(1) });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: {} });
    expect(sidebar.querySelector('.fx-ambient')).not.toBeNull();
    document.body.dataset.chromeLayout = 'bottom';
    await Promise.resolve();
    expect(sidebar.querySelector('.fx-ambient')).toBeNull();
    expect(bar.previousSibling.classList.contains('fx-ambient')).toBe(true);
    expect(amb.isRunning()).toBe(true);
  });

  test('subtle level is a CSS drift with no canvas and no frames', () => {
    const { sidebar } = chrome('left');
    const amb = createAmbient({ rng: mulberry32(1) });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: {} });
    expect(amb.isRunning()).toBe(true);
    amb.apply({ level: 'subtle', lowPower: false, chromeAmbient: {} });
    const host = sidebar.querySelector('.fx-ambient');
    expect(host.classList.contains('fx-ambient--drift')).toBe(true);
    expect(host.querySelector('canvas')).toBeNull();
    expect(amb.isRunning()).toBe(false);
    expect(amb.getMode()).toBe('drift');
  });

  test('pauses while the document is hidden and resumes when visible', () => {
    chrome('left');
    const amb = createAmbient({ rng: mulberry32(1) });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: {} });
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(amb.isRunning()).toBe(false);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(amb.isRunning()).toBe(true);
  });

  test('draws ~30fps focused and ~15fps when the window loses focus', () => {
    chrome('left');
    const amb = createAmbient({ rng: mulberry32(1) });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: { scene: 'aurora' } });
    const paints = () => ctx.log.calls.clearRect || 0;
    runFrames(60);
    const focused = paints();
    window.dispatchEvent(new Event('blur'));
    runFrames(60);
    const blurred = paints() - focused;
    expect(focused).toBeGreaterThanOrEqual(28);
    expect(focused).toBeLessThanOrEqual(31);
    expect(blurred).toBeGreaterThanOrEqual(13);
    expect(blurred).toBeLessThanOrEqual(16);
    window.dispatchEvent(new Event('focus'));
  });

  test('light theme draws source-over; re-applying the same scene keeps the rotation', () => {
    chrome('left');
    document.body.classList.add('theme-light');
    const amb = createAmbient({ rng: mulberry32(1) });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: { scene: 'cycle' } });
    runFrames(10);
    expect(ctx.log.ops).not.toContain('lighter');
    expect(ctx.log.ops).toContain('source-over');
    const scene = amb.getScene();
    amb.apply({ level: 'full', lowPower: true, chromeAmbient: { scene: 'cycle', intensity: 'normal' } });
    expect(amb.getScene()).toBe(scene);
    amb.apply({ level: 'full', lowPower: true, chromeAmbient: { scene: 'drift' } });
    expect(amb.getScene()).toBe('drift');
  });

  test('turning motion off tears everything down', () => {
    const { sidebar } = chrome('left');
    const amb = createAmbient({ rng: mulberry32(1) });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: {} });
    amb.apply({ level: 'off', lowPower: false, chromeAmbient: {} });
    expect(sidebar.querySelector('.fx-ambient')).toBeNull();
    expect(document.body.classList.contains('fx-ambient-on')).toBe(false);
    expect(amb.isRunning()).toBe(false);
    runFrames(3);
    expect(frames).toHaveLength(0);
  });

  test('a located strip is filled under its content, unrotated, without the chrome body class', () => {
    chrome('top');
    const header = panelHeader();
    const amb = createAmbient({ rng: mulberry32(1), locate: locateHeader, bodyClass: null });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: { scene: 'nebula' } });
    const host = header.firstChild;
    expect(host.classList.contains('fx-ambient')).toBe(true);
    expect(host.classList.contains('fx-ambient--fill')).toBe(true);
    expect(host.classList.contains('fx-ambient--vertical')).toBe(false);
    expect(host.style.width).toBe('');
    expect(document.body.classList.contains('fx-ambient-on')).toBe(false);
    runFrames(30);
    expect(ctx.log.calls.fillRect).toBeGreaterThan(0);
    expect(ctx.log.calls.rotate).toBeUndefined();
  });

  test('a follower draws the leader scene and crossfades to the leader next one', () => {
    chrome('top');
    panelHeader();
    const leader = createAmbient({ rng: mulberry32(1) });
    const follower = createAmbient({ rng: mulberry32(2), locate: locateHeader, bodyClass: null, leader });
    const settings = { level: 'full', lowPower: false, chromeAmbient: { scene: 'cycle' } };
    leader.apply(settings);
    follower.apply(settings);
    runFrames(10);
    const first = leader.getScene();
    expect(follower.getScene()).toBe(first);
    // Skip the leader's hold so its crossfade starts on the next frame.
    const rotation = leader.getRotation();
    rotation.elapsed = rotation.holdFor;
    runFrames(2);
    expect(rotation.next).not.toBeNull();
    expect(follower.getRotation()).toBe(rotation);
    runFrames(60 * 4);
    expect(leader.getScene()).not.toBe(first);
    expect(follower.getScene()).toBe(leader.getScene());
    expect(document.body.classList.contains('fx-ambient-on')).toBe(true);
  });

  test('pauseOffscreen draws nothing until the host scrolls into view, and stops when clipped', () => {
    chrome('top');
    panelHeader();
    const amb = createAmbient({ rng: mulberry32(1), locate: locateHeader, bodyClass: null, pauseOffscreen: true });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: { scene: 'aurora' } });
    expect(amb.isRunning()).toBe(false);
    runFrames(5);
    expect(ctx.log.calls.clearRect).toBeUndefined();
    const view = views[0];
    expect(view.targets[0].classList.contains('fx-ambient')).toBe(true);
    view.cb([{ isIntersecting: true }]);
    expect(amb.isRunning()).toBe(true);
    runFrames(5);
    expect(ctx.log.calls.clearRect).toBeGreaterThan(0);
    view.cb([{ isIntersecting: false }]);
    expect(amb.isRunning()).toBe(false);
  });

  test('a strip built after apply() is mounted on the next body change', async () => {
    chrome('top');
    const amb = createAmbient({ rng: mulberry32(1), locate: locateHeader, bodyClass: null });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: {} });
    expect(document.querySelector('.fx-ambient')).toBeNull();
    const header = panelHeader();
    document.body.classList.add('assistant-sidebar-open');
    await Promise.resolve();
    expect(header.firstChild.classList.contains('fx-ambient--fill')).toBe(true);
    expect(amb.isRunning()).toBe(true);
  });

  test('with no strip to mount on, a body change looks for one once instead of re-firing itself', async () => {
    let looks = 0;
    // Past 20 looks the strip appears, so a feedback loop fails here rather than hanging the run.
    const locate = () => (++looks > 20 ? locateHeader() : null);
    document.body.className = 'fx-full';
    const amb = createAmbient({ rng: mulberry32(1), locate });
    amb.apply({ level: 'full', lowPower: false, chromeAmbient: {} });
    panelHeader();
    looks = 0;
    document.body.classList.add('assistant-sidebar-open');
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(looks).toBe(1);
    expect(document.body.className).toBe('fx-full assistant-sidebar-open');
  });

  test('fx.applySettings puts the assistant header under the same sky as the tab bar', () => {
    const { bar } = chrome('top');
    const header = panelHeader();
    window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn() }));
    const fx = require('../../../../renderer/fx');
    fx.applySettings({ motionEffects: 'full', chromeAmbient: { scene: 'aurora' } });
    expect(bar.previousSibling.classList.contains('fx-ambient')).toBe(true);
    expect(header.firstChild.classList.contains('fx-ambient--fill')).toBe(true);
    expect(header.querySelector('canvas')).not.toBeNull();
    fx.applySettings({ motionEffects: 'off', chromeAmbient: { scene: 'aurora' } });
    expect(document.querySelector('.fx-ambient')).toBeNull();
  });

  test('fx.applySettings drives the ambient from settings.chromeAmbient', () => {
    chrome('left');
    window.matchMedia = jest.fn(() => ({ matches: false, addEventListener: jest.fn() }));
    const fx = require('../../../../renderer/fx');
    fx.applySettings({ motionEffects: 'subtle', chromeAmbient: { scene: 'cycle' } });
    expect(document.querySelector('.fx-ambient--drift')).not.toBeNull();
    fx.applySettings({ motionEffects: 'full', chromeAmbient: { scene: 'off' } });
    expect(document.querySelector('.fx-ambient')).toBeNull();
    fx.applySettings({ motionEffects: 'full', chromeAmbient: { scene: 'flowlines' } });
    expect(document.querySelector('.fx-ambient > canvas')).not.toBeNull();
  });
});
