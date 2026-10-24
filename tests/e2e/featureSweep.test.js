/**
 * featureSweep.test.js — drives the REAL app across every user-facing surface
 * in one launch: shell, palette, tabs, spaces, layouts, find, zoom, settings,
 * library, notifications, projects, user memory, personas, the agent panel,
 * and the main-process IPC census.
 *
 * WHY THIS TEST EXISTS
 * The unit suite mocks electron; the integration suite mocks ipcMain. Both
 * prove the wiring is internally consistent. Neither can catch a surface that
 * never opens, a shortcut that stopped reaching the renderer, a setting that
 * never lands on disk, or a lane that reports success with nothing to show.
 *
 * RUN IT
 *   RUN_E2E_SWEEP=1 npm run test:e2e:sweep
 *
 * GATING
 * Without RUN_E2E_SWEEP=1 every test here is a SKIP — never a pass.
 *
 * ORDER MATTERS. One app instance is shared by the whole file and the tests run
 * in declaration order; each area restores the state it changed so the next one
 * starts from the documented baseline (single layout, one tab, no panel open).
 */

const { AppHarness } = require('./helpers/appHarness');

const RUN = process.env.RUN_E2E_SWEEP === '1';
const describeFn = RUN ? describe : describe.skip;

const T = 60000; // per-test ceiling: a surface that hangs must fail, not stall the run

describeFn('Feature sweep (real app)', () => {
  /** @type {AppHarness} */
  let h;
  /** @type {import('playwright').Page} */
  let page;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (sel) => page.locator(sel).first().isVisible();
  // Every surface is a dropdown over the chrome; Escape is the shared close
  // chord, and the state assertions below depend on starting from nothing open.
  // 600ms clears Dropdown's 320ms animation fallback.
  const closeOverlays = async () => {
    await page.keyboard.press('Escape');
    await sleep(600);
  };
  // A closed Dropdown is removed from the DOM unless it was built persistent
  // (Settings), in which case it stays mounted with display:none. Visibility is
  // the assertion that holds for both shapes.
  const isShowing = async (sel) => page.locator(sel).first().isVisible();

  beforeAll(async () => {
    h = await new AppHarness().launch();
    page = h.page;
    await h.autoDismissSiteBlocked();
    await h.dismissWelcome();
  }, 120000);

  afterAll(async () => {
    if (h) await h.close();
  }, 60000);

  // ---- Shell ------------------------------------------------------------

  describe('app shell', () => {
    test('the chrome, tab bar and icon sprite all painted', async () => {
      expect(await visible('#chrome-sidebar')).toBe(true);
      expect(await visible('#tab-bar')).toBe(true);
      // The sprite is what every Icon instance references; a missing sprite
      // renders the whole UI icon-less without throwing.
      expect(await page.locator('#ic-icon-sprite').count()).toBe(1);
    }, T);

    test('a fresh profile opens exactly one space and focuses it', async () => {
      const openTabs = await h.state('openTabs');
      expect(Array.isArray(openTabs)).toBe(true);
      expect(openTabs.length).toBe(1);
      expect(await h.state('currentSpaceId')).toBe(openTabs[0]);
      // The focused space owns a live <webview>, not just a state entry.
      expect(await page.locator(`webview#${openTabs[0]}`).count()).toBe(1);
    }, T);

    test('hovering the rail expands it and leaving collapses it back', async () => {
      const rail = page.locator('#chrome-sidebar');
      const railWidthVar = () => page.evaluate(() => getComputedStyle(document.documentElement)
        .getPropertyValue('--chrome-sidebar-current-width').trim());
      const collapsedWidth = parseInt(await railWidthVar(), 10);
      expect(await rail.evaluate((el) => el.classList.contains('chrome-sidebar--expanded'))).toBe(false);

      const box = await rail.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForFunction(
        () => !!document.querySelector('#chrome-sidebar.chrome-sidebar--expanded'),
        undefined,
        { timeout: 5000 },
      );
      // The expanded rail must also widen the chrome the layout reserves for
      // it, or the panes underneath render behind an opaque overlay.
      expect(parseInt(await railWidthVar(), 10)).toBeGreaterThan(collapsedWidth);

      // Moving the pointer off the rail lands it on the space <webview>, whose
      // guest process takes the synthetic move without the host ever seeing the
      // transition — so drive the leave event the browser would send.
      await rail.dispatchEvent('mouseleave');
      await page.waitForFunction(
        () => !document.querySelector('#chrome-sidebar.chrome-sidebar--expanded'),
        undefined,
        { timeout: 5000 },
      );
      expect(parseInt(await railWidthVar(), 10)).toBe(collapsedWidth);
    }, T);
  });

  // ---- Command palette --------------------------------------------------

  describe('command palette', () => {
    test('Mod+K opens it with a populated command list', async () => {
      await h.press('Mod+K');
      await page.waitForSelector('#command-palette .command-palette-input', { state: 'visible', timeout: 15000 });
      const count = await page.locator('#command-palette .command-palette-list > .command-palette-item').count();
      expect(count).toBeGreaterThan(5);
    }, T);

    test('typing narrows the list to matching commands only', async () => {
      const all = await page.locator('#command-palette .command-palette-list > .command-palette-item').count();
      await page.fill('#command-palette .command-palette-input', 'settings');
      await sleep(300);
      const items = await page.locator('#command-palette .command-palette-list > .command-palette-item').allTextContents();
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThan(all);
      // The command the user typed the name of must rank first; the rest of the
      // shortlist may match on keywords rather than on the visible label.
      expect(items[0]).toMatch(/settings/i);
    }, T);

    test('Escape closes it and leaves no overlay behind', async () => {
      await closeOverlays();
      expect(await isShowing('#command-palette')).toBe(false);
      expect(await isShowing('#command-palette-backdrop')).toBe(false);
    }, T);
  });

  // ---- Tabs -------------------------------------------------------------

  describe('tabs', () => {
    test('Mod+T opens the new-tab picker with its space groups', async () => {
      await h.press('Mod+T');
      await page.waitForSelector('#new-tab-picker .new-tab-picker-search', { state: 'visible', timeout: 15000 });
      expect(await page.locator('#new-tab-picker .new-tab-picker-group').count()).toBeGreaterThan(0);
    }, T);

    test('typing a URL offers the open-as-URL option and opening it adds a tab', async () => {
      const before = (await h.state('openTabs')).length;
      await page.fill('#new-tab-picker .new-tab-picker-search', 'example.com');
      await page.waitForSelector('#new-tab-picker .new-tab-picker-url-option', { state: 'visible', timeout: 10000 });
      await page.click('#new-tab-picker .new-tab-picker-url-option');
      const after = await h.waitForState('openTabs', (v) => v.length === before + 1, 15000);
      expect(after.length).toBe(before + 1);
      // The new tab is the focused one and has a rendered tab-bar entry.
      const current = await h.state('currentSpaceId');
      expect(after).toContain(current);
      expect(await page.locator(`#tab-bar [data-space-id="${current}"]`).count()).toBeGreaterThan(0);
      // Opening navigates and dismisses the picker; leaving it mounted would
      // keep every following surface behind its focus trap.
      await sleep(500);
      expect(await isShowing('#new-tab-picker')).toBe(false);
    }, T);

    test('Mod+W closes the active tab and refocuses a surviving one', async () => {
      const before = await h.state('openTabs');
      expect(before.length).toBeGreaterThan(1);
      await h.press('Mod+W');
      const after = await h.waitForState('openTabs', (v) => v.length === before.length - 1, 15000);
      expect(after.length).toBe(before.length - 1);
      expect(after).toContain(await h.state('currentSpaceId'));
    }, T);

    test('Mod+W on the last remaining tab is refused (negative)', async () => {
      const before = await h.state('openTabs');
      expect(before.length).toBe(1);
      await h.press('Mod+W');
      await sleep(800);
      expect(await h.state('openTabs')).toEqual(before);
    }, T);
  });

  // ---- Layout and view modes -------------------------------------------

  describe('layouts and view modes', () => {
    test('Mod+M turns on multi-space and moves off the single layout', async () => {
      expect(await h.state('multiSpace')).toBe(false);
      await h.press('Mod+M');
      expect(await h.waitForState('multiSpace', (v) => v === true)).toBe(true);
      expect(await h.state('currentLayout')).not.toBe('single');
    }, T);

    test('cycleLayout walks the layout strategies and comes back', async () => {
      const seen = new Set();
      for (let i = 0; i < 6; i += 1) {
        seen.add(await h.state('currentLayout'));
        await page.evaluate(() => window.cycleLayout());
        await sleep(200);
      }
      // More than one strategy must actually be reachable from the cycle.
      expect(seen.size).toBeGreaterThan(1);
    }, T);

    test('Mod+M turns multi-space back off and restores the single layout', async () => {
      await h.press('Mod+M');
      expect(await h.waitForState('multiSpace', (v) => v === false)).toBe(false);
      expect(await h.waitForState('currentLayout', (v) => v === 'single')).toBe('single');
    }, T);

    test('Mod+B toggles the dedicated browser view on and off', async () => {
      expect(await h.state('browserViewActive')).toBe(false);
      await h.press('Mod+B');
      expect(await h.waitForState('browserViewActive', (v) => v === true)).toBe(true);
      expect(await visible('#browser-container')).toBe(true);
      await h.press('Mod+B');
      expect(await h.waitForState('browserViewActive', (v) => v === false)).toBe(false);
    }, T);

    test('Alt+Shift+A swaps into the agent workspace and back', async () => {
      expect(await h.state('viewMode')).toBe('user');
      await h.press('Alt+Shift+A');
      expect(await h.waitForState('viewMode', (v) => v === 'agent')).toBe('agent');
      await h.press('Alt+Shift+A');
      expect(await h.waitForState('viewMode', (v) => v === 'user')).toBe('user');
    }, T);
  });

  // ---- Find bar ---------------------------------------------------------

  describe('toolbar actions', () => {
    const MENU = '.tab-bar-more-menu';
    const openMore = async () => {
      await page.click('#tabbar-more');
      await page.waitForSelector(MENU, { state: 'visible', timeout: 10000 });
    };
    // A failed assertion must not leave the menu over the chrome for the next test.
    afterEach(async () => {
      if (await isShowing(MENU)) await closeOverlays();
    });

    test('More opens a menu with View and Page sections split by a separator', async () => {
      await openMore();
      // textContent, not innerText: the labels are uppercased by CSS.
      const labels = await page.locator(`${MENU} .ic-menu-label`).allTextContents();
      expect(labels.map((l) => l.trim())).toEqual(['View', 'Page']);
      expect(await page.locator(`${MENU} .ic-menu-sep`).count()).toBe(1);
      const ids = await page.locator(`${MENU} .ic-menu-item`).evaluateAll((els) => els.map((e) => e.dataset.itemId));
      expect(ids).toEqual([
        'tabbar-assistant-view', 'tabbar-multi-space', 'tabbar-layout', 'tabbar-space-view', 'tabbar-browser-view',
        'tabbar-bookmark', 'tabbar-find', 'tabbar-external-links',
      ]);
      await closeOverlays();
      expect(await isShowing(MENU)).toBe(false);
    }, T);

    test('Find from the menu opens the find bar, checks the item and lights the More dot', async () => {
      expect(await isShowing('.tab-bar-more-dot')).toBe(false);
      await openMore();
      await page.click(`${MENU} [data-item-id="tabbar-find"]`);
      expect(await h.waitForState('findBarVisible', (v) => v === true)).toBe(true);
      await page.waitForSelector('.tab-bar-more-dot', { state: 'visible', timeout: 10000 });
      expect(await page.getAttribute('#tabbar-more', 'aria-label')).toContain('Find in Page');
      await openMore();
      expect(await page.getAttribute(`${MENU} [data-item-id="tabbar-find"]`, 'aria-checked')).toBe('true');
      await closeOverlays();
      await page.keyboard.press('Escape');
      expect(await h.waitForState('findBarVisible', (v) => v === false)).toBe(false);
      await page.waitForSelector('.tab-bar-more-dot', { state: 'hidden', timeout: 10000 });
    }, T);

    test('the Assistant pill is pressed only while its panel is open', async () => {
      expect(await page.getAttribute('#tabbar-assistant', 'aria-pressed')).toBe('false');
      await page.click('#tabbar-assistant');
      await page.waitForSelector('#agent-panel .agent-panel-input', { state: 'visible', timeout: 15000 });
      expect(await page.getAttribute('#tabbar-assistant', 'aria-pressed')).toBe('true');
      await closeOverlays();
      expect(await page.getAttribute('#tabbar-assistant', 'aria-pressed')).toBe('false');
    }, T);
  });

  describe('find in page', () => {
    test('Mod+F opens the find bar and Escape closes it', async () => {
      await h.press('Mod+F');
      expect(await h.waitForState('findBarVisible', (v) => v === true)).toBe(true);
      await page.waitForSelector('#find-bar', { state: 'visible', timeout: 10000 });
      await page.keyboard.press('Escape');
      expect(await h.waitForState('findBarVisible', (v) => v === false)).toBe(false);
    }, T);
  });

  // ---- Zoom -------------------------------------------------------------

  describe('zoom', () => {
    const zoomLevel = () => page.evaluate(() => {
      const id = window.appState.get('currentSpaceId');
      const wv = /** @type {any} */ (document.getElementById(id));
      return wv && wv.getZoomLevel ? wv.getZoomLevel() : null;
    });

    test('zoom in, zoom out and reset all move the active webview', async () => {
      const base = await zoomLevel();
      expect(base).not.toBeNull();
      await h.press('Mod+=');
      await sleep(300);
      const zoomedIn = await zoomLevel();
      expect(zoomedIn).toBeGreaterThan(base);
      await h.press('Mod+-');
      await sleep(300);
      expect(await zoomLevel()).toBeLessThan(zoomedIn);
      await h.press('Mod+0');
      await sleep(300);
      expect(await zoomLevel()).toBe(0);
    }, T);
  });

  // ---- Settings ---------------------------------------------------------

  describe('settings', () => {
    test('Mod+, opens Settings with every registered section rendered', async () => {
      await h.press('Mod+,');
      await page.waitForSelector('#settings-v2 .settings-v2-nav-item', { state: 'visible', timeout: 15000 });
      const navCount = await page.locator('#settings-v2 .settings-v2-nav-item').count();
      const sectionCount = await page.locator('#settings-v2 .settings-v2-section').count();
      expect(navCount).toBeGreaterThan(5);
      // Every nav entry must have a section behind it — a nav item pointing at
      // nothing is a dead link the user can click into an empty pane.
      expect(sectionCount).toBe(navCount);
    }, T);

    test('every section carries at least one setting row', async () => {
      const empties = await page.evaluate(() => {
        const out = [];
        for (const s of Array.from(document.querySelectorAll('#settings-v2 .settings-v2-section'))) {
          if (!s.querySelector('.settings-v2-row')) out.push(s.getAttribute('data-section-id') || s.id || '(unnamed)');
        }
        return out;
      });
      expect(empties).toEqual([]);
    }, T);

    test('clicking each nav item activates its section without a renderer throw', async () => {
      const marker = h.errorMarker;
      const items = page.locator('#settings-v2 .settings-v2-nav-item');
      const n = await items.count();
      for (let i = 0; i < n; i += 1) {
        await items.nth(i).click();
        await sleep(120);
      }
      expect(h.errorsSince(marker)).toEqual([]);
    }, T);

    test('search filters the settings list and clears back', async () => {
      const search = page.locator('#settings-v2 .settings-v2-search input').first();
      await search.fill('zoom');
      await sleep(400);
      const visibleRows = await page.evaluate(() => Array.from(
        document.querySelectorAll('#settings-v2 .settings-v2-row'),
      ).filter((r) => /** @type {HTMLElement} */ (r).offsetParent !== null).length);
      expect(visibleRows).toBeGreaterThan(0);
      const titles = await page.evaluate(() => Array.from(
        document.querySelectorAll('#settings-v2 .settings-v2-row'),
      ).filter((r) => /** @type {HTMLElement} */ (r).offsetParent !== null)
        .map((r) => (r.textContent || '').toLowerCase()));
      expect(titles.some((t) => t.includes('zoom'))).toBe(true);
      await search.fill('');
      await sleep(300);
    }, T);

    test('flipping a toggle reaches the main process and lands in config.json', async () => {
      const sel = '[id="set-general.openLinkExternal"]';
      // The checkbox itself sits under the switch skin, so a user clicks the
      // label — the same path the row's own hit area gives them.
      const skin = page.locator('label.sv-toggle:has(> [id="set-general.openLinkExternal"]) .sv-toggle-slider');
      await page.locator('#settings-v2 .settings-v2-nav-item').first().click();
      await page.waitForSelector(sel, { timeout: 10000 });
      const before = await page.locator(sel).isChecked();
      await skin.click();
      await sleep(600); // ConfigService debounces its write by 100ms
      expect(await page.locator(sel).isChecked()).toBe(!before);
      const persisted = await h.readPersistedConfig();
      expect(persisted.settings.openLinkExternal).toBe(!before);
      // And the live mirror the link handler reads agrees — a setting that only
      // takes effect after a restart is a split brain, not a saved setting.
      const inState = await page.evaluate(() => window.appState.get('openLinkExternal'));
      expect(inState).toBe(!before);
      // Restore.
      await skin.click();
      await sleep(600);
      expect((await h.readPersistedConfig()).settings.openLinkExternal).toBe(before);
    }, T);

    test('Escape closes Settings', async () => {
      await closeOverlays();
      expect(await isShowing('#settings-v2')).toBe(false);
    }, T);
  });

  // ---- Library (history / bookmarks / downloads / notifications / extensions / ask)

  describe('library', () => {
    const TABS = ['ask', 'bookmarks', 'history', 'downloads', 'notifications', 'extensions'];

    test('Mod+Shift+Y opens the library', async () => {
      await h.press('Mod+Shift+Y');
      await page.waitForSelector('#library-window .library-window-tabs', { state: 'visible', timeout: 15000 });
      expect(await page.locator('#library-window .library-window-tab').count()).toBe(TABS.length);
    }, T);

    test('each library tab activates and renders its panel', async () => {
      const marker = h.errorMarker;
      for (const id of TABS) {
        await page.click(`#library-window-tab-${id}`);
        await sleep(250);
        const active = await page.locator(`#library-window-tab-${id}`).getAttribute('class');
        expect(active).toMatch(/selected/);
        expect(await page.locator('#library-window-panel').count()).toBe(1);
      }
      expect(h.errorsSince(marker)).toEqual([]);
    }, T);

    test('a visit recorded through the real service shows up in the History tab', async () => {
      const url = `https://e2e.invalid/sweep-${Date.now()}`;
      const title = 'E2E sweep visit';
      const added = await h.invoke('history:add', { url, title, spaceId: 'custom1' });
      expect(added).toBeTruthy();
      const recent = await h.invoke('history:recent', { limit: 20 });
      expect(recent.some((e) => e.url === url)).toBe(true);
      // The panel reads the same service — reopen the tab and look for the row.
      await page.click('#library-window-tab-history');
      await sleep(600);
      expect(await page.locator('#library-window-panel').innerText()).toContain(title);
    }, T);

    test('a bookmark toggled on is searchable and can be removed', async () => {
      const url = `https://e2e.invalid/bookmark-${Date.now()}`;
      const res = await h.invoke('bookmarks:toggle', { url, title: 'E2E bookmark' });
      expect(res).toBeTruthy();
      const found = await h.invoke('bookmarks:search', { query: 'E2E bookmark' });
      expect(Array.isArray(found)).toBe(true);
      expect(found.some((b) => b.url === url)).toBe(true);
      await h.invoke('bookmarks:toggle', { url, title: 'E2E bookmark' });
      const gone = await h.invoke('bookmarks:search', { query: 'E2E bookmark' });
      expect(gone.some((b) => b.url === url)).toBe(false);
    }, T);

    test('Escape closes the library', async () => {
      await closeOverlays();
      expect(await isShowing('#library-window')).toBe(false);
    }, T);
  });

  // ---- Notifications ----------------------------------------------------

  describe('notifications', () => {
    test('a notification raised by a page reaches the notification centre', async () => {
      await h.send('notification:show', { title: 'E2E notice', body: 'from the sweep', origin: 'https://e2e.invalid' });
      await sleep(500);
      const list = await h.invoke('notifications:list');
      expect(Array.isArray(list)).toBe(true);
      const entry = list.find((n) => n.title === 'E2E notice');
      expect(entry).toBeTruthy();
      expect(await h.invoke('notifications:mark-read', entry.id)).toBeTruthy();
      await h.invoke('notifications:clear-all');
      expect((await h.invoke('notifications:list')).length).toBe(0);
    }, T);
  });

  // ---- Projects ---------------------------------------------------------

  describe('projects', () => {
    test('create → list → rename → delete round-trips through ProjectService', async () => {
      const created = await h.invoke('projects:create', { name: 'E2E sweep project' });
      expect(created.ok).toBe(true);
      const id = created.project.id;
      const listed = await h.invoke('projects:list');
      expect(listed.projects.some((p) => p.id === id)).toBe(true);
      expect((await h.invoke('projects:rename', { id, name: 'E2E renamed' })).ok).toBe(true);
      expect((await h.invoke('projects:list')).projects.find((p) => p.id === id).name).toBe('E2E renamed');
      expect((await h.invoke('projects:delete', { id })).ok).toBe(true);
      expect((await h.invoke('projects:list')).projects.some((p) => p.id === id)).toBe(false);
    }, T);

    test('an empty project name is refused (negative)', async () => {
      const res = await h.invoke('projects:create', { name: '   ' });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('empty_name');
    }, T);
  });

  // ---- User memory ------------------------------------------------------

  describe('user memory', () => {
    test('add → list → pin → delete round-trips and persists to config', async () => {
      const added = await h.invoke('usermemory:add', { text: 'E2E remembers this fact' });
      expect(added.ok).toBe(true);
      const id = added.fact.id;
      expect((await h.invoke('usermemory:list')).facts.some((f) => f.id === id)).toBe(true);
      expect((await h.invoke('usermemory:pin', { id, on: true })).ok).toBe(true);
      await sleep(600);
      const persisted = await h.readPersistedConfig();
      expect(persisted.settings.userMemory.facts.some((f) => f.id === id && f.pinned)).toBe(true);
      expect((await h.invoke('usermemory:delete', id)).ok).toBe(true);
      expect((await h.invoke('usermemory:list')).facts.some((f) => f.id === id)).toBe(false);
    }, T);

    test('empty memory text is refused (negative)', async () => {
      const res = await h.invoke('usermemory:add', { text: '' });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('empty_text');
    }, T);
  });

  // ---- Personas ---------------------------------------------------------

  describe('personas', () => {
    test('the persona roster loads and routing picks one for a task', async () => {
      const roster = await h.invoke('persona:list');
      expect(Array.isArray(roster.enabled)).toBe(true);
      const routed = await h.invoke('persona:test-route', { description: 'find me the cheapest flight to Tokyo', sync: true });
      expect(routed).toBeTruthy();
    }, T);
  });

  // ---- Adblocker / session / permissions --------------------------------

  describe('web protection services', () => {
    test('the adblocker exposes a catalog and live stats', async () => {
      const catalog = await h.invoke('adblocker:get-catalog');
      expect(Array.isArray(catalog) || (catalog && typeof catalog === 'object')).toBe(true);
      const stats = await h.invoke('adblocker:get-stats');
      expect(stats).toBeTruthy();
    }, T);

    test('a permission check answers for an origin without prompting', async () => {
      const verdict = await h.invoke('permission:check', 'https://e2e.invalid', 'notifications');
      expect(typeof verdict === 'string' || typeof verdict === 'object').toBe(true);
    }, T);
  });

  // ---- LLM surface ------------------------------------------------------

  describe('LLM surface', () => {
    test('status, backends and model list answer on a profile with no engine', async () => {
      const status = await h.invoke('llm:get-status');
      expect(status).toBeTruthy();
      expect(typeof status.status).toBe('string');
      const backends = await h.invoke('llm:backends');
      expect(backends).toBeTruthy();
      const models = await h.invoke('llm:list-models');
      expect(models).toBeTruthy();
    }, T);
  });

  // ---- Agent panel ------------------------------------------------------

  describe('agent panel', () => {
    test('Mod+Shift+A opens the panel with its composer and header controls', async () => {
      await h.press('Mod+Shift+A');
      await page.waitForSelector('#agent-panel .agent-panel-input', { state: 'visible', timeout: 15000 });
      expect(await page.locator('#agent-panel .agent-panel-run').count()).toBe(1);
      // The new-conversation control lives in the header, not buried in the ⋯ menu.
      expect(await page.locator('#agent-panel .agent-panel-header .agent-panel-new').count()).toBe(1);
    }, T);

    test('history starts collapsed to a rail and the header toggle expands it', async () => {
      const toggle = page.locator('#agent-panel .agent-panel-history-toggle').first();
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      expect(await isShowing('#agent-panel .agent-panel-history-rail')).toBe(true);
      expect(await isShowing('#agent-panel-history')).toBe(false);
      await toggle.click();
      await page.waitForSelector('#agent-panel-history', { state: 'visible', timeout: 10000 });
      expect(await toggle.getAttribute('aria-expanded')).toBe('true');
      expect(await isShowing('#agent-panel .agent-panel-history-rail')).toBe(false);
      await toggle.click();
      await page.waitForSelector('#agent-panel-history', { state: 'hidden', timeout: 10000 });
      expect(await page.evaluate(() => window.localStorage.getItem('agent.history.open'))).toBe('0');
    }, T);

    test('sending with no engine configured fails loudly instead of a blank "done"', async () => {
      await page.fill('#agent-panel .agent-panel-input', 'What is the capital of France?');
      await page.click('#agent-panel .agent-panel-run');
      // Either lane (chat or agent) must land on error; a green "done" with an
      // empty answer is the exact regression this asserts against.
      await page.waitForFunction(() => {
        const el = document.querySelector('#agent-panel .agent-panel-status');
        return !!el && el.getAttribute('data-status') === 'error';
      }, undefined, { timeout: 45000 });
      const answer = await page.locator('#agent-panel .agent-panel-answer-slot').innerText();
      expect(answer.trim().length).toBeGreaterThan(0);
    }, T);

    test('+ New conversation clears the thread and returns the panel to idle', async () => {
      await page.click('#agent-panel .agent-panel-header .agent-panel-new');
      await sleep(500);
      const status = await page.locator('#agent-panel .agent-panel-status').getAttribute('data-status');
      expect(status).toBe('idle');
      const transcriptChildren = await page.locator('#agent-panel .agent-panel-transcript > *').count();
      expect(transcriptChildren).toBe(0);
    }, T);

    test('Escape closes the panel', async () => {
      await closeOverlays();
      expect(await isShowing('#agent-panel')).toBe(false);
    }, T);
  });

  // ---- Assistant mode ---------------------------------------------------

  describe('assistant mode', () => {
    // Guest identity: a reparented or reloaded <webview> gets a new guest
    // webContents, so an unchanged id per element proves the flip never moved it.
    const webviewIds = () => page.evaluate(() => Array.from(document.querySelectorAll('#space-container webview'))
      .map((wv) => /** @type {any} */ (wv).getWebContentsId()));

    test('Mod+E flips into assistant mode without reloading or moving any webview', async () => {
      const before = await webviewIds();
      expect(before.length).toBeGreaterThan(0);
      await h.press('Mod+E');
      await page.waitForFunction(() => document.body.classList.contains('app-mode-assistant'), undefined, { timeout: 10000 });
      // The shell is visibility:hidden until the flip lands; wait for it rather than sample mid-transition.
      await page.waitForSelector('#assistant-shell .agent-panel-input', { state: 'visible', timeout: 10000 });
      expect(await webviewIds()).toEqual(before);
    }, T);

    test('a collapsed dock still paints: capturePage returns a non-empty image', async () => {
      const shot = await page.evaluate(async () => {
        const wrap = document.getElementById('tab-bar-wrap');
        const wv = /** @type {any} */ (document.querySelector('#space-container webview'));
        const img = await wv.capturePage();
        return { collapsed: !document.body.classList.contains('assistant-dock-open'), inert: wrap.hasAttribute('inert'), empty: img.isEmpty(), size: img.getSize() };
      });
      expect(shot.collapsed).toBe(true);
      expect(shot.inert).toBe(true);
      expect(shot.empty).toBe(false);
      expect(shot.size.width).toBeGreaterThan(0);
    }, T);

    test('Mod+E flips back to browser mode with the same webviews', async () => {
      const before = await webviewIds();
      await h.press('Mod+E');
      await page.waitForFunction(() => document.body.classList.contains('app-mode-browser'), undefined, { timeout: 10000 });
      expect(await webviewIds()).toEqual(before);
      expect(await page.locator('#tab-bar-wrap[inert]').count()).toBe(0);
    }, T);

    test('the browser-mode sidebar leaves the page interactive: nothing is inert', async () => {
      await h.press('Mod+Shift+A');
      await page.waitForFunction(() => document.body.classList.contains('assistant-sidebar-open'), undefined, { timeout: 10000 });
      expect(await page.locator('[inert]').count()).toBe(0);
      expect(await visible('#tab-bar')).toBe(true);
      await closeOverlays();
      await page.waitForFunction(() => !document.body.classList.contains('assistant-sidebar-open'), undefined, { timeout: 10000 });
    }, T);

    test('the quick launcher hotkey is registered and its window opens', async () => {
      const result = await h.app.evaluate(async ({ globalShortcut, BrowserWindow }) => {
        // @ts-ignore main.js is the main module; this reaches the launcher singleton the hotkey toggles
        const launcher = process.mainModule.require('./main/launcher/launcherWindow').getLauncherWindow();
        launcher.toggle();
        await new Promise((r) => setTimeout(r, 1500));
        const win = BrowserWindow.getAllWindows().find((w) => /launcher\.html$/.test(w.webContents.getURL()));
        const out = { registered: globalShortcut.isRegistered('Alt+Shift+Space'), visible: launcher.isVisible(), loaded: !!win };
        launcher.hide();
        return out;
      });
      expect(result).toEqual({ registered: true, visible: true, loaded: true });
    }, T);
  });

  // ---- Main-process census ---------------------------------------------

  describe('main process', () => {
    test('every IPC domain the UI depends on is registered', async () => {
      const channels = await h.invokeChannels();
      const required = [
        'config:get', 'llm:get-status', 'llm:backends', 'agent:start', 'agent:history-open',
        'chat:ask', 'chat:web-search', 'history:recent', 'bookmarks:tree', 'downloads:history',
        'notifications:list', 'permission:check', 'persona:list', 'projects:list',
        'usermemory:list', 'extensions:list', 'adblocker:get-stats', 'session:clear-site-data',
        'browsing:ask', 'voice:available', 'mcp:status', 'updater:status', 'routine:run-now',
        'agent-workspace:get-state', 'pack:apply', 'dns:validate', 'site-allowlist:add',
        'session:list', 'session:send', 'permissions:get', 'checkpoint:list', 'artifact:list',
        'skills:list', 'commands:list', 'inbox:list', 'recorder:list', 'launcher:submit',
        'workspace:search-files',
      ];
      const missing = required.filter((c) => !channels.includes(c));
      expect(missing).toEqual([]);
      // A partial registerAll() leaves a plausible-looking subset behind.
      expect(channels.length).toBeGreaterThanOrEqual(100);
    }, T);

    test('the app is still alive and error-free after the whole sweep', async () => {
      expect(await visible('#tab-bar')).toBe(true);
      expect(h.pageErrors).toEqual([]);
      expect(h.refusedIpc()).toEqual([]);
    }, T);
  });

  // ---- Browsing history in a real pane (runs last: it relaunches the app) --

  describe('browsing history', () => {
    const http = require('http');
    /** @type {import('http').Server} */
    let server;
    let origin;
    /** @type {Record<string, import('http').IncomingHttpHeaders>} */
    const seenHeaders = {};
    const SETTLE = 2500; // the recorder commits a URL 1.5 s after it stops changing

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        seenHeaders[req.url] = req.headers;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Sweep SPA home</title><p>spa</p>');
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      origin = `http://127.0.0.1:${/** @type {import('net').AddressInfo} */ (server.address()).port}`;
    });

    afterAll(async () => {
      if (server) await new Promise((r) => server.close(r));
    });

    const paneId = async () => (await h.state('openTabs'))[0];
    const recent = async () => /** @type {{url: string, title: string}[]} */ (await h.invoke('history:recent', { limit: 50 }))
      .filter((e) => e.url.startsWith(origin));

    test('a full load and three pushState routes each record once, under the title the page settled on', async () => {
      h.send('config:set', { path: 'settings.doNotTrack', value: true });
      const id = await paneId();
      await page.evaluate(([wvId, url]) => /** @type {any} */ (document.getElementById(wvId)).loadURL(url), [id, `${origin}/`]);
      await sleep(SETTLE);
      for (let i = 1; i <= 3; i++) {
        // A chat app swaps the route first and names the page a moment later.
        await page.evaluate(([wvId, n]) => /** @type {any} */ (document.getElementById(wvId)).executeJavaScript(
          `history.pushState({}, '', '/chat/${n}'); setTimeout(() => { document.title = 'Sweep chat ${n}'; }, 400);`,
        ), [id, i]);
        await sleep(SETTLE);
      }
      const entries = await recent();
      const byUrl = Object.fromEntries(entries.map((e) => [e.url.slice(origin.length), e.title]));
      expect(byUrl).toEqual({
        '/': 'Sweep SPA home',
        '/chat/1': 'Sweep chat 1',
        '/chat/2': 'Sweep chat 2',
        '/chat/3': 'Sweep chat 3',
      });
      expect(entries).toHaveLength(4);
      // The Do Not Track setting reached the live session's request headers.
      expect(seenHeaders['/']).toMatchObject({ dnt: '1', 'sec-gpc': '1' });
    }, T);

    test('the visits survive quitting and reopening the app', async () => {
      await h.relaunch();
      page = h.page;
      await h.autoDismissSiteBlocked();
      const urls = (await recent()).map((e) => e.url.slice(origin.length)).sort();
      expect(urls).toEqual(['/', '/chat/1', '/chat/2', '/chat/3']);
      expect(h.pageErrors).toEqual([]);
      expect(h.refusedIpc()).toEqual([]);
    }, 120000);
  });
});
