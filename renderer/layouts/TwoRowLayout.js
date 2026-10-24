const LayoutStrategy = require('./LayoutStrategy');

/**
 * Arranges active spaces in a 2-row grid layout.
 * First row takes ceil(count/2), second row takes floor(count/2).
 * For odd counts, items distribute evenly across their row's available space.
 */
class TwoRowLayout extends LayoutStrategy {
  apply(container, activeSpaces, _currentSpaceId, spaceOrder) {
    if (!container) return;

    const activeIds = Object.entries(activeSpaces)
      .filter(([_, isActive]) => isActive)
      .map(([id]) => id);
    const count = activeIds.length;
    if (count === 0) return;

    if (count === 1) {
      container.style.display = 'grid';
      container.style.gridTemplateColumns = '1fr';
      container.style.gridTemplateRows = '1fr';
    } else {
      const topCount = Math.ceil(count / 2);
      const bottomCount = Math.floor(count / 2);
      const maxCols = Math.max(topCount, bottomCount);

      container.style.display = 'grid';
      container.style.gridTemplateColumns = `repeat(${maxCols}, 1fr)`;
      container.style.gridTemplateRows = 'repeat(2, 1fr)';
    }

    const orderedActiveIds = spaceOrder
      ? spaceOrder.filter((id) => activeSpaces[id])
      : activeIds;

    const topCount = Math.ceil(count / 2);

    const wrappers = container.querySelectorAll('.space-webview-wrapper');
    wrappers.forEach((wrapper) => {
      const wv = wrapper.querySelector('.space-browser');
      if (!wv) return;

      if (activeSpaces[wv.id]) {
        wrapper.style.display = 'flex';
        // Order comes from tab order (spaceOrder arg is now openTabs at runtime).
        // Using absolute tab index keeps drag-reorder and visibility toggles
        // consistent with the other layouts.
        const absIdx = spaceOrder ? spaceOrder.indexOf(wv.id) : activeIds.indexOf(wv.id);
        wrapper.style.order = String(absIdx);
        const idx = orderedActiveIds.indexOf(wv.id);

        if (count > 1 && count % 2 !== 0 && idx === topCount - 1) {
          // Last item in top row spans remaining columns when odd count
          const maxCols = Math.max(topCount, count - topCount);
          const colsToSpan = maxCols - topCount + 1;
          wrapper.style.gridColumn = `span ${colsToSpan}`;
        } else {
          wrapper.style.gridColumn = '';
        }

        wv.classList.add('active');
        wv.classList.remove('inactive');
      } else {
        wrapper.style.display = 'none';
        wrapper.style.order = '';
        wrapper.style.gridColumn = '';
        wv.classList.remove('active');
        wv.classList.add('inactive');
      }
    });

    LayoutStrategy.applyAccentColors(container, activeSpaces);
  }

  teardown(container) {
    if (!container) return;
    const wrappers = container.querySelectorAll('.space-webview-wrapper');
    wrappers.forEach((wrapper) => {
      wrapper.style.gridColumn = '';
    });
    super.teardown(container);
  }
}

module.exports = TwoRowLayout;
