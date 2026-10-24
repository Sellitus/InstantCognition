// Ambient background behind the tab chrome. One host element sits under the
// tab strip: in top/bottom layouts it is positioned over #tab-bar as the bar's
// previous sibling (TabBar.render wipes #tab-bar, so it cannot live inside it);
// in left/right layouts it fills #chrome-sidebar. 'canvas' mode rotates seeded
// scenes with a crossfade on the shared ticker; 'drift' is a CSS-only
// gradient slide; 'off' removes the host.
//
// Other strips reuse the controller through `locate`, which names the element
// to fill. A `leader` instance owns the scene rotation and its followers draw
// the same scenes in step with it, so every strip shows one sky.

const ticker = require('./ticker');
const aurora = require('./scenes/aurora');
const nebula = require('./scenes/nebula');
const flowlines = require('./scenes/flowlines');
const drift = require('./scenes/drift');

const SCENES = { aurora, nebula, flowlines, drift };
const SCENE_NAMES = Object.keys(SCENES);
const SCENE_OPTIONS = ['cycle', ...SCENE_NAMES, 'off'];
const INTENSITIES = { soft: 0.65, normal: 1 };
// Peak scene alpha. Light theme draws source-over, so it needs less.
const ALPHA_CAP = { dark: 0.35, light: 0.2 };
const HOLD_S = [40, 60];
const FADE_S = 3;
const INTRO_S = 1.2;
const FPS = { focused: 30, blurred: 15 };
// tokens.css brand values, used when a token is not resolvable (no stylesheet).
const BRAND = [[47, 185, 214], [0, 220, 255], [255, 36, 134], [128, 128, 195]];
const PALETTE_VARS = ['--accent-rgb', '--brand-cyan-rgb', '--brand-magenta-rgb', '--brand-violet-rgb'];

function normalizeAmbientSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    scene: SCENE_OPTIONS.includes(v.scene) ? v.scene : 'cycle',
    intensity: v.intensity === 'normal' ? 'normal' : 'soft',
  };
}

// 'canvas' | 'drift' | 'off' for a motion level and a scene option.
function resolveMode(level, scene) {
  if (level === 'off' || scene === 'off') return 'off';
  return level === 'full' ? 'canvas' : 'drift';
}

function peakAlpha(theme, intensity) {
  return ALPHA_CAP[theme === 'light' ? 'light' : 'dark'] * INTENSITIES[intensity];
}

function parseRgb(text) {
  const parts = String(text || '').split(',').map((p) => Number(p.trim()));
  return parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255) ? parts : null;
}

function holdTime(rng, hold) { return hold[0] + rng() * (hold[1] - hold[0]); }

// Scene order: shuffled bags, never the same scene twice in a row (unless the
// rotation has only one scene, which then re-seeds itself each hold).
function createRotation(names, rng, { hold = HOLD_S, fade = FADE_S } = {}) {
  let bag = [];
  let last = null;
  function take() {
    if (!bag.length) {
      bag = names.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      if (bag.length > 1 && bag[bag.length - 1] === last) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    }
    last = bag.pop();
    return last;
  }
  const r = { current: take(), next: null, mix: 0, elapsed: 0, holdFor: holdTime(rng, hold) };
  // Returns 'fade' when a crossfade starts, 'switch' when it completes.
  r.advance = (dt) => {
    r.elapsed += dt;
    let event = null;
    if (!r.next && r.elapsed >= r.holdFor) { r.next = take(); event = 'fade'; }
    if (!r.next) return event;
    r.mix = Math.min(1, (r.elapsed - r.holdFor) / fade);
    if (r.mix < 1) return event;
    r.current = r.next;
    r.next = null;
    r.mix = 0;
    r.elapsed = 0;
    r.holdFor = holdTime(rng, hold);
    return 'switch';
  };
  return r;
}

// The tab chrome for the current layout, or null before it is built.
function locateChrome() {
  const layout = document.body.dataset.chromeLayout || 'left';
  if (layout === 'left' || layout === 'right') {
    const sidebar = document.getElementById('chrome-sidebar');
    return sidebar && { parent: sidebar, anchor: sidebar.firstChild, overlay: null, vertical: true };
  }
  const bar = document.getElementById('tab-bar');
  return bar && bar.parentElement && { parent: bar.parentElement, anchor: bar, overlay: bar, vertical: false };
}

/**
 * @param {object} [o]
 * @param {() => number} [o.rng]
 * @param {() => ({ parent: Element, anchor: Node|null, overlay: HTMLElement|null, vertical: boolean }|null)} [o.locate]
 *   where the host goes: inserted into `parent` before `anchor`; positioned
 *   over `overlay` when given, else it fills `parent` under its content.
 * @param {{ getRotation: () => object|null }} [o.leader] instance whose scene rotation this one draws
 * @param {string|null} [o.bodyClass] body class set while mounted
 * @param {boolean} [o.pauseOffscreen] stop drawing while the host is clipped out of view
 */
function createAmbient({ rng = Math.random, locate = locateChrome, leader = null, bodyClass = 'fx-ambient-on', pauseOffscreen = false } = {}) {
  const palette = { colors: BRAND.slice() };
  let mode = 'off';
  let opts = { scene: 'cycle', intensity: 'soft', lowPower: false };
  let host = null;
  let canvas = null;
  let ctx = null;
  let bar = null;
  let vertical = false;
  let rotation = null;
  let current = null;
  let next = null;
  let currentName = null;
  let nextName = null;
  let seeded = false;
  let removeTick = null;
  let acc = 0;
  let intro = 0;
  let theme = 'dark';
  let paletteDirty = true;
  let focused = true;
  let bodyObserver = null;
  let sizeObserver = null;
  let viewObserver = null;
  let onScreen = !pauseOffscreen;

  const onVisibility = () => { if (document.hidden) stopTick(); else startTick(); };
  const onBlur = () => { focused = false; };
  const onFocus = () => { focused = true; };

  function readPalette() {
    const style = getComputedStyle(document.body);
    palette.colors = PALETTE_VARS.map((name, i) => parseRgb(style.getPropertyValue(name)) || BRAND[i]);
    theme = document.body.classList.contains('theme-light') ? 'light' : 'dark';
    paletteDirty = false;
  }

  function resetScenes() {
    seeded = true;
    intro = 0;
    current = next = null;
    currentName = nextName = null;
    if (leader) return;
    rotation = createRotation(opts.scene === 'cycle' ? SCENE_NAMES : [opts.scene], rng);
    current = SCENES[rotation.current].create(rng, palette);
    currentName = rotation.current;
  }

  // Own scene instances for the leader's rotation; false while it has none.
  function followLeader() {
    rotation = leader.getRotation();
    if (!rotation) return false;
    if (currentName !== rotation.current) {
      current = nextName === rotation.current ? next : SCENES[rotation.current].create(rng, palette);
      currentName = rotation.current;
      next = null;
      nextName = null;
    }
    if (rotation.next && nextName !== rotation.next) {
      next = SCENES[rotation.next].create(rng, palette);
      nextName = rotation.next;
    } else if (!rotation.next) {
      next = null;
      nextName = null;
    }
    return true;
  }

  function place() {
    if (!host) return;
    const s = host.style;
    if (!bar) { s.top = s.left = s.width = s.height = ''; return; }
    s.top = `${bar.offsetTop}px`;
    s.left = `${bar.offsetLeft}px`;
    s.width = `${bar.offsetWidth}px`;
    s.height = `${bar.offsetHeight}px`;
  }

  // Attach the host to its strip; false when the strip is not built yet.
  function mount() {
    const spot = locate();
    if (!spot) { if (host) unmount(); return false; }
    const { parent, anchor } = spot;
    vertical = !!spot.vertical;
    bar = spot.overlay || null;
    if (!host) {
      host = document.createElement('div');
      host.className = 'fx-ambient';
      host.setAttribute('aria-hidden', 'true');
      sizeObserver = new ResizeObserver(() => { place(); startTick(); });
      if (pauseOffscreen) {
        viewObserver = new IntersectionObserver((entries) => {
          onScreen = entries[entries.length - 1].isIntersecting;
          if (onScreen) startTick(); else stopTick();
        });
        viewObserver.observe(host);
      }
    }
    host.classList.toggle('fx-ambient--vertical', vertical);
    host.classList.toggle('fx-ambient--fill', !bar && !vertical);
    host.classList.toggle('fx-ambient--drift', mode === 'drift');
    if (host.nextSibling !== anchor || host.parentNode !== parent) parent.insertBefore(host, anchor);
    sizeObserver.disconnect();
    sizeObserver.observe(bar || parent);
    place();
    if (bodyClass && !document.body.classList.contains(bodyClass)) document.body.classList.add(bodyClass);
    return true;
  }

  function unmount() {
    stopTick();
    if (sizeObserver) sizeObserver.disconnect();
    if (viewObserver) viewObserver.disconnect();
    if (host) host.remove();
    host = null;
    canvas = null;
    ctx = null;
    sizeObserver = null;
    viewObserver = null;
    onScreen = !pauseOffscreen;
    // classList writes the attribute even when nothing changes, which would
    // re-fire the body observer that called us.
    if (bodyClass && document.body.classList.contains(bodyClass)) document.body.classList.remove(bodyClass);
  }

  function ensureCanvas() {
    if (canvas && canvas.parentNode === host) return;
    canvas = document.createElement('canvas');
    host.appendChild(canvas);
    ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('fx/ambient: 2d canvas context unavailable');
  }

  function fit() {
    const dpr = Math.min(opts.lowPower ? 1 : 2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.ceil(w * dpr)) canvas.width = Math.ceil(w * dpr);
    if (canvas.height !== Math.ceil(h * dpr)) canvas.height = Math.ceil(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function paint(size) {
    const { w, h } = size;
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = theme === 'light' ? 'source-over' : 'lighter';
    // Scenes draw a horizontal strip; the sidebar rotates it a quarter turn.
    const len = vertical ? h : w;
    const thick = vertical ? w : h;
    if (vertical) { ctx.translate(w, 0); ctx.rotate(Math.PI / 2); }
    const peak = peakAlpha(theme, opts.intensity) * Math.min(1, intro / INTRO_S);
    current.draw(ctx, len, thick, peak * (1 - rotation.mix));
    if (next) next.draw(ctx, len, thick, peak * rotation.mix);
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(dt) {
    acc += dt;
    // 10% slack so a 60Hz display lands on every 2nd frame despite float drift.
    if (acc < 0.9 / (focused ? FPS.focused : FPS.blurred)) return true;
    const step = Math.min(acc, 0.25);
    acc = 0;
    if (!canvas || !canvas.isConnected) { removeTick = null; return false; }
    const size = fit();
    // Zero-size chrome (hidden bar): idle until the size observer restarts us.
    if (!size) { removeTick = null; return false; }
    if (paletteDirty) readPalette();
    intro += step;
    if (leader) {
      if (!followLeader()) return true;
    } else {
      const event = rotation.advance(step);
      if (event === 'fade') { next = SCENES[rotation.next].create(rng, palette); nextName = rotation.next; }
      if (event === 'switch') { current = next; currentName = nextName; next = null; nextName = null; }
    }
    current.step(step);
    if (next) next.step(step);
    paint(size);
    return true;
  }

  function startTick() {
    if (removeTick || mode !== 'canvas' || !canvas || document.hidden || !onScreen) return;
    acc = 1;
    removeTick = ticker.add(frame);
  }

  function stopTick() {
    if (removeTick) removeTick();
    removeTick = null;
  }

  function listen(on) {
    const method = on ? 'addEventListener' : 'removeEventListener';
    document[method]('visibilitychange', onVisibility);
    window[method]('blur', onBlur);
    window[method]('focus', onFocus);
    if (on && !bodyObserver) {
      bodyObserver = new MutationObserver((records) => {
        // A layout flip moves the chrome; a strip built after apply() (or
        // rebuilt) is picked up on the next body change.
        const moved = records.some((r) => r.attributeName === 'data-chrome-layout');
        if ((moved || !host || !host.isConnected) && mount()) {
          if (mode === 'canvas') { ensureCanvas(); startTick(); }
        }
        if (records.some((r) => r.attributeName !== 'data-chrome-layout')) paletteDirty = true;
      });
      bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-chrome-layout'] });
    } else if (!on && bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
    }
  }

  // level: resolved motion level; settings.chromeAmbient is normalized here.
  function apply({ level, lowPower, chromeAmbient }) {
    const nextOpts = { ...normalizeAmbientSettings(chromeAmbient), lowPower: !!lowPower };
    const nextMode = resolveMode(level, nextOpts.scene);
    const sceneChanged = nextOpts.scene !== opts.scene;
    opts = nextOpts;
    paletteDirty = true;
    if (nextMode === 'off') {
      mode = 'off';
      listen(false);
      unmount();
      rotation = current = next = null;
      currentName = nextName = null;
      seeded = false;
      return;
    }
    mode = nextMode;
    listen(true);
    if (!mount()) return;
    if (mode === 'drift') {
      stopTick();
      if (canvas) canvas.remove();
      canvas = ctx = null;
      return;
    }
    if (!seeded || sceneChanged) resetScenes();
    ensureCanvas();
    startTick();
  }

  return {
    apply,
    getMode: () => mode,
    getScene: () => (rotation ? rotation.current : null),
    getRotation: () => rotation,
    isRunning: () => removeTick !== null,
  };
}

module.exports = {
  createAmbient,
  createRotation,
  resolveMode,
  peakAlpha,
  parseRgb,
  normalizeAmbientSettings,
  SCENES,
  SCENE_NAMES,
  SCENE_OPTIONS,
};
