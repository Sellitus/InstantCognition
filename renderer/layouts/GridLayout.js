const LayoutStrategy = require('./LayoutStrategy');

/**
 * Arranges active spaces in a responsive grid.
 * Automatically calculates columns based on count.
 * When the count is odd, the first row has one fewer item,
 * with each item spanning wider to fill the row.
 */
class GridLayout extends LayoutStrategy {
  apply(container, activeSpaces, _currentSpaceId, spaceOrder) {
    if (!container) return;

    const activeIds = Object.entries(activeSpaces)
      .filter(([_, isActive]) => isActive)
      .map(([id]) => id);
    const count = activeIds.length;
    if (count === 0) return;

    // Sort by spaceOrder so we can assign grid positions predictably
    if (spaceOrder) {
      activeIds.sort((a, b) => spaceOrder.indexOf(a) - spaceOrder.indexOf(b));
    }

    const cols = count === 2 ? 1 : Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const remainder = count % cols;
    const hasOddRow = remainder !== 0;
    // Items on the first row when odd: remainder items spanning cols columns
    const firstRowCount = hasOddRow ? remainder : cols;

    // Use a column count that allows spanning (lcm-like approach: cols columns)
    container.style.display = 'grid';
    container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    const wrappers = container.querySelectorAll('.space-webview-wrapper');

    // Build a map of activeId -> position index
    const positionMap = new Map();
    activeIds.forEach((id, i) => positionMap.set(id, i));

    wrappers.forEach((wrapper) => {
      const wv = wrapper.querySelector('.space-browser');
      if (!wv) return;
      if (activeSpaces[wv.id]) {
        wrapper.style.display = 'flex';
        wrapper.style.order = spaceOrder ? String(spaceOrder.indexOf(wv.id)) : '';

        const pos = positionMap.get(wv.id);
        if (hasOddRow && pos !== undefined && pos < firstRowCount) {
          // First row items span wider to fill the row evenly
          const spanSize = Math.floor(cols / firstRowCount);
          const extraSpan = pos < (cols % firstRowCount) ? 1 : 0;
          wrapper.style.gridColumn = `span ${spanSize + extraSpan}`;
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

module.exports = GridLayout;
