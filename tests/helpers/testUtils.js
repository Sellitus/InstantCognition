/**
 * Test utility functions for InstantCognition tests
 */

/**
 * Wait for a condition to be true
 * @param {Function} condition - Function that returns boolean
 * @param {number} timeout - Maximum wait time in ms
 * @param {number} interval - Check interval in ms
 * @returns {Promise<void>}
 */
async function waitFor(condition, timeout = 5000, interval = 50) {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error(`Timeout waiting for condition after ${timeout}ms`));
      } else {
        setTimeout(check, interval);
      }
    };

    check();
  });
}

/**
 * Create a mock configuration object
 * @param {Object} overrides - Configuration overrides
 * @returns {Object} Mock configuration
 */
function createMockConfig(overrides = {}) {
  return {
    spaces: {
      custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/', type: 'ai-service' },
      custom2: { name: 'Claude', url: 'https://claude.ai/new', type: 'ai-service' },
      custom3: { name: 'Gemini', url: 'https://gemini.google.com/', type: 'ai-service' },
    },
    multiSpaceActive: false,
    activeSpace: 0,
    openExternalLinks: false,
    adBlockerEnabled: true,
    hotkeyLocked: false,
    windowBounds: { x: 100, y: 100, width: 1200, height: 800 },
    acceptedCertificates: [],
    ...overrides,
  };
}

/**
 * Create a mock DOM environment for component tests
 * @returns {Object} Mock DOM elements
 */
function createMockDOM() {
  // Create mock DOM elements commonly used in tests
  const mockElements = {
    'side-bar': document.createElement('div'),
    'toggle-button': document.createElement('button'),
    'settings-menu': document.createElement('div'),
    'settings-close-button': document.createElement('button'),
    'shortcuts-list': document.createElement('div'),
    'shortcut-search': document.createElement('input'),
    'reset-all-shortcuts': document.createElement('button'),
    'spaces-list': document.createElement('div'),
    'general-tab': document.createElement('div'),
    'shortcuts-tab': document.createElement('div'),
    'spaces-tab': document.createElement('div'),
    'appearance-tab': document.createElement('div'),
    'preventMenuExpansion': document.createElement('input'),
    'enableAdblocker': document.createElement('input'),
    'launchAtStartup': document.createElement('input'),
    'openLinkExternal': document.createElement('input'),
    'browserHomeUrl': document.createElement('input'),
    'enableDefaultSpace': document.createElement('input'),
    'defaultSpaceSelect': document.createElement('select'),

    'autoDenyCertErrors': document.createElement('input'),
    'persistZoomLevels': document.createElement('input'),
    'enableAnimations': document.createElement('input'),
    'enableRippleEffects': document.createElement('input'),
    'sidebarWidth': document.createElement('input'),
    'sidebarWidthValue': document.createElement('span')
  };

  // Add IDs to elements
  Object.entries(mockElements).forEach(([id, element]) => {
    element.id = id;
  });

  // Create menu content element with class
  const menuContent = document.createElement('div');
  menuContent.className = 'menu-content';
  mockElements['side-bar'].appendChild(menuContent);

  // Create dropdown sections
  const dropdownSection = document.createElement('div');
  dropdownSection.className = 'dropdown-section';
  menuContent.appendChild(dropdownSection);

  // Create space dropdown section
  const spaceSection = document.createElement('div');
  spaceSection.className = 'space-dropdown-section';
  menuContent.appendChild(spaceSection);

  // Mock global functions. jsdom's `window` is read-only, so the stubs go on it.
  Object.assign(window, {
    fullNames: {
      'custom1': 'Custom 1',
      'custom2': 'Custom 2',
      'browser': 'Browser'
    },
    saveSettings: jest.fn(),
    sidebar: {
      setPreventExpansion: jest.fn()
    }
  });

  // Mock getElementById to return our elements
  const originalGetElementById = document.getElementById;
  document.getElementById = jest.fn((id) => {
    return mockElements[id] || originalGetElementById.call(document, id);
  });

  // Mock querySelector and querySelectorAll
  document.querySelector = jest.fn((selector) => {
    if (selector === '.menu-content') return menuContent;
    if (selector === '.settings-menu') return mockElements['settings-menu'];
    if (selector.includes('[name="theme"]')) {
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'theme';
      radio.value = 'dark';
      radio.checked = true;
      return radio;
    }
    return null;
  });

  document.querySelectorAll = jest.fn((selector) => {
    if (selector === '.tab-button') {
      return [
        createTabButton('general'),
        createTabButton('shortcuts'),
        createTabButton('spaces'),
        createTabButton('appearance')
      ];
    }
    if (selector === '.tab-content') {
      return [
        mockElements['general-tab'],
        mockElements['shortcuts-tab'],
        mockElements['spaces-tab'],
        mockElements['appearance-tab']
      ];
    }
    if (selector === '.dropdown-section > div') {
      return [
        createDropdownItem('custom1button'),
        createDropdownItem('custom2button'),
        createDropdownItem('browserbutton')
      ];
    }
    if (selector === '.space-dropdown-section > div') {
      return [
        createDropdownItem('custom1button'),
        createDropdownItem('custom2button')
      ];
    }
    if (selector.includes('[name="theme"]')) {
      return [
        createRadioButton('theme', 'dark'),
        createRadioButton('theme', 'light'),
        createRadioButton('theme', 'system')
      ];
    }
    return [];
  });

  // Mock body for appending elements
  document.body.appendChild = jest.fn();
  document.body.insertAdjacentHTML = jest.fn();
  document.body.classList = {
    add: jest.fn(),
    remove: jest.fn(),
    toggle: jest.fn()
  };

  return mockElements;
}

function createTabButton(tabName) {
  const button = document.createElement('button');
  button.className = 'tab-button';
  button.dataset.tab = tabName;
  if (tabName === 'general') button.classList.add('active');
  return button;
}

function createDropdownItem(id) {
  const div = document.createElement('div');
  div.id = id;

  // Create a real classList implementation
  const classList = new Set();
  div.classList = {
    add: jest.fn((className) => classList.add(className)),
    remove: jest.fn((className) => classList.delete(className)),
    contains: jest.fn((className) => classList.has(className)),
    toggle: jest.fn((className) => {
      if (classList.has(className)) {
        classList.delete(className);
        return false;
      } else {
        classList.add(className);
        return true;
      }
    })
  };

  // Add methods for querying
  div.querySelector = jest.fn(() => null);
  div.appendChild = jest.fn();
  div.removeChild = jest.fn();

  return div;
}

function createRadioButton(name, value) {
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = name;
  radio.value = value;
  if (value === 'dark') radio.checked = true;
  return radio;
}

module.exports = {
  waitFor,
  createMockConfig,
  createMockDOM,
};
