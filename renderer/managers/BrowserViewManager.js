class BrowserViewManager {
  constructor(state, navigationManager) {
    this.state = state;
    this.navigationManager = navigationManager;
    this.findBarManager = null;
  }

  setFindBarManager(findBarManager) {
    this.findBarManager = findBarManager;
  }

  toggle(onlyShow = false, onlyHide = false) {
    const isActive = this.state.get('browserViewActive');
    if (isActive && onlyShow) return;
    if (!isActive && onlyHide) return;

    const newState = onlyShow ? true : !isActive;
    this.state.set('browserViewActive', newState);

    const browserContainer = document.getElementById('browser-container');

    if (newState) {
      if (browserContainer) {
        browserContainer.classList.add('active');
        browserContainer.classList.remove('inactive');
        browserContainer.style.flex = '1';
      }
    } else {
      if (browserContainer) {
        browserContainer.classList.remove('active');
        browserContainer.classList.add('inactive');
        browserContainer.style.flex = '0';
      }
      // Ensure space view is shown if browser is hidden
      if (!this.state.get('spaceViewActive')) {
        this.toggleSpace(true);
      }
    }
  }

  toggleSpace(onlyShow = false, onlyHide = false) {
    const isActive = this.state.get('spaceViewActive');
    if (isActive && onlyShow) return;
    if (!isActive && onlyHide) return;

    const newState = onlyShow ? true : !isActive;
    this.state.set('spaceViewActive', newState);

    const spaceContainer = document.getElementById('space-container');

    if (newState) {
      if (spaceContainer) {
        spaceContainer.classList.add('active');
        spaceContainer.classList.remove('inactive');
        spaceContainer.style.flex = '1';
      }

      // Multi-space edge case: if no spaces are active, revert
      const multiSpace = this.state.get('multiSpace');
      const activeSpaces = this.state.get('activeSpaces');
      if (multiSpace && Object.values(activeSpaces).filter(Boolean).length === 0) {
        this.state.set('spaceViewActive', false);
        if (spaceContainer) spaceContainer.style.flex = '0';
        this.toggle(true);
      }
    } else {
      if (spaceContainer) {
        spaceContainer.classList.remove('active');
        spaceContainer.classList.add('inactive');
        spaceContainer.style.flex = '0';
      }
      // Ensure browser view is shown if space is hidden
      if (!this.state.get('browserViewActive')) {
        this.toggle(true);
      }
    }
  }

  toggleView() {
    if (this.findBarManager) this.findBarManager.close();
    const browserActive = this.state.get('browserViewActive');
    const spaceActive = this.state.get('spaceViewActive');

    if (browserActive && spaceActive) {
      // Both active: hide browser, keep space
      this.toggle();
    } else if (browserActive && !spaceActive) {
      this.toggleSpace();
      this.toggle();
    } else if (!browserActive && spaceActive) {
      this.toggle();
      this.toggleSpace();
    }
  }

}

module.exports = BrowserViewManager;
