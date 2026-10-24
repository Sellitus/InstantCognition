/**
 * appHarness.js — launches the real Electron app under Playwright against a
 * scratch profile, and exposes the small set of primitives every E2E spec
 * needs: keyboard chords that reach the host chrome, renderer state reads, and
 * the on-disk config the main process actually wrote.
 *
 * A scratch userData dir AND a scratch HOME are both required to make a run a
 * true first run: ConfigService also imports a legacy ~/.instant-cognition
 * config, so leaving HOME alone leaks the developer's real settings into the
 * assertions.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../../..');

const CHROME_ANCHOR = '#tab-bar';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

// Test windows stay out of the way of whoever is using the machine; see
// backgroundWindows.js. Playwright drops NODE_OPTIONS, so the hook rides in as
// an Electron -r preload ahead of the app path.
function backgroundArgs() {
  return process.env.IC_E2E_VISIBLE === '1' ? [] : ['-r', path.join(__dirname, 'backgroundWindows.js')];
}

// The windows load renderer.bundle.js, so a launch must never run a bundle
// older than the source under test. Built once per test process.
let bundleBuilt = null;
function ensureRendererBundle() {
  if (!bundleBuilt) bundleBuilt = require('../../../scripts/build-renderer').buildRenderer();
  return bundleBuilt;
}

class AppHarness {
  constructor() {
    /** @type {import('playwright')._electron.ElectronApplication | null} */
    this.app = null;
    /** @type {import('playwright').Page | null} */
    this.page = null;
    /** @type {string[]} */
    this.pageErrors = [];
    /** Main-process stdout + stderr across every launch. */
    this.mainOutput = '';
    this.userDataDir = null;
    this.fakeHome = null;
  }

  async launch() {
    const { _electron: electron } = require('playwright');
    await ensureRendererBundle();
    this.userDataDir = this.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'instantcognition-e2e-'));
    this.fakeHome = this.fakeHome || fs.mkdtempSync(path.join(os.tmpdir(), 'instantcognition-e2e-home-'));
    this.app = await electron.launch({
      args: [...backgroundArgs(), REPO_ROOT, `--user-data-dir=${this.userDataDir}`],
      env: { ...process.env, HOME: this.fakeHome, ELECTRON_ENABLE_LOGGING: '1' },
    });
    for (const stream of [this.app.process().stdout, this.app.process().stderr]) {
      if (stream) stream.on('data', (chunk) => { this.mainOutput += String(chunk); });
    }
    this.page = await this.app.firstWindow();
    this.page.on('pageerror', (err) => this.pageErrors.push(String((err && err.message) || err)));
    await this.page.waitForLoadState('domcontentloaded');
    await this.page.waitForSelector(CHROME_ANCHOR, { timeout: 30000 });
    return this;
  }

  // Quit the app but keep its profile, as a user quitting and reopening would;
  // the next launch() starts on the same userData and HOME.
  async quit() {
    if (this.app) await this.app.close();
    this.app = null;
    this.page = null;
  }

  async relaunch() {
    await this.quit();
    return this.launch();
  }

  async close() {
    await this.quit();
    if (this.userDataDir) fs.rmSync(this.userDataDir, { recursive: true, force: true });
    if (this.fakeHome) fs.rmSync(this.fakeHome, { recursive: true, force: true });
    this.userDataDir = null;
    this.fakeHome = null;
  }

  // A first launch greets the user; every other surface is behind it.
  async dismissWelcome() {
    await this.page.waitForSelector('.welcome-panel', { timeout: 15000 });
    await this.page.click('.welcome-dismiss');
    await this.page.waitForSelector('.welcome-panel', { state: 'detached', timeout: 10000 });
  }

  // A space whose page fails to load raises a modal "Site couldn't load" alert
  // over whatever is on screen, at whatever moment the network decides. It is
  // about the sandbox's connectivity, not about the feature under test, so the
  // sweep closes it on sight instead of racing it.
  async autoDismissSiteBlocked() {
    await this.page.evaluate(() => {
      const close = () => {
        for (const btn of Array.from(document.querySelectorAll('.site-blocked-overlay .site-blocked-close'))) {
          /** @type {HTMLElement} */ (btn).click();
        }
      };
      new MutationObserver(close).observe(document.body, { childList: true, subtree: true });
      close();
    });
  }

  // The host document owns the shortcut listener (renderer.js), but a focused
  // <webview> swallows keys into the guest page. Blurring hands focus back to
  // the host body without clicking anything, so a chord still lands when an
  // overlay or the expanded sidebar rail covers the chrome.
  async press(chord) {
    await this.page.evaluate(() => {
      const el = /** @type {any} */ (document.activeElement);
      if (el && el !== document.body && typeof el.blur === 'function') el.blur();
    });
    await this.page.keyboard.press(chord.replace(/\bMod\b/g, MOD));
  }

  // Read one key out of the renderer's observable state container. This is the
  // same object every manager subscribes to, so a value here is what the UI is
  // actually driving off.
  async state(key) {
    return this.page.evaluate((k) => {
      if (!window.appState) throw new Error('window.appState missing — renderer bootstrap did not complete');
      const v = window.appState.get(k);
      return typeof v === 'undefined' ? null : JSON.parse(JSON.stringify(v));
    }, key);
  }

  // Poll until the renderer state key matches, so a spec never races an async
  // manager. Throws with the last value seen, which is what makes a failure
  // diagnosable instead of a bare timeout.
  async waitForState(key, predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      last = await this.state(key);
      if (predicate(last)) return last;
      if (Date.now() > deadline) throw new Error(`state.${key} never satisfied predicate; last=${JSON.stringify(last)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Call an IPC channel from the renderer's own context — the same bridge the
  // UI uses, so a handler that is missing or throws fails here exactly as it
  // would for a user.
  /** IPC messages main's sender check refused; the app itself should never cause one. */
  refusedIpc() {
    return this.mainOutput.split('\n').filter((line) => line.includes('[ipc] refused'));
  }

  async invoke(channel, ...args) {
    return this.page.evaluate(
      ([ch, a]) => window.icShell.invoke(ch, ...a),
      [channel, args],
    );
  }

  async send(channel, ...args) {
    return this.page.evaluate(
      ([ch, a]) => window.icShell.send(ch, ...a),
      [channel, args],
    );
  }

  // Every ipcMain.handle channel the main process registered. The census a
  // renderer call rides on: an empty or shrunken set means a register() threw.
  async invokeChannels() {
    return this.app.evaluate(({ ipcMain }) => {
      // @ts-ignore internal map — the only way to observe registration
      return Array.from(ipcMain._invokeHandlers.keys()).sort();
    });
  }

  // The config the MAIN process wrote to disk, not the renderer's copy. Waits
  // out ConfigService's 100ms save debounce.
  async readPersistedConfig(timeoutMs = 3000) {
    const file = path.join(this.userDataDir, 'config.json');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (fs.existsSync(file)) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* mid-write */ }
      }
      if (Date.now() > deadline) throw new Error(`config.json never appeared under ${this.userDataDir}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Errors seen since a marker, so one area's spec cannot be blamed for an
  // earlier area's throw.
  errorsSince(marker) {
    return this.pageErrors.slice(marker);
  }

  get errorMarker() {
    return this.pageErrors.length;
  }
}

module.exports = { AppHarness, MOD, REPO_ROOT, CHROME_ANCHOR, backgroundArgs, ensureRendererBundle };
