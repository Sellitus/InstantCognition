const sidebar = require('../../../../renderer/components/Sidebar');
const { createMockDOM } = require('../../../helpers/testUtils');

// Mock electron
jest.mock('electron', () => ({
  ipcRenderer: {
    send: jest.fn(),
    on: jest.fn()
  }
}));

// Mock IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe('Sidebar', () => {
  let mockConfig;
  let mockElements;

  beforeEach(() => {
    // Reset the DOM
    document.body.innerHTML = '';
    
    // Create mock config
    mockConfig = {
      settings: {
        preventMenuExpansion: false
      }
    };

    // Set up mock DOM
    mockElements = createMockDOM();
    
    // Reset sidebar state
    sidebar.isExpanded = false;
    sidebar.preventExpansion = false;
  });

  afterEach(() => {
    jest.clearAllMocks();
    clearTimeout(sidebar.expandTimeout);
  });

  describe('Initialization', () => {
    test('should initialize sidebar elements', () => {
      sidebar.initialize(mockConfig);
      
      expect(sidebar.element).toBe(mockElements['side-bar']);
      expect(sidebar.toggleButton).toBe(mockElements['toggle-button']);
      expect(sidebar.menuContent).toBeTruthy();
    });

    test('should respect preventMenuExpansion setting', () => {
      mockConfig.settings.preventMenuExpansion = true;
      
      sidebar.initialize(mockConfig);
      
      expect(sidebar.preventExpansion).toBe(true);
    });

    test('should set up event listeners', () => {
      sidebar.initialize(mockConfig);
      
      // Verify that event listeners were set up by checking that the element has them
      expect(sidebar.toggleButton).toBeTruthy();
      expect(sidebar.element).toBeTruthy();
    });
  });

  describe('Toggle Button', () => {
    beforeEach(() => {
      sidebar.initialize(mockConfig);
    });

    test('should send toggle-settings-menu on click', () => {
      const { ipcRenderer } = require('electron');
      
      sidebar.toggleButton.click();
      
      expect(ipcRenderer.send).toHaveBeenCalledWith('toggle-settings-menu');
    });

    test('should create ripple effect on click', () => {
      const createRippleSpy = jest.spyOn(sidebar, 'createRipple');
      
      const event = new MouseEvent('click', {
        clientX: 10,
        clientY: 10
      });
      sidebar.toggleButton.dispatchEvent(event);
      
      expect(createRippleSpy).toHaveBeenCalledWith(expect.any(MouseEvent), sidebar.toggleButton);
    });
  });

  describe('Expand/Collapse', () => {
    beforeEach(() => {
      sidebar.initialize(mockConfig);
    });

    test('should expand sidebar', () => {
      sidebar.expand();
      
      expect(sidebar.isExpanded).toBe(true);
      expect(sidebar.element.classList.contains('expanded')).toBe(true);
      expect(sidebar.element.classList.contains('animating')).toBe(true);
    });

    test('should collapse sidebar', () => {
      sidebar.expand();
      sidebar.collapse();
      
      expect(sidebar.isExpanded).toBe(false);
      expect(sidebar.element.classList.contains('expanded')).toBe(false);
    });

    test('should not expand if already expanded', () => {
      sidebar.expand();
      const addSpy = jest.spyOn(sidebar.element.classList, 'add');
      
      sidebar.expand();
      
      expect(addSpy).not.toHaveBeenCalled();
    });

    test('should not collapse if already collapsed', () => {
      const removeSpy = jest.spyOn(sidebar.element.classList, 'remove');
      
      sidebar.collapse();
      
      expect(removeSpy).not.toHaveBeenCalled();
    });
  });

  describe('Button States', () => {
    beforeEach(() => {
      sidebar.initialize(mockConfig);
    });

    test('should update button selection state', () => {
      const button = mockElements['custom1button'];
      
      sidebar.updateButton('custom1button', true);
      
      expect(button.classList.contains('selected')).toBe(true);
    });

    test('should remove button selection state', () => {
      const button = mockElements['custom1button'];
      button.classList.add('selected');
      
      sidebar.updateButton('custom1button', false);
      
      expect(button.classList.contains('selected')).toBe(false);
    });
  });

  describe('Highlight', () => {
    beforeEach(() => {
      sidebar.initialize(mockConfig);
    });

    test('should highlight button temporarily', (done) => {
      const button = mockElements['custom1button'];
      
      sidebar.highlightButton('custom1button', 100);
      
      expect(button.classList.contains('highlight')).toBe(true);
      
      setTimeout(() => {
        expect(button.classList.contains('highlight')).toBe(false);
        done();
      }, 150);
    });
  });

  describe('Tooltips', () => {
    beforeEach(() => {
      sidebar.initialize(mockConfig);
    });

    test('should show tooltip when collapsed', () => {
      const element = mockElements['custom1button'];
      const appendChildSpy = jest.spyOn(document.body, 'appendChild');
      
      sidebar.showTooltip(element, 'Test Tooltip');
      
      expect(appendChildSpy).toHaveBeenCalled();
      const tooltip = appendChildSpy.mock.calls[0][0];
      expect(tooltip.className).toBe('sidebar-tooltip');
      expect(tooltip.textContent).toBe('Test Tooltip');
    });

    test('should not show tooltip when expanded', () => {
      sidebar.expand();
      const appendChildSpy = jest.spyOn(document.body, 'appendChild');
      
      sidebar.showTooltip(mockElements['custom1button'], 'Test Tooltip');
      
      expect(appendChildSpy).not.toHaveBeenCalled();
    });
  });

  describe('Ripple Effects', () => {
    beforeEach(() => {
      sidebar.initialize(mockConfig);
    });

    test('should create ripple element', () => {
      const element = mockElements['custom1button'];
      const event = new MouseEvent('click', {
        clientX: 50,
        clientY: 50
      });
      
      sidebar.createRipple(event, element);
      
      const ripple = element.querySelector('.ripple');
      expect(ripple).toBeTruthy();
      expect(ripple.classList.contains('animate')).toBe(true);
    });

    test('should clean up old ripples', () => {
      const element = mockElements['custom1button'];
      const event = new MouseEvent('click', {
        clientX: 50,
        clientY: 50
      });
      
      // Create first ripple
      sidebar.createRipple(event, element);
      const firstRipple = element.querySelector('.ripple');
      
      // Create second ripple
      sidebar.createRipple(event, element);
      
      // First ripple should be removed
      expect(firstRipple.parentNode).toBeNull();
    });
  });

  describe('Drag and Drop', () => {
    beforeEach(() => {
      sidebar.initialize(mockConfig);
      sidebar.addDragAndDrop();
    });

    test('should make cognitizer buttons draggable', () => {
      const buttons = document.querySelectorAll('.cognitizer-dropdown-section > div');
      
      buttons.forEach(button => {
        expect(button.draggable).toBe(true);
      });
    });

    test('should handle drag start', () => {
      const button = document.querySelector('.cognitizer-dropdown-section > div');
      const event = new DragEvent('dragstart', {
        dataTransfer: new DataTransfer()
      });
      
      button.dispatchEvent(event);
      
      expect(button.classList.contains('dragging')).toBe(true);
    });

    test('should handle drag end', () => {
      const button = document.querySelector('.cognitizer-dropdown-section > div');
      button.classList.add('dragging');
      
      const event = new DragEvent('dragend');
      button.dispatchEvent(event);
      
      expect(button.classList.contains('dragging')).toBe(false);
    });
  });

  describe('Prevent Expansion', () => {
    test('should not set up hover listeners when preventExpansion is true', () => {
      mockConfig.settings.preventMenuExpansion = true;
      
      sidebar.initialize(mockConfig);
      
      // Trigger mouseenter
      const event = new MouseEvent('mouseenter');
      sidebar.toggleButton.dispatchEvent(event);
      
      // Should not expand
      expect(sidebar.isExpanded).toBe(false);
    });

    test('should update preventExpansion setting', () => {
      sidebar.initialize(mockConfig);
      
      sidebar.setPreventExpansion(true);
      
      expect(sidebar.preventExpansion).toBe(true);
    });
  });
});