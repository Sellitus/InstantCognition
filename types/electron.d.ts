/// <reference types="electron" />

import { BrowserWindow, WebContents, IpcMainEvent, IpcRendererEvent } from 'electron';

// Extend Electron types with custom properties
declare global {
  interface Window {
    electron: {
      send: (channel: string, ...args: any[]) => void;
      receive: (channel: string, callback: (...args: any[]) => void) => void;
      invoke: (channel: string, ...args: any[]) => Promise<any>;
    };
  }
}

// Custom IPC channels
export type IPCChannels =
  | 'navigate-back'
  | 'navigate-forward'
  | 'reload'
  | 'stop-loading'
  | 'open-external-links'
  | 'toggle-external-links'
  | 'get-open-external-links'
  | 'toggle-find-bar'
  | 'find-in-page'
  | 'find-next'
  | 'find-previous'
  | 'clear-find'
  | 'go-to-website'
  | 'settings-changed'
  | 'toggle-multi-cognition'
  | 'select-cognitizer'
  | 'config-updated'
  | 'reload-config'
  | 'get-config'
  | 'save-config'
  | 'window-bounds-changed'
  | 'focus-changed'
  | 'memory-pressure'
  | 'certificate-error'
  | 'webview-ready'
  | 'webview-crashed'
  | 'webview-unresponsive';

// Configuration types
export interface CognitizerConfig {
  name: string;
  url: string;
  icon?: string;
  active?: boolean;
  customCSS?: string;
  userAgent?: string;
}

export interface AppConfig {
  cognitizers: CognitizerConfig[];
  multiCognitionActive: boolean;
  activeCognitizer: number;
  openExternalLinks: boolean;
  adBlockerEnabled: boolean;
  hotkeyLocked: boolean;
  windowBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  baseUrls?: Record<string, string>;
  acceptedCertificates?: string[];
}

// Memory management types
export interface MemoryInfo {
  pid: number;
  type: 'main' | 'renderer' | 'webview';
  workingSetSize: number;
  privateBytes?: number;
  sharedBytes?: number;
}

// Certificate error types
export interface CertificateError {
  url: string;
  error: string;
  certificate: {
    issuerName: string;
    subjectName: string;
    serialNumber: string;
    validStart: number;
    validExpiry: number;
    fingerprint: string;
  };
}

// Custom BrowserWindow options
export interface CustomBrowserWindowOptions extends Electron.BrowserWindowConstructorOptions {
  customData?: {
    cognitizerId?: number;
    isMultiCognition?: boolean;
  };
}

// Webview tag attributes
export interface WebviewTag extends HTMLElement {
  src: string;
  preload: string;
  webpreferences: string;
  partition: string;
  useragent?: string;
  loadURL(url: string): void;
  reload(): void;
  stop(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getWebContentsId(): number;
  findInPage(text: string, options?: Electron.FindInPageOptions): number;
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
  insertCSS(css: string): Promise<string>;
  executeJavaScript(code: string): Promise<any>;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  isWaitingForResponse(): boolean;
  getWebContents(): WebContents;
  setZoomFactor(factor: number): void;
  setZoomLevel(level: number): void;
  addEventListener(event: string, listener: Function): void;
  removeEventListener(event: string, listener: Function): void;
}

// Event payload types
export interface NavigationEvent {
  url: string;
  isMainFrame: boolean;
  isInPlace: boolean;
  httpResponseCode?: number;
  httpStatusText?: string;
}

export interface FindResult {
  requestId: number;
  matches: number;
  activeMatchOrdinal: number;
  finalUpdate: boolean;
}

export interface MemoryPressureEvent {
  level: 'moderate' | 'critical';
  timestamp: number;
}

export interface CognitizerSwitchEvent {
  from: number;
  to: number;
  multiCognitionActive: boolean;
}

// Gesture types
export interface GestureEvent {
  type: 'swipe' | 'pinch' | 'rotate';
  direction?: 'left' | 'right' | 'up' | 'down';
  velocity?: number;
  scale?: number;
  rotation?: number;
}

// Logger types
export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: string;
  metadata?: Record<string, any>;
}
