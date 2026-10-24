/**
 * appLaunch.test.js — boots the real Electron app through Playwright and
 * proves the bootstrap chain completes: main/index.js → App.js → IPC
 * registration → renderer bootstrap → first paint.
 *
 * WHY THIS TEST EXISTS
 * The unit suite mocks electron, child_process and http. It proves the wiring
 * is internally consistent; it cannot catch a main-process throw at startup, a
 * missing preload path, or a renderer that dies before the tab bar renders.
 *
 * RUN IT
 *   RUN_APP_SMOKE=1 npm run test:e2e:app
 *
 * GATING
 * Without RUN_APP_SMOKE=1 every test here is a SKIP — never a pass — so the
 * default runs stay fast and headless-safe.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { backgroundArgs, ensureRendererBundle } = require('./helpers/appHarness');
const { MERMAID_URL, FRAME_CSP } = require('../../shared/artifactFrame');

const RUN_APP_SMOKE = process.env.RUN_APP_SMOKE === '1';
const describeFn = RUN_APP_SMOKE ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, '../..');

describeFn('Electron app launch', () => {
  /** @type {import('playwright')._electron.ElectronApplication | null} */
  let app = null;
  /** @type {import('playwright').Page | null} */
  let page = null;
  /** @type {string[]} */
  const pageErrors = [];
  /** @type {string | null} */
  let userDataDir = null;
  /** @type {string | null} */
  let fakeHome = null;
  /** Main-process stdout + stderr, where a refused IPC message is logged. */
  let mainOutput = '';

  beforeAll(async () => {
    const { _electron: electron } = require('playwright');
    await ensureRendererBundle();
    // A scratch userData dir keeps the smoke run off the real config: the app
    // writes state (window bounds, hasSeenWelcome) on every launch.
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instantcognition-smoke-'));
    // ConfigService also imports a legacy ~/.instant-cognition/config.json, so a
    // scratch HOME is what actually makes this a first run.
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instantcognition-home-'));
    app = await electron.launch({
      args: [...backgroundArgs(), REPO_ROOT, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, HOME: fakeHome, ELECTRON_ENABLE_LOGGING: '1' },
    });
    for (const stream of [app.process().stdout, app.process().stderr]) {
      if (stream) stream.on('data', (chunk) => { mainOutput += String(chunk); });
    }
    page = await app.firstWindow();
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
    await page.waitForLoadState('domcontentloaded');
  }, 120000);

  afterAll(async () => {
    if (app) await app.close();
    app = null;
    page = null;
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    userDataDir = null;
    if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });
    fakeHome = null;
  }, 60000);

  test('the main window opens and the renderer paints its chrome', async () => {
    expect(page).not.toBeNull();
    await page.waitForSelector('#tab-bar', { timeout: 30000 });
    expect(await page.title()).toBeTruthy();
  }, 60000);

  test('the main process registered its IPC handlers', async () => {
    // ipcMain.handle registrations are the contract every renderer call rides
    // on; an empty set means App.js threw before registerAll().
    const hasHandler = await app.evaluate(({ ipcMain }) => {
      // @ts-ignore internal map — the only way to observe registration
      return typeof ipcMain._invokeHandlers === 'object' && ipcMain._invokeHandlers.size > 0;
    });
    expect(hasHandler).toBe(true);
  }, 30000);

  test('a first run greets the user and the welcome panel dismisses', async () => {
    const panel = await page.waitForSelector('.welcome-panel', { timeout: 15000 });
    expect(panel).not.toBeNull();
    await page.click('.welcome-dismiss');
    await page.waitForSelector('.welcome-panel', { state: 'detached', timeout: 10000 });
  }, 30000);

  test('Cmd/Ctrl+K opens the command palette', async () => {
    // Focus starts inside the space <webview>, which swallows key events; click
    // the host chrome first so the renderer's own listener sees the keystroke.
    await page.locator('#tab-bar').click({ position: { x: 2, y: 2 } });
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+K`);
    await page.waitForSelector('#command-palette .command-palette-input', { state: 'visible', timeout: 15000 });
  }, 30000);

  test('the shell runs without Node and behind its CSP', async () => {
    const shell = await page.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      // An inline script the CSP must refuse to run.
      const probe = document.createElement('script');
      probe.textContent = 'window.__icInlineRan = true;';
      document.head.appendChild(probe);
      return {
        require: typeof (/** @type {any} */ (window)).require,
        module: typeof (/** @type {any} */ (window)).module,
        bridge: typeof (/** @type {any} */ (window)).icShell?.invoke,
        csp: meta ? meta.getAttribute('content') : null,
        inlineRan: (/** @type {any} */ (window)).__icInlineRan === true,
      };
    });
    expect(shell.require).toBe('undefined');
    expect(shell.module).toBe('undefined');
    expect(shell.bridge).toBe('function');
    expect(shell.csp).toContain("script-src 'self'");
    expect(shell.inlineRan).toBe(false);
  }, 30000);

  // getLastWebPreferences() does not report `preload`; the shell preload is
  // proven by window.icShell above, and guests' by the will-attach-webview unit tests.
  test('main window and every webview guest get the hardened preferences', async () => {
    const readPrefs = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((wc) => {
      const p = wc.getLastWebPreferences() || {};
      return { type: wc.getType(), url: wc.getURL(), nodeIntegration: !!p.nodeIntegration, contextIsolation: p.contextIsolation !== false, sandbox: !!p.sandbox };
    }));
    let prefs = await readPrefs();
    const deadline = Date.now() + 15000;
    while (!prefs.some((p) => p.type === 'webview') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      prefs = await readPrefs();
    }
    const shell = prefs.find((p) => p.type === 'window' && /index\.html/.test(p.url));
    expect(shell).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true });
    const guests = prefs.filter((p) => p.type === 'webview');
    expect(guests.length).toBeGreaterThan(0);
    for (const g of guests) expect(g).toMatchObject({ nodeIntegration: false, contextIsolation: true });
  }, 30000);

  test('an artifact frame runs its own script and mermaid under the frame CSP', async () => {
    const doc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"></head>`
      + `<body><script src="${MERMAID_URL}"></script><script>document.body.dataset.ran = typeof globalThis.mermaid;</script></body></html>`;
    const url = await page.evaluate((html) => (/** @type {any} */ (window)).icShell.invoke('artifact-frame:stage', html), doc);
    expect(url).toMatch(/^ic-artifact:\/\/frame\/[0-9a-f]{32}$/);
    await page.evaluate((src) => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.id = 'e2e-artifact-probe';
      f.src = src;
      document.body.appendChild(f);
    }, url);
    const deadline = Date.now() + 15000;
    let frame = null;
    while (!frame && Date.now() < deadline) {
      frame = page.frames().find((f) => f.url() === url) || null;
      if (!frame) await new Promise((r) => setTimeout(r, 100));
    }
    expect(frame).not.toBeNull();
    await frame.waitForFunction(() => document.body && document.body.dataset.ran, null, { timeout: 15000 });
    expect(await frame.evaluate(() => document.body.dataset.ran)).toBe('object');
    // FRAME_CSP allows no network: a fetch out of the frame must fail.
    const fetched = await frame.evaluate(() => fetch('https://example.com/').then(() => 'loaded', () => 'blocked'));
    expect(fetched).toBe('blocked');
    await page.evaluate((src) => {
      document.getElementById('e2e-artifact-probe').remove();
      return (/** @type {any} */ (window)).icShell.invoke('artifact-frame:release', src);
    }, url);
  }, 60000);

  test('the Visit URL prompt window still gets its options and posts its answer', async () => {
    const promptPage = app.waitForEvent('window', { timeout: 15000 });
    await page.evaluate(() => (/** @type {any} */ (window)).icShell.send('show-url-prompt'));
    const prompt = await promptPage;
    // Its options arrive over a sendSync; a refused one leaves the input empty.
    await prompt.waitForFunction(() => {
      const input = /** @type {HTMLInputElement | null} */ (document.querySelector('#data'));
      return !!input && input.value === 'https://';
    }, null, { timeout: 10000 });
    await prompt.fill('#data', 'https://example.com/');
    const navigated = page.evaluate(() => new Promise((resolve) => {
      (/** @type {any} */ (window)).icShell.on('navigate-to-url', (payload) => resolve(payload && payload.url));
    }));
    // OK closes the prompt window, which aborts a click still waiting on its
    // input events, so the click runs after this evaluate has returned.
    await prompt.evaluate(() => {
      setTimeout(() => /** @type {HTMLButtonElement} */ (document.getElementById('ok')).click(), 0);
    });
    expect(await navigated).toBe('https://example.com/');
  }, 30000);

  test('the app and its tabs sent no IPC message the sender check refused', () => {
    expect(mainOutput.split('\n').filter((line) => line.includes('[ipc] refused'))).toEqual([]);
  });

  // A window main did not mark as the app stands in for a tab or pop-up whose
  // preload world is compromised: it reaches the real ipcMain, policy included.
  test('a window that is not the app is refused app channels and keeps the guest ones', async () => {
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instantcognition-ipc-probe-'));
    const preload = path.join(probeDir, 'probe-preload.js');
    fs.writeFileSync(preload, [
      "const { ipcRenderer } = require('electron');",
      "const report = (k, v) => console.log('ipc-probe ' + k + ' ' + v);",
      "ipcRenderer.invoke('config:get').then(() => report('config:get', 'allowed'), (e) => report('config:get', /forbidden/.test(String(e)) ? 'forbidden' : String(e)));",
      "report('config:get-sync', JSON.stringify(ipcRenderer.sendSync('config:get-sync')));",
      "ipcRenderer.invoke('permission:check', 'https://example.com', 'notifications').then((v) => report('permission:check', 'answered:' + typeof v), (e) => report('permission:check', String(e)));",
    ].join('\n'));
    try {
      const results = await app.evaluate(({ BrowserWindow }, preloadPath) => new Promise((resolve, reject) => {
        const win = new BrowserWindow({ show: false, webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true } });
        const seen = {};
        const timer = setTimeout(() => { win.destroy(); reject(new Error(`probe timed out: ${JSON.stringify(seen)}`)); }, 15000);
        win.webContents.on('console-message', (...args) => {
          const message = String(args[0] && args[0].message !== undefined ? args[0].message : args[2]);
          const m = /^ipc-probe (\S+) (.*)$/.exec(message);
          if (!m) return;
          seen[m[1]] = m[2];
          if (Object.keys(seen).length === 3) { clearTimeout(timer); win.destroy(); resolve(seen); }
        });
        win.loadURL('data:text/html,<p>probe</p>');
      }), preload);
      expect(results).toEqual({ 'config:get': 'forbidden', 'config:get-sync': 'null', 'permission:check': expect.stringMatching(/^answered:/) });
      expect(mainOutput).toContain("[ipc] refused 'config:get' from window");
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  }, 30000);

  test('startup produced no uncaught renderer error', () => {
    expect(pageErrors).toEqual([]);
  });
});
