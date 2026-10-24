const LayoutStrategy = require('./LayoutStrategy');
const { installHandles, loadRatios } = require('../utils/sideBySideResize');

/**
 * Shows all active spaces side by side.
 * Equal split by default; user can drag dividers between spaces to resize.
 * Ratios are persisted per-active-set in localStorage and restored on apply.
 */
class SideBySideLayout extends LayoutStrategy {
  constructor() {
    super();
    this._ratios = null;
    this._activeKey = null;
  }

  apply(container, activeSpaces, _currentSpaceId, spaceOrder) {
    if (!container) return;
    container.style.display = 'flex';

    const orderedActive = (spaceOrder || Object.keys(activeSpaces))
      .filter((id) => activeSpaces[id]);

    const key = orderedActive.join('|');
    if (this._activeKey !== key) {
      this._activeKey = key;
      this._ratios = loadRatios(orderedActive);
    }

    const ratios = this._ratios && orderedActive.every((id) => typeof this._ratios[id] === 'number')
      ? this._ratios
      : null;
    const equal = `${100 / Math.max(orderedActive.length, 1)}%`;

    container.querySelectorAll('.space-webview-wrapper').forEach((wrapper) => {
      const wv = wrapper.querySelector('.space-browser');
      if (!wv) return;
      if (activeSpaces[wv.id]) {
        const basis = ratios ? `${ratios[wv.id]}%` : equal;
        wrapper.style.display = 'flex';
        wrapper.style.flexBasis = basis;
        wrapper.style.maxWidth = basis;
        wrapper.style.flexGrow = '0';
        wrapper.style.flexShrink = '0';
        // Order doubled so resize handles can claim the odd integers in
        // between (CSS order accepts <integer> only — fractional values
        // like 0.5 are silently rejected and the handle drops to default 0).
        wrapper.style.order = spaceOrder ? String(spaceOrder.indexOf(wv.id) * 2) : '';
        wv.classList.add('active');
        wv.classList.remove('inactive');
      } else {
        wrapper.style.display = 'none';
        wrapper.style.flexBasis = '0';
        wrapper.style.maxWidth = '0';
        wrapper.style.order = '';
        wv.classList.remove('active');
        wv.classList.add('inactive');
      }
    });

    LayoutStrategy.applyAccentColors(container, activeSpaces);
    installHandles(container, orderedActive, (next) => {
      this._ratios = next;
      this._activeKey = orderedActive.join('|');
    });
  }

  teardown(container) {
    if (container && typeof container.querySelectorAll === 'function') {
      container.querySelectorAll('.space-resize-handle').forEach((h) => h.remove());
    }
    super.teardown(container);
    if (container && container.style) {
      container.style.flexGrow = '';
      container.style.flexShrink = '';
    }
  }
}

module.exports = SideBySideLayout;
