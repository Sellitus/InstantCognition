// Comprehensive unit tests for renderer process

// Mock electron before requiring it
jest.mock('electron', () => ({
  ipcRenderer: {
    send: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn()
  },
  shell: {
    openExternal: jest.fn()
  }
}));

const { ipcRenderer, shell } = require('electron');
const { createMockConfig, createMockEvent } = require('../../helpers/testUtils');

// Mock fs module
jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  existsSync: jest.fn()
}));

// Mock os module  
jest.mock('os', () => ({
  platform: jest.fn(() => 'darwin'),
  homedir: jest.fn(() => '/home/user')
}));

describe('Renderer Process', () => {
  beforeEach(() => {
    // Set up DOM environment
    document.body.innerHTML = `
      <div class="dropdown-section">
        <div id="custom1button">ChatGPT</div>
        <div id="custom2button">Claude</div>
      </div>
      <div class="cognitizer-dropdown-section">
        <div id="custom1button">ChatGPT</div>
        <div id="custom2button">Claude</div>
      </div>
      <div id="cognitizer-container">
        <webview id="custom1" class="inactive"></webview>
        <webview id="custom2" class="inactive"></webview>
      </div>
      <div id="browser-container">
        <webview id="browser-webview" class="inactive"></webview>
      </div>
      <div id="findbar" style="display: none;">
        <input id="findinput" type="text">
        <button id="find-previous">Previous</button>
        <button id="find-next">Next</button>
        <span id="find-close">×</span>
      </div>
      <div id="sidebar-hamburger">☰</div>
      <div id="menu-hamburger">☰</div>
      <div id="sidebar" class="collapsed"></div>
      <div id="menu" class="collapsed"></div>
    `;

    // Mock file system
    const fs = require('fs');
    fs.readFileSync.mockReturnValue(JSON.stringify(createMockConfig()));
    fs.writeFileSync.mockReturnValue(undefined);
    fs.existsSync.mockReturnValue(true);

    // Clear all mocks
    jest.clearAllMocks();
    
    // Clear module cache
    jest.resetModules();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Configuration Loading', () => {
    it('should load settings from config file', () => {
      const fs = require('fs');
      const mockConfig = createMockConfig({
        baseUrls: {
          custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
          custom2: { name: 'Claude', url: 'https://claude.ai/' },
        },
      });
      fs.readFileSync.mockReturnValue(JSON.stringify(mockConfig));

      // Test that config is loaded properly
      expect(fs.readFileSync).toHaveBeenCalled();
    });
  });

  describe('IPC Communication', () => {
    it('should send IPC messages correctly', () => {
      // Simulate button click
      const button = document.getElementById('custom1button');
      button.click();
      
      // Check if IPC message was sent
      expect(ipcRenderer.send).toHaveBeenCalled();
    });
  });

  describe('External Links', () => {
    it('should handle external links properly', () => {
      const link = document.createElement('a');
      link.href = 'https://external.com';
      link.target = '_blank';
      document.body.appendChild(link);
      
      link.click();
      
      // Check if shell.openExternal was called
      expect(shell.openExternal).toHaveBeenCalled();
    });
  });

  describe('Find Bar', () => {
    it('should show find bar on keyboard shortcut', () => {
      const findbar = document.getElementById('findbar');
      const event = createMockEvent('keydown', {
        key: 'f',
        ctrlKey: true
      });
      
      document.dispatchEvent(event);
      
      // Check if findbar is visible
      expect(findbar.style.display).not.toBe('none');
    });
  });

  describe('Sidebar Toggle', () => {
    it('should toggle sidebar on hamburger click', () => {
      const hamburger = document.getElementById('sidebar-hamburger');
      const sidebar = document.getElementById('sidebar');
      
      hamburger.click();
      
      // Check if sidebar state changed
      expect(sidebar.classList.contains('collapsed')).toBe(false);
    });
  });
});