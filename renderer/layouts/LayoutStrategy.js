/**
 * Base class for space layout strategies.
 * Subclasses implement apply() to position webviews.
 */
class LayoutStrategy {
  /**
   * Apply this layout to the space container.
   * @abstract
   * @param {HTMLElement} _container - the space-container element
   * @param {Object} _activeSpaces - map of { spaceId: boolean }
   * @param {string} _currentSpaceId - the focused space
   * @param {string[]} [_spaceOrder] - ordered list of space IDs
   */
  apply(_container, _activeSpaces, _currentSpaceId, _spaceOrder) {
    throw new Error('Subclasses must implement apply()');
  }

  /**
   * Apply accent color borders to active space wrappers.
   * Called by subclass layouts after positioning.
   */
  static applyAccentColors(container, activeSpaces) {
    if (!container) return;
    const config = window.config;
    if (!config || !config.spaces) return;

    const wrappers = container.querySelectorAll('.space-webview-wrapper');
    wrappers.forEach((wrapper) => {
      const wv = wrapper.querySelector('.space-browser');
      if (!wv) return;
      const space = config.spaces[wv.id];
      if (space && space.color && activeSpaces[wv.id]) {
        wrapper.style.borderTop = `3px solid ${space.color}`;
      } else {
        wrapper.style.borderTop = '';
      }
    });
  }

  /**
   * Clean up styles when switching to a different layout. Clears every style
   * any concrete layout might have set on wrappers — gridColumn included, so
   * switching out of Grid/TwoRow leaves no stale `span N` on the wrappers
   * even if a sibling layout never touched it.
   */
  teardown(container) {
    if (!container) return;
    const wrappers = container.querySelectorAll('.space-webview-wrapper');
    wrappers.forEach((wrapper) => {
      wrapper.style.flexBasis = '';
      wrapper.style.maxWidth = '';
      wrapper.style.maxHeight = '';
      wrapper.style.width = '';
      wrapper.style.order = '';
      wrapper.style.display = '';
      wrapper.style.borderTop = '';
      wrapper.style.gridColumn = '';
      wrapper.style.flexGrow = '';
      wrapper.style.flexShrink = '';
    });
    container.style.display = '';
    container.style.gridTemplateColumns = '';
    container.style.gridTemplateRows = '';
    container.style.flexDirection = '';
  }
}

module.exports = LayoutStrategy;
