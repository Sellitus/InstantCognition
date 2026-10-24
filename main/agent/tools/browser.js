// Browser tool set for the agent. Each tool returns a JSON-serializable
// result. Read-only tools (list_tabs/read_tab/screenshot_tabs/extract/
// get_selection) can run concurrently on the same tab; side-effecting tools
// (navigate/click/type/scroll/wait/press_key/open_tab/close_tab/focus_tab)
// are marked sideEffect:true and are serialized per spaceId by the runtime.

const ap = require('../actionPrimitives');
const { buildReadableScript } = require('../readableExtractor');
const { buildExtractScript } = require('../domExtractor');
const { errMsg } = require('../../../shared/errMsg');
const browsingPrivacy = require('../../services/BrowsingPrivacyService');

// True for tabs the agent owns (agent workspace) and should be allowed to
// touch. The agent must NEVER act on user tabs from its tools — those live
// in a different view, share the chrome with the user's tab bar, and aren't
// reflected in AgentWorkspaceManager._wrappers (so focus_tab on a user id
// would silently fail with tab_not_found).
function isAgentTab(t) { return t && (t.kind || 'user') === 'agent' && t.webContentsId != null; }

// Resolve the WebContents to act on. With an explicit spaceId we look it up.
// Without one ("active tab"), we ask the live tabRegistry which tab is active
// RIGHT NOW — not the one cached at task start. Otherwise opening a new tab
// then calling read_tab without a spaceId reads the previously-focused tab.
function activeWc(toolCtx, spaceId) {
  if (spaceId) {
    if (typeof toolCtx.resolveWc === 'function') return toolCtx.resolveWc(spaceId) || toolCtx.defaultWebContents;
    return toolCtx.defaultWebContents;
  }
  const reg = toolCtx.tabRegistry;
  if (reg && typeof reg.list === 'function' && typeof toolCtx.resolveWc === 'function') {
    // Scope to agent tabs — the user's active tab in the other view must not
    // become the agent's "active" target.
    const active = reg.list().find((t) => t.isActive && isAgentTab(t));
    if (active) {
      const wc = toolCtx.resolveWc(active.spaceId);
      if (wc) return wc;
    }
  }
  return toolCtx.defaultWebContents;
}

const listTabs = {
  name: 'browser.list_tabs',
  description: 'List every open tab in the agent workspace with spaceId, name, title, url, and which is currently active. The user\'s own tabs are NOT listed — the agent operates on its isolated workspace only.',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async (_args, toolCtx) => {
    const reg = toolCtx.tabRegistry;
    const list = reg && reg.list ? reg.list().filter(isAgentTab) : [];
    return { ok: true, tabs: list.map((t) => ({ spaceId: t.spaceId, name: t.name || '', title: t.title || '', url: t.url || '', isActive: !!t.isActive })) };
  },
};

// SPA sites that hydrate content client-side. read_tab can return the empty
// shell on these. When that happens, return a hint pointing the agent to a
// recovery path (wait_for_load network_idle, extract a known selector, or
// the old.* equivalent) instead of letting it spin on snapshot_ax→click.
const SPA_HOST_RX = /(^|\.)(reddit|twitter|x|threads|linkedin)\.(com|net)$|^t\.co$/i;
const SPA_RECOVERY_HINTS = {
  reddit: 'Page is the SPA shell. Recovery options: (1) navigate to https://old.reddit.com/r/<sub>/top/?t=week — server-rendered content; (2) call browser.wait_for { network_idle: true } then read_tab again; (3) call browser.extract with selector `[data-testid="post-container"]`.',
  twitter: 'Page is the SPA shell. Try wait_for { network_idle: true } first, then read_tab again. Or use browser.extract with `[data-testid="tweet"]`.',
  x: 'Page is the SPA shell. Try wait_for { network_idle: true } first, then read_tab again. Or use browser.extract with `[data-testid="tweet"]`.',
  threads: 'Page is the SPA shell. Try wait_for { network_idle: true } then read_tab again.',
  linkedin: 'Page is the SPA shell. Try wait_for { network_idle: true } then read_tab again, or browser.extract with `.feed-shared-update-v2`.',
};
const MIN_USEFUL_WORDS = 20;

function spaHintForUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!SPA_HOST_RX.test(host)) return null;
    const key = host.replace(/^(www\.|m\.|mobile\.)/, '').split('.')[0];
    return SPA_RECOVERY_HINTS[key] || SPA_RECOVERY_HINTS.reddit;
  } catch (_) { return null; }
}

const readTab = {
  name: 'browser.read_tab',
  description: 'Return readable main text of a tab (Readability-style; strips nav/ads). Defaults to the active tab if spaceId is omitted. Safe to call multiple times in parallel for different tabs.',
  parameters: { type: 'object', properties: { spaceId: { type: 'string' }, maxChars: { type: 'number' } }, required: [] },
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    if (!wc || typeof wc.executeJavaScript !== 'function') return { ok: false, error: 'webcontents_unavailable' };
    try {
      let result;
      const out = await wc.executeJavaScript(buildReadableScript({ maxMainText: args.maxChars || 6000 }), true);
      if (out && out.mainText) result = { ok: true, ...out };
      else {
        const fb = await wc.executeJavaScript(buildExtractScript({ maxTextLength: 4000 }), true);
        result = { ok: true, url: fb.url, title: fb.title, mainText: fb.text || '', headings: [], wordCount: (fb.text || '').split(/\s+/).filter(Boolean).length };
      }
      // SPA hydration detection: if we got back fewer than ~20 useful words AND
      // the host is a known SPA, surface a recovery hint so the agent doesn't
      // burn steps spinning on snapshot_ax / click_idx against an empty shell.
      const wc_url = (typeof wc.getURL === 'function') ? (wc.getURL() || '') : (result.url || '');
      const wordCount = result.wordCount || (result.mainText || '').split(/\s+/).filter(Boolean).length;
      if (wordCount < MIN_USEFUL_WORDS) {
        const hint = spaHintForUrl(wc_url);
        if (hint) result.hint = hint;
      }
      return result;
    } catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

const screenshotTabs = {
  name: 'browser.screenshot_tabs',
  description: 'Capture screenshots of one or more tabs (returned as data URLs for vision-capable models). Only works if vision is enabled.',
  parameters: { type: 'object', properties: { spaceIds: { type: 'array' } }, required: ['spaceIds'] },
  handler: async (args, toolCtx, invCtx) => {
    if (!invCtx || !invCtx.visionEnabled) return { ok: false, error: 'vision_disabled' };
    const ss = toolCtx.screenshots;
    if (!ss) return { ok: false, error: 'screenshots_unavailable' };
    const reg = toolCtx.tabRegistry;
    const images = [];
    for (const sid of (args.spaceIds || []).slice(0, 4)) {
      const entry = reg && reg.get ? reg.get(sid) : null;
      if (!entry || entry.webContentsId == null) continue;
      try {
        const dataUrl = await ss.captureById(entry.webContentsId, { format: 'dataUrl', maxDim: (invCtx && invCtx.screenshotLongEdgePx) || 1280 });
        if (dataUrl) images.push({ spaceId: sid, dataUrl });
      } catch (_) { /* skip failed tab */ }
    }
    return { ok: true, images };
  },
};

function sideEffectTool(name, description, schema, runner) {
  return {
    name, description, parameters: schema, sideEffect: true,
    handler: async (args, toolCtx) => {
      const wc = activeWc(toolCtx, args.spaceId);
      if (!wc) return { ok: false, error: 'webcontents_unavailable' };
      try { return await runner(args, wc, toolCtx); }
      catch (err) { return { ok: false, error: errMsg(err) }; }
    },
  };
}

const click = sideEffectTool('browser.click', 'LEGACY selector-based click. Prefer browser.click_idx (real pointer events against an AX idx). Use this only when you already have a known-good CSS selector (e.g. hardcoded from page source) and the CDP path is unavailable.',
  { type: 'object', properties: { spaceId: { type: 'string' }, selector: { type: 'string' } }, required: ['selector'] },
  (args, wc) => wc.executeJavaScript(ap.buildClickScript(args.selector), true));

const type = sideEffectTool('browser.type', 'LEGACY selector-based type. Prefer browser.type_text with an idx from snapshot_ax — it goes through real CDP input events and works with React/Vue/Svelte without value-setter tricks.',
  { type: 'object', properties: { spaceId: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] },
  (args, wc) => wc.executeJavaScript(ap.buildTypeScript(args.selector, args.text || ''), true));

const scroll = sideEffectTool('browser.scroll', 'Scroll within a tab.',
  { type: 'object', properties: { spaceId: { type: 'string' }, direction: { type: 'string' }, amount: { type: 'number' } }, required: [] },
  (args, wc) => wc.executeJavaScript(ap.buildScrollScript(args.direction || 'down', args.amount || 400), true));

const waitFor = sideEffectTool('browser.wait', 'LEGACY selector-only wait. Prefer browser.wait_for — it supports text substring, min_words (for SPA hydration detection), and network_idle in addition to selector.',
  { type: 'object', properties: { spaceId: { type: 'string' }, selector: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['selector'] },
  (args, wc) => wc.executeJavaScript(ap.buildWaitForScript(args.selector, args.timeoutMs || 5000), true));

const navigate = sideEffectTool('browser.navigate', 'Navigate a tab to a new URL.',
  { type: 'object', properties: { spaceId: { type: 'string' }, url: { type: 'string' } }, required: ['url'] },
  async (args, wc) => {
    if (typeof wc.loadURL !== 'function') return { ok: false, error: 'loadURL_unavailable' };
    // HTTPS-only cancels an http load mid-flight, which would reject this one.
    await wc.loadURL(browsingPrivacy.upgradeTarget(args.url));
    return { ok: true };
  });

const extract = {
  name: 'browser.extract',
  description: 'Extract text from elements matching a selector. Truncates at maxChars (default 6000) and sets truncated:true — narrow the selector instead of re-reading. Read-only.',
  parameters: { type: 'object', properties: { spaceId: { type: 'string' }, selector: { type: 'string' }, maxChars: { type: 'number' } }, required: ['selector'] },
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    if (!wc) return { ok: false, error: 'webcontents_unavailable' };
    try { return await wc.executeJavaScript(ap.buildExtractTextScript(args.selector, args.maxChars), true); }
    catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

const getSelection = {
  name: 'browser.get_selection',
  description: 'Return the currently selected text on a tab. Read-only.',
  parameters: { type: 'object', properties: { spaceId: { type: 'string' } }, required: [] },
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    if (!wc) return { ok: false, error: 'webcontents_unavailable' };
    try {
      const text = await wc.executeJavaScript('String(window.getSelection ? window.getSelection().toString() : "")', true);
      return { ok: true, text: text || '' };
    } catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

const pressKey = sideEffectTool('browser.press_key', 'LEGACY JS-dispatch key event. Most real forms ignore synthetic KeyboardEvents. Prefer browser.press_key_real (CDP-level) — it actually submits forms and navigates menus.',
  { type: 'object', properties: { spaceId: { type: 'string' }, key: { type: 'string' } }, required: ['key'] },
  (args, wc) => {
    const src = `(function(){var ev=new KeyboardEvent('keydown',{key:${JSON.stringify(args.key)},bubbles:true});var t=document.activeElement||document.body;t.dispatchEvent(ev);var up=new KeyboardEvent('keyup',{key:${JSON.stringify(args.key)},bubbles:true});t.dispatchEvent(up);return {ok:true};})();`;
    return wc.executeJavaScript(src, true);
  });

module.exports = [listTabs, readTab, screenshotTabs, click, type, scroll, waitFor, navigate, extract, getSelection, pressKey];
module.exports.activeWc = activeWc;
