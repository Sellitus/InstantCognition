// Tooltip.js — singleton fast tooltip for chrome-bar action buttons.
//
// Shows after 150ms on mouseenter (vs ~500ms for native title attr).
// Anchor side adapts to body[data-chrome-layout] so tooltips never
// clip behind the bar. Suppressed when the host is inside an expanded
// sidebar (inline labels are visible there instead).

const SHOW_DELAY_MS = 150;
const HIDE_DELAY_MS = 60;
const MARGIN = 8;

let tooltipEl = null;
let activeHost = null;
let showTimer = null;
let hideTimer = null;

function ensureEl() {
  if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'app-tooltip';
  tooltipEl.setAttribute('role', 'tooltip');
  tooltipEl.hidden = true;
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function chromeLayout() {
  return (document && document.body && document.body.dataset && document.body.dataset.chromeLayout) || 'left';
}

function shouldSuppress(host) {
  if (!host || typeof host.closest !== 'function') return false;
  return !!host.closest('.chrome-sidebar--expanded');
}

function position(host, label) {
  const el = ensureEl();
  el.textContent = label;
  el.hidden = false;

  const r = host.getBoundingClientRect();
  // Force layout so width/height are valid.
  const tw = el.offsetWidth;
  const th = el.offsetHeight;
  const layout = chromeLayout();

  let top = 0;
  let left = 0;
  switch (layout) {
    case 'top':
      top = r.bottom + MARGIN;
      left = r.left + r.width / 2 - tw / 2;
      break;
    case 'bottom':
      top = r.top - th - MARGIN;
      left = r.left + r.width / 2 - tw / 2;
      break;
    case 'right':
      top = r.top + r.height / 2 - th / 2;
      left = r.left - tw - MARGIN;
      break;
    case 'left':
    default:
      top = r.top + r.height / 2 - th / 2;
      left = r.right + MARGIN;
      break;
  }

  // Clamp within viewport.
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (left < MARGIN) left = MARGIN;
  if (left + tw > vw - MARGIN) left = vw - tw - MARGIN;
  if (top < MARGIN) top = MARGIN;
  if (top + th > vh - MARGIN) top = vh - th - MARGIN;

  el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function show(host) {
  if (!host) return;
  const label = host.__appTooltipLabel;
  if (!label) return;
  if (shouldSuppress(host)) return;
  position(host, label);
  // Force a frame so the transition runs from opacity 0.
  ensureEl().offsetWidth;
  ensureEl().classList.add('is-visible');
}

function hide() {
  const el = ensureEl();
  el.classList.remove('is-visible');
  // Hide attribute after transition for full removal from layer tree.
  setTimeout(() => {
    if (!el.classList.contains('is-visible')) el.hidden = true;
  }, 180);
}

function clearTimers() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function onEnter(e) {
  const host = e.currentTarget;
  activeHost = host;
  clearTimers();
  const noAnim = document.body.classList.contains('no-animations');
  const delay = noAnim ? 0 : SHOW_DELAY_MS;
  showTimer = setTimeout(() => {
    if (activeHost === host) show(host);
  }, delay);
}

function onLeave(e) {
  const host = e.currentTarget;
  if (activeHost === host) activeHost = null;
  clearTimers();
  hideTimer = setTimeout(hide, HIDE_DELAY_MS);
}

function onDown(e) {
  if (activeHost === e.currentTarget) activeHost = null;
  clearTimers();
  hide();
}

const Tooltip = {
  attach(element, label) {
    if (!element || typeof label !== 'string') return;
    if (element.__appTooltipAttached) {
      element.__appTooltipLabel = label;
      return;
    }
    element.__appTooltipAttached = true;
    element.__appTooltipLabel = label;
    element.addEventListener('mouseenter', onEnter);
    element.addEventListener('mouseleave', onLeave);
    element.addEventListener('mousedown', onDown);
    element.addEventListener('blur', onDown);
  },

  detach(element) {
    if (!element || !element.__appTooltipAttached) return;
    element.removeEventListener('mouseenter', onEnter);
    element.removeEventListener('mouseleave', onLeave);
    element.removeEventListener('mousedown', onDown);
    element.removeEventListener('blur', onDown);
    delete element.__appTooltipAttached;
    delete element.__appTooltipLabel;
    if (activeHost === element) {
      activeHost = null;
      clearTimers();
      hide();
    }
  },

  hide() {
    activeHost = null;
    clearTimers();
    hide();
  },
};

module.exports = Tooltip;
