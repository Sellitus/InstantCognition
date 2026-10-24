const LayoutStrategy = require('./LayoutStrategy');
const { installHandles, loadRatios } = require('../utils/sideBySideResize');

/**
 * Stacks active spaces vertically (top to bottom).
 * Equal split by default; user can drag horizontal dividers to resize rows.
 * Ratios persist per-active-set in localStorage under the vertical-axis key.
 */
class StackedLayout extends LayoutStrategy {
  constructor() {
    super();
    this._ratios = null;
    this._activeKey = null;
  }

  apply(container, activeSpaces, _currentSpaceId, spaceOrder) {
    if (!container) return;
    container.style.display = 'flex';
    container.style.flexDirection = 'column';

    const orderedActive = (spaceOrder || Object.keys(activeSpaces))
      .filter((id) => activeSpaces[id]);

    const key = orderedActive.join('|');
    if (this._activeKey !== key) {
      this._activeKey = key;
      this._ratios = loadRatios(orderedActive, 'vertical');
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
        wrapper.style.maxHeight = basis;
        wrapper.style.maxWidth = '';
        wrapper.style.width = '100%';
        wrapper.style.flexGrow = '0';
        wrapper.style.flexShrink = '0';
        // Order doubled so resize handles claim the odd integers between
        // wrappers (CSS `order` accepts <integer> only).
        wrapper.style.order = spaceOrder ? String(spaceOrder.indexOf(wv.id) * 2) : '';
        wv.classList.add('active');
        wv.classList.remove('inactive');
      } else {
        wrapper.style.display = 'none';
        wrapper.style.flexBasis = '0';
        wrapper.style.maxHeight = '0';
        wrapper.style.order = '';
        wv.classList.remove('active');
        wv.classList.add('inactive');
      }
    });

    LayoutStrategy.applyAccentColors(container, activeSpaces);
    installHandles(container, orderedActive, (next) => {
      this._ratios = next;
      this._activeKey = orderedActive.join('|');
    }, 'vertical');
  }

  teardown(container) {
    if (container && typeof container.querySelectorAll === 'function') {
      container.querySelectorAll('.space-resize-handle').forEach((h) => h.remove());
      container.querySelectorAll('.space-webview-wrapper').forEach((w) => {
        w.style.maxHeight = '';
        w.style.width = '';
      });
    }
    super.teardown(container);
    if (container && container.style) {
      container.style.flexDirection = '';
      container.style.flexGrow = '';
      container.style.flexShrink = '';
    }
  }
}

module.exports = StackedLayout;
