/// <reference types="electron" />

// Extend Electron types with custom properties the renderer attaches to `window`.
// Global augmentation (declare global) is picked up automatically via tsconfig
// typeRoots — no import needed at consumer sites.
declare global {
  interface Window {
    electron: {
      send: (channel: string, ...args: any[]) => void;
      receive: (channel: string, callback: (...args: any[]) => void) => void;
      invoke: (channel: string, ...args: any[]) => Promise<any>;
    };
    // Renderer attaches globals for keyboard shortcuts + cross-module reach.
    config: any;
    appState: any;
    agentWorkspaceManager: any;
    shortcutManager: any;
    saveSettings: (config?: any) => void;
    _wireWebviewEvents: (webview: Electron.WebviewTag) => void;
    [key: string]: any;
  }
}

export {};
