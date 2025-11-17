// Import necessary modules
const { JSDOM } = require('jsdom');

// Mock modules
jest.mock('electron', () => {
  return {
    ipcRenderer: {
      on: jest.fn(),
      send: jest.fn(),
    },
  };
});

// Create a mock DOM environment for testing
const dom = new JSDOM(`
<!DOCTYPE html>
<html>
  <head></head>
  <body>
    <div id="side-bar"></div>
    <div id="cognitizer-container"></div>
    <div id="browser-container"></div>
    <div id="toggle-find-bar" class="menu-button"></div>
  </body>
</html>
`);

// Assign DOM globals
global.document = dom.window.document;
global.window = dom.window;
global.HTMLElement = dom.window.HTMLElement;

// Extract the findBar functionality from renderer.js for testing
const findBarUtils = {
  currentFindTerm: '',
  findInPageRequestId: 0,

  toggleFindBar: function () {
    const findBar = document.getElementById('find-bar');

    let bar = findBar;
    if (!bar) {
      this.createFindBar();
      bar = document.getElementById('find-bar');
    } else {
      if (bar.style.display === 'flex') {
        document.getElementById(`toggle-find-bar`).classList.remove('selected');
        this.closeFindBar();
        this.stopFindInPage();
        return;
      }
    }

    document.getElementById(`toggle-find-bar`).classList.add('selected');

    bar.style.display = 'flex';

    const findInput = document.getElementById('find-input');

    if (findInput) {
      findInput.focus();
      findInput.select();
    }

    // Add event listener in a real implementation

    this.findInPage('forward');
  },

  createFindBar: function () {
    // Create the find bar elements
    const findBar = document.createElement('div');
    findBar.id = 'find-bar';
    findBar.style.display = 'none';

    findBar.innerHTML = `
      <input type="text" id="find-input" placeholder="Find in page">
      <span id="find-results-count"></span>
      <button id="find-prev">▲</button>
      <button id="find-next">▼</button>
      <button id="find-close">✖</button>
    `;

    document.body.appendChild(findBar);
  },

  findInPage: function (direction) {
    const activeWebview = this.getActiveWebview();
    if (activeWebview && this.currentFindTerm) {
      this.findInPageRequestId++;
      activeWebview.findInPage(this.currentFindTerm, {
        forward: direction === 'forward',
        findNext: true,
        requestId: this.findInPageRequestId,
      });
    }
  },

  updateFindResultsCount: function (activeMatchOrdinal, matches) {
    const findResultsCount = document.getElementById('find-results-count');
    if (findResultsCount) {
      if (matches > 0) {
        findResultsCount.textContent = `${activeMatchOrdinal} of ${matches}`;
      } else {
        findResultsCount.textContent = '';
      }
    }
  },

  startFindInPage: function (text) {
    const activeWebview = this.getActiveWebview();
    if (!activeWebview || !text) return;

    activeWebview.stopFindInPage('clearSelection');

    if (this.findInPageTimeout) {
      clearTimeout(this.findInPageTimeout);
    }

    if (text.length > 0) {
      this.findInPageRequestId++;
      activeWebview.findInPage(text, {
        forward: true,
        findNext: false,
        matchCase: false,
        requestId: this.findInPageRequestId,
      });
    }
  },

  stopFindInPage: function () {
    const activeWebview = this.getActiveWebview();
    if (activeWebview && activeWebview.isReady) {
      activeWebview.stopFindInPage('clearSelection');
    }
  },

  closeFindBar: function () {
    this.stopFindInPage();
    const findBar = document.getElementById('find-bar');
    if (findBar) {
      findBar.style.display = 'none';
    }
    this.currentFindTerm = '';
    this.updateFindResultsCount(0, 0);
  },

  handleFoundInPage: function (event) {
    const result = event.result;
    const findResultsCount = document.getElementById('find-results-count');
    if (findResultsCount) {
      if (result.finalUpdate) {
        this.updateFindResultsCount(result.activeMatchOrdinal, result.matches);
      }
    }
  },

  getActiveWebview: function () {
    // Mock implementation for testing
    return {
      findInPage: jest.fn(),
      stopFindInPage: jest.fn(),
      isReady: true,
    };
  },
};

describe('findBar', () => {
  // Create spies for function calls
  let createFindBarSpy;
  let findInPageSpy;
  let updateFindResultsCountSpy;
  let stopFindInPageSpy;
  let closeFindBarSpy;

  beforeEach(() => {
    // Reset the DOM for each test
    document.body.innerHTML = `
      <div id="side-bar"></div>
      <div id="cognitizer-container"></div>
      <div id="browser-container"></div>
      <div id="toggle-find-bar" class="menu-button"></div>
    `;

    // Create spies
    createFindBarSpy = jest.spyOn(findBarUtils, 'createFindBar');
    findInPageSpy = jest.spyOn(findBarUtils, 'findInPage');
    updateFindResultsCountSpy = jest.spyOn(findBarUtils, 'updateFindResultsCount');
    stopFindInPageSpy = jest.spyOn(findBarUtils, 'stopFindInPage');
    closeFindBarSpy = jest.spyOn(findBarUtils, 'closeFindBar');

    // Reset state
    findBarUtils.findInPageTimeout = null;
    findBarUtils.currentFindTerm = '';
    findBarUtils.findInPageRequestId = 0;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('toggleFindBar creates find bar when it does not exist', () => {
    // Act
    findBarUtils.toggleFindBar();

    // Assert
    expect(createFindBarSpy).toHaveBeenCalled();
    expect(document.getElementById('find-bar')).not.toBeNull();
    expect(document.getElementById('find-bar').style.display).toBe('flex');
    expect(document.getElementById('toggle-find-bar').classList.contains('selected')).toBeTruthy();
    expect(findInPageSpy).toHaveBeenCalledWith('forward');
  });

  test('toggleFindBar hides find bar when it is already visible', () => {
    // Arrange
    findBarUtils.createFindBar();
    const findBar = document.getElementById('find-bar');
    findBar.style.display = 'flex';
    document.getElementById('toggle-find-bar').classList.add('selected');

    // Act
    findBarUtils.toggleFindBar();

    // Assert
    expect(closeFindBarSpy).toHaveBeenCalled();
    expect(stopFindInPageSpy).toHaveBeenCalled();
    expect(document.getElementById('toggle-find-bar').classList.contains('selected')).toBeFalsy();
  });

  test('createFindBar adds find bar to the DOM with correct elements', () => {
    // Act
    findBarUtils.createFindBar();

    // Assert
    const findBar = document.getElementById('find-bar');
    expect(findBar).not.toBeNull();
    expect(document.getElementById('find-input')).not.toBeNull();
    expect(document.getElementById('find-results-count')).not.toBeNull();
    expect(document.getElementById('find-prev')).not.toBeNull();
    expect(document.getElementById('find-next')).not.toBeNull();
    expect(document.getElementById('find-close')).not.toBeNull();
  });

  test('updateFindResultsCount displays match count correctly', () => {
    // Arrange
    findBarUtils.createFindBar();
    const resultsCount = document.getElementById('find-results-count');

    // Act
    findBarUtils.updateFindResultsCount(3, 10);

    // Assert
    expect(resultsCount.textContent).toBe('3 of 10');
  });

  test('updateFindResultsCount clears text when no matches', () => {
    // Arrange
    findBarUtils.createFindBar();
    const resultsCount = document.getElementById('find-results-count');
    resultsCount.textContent = '1 of 5';

    // Act
    findBarUtils.updateFindResultsCount(0, 0);

    // Assert
    expect(resultsCount.textContent).toBe('');
  });

  test('startFindInPage calls findInPage with correct parameters', () => {
    // Arrange - create a mock with explicit functions for tracking calls
    const mockWebview = {
      stopFindInPage: jest.fn(),
      findInPage: jest.fn(),
      isReady: true,
    };

    // Override getActiveWebview for just this test
    jest.spyOn(findBarUtils, 'getActiveWebview').mockReturnValue(mockWebview);

    // Act
    findBarUtils.startFindInPage('test');

    // Assert
    expect(mockWebview.stopFindInPage).toHaveBeenCalledWith('clearSelection');
    expect(mockWebview.findInPage).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({
        forward: true,
        findNext: false,
        matchCase: false,
      })
    );
  });

  test('closeFindBar hides the find bar and resets state', () => {
    // Arrange
    findBarUtils.createFindBar();
    const findBar = document.getElementById('find-bar');
    findBar.style.display = 'flex';
    findBarUtils.currentFindTerm = 'test';

    // Act
    findBarUtils.closeFindBar();

    // Assert
    expect(stopFindInPageSpy).toHaveBeenCalled();
    expect(findBar.style.display).toBe('none');
    expect(findBarUtils.currentFindTerm).toBe('');
    expect(updateFindResultsCountSpy).toHaveBeenCalledWith(0, 0);
  });

  test('handleFoundInPage updates result count on final update', () => {
    // Arrange
    findBarUtils.createFindBar();
    const event = {
      result: {
        finalUpdate: true,
        activeMatchOrdinal: 2,
        matches: 5,
      },
    };

    // Act
    findBarUtils.handleFoundInPage(event);

    // Assert
    expect(updateFindResultsCountSpy).toHaveBeenCalledWith(2, 5);
  });
});
