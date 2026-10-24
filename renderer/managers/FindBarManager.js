const { icon } = require('../components/Icon');
const Dropdown = require('../components/dropdown/Dropdown');

class FindBarManager {
  constructor(state, navigationManager) {
    this.state = state;
    this.navigationManager = navigationManager;
    this._content = null;
    this._findInput = null;
    this._resultsDisplay = null;
    this._currentFindTerm = '';
    this._targetWebview = null;
    this._requestId = null;
    this._debounceTimer = null;
    this._dropdown = null;
  }

  open() {
    if (!this._dropdown) this._buildDropdown();
    if (!this._dropdown) return;

    this.state.set('findBarVisible', true);
    this._dropdown.open();
    if (this._findInput) {
      this._findInput.focus();
      this._findInput.select();
    }
  }

  toggle() {
    if (this.state.get('findBarVisible')) this.close();
    else this.open();
  }

  findNext() {
    if (!this._currentFindTerm || !this._targetWebview) return;
    if (!this._targetWebview.findInPage) return;
    this._requestId = this._targetWebview.findInPage(this._currentFindTerm, { forward: true, findNext: true });
  }

  findPrev() {
    if (!this._currentFindTerm || !this._targetWebview) return;
    if (!this._targetWebview.findInPage) return;
    this._requestId = this._targetWebview.findInPage(this._currentFindTerm, { forward: false, findNext: true });
  }

  close() {
    this.state.set('findBarVisible', false);
    if (this._targetWebview && this._targetWebview.stopFindInPage) {
      try { this._targetWebview.stopFindInPage('clearSelection'); } catch (_) { /* ignore */ }
    }
    this._currentFindTerm = '';
    this._targetWebview = null;
    this._requestId = null;
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._findInput) this._findInput.value = '';
    if (this._resultsDisplay) this._resultsDisplay.textContent = '';
    if (this._dropdown) this._dropdown.close();
  }

  handleFoundInPage(webview, result) {
    if (!this.state.get('findBarVisible')) return;
    if (webview !== this._targetWebview) return;
    if (this._requestId !== null && result.requestId !== this._requestId) return;
    if (!result.finalUpdate) return;
    this._updateResultCount(result.activeMatchOrdinal, result.matches);
  }

  _updateResultCount(activeMatchOrdinal, numberOfMatches) {
    if (!this._resultsDisplay) return;
    if (numberOfMatches > 0) {
      this._resultsDisplay.textContent = `${activeMatchOrdinal}/${numberOfMatches}`;
    } else if (this._currentFindTerm) {
      this._resultsDisplay.textContent = 'No results';
    } else {
      this._resultsDisplay.textContent = '';
    }
  }

  _search(term) {
    this._currentFindTerm = term;

    if (!this._targetWebview || !this._targetWebview.isConnected) {
      this._targetWebview = this.navigationManager.getActiveWebview();
    }

    if (!term) {
      if (this._targetWebview && this._targetWebview.stopFindInPage) {
        try { this._targetWebview.stopFindInPage('clearSelection'); } catch (_) { /* ignore */ }
      }
      this._requestId = null;
      if (this._resultsDisplay) this._resultsDisplay.textContent = '';
      return;
    }

    if (this._targetWebview && this._targetWebview.findInPage) {
      this._requestId = this._targetWebview.findInPage(term);
    }
  }

  _buildDropdown() {
    const content = document.createElement('div');
    content.className = 'find-bar-content';

    this._findInput = document.createElement('input');
    this._findInput.type = 'text';
    this._findInput.placeholder = 'Find in page…';
    this._findInput.className = 'find-input';
    this._findInput.setAttribute('data-autofocus', 'true');

    this._resultsDisplay = document.createElement('span');
    this._resultsDisplay.className = 'find-results';

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.appendChild(icon('up'));
    prevBtn.className = 'find-btn';
    prevBtn.setAttribute('aria-label', 'Previous match');
    prevBtn.addEventListener('click', () => this.findPrev());

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.appendChild(icon('down'));
    nextBtn.className = 'find-btn';
    nextBtn.setAttribute('aria-label', 'Next match');
    nextBtn.addEventListener('click', () => this.findNext());

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.appendChild(icon('close'));
    closeBtn.className = 'find-btn find-btn--close';
    closeBtn.setAttribute('aria-label', 'Close find bar');
    closeBtn.addEventListener('click', () => this.close());

    this._findInput.addEventListener('input', (e) => {
      const term = /** @type {HTMLInputElement} */ (e.target).value;
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = null;
        this._search(term);
      }, 100);
    });

    this._findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this._debounceTimer) {
          clearTimeout(this._debounceTimer);
          this._debounceTimer = null;
          this._search(this._findInput.value);
        }
        if (e.shiftKey) this.findPrev();
        else this.findNext();
      }
      // Esc handled by Dropdown controller (which calls close()).
    });

    content.appendChild(this._findInput);
    content.appendChild(this._resultsDisplay);
    content.appendChild(prevBtn);
    content.appendChild(nextBtn);
    content.appendChild(closeBtn);

    this._content = content;
    this._dropdown = new Dropdown({
      id: 'find-bar',
      size: 'sm',
      ariaLabel: 'Find in page',
      // FindBar is non-modal: no dim, no outside-click close — the page
      // behind it must stay interactive while the user searches.
      noBackdrop: true,
      closeOnBackdrop: false,
      onClose: () => {
        // Mirror controller-driven close into our state flag.
        if (this.state.get('findBarVisible')) {
          this.state.set('findBarVisible', false);
        }
      },
    });
    this._dropdown.el.classList.add('app-dropdown--compact');
    this._dropdown.mount(content);
  }
}

module.exports = FindBarManager;
