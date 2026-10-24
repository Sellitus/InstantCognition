/** @jest-environment jsdom */

// WelcomeOverlay — the one-time first-run panel. Covers the show-once gate,
// the persisted flag, the Settings → LLM hand-off, and Escape dismissal.

jest.mock('electron', () => ({
  ipcRenderer: { on: jest.fn(), send: jest.fn(), invoke: jest.fn(), sendSync: jest.fn(() => ({})) },
}));

jest.mock('../../../../renderer/core/configBridge', () => ({
  set: jest.fn(),
  snapshot: jest.fn(() => ({})),
  onChange: jest.fn(),
}));

const configBridge = require('../../../../renderer/core/configBridge');
const welcomeOverlay = require('../../../../renderer/components/WelcomeOverlay');

describe('WelcomeOverlay', () => {
  beforeEach(() => {
    document.body.textContent = '';
    configBridge.set.mockClear();
    welcomeOverlay.initialize({});
  });

  afterEach(() => {
    welcomeOverlay.dismiss();
    document.body.textContent = '';
  });

  test('maybeShow renders on a fresh config and stays away once seen', () => {
    expect(welcomeOverlay.maybeShow({ state: {} })).toBe(true);
    expect(document.querySelector('.welcome-panel')).not.toBeNull();
    welcomeOverlay.dismiss();

    expect(welcomeOverlay.maybeShow({ state: { hasSeenWelcome: true } })).toBe(false);
    expect(document.querySelector('.welcome-panel')).toBeNull();
  });

  test('dismissing persists state.hasSeenWelcome so the panel never returns', () => {
    welcomeOverlay.maybeShow({ state: {} });
    /** @type {HTMLButtonElement} */ (document.querySelector('.welcome-dismiss')).click();
    expect(configBridge.set).toHaveBeenCalledWith('state.hasSeenWelcome', true);
    expect(document.querySelector('.welcome-panel')).toBeNull();
  });

  test('"Set up a model" closes the panel and opens Settings → LLM', () => {
    const onOpenLlmSettings = jest.fn();
    welcomeOverlay.initialize({ onOpenLlmSettings });
    welcomeOverlay.maybeShow({ state: {} });
    /** @type {HTMLButtonElement} */ (document.querySelector('.welcome-llm')).click();
    expect(onOpenLlmSettings).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.welcome-panel')).toBeNull();
    expect(configBridge.set).toHaveBeenCalledWith('state.hasSeenWelcome', true);
  });

  test('Escape dismisses and still records the flag', () => {
    welcomeOverlay.maybeShow({ state: {} });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('.welcome-panel')).toBeNull();
    expect(configBridge.set).toHaveBeenCalledWith('state.hasSeenWelcome', true);
  });

  test('each highlighted row shows the live shortcut binding', () => {
    const shortcutManager = require('../../../../renderer/utils/shortcuts');
    shortcutManager.loadShortcuts({ settings: {} });
    welcomeOverlay.maybeShow({ state: {} });
    const keys = Array.from(document.querySelectorAll('.welcome-row-key')).map((el) => el.textContent);
    expect(keys).toHaveLength(5);
    // The flip row renders its live binding (Mod+E by default).
    expect(keys[4]).toMatch(/E$/);
    for (const key of keys) {
      expect(key).toBeTruthy();
      expect(key).not.toContain('CmdOrCtrl');
    }
  });
});
