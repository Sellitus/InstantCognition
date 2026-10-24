// Visual-effects facade. Components call these hooks unconditionally; each
// hook checks the resolved motion level and returns immediately (or hands back
// a no-op) when the effect is not enabled. The level is 'off' until
// applySettings() runs, so headless tests and early boot draw nothing.
//
// Levels: 'full' adds canvas effects (particles, comets, constellation,
// starfield animation, voice orb); 'subtle' keeps compositor-only effects
// (rims, springs, spotlight, glide, stream fade); 'off' disables everything.

const { resolveMotionLevel, isLowPower, springEasing } = require('./motion');
const canvasLayer = require('./canvasLayer');
const { captureRects, playFlip } = require('./flip');
const { spawnBurst, stepParticles, drawParticles } = require('./particles');
const rim = require('./rim');
const spotlight = require('./spotlight');
const { glide: glideTo } = require('./glide');
const streamReveal = require('./streamReveal');
const summon = require('./summon');
const comets = require('./comets');
const council = require('./council');
const { createStarfield } = require('./starfield');
const { drawOrb } = require('./voiceOrb');
const { createAmbient } = require('./ambient');

const SPRING = {
  layout: { stiffness: 210, damping: 24 },
  glide: { stiffness: 380, damping: 30 },
  pop: { stiffness: 260, damping: 15 },
  settle: { stiffness: 180, damping: 20 },
};
const NOOP = () => {};
const TARGET_RIM_MS = 1400;

let level = 'off';
let lowPower = false;
let appState = null;
let lastSettings = null;
let installed = false;
const rimTimers = new Map();
let councilWrappers = [];
const ambient = createAmbient();
// The assistant header is a second strip under the same sky as the tab chrome.
const panelAmbient = createAmbient({
  leader: ambient,
  bodyClass: null,
  pauseOffscreen: true,
  locate: () => {
    const header = document.querySelector('#assistant-shell .agent-panel-header');
    return header && { parent: header, anchor: header.firstChild, overlay: null, vertical: false };
  },
});

const on = () => level !== 'off';
const full = () => level === 'full';
const springFor = (name) => springEasing(SPRING[name]);

function reducedMotionQuery() {
  return window.matchMedia('(prefers-reduced-motion: reduce)');
}

function applySettings(settings) {
  lastSettings = settings || {};
  level = resolveMotionLevel(lastSettings, { prefersReducedMotion: reducedMotionQuery().matches });
  lowPower = isLowPower(lastSettings, process.platform);
  document.body.classList.toggle('fx-full', level === 'full');
  document.body.classList.toggle('fx-subtle', level === 'subtle');
  document.body.classList.toggle('fx-lowpower', lowPower);
  canvasLayer.setLowPower(lowPower);
  ambient.apply({ level, lowPower, chromeAmbient: lastSettings.chromeAmbient });
  panelAmbient.apply({ level, lowPower, chromeAmbient: lastSettings.chromeAmbient });
}

function init({ state }) {
  appState = state;
  if (installed) return;
  installed = true;
  spotlight.install();
  summon.install({ getLevel: () => level, getSpring: () => springFor('settle') });
  reducedMotionQuery().addEventListener('change', () => {
    if (lastSettings) applySettings(lastSettings);
  });
}

function burstAt(rect) {
  const ps = spawnBurst({ x: rect.left, y: rect.top, w: rect.width, h: rect.height, count: lowPower ? 14 : 30 });
  canvasLayer.addTask((ctx, dt) => {
    const alive = stepParticles(ps, dt);
    drawParticles(ctx, ps);
    return alive > 0;
  });
}

function pop(el) {
  const s = springFor('pop');
  el.animate([{ transform: 'scale(0.7)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: s.duration, easing: s.easing });
}

// ── Tab bar: neighbours spring into place, closed tabs burst, new tabs pop ──
function tabsBeforeRender(bar) {
  if (!on() || !bar) return NOOP;
  const keyOf = (el) => el.dataset.spaceId;
  const before = captureRects(bar, '.tab-bar-tab', keyOf);
  return () => {
    const s = springFor('layout');
    const diff = playFlip(bar, '.tab-bar-tab', keyOf, before, { ...s, scale: false });
    // A view switch replaces every tab; only decorate small, local changes.
    if (diff.added.length + diff.removed.length > 2) return;
    if (full()) diff.removed.forEach((r) => burstAt(r.rect));
    diff.added.forEach((key) => pop(diff.els.get(key)));
  };
}

// ── Layout: panes morph between Single/SideBySide/Grid/Stacked positions ──
function layoutBeforeApply(container) {
  if (!on() || !container) return NOOP;
  const body = document.body;
  if (body.classList.contains('window-stabilizing') || body.classList.contains('suppress-transitions')) return NOOP;
  if (document.querySelector('.space-resize-overlay')) return NOOP;
  const keyOf = (el) => el.dataset.spaceId;
  const before = captureRects(container, '.space-webview-wrapper', keyOf);
  return () => {
    const s = springFor('layout');
    const diff = playFlip(container, '.space-webview-wrapper', keyOf, before, s);
    if (before.size === 0) return;
    diff.added.forEach((key) => {
      diff.els.get(key).animate([{ transform: 'scale(0.96)', opacity: 0 }, { transform: 'none', opacity: 1 }], s);
    });
  };
}

function glide(list, selectedSelector) {
  if (!on()) return;
  glideTo(list, selectedSelector, springFor('glide'));
}

function streamReset(body) { streamReveal.reset(body); }

function streamAfterRender(body) {
  if (on()) streamReveal.afterRender(body);
}

// ── Agent ──
function agentActivity(running) {
  const panel = document.getElementById('agent-panel');
  if (!panel) return;
  if (running && on()) rim.attach(panel);
  else rim.detach(panel);
}

function visibleRect(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

// The pane a tool call acts on: explicit spaceId, else the active agent tab,
// else the user's focused tab (main resolves an unscoped call the same way).
function resolveTarget(args) {
  const byId = (id) => {
    const wv = id ? document.getElementById(id) : null;
    const wrapper = wv && wv.closest('.agent-tab-wrapper, .space-webview-wrapper');
    return wrapper && visibleRect(wrapper) ? { webview: wv, wrapper } : null;
  };
  const explicit = args && typeof args.spaceId === 'string' ? byId(args.spaceId) : null;
  if (explicit) return explicit;
  const agentTab = document.querySelector('.agent-tab-wrapper.is-active');
  if (agentTab && visibleRect(agentTab)) return { webview: agentTab.querySelector('webview'), wrapper: agentTab };
  return byId(appState && appState.get('currentSpaceId'));
}

function touchTarget(wrapper) {
  rim.attach(wrapper);
  clearTimeout(rimTimers.get(wrapper));
  rimTimers.set(wrapper, setTimeout(() => { rim.detach(wrapper); rimTimers.delete(wrapper); }, TARGET_RIM_MS));
}

function agentStepPlanned(payload) {
  if (!on() || !payload || !Array.isArray(payload.calls)) return;
  const calls = payload.calls.filter((c) => c && typeof c.name === 'string'
    && c.name.startsWith('browser.') && c.name !== 'browser.web_search').slice(0, 3);
  const panel = document.getElementById('agent-panel');
  const rows = panel ? panel.querySelectorAll('.agent-tool-stream-call') : [];
  const source = visibleRect(rows.length ? rows[rows.length - 1] : null) || visibleRect(panel);
  calls.forEach((call, i) => {
    const target = resolveTarget(call.args);
    if (!target) return;
    const rect = visibleRect(target.wrapper);
    if (full() && source && rect) {
      comets.launch(source, rect, { delay: i * 0.08, color: i % 2 ? '#FF2486' : '#00DCFF', onArrive: () => touchTarget(target.wrapper) });
    } else {
      touchTarget(target.wrapper);
    }
  });
}

// Successful clicks ring out at the exact point the agent clicked.
function agentStepActed(payload) {
  if (!full() || !payload || !Array.isArray(payload.results)) return;
  const calls = Array.isArray(payload.calls) ? payload.calls : [];
  payload.results.forEach((res, i) => {
    const at = res && res.result && res.result.ok && res.result.at;
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    const target = resolveTarget(calls[i] && calls[i].args);
    const wv = target && /** @type {any} */ (target.webview);
    const r = visibleRect(wv);
    if (!r) return;
    const zoom = typeof wv.getZoomFactor === 'function' ? wv.getZoomFactor() : 1;
    comets.impactAt(r.left + at.x * zoom, r.top + at.y * zoom);
  });
}

// ── /council ──
function councilStart(spaceIds) {
  councilStop();
  if (!on() || !Array.isArray(spaceIds)) return;
  councilWrappers = spaceIds
    .map((id) => { const wv = document.getElementById(id); return wv && wv.closest('.space-webview-wrapper'); })
    .filter((w) => w && visibleRect(w));
  councilWrappers.forEach((w) => rim.attach(w));
  if (full() && councilWrappers.length >= 2) council.start(councilWrappers);
}

// answers[i] = { text } captured from spaceIds[i] on this round.
function councilUpdate(answers) {
  if (!full() || !Array.isArray(answers)) return;
  council.update(answers.map((a) => (a && a.text) || ''));
}

function councilConverge() {
  if (full()) {
    const dest = visibleRect(document.querySelector('#agent-panel .agent-answer')) || visibleRect(document.getElementById('agent-panel'));
    if (dest) council.nodeRects().forEach((r, i) => comets.launch(r, dest, { delay: i * 0.06, color: '#FF2486' }));
  }
  council.stop();
}

function councilStop() {
  council.stop();
  councilWrappers.forEach((w) => rim.detach(w));
  councilWrappers = [];
}

// ── Canvas surfaces owned by components ──
function starfield(canvas, { warp = false } = {}) {
  if (!on() || !canvas) return { start: NOOP, stop: NOOP };
  return createStarfield(canvas, { warp, lowPower, mode: full() ? 'animate' : 'static' });
}

function voiceOrb(canvas, micLevel) {
  if (full() && canvas) drawOrb(canvas, micLevel, performance.now());
}

module.exports = {
  init,
  applySettings,
  getLevel: () => level,
  tabsBeforeRender,
  layoutBeforeApply,
  glide,
  streamReset,
  streamAfterRender,
  agentActivity,
  agentStepPlanned,
  agentStepActed,
  councilStart,
  councilUpdate,
  councilConverge,
  councilStop,
  starfield,
  voiceOrb,
};
