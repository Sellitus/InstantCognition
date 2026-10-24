const LayoutStrategy = require('./LayoutStrategy');

/**
 * Shows only the current space, hides all others.
 * This is the default layout.
 */
class SingleLayout extends LayoutStrategy {
  apply(container, activeSpaces, currentSpaceId) {
    if (!container) return;
    container.style.display = 'flex';

    const wrappers = container.querySelectorAll('.space-webview-wrapper');
    wrappers.forEach((wrapper) => {
      const wv = wrapper.querySelector('.space-browser');
      if (!wv) return;
      if (wv.id === currentSpaceId) {
        wrapper.style.display = 'flex';
        wrapper.style.flexBasis = '100%';
        wrapper.style.maxWidth = '100%';
        wv.classList.add('active');
        wv.classList.remove('inactive');
      } else {
        wrapper.style.display = 'none';
        wrapper.style.flexBasis = '0';
        wrapper.style.maxWidth = '0';
        wv.classList.remove('active');
        wv.classList.add('inactive');
      }
    });

    LayoutStrategy.applyAccentColors(container, activeSpaces);
  }
}

module.exports = SingleLayout;
