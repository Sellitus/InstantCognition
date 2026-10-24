// tabsTools — agent tools that create / close / focus / duplicate tabs.
// Delegates to AgentTabOpsService which bridges main<->renderer via IPC to
// SpaceManager. Tools are side-effecting but do not target a single spaceId
// for the purposes of intra-tab conflict detection (each operates on the
// tab manifest itself, not a page).

const tabOps = require('../../services/AgentTabOpsService');
const tabRegistry = require('../../services/tabRegistry');
const { errMsg } = require('../../../shared/errMsg');

// Wait for a newly-opened tab to settle before returning to the agent. Without
// this, the LLM reads the tab while it's still a skeleton and the subsequent
// snapshot_ax / read_tab misses the actual content. Times out silently — the
// agent's next wait_for_load / snapshot_ax will still catch up.
async function waitForLoadSettled(wc, timeoutMs) {
  if (!wc || typeof wc.isLoading !== 'function') return;
  const deadline = Date.now() + Math.max(500, Math.min(timeoutMs || 8000, 15000));
  if (wc.isLoading()) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      try { wc.once('did-finish-load', finish); } catch (_) { /* ignore */ }
      setTimeout(finish, Math.max(250, deadline - Date.now()));
    });
  }
  // Tiny settling pause so client-side rendering (e.g. SPA hydration on hn.algolia.com)
  // finishes before we snapshot/read.
  await new Promise((r) => setTimeout(r, 400));
}

function make(name, description, schema, runner) {
  return {
    name, description, parameters: schema, sideEffect: true,
    // Use op name as the conflict key so two tab-level ops in one turn serialize.
    targetSpaceKey: '_tabOp',
    handler: async (args, toolCtx) => {
      const ops = (toolCtx && toolCtx.tabOps) || tabOps;
      try { return await runner(args, ops, toolCtx); }
      catch (err) { return { ok: false, error: errMsg(err) }; }
    },
  };
}

const openTab = make(
  'browser.open_tab',
  'Open a new tab with the given URL, switch to it, and wait for the page to finish loading before returning. Returns {ok, spaceId} — pass spaceId to snapshot_ax / read_tab / type_text / click_idx to interact with the new tab.',
  { type: 'object', properties: { url: { type: 'string' }, background: { type: 'boolean' } }, required: ['url'] },
  async (args, ops, toolCtx) => {
    const res = await ops.openTab(args.url);
    const spaceId = res.spaceId || null;
    if (spaceId && toolCtx && typeof toolCtx.resolveWc === 'function') {
      const wc = toolCtx.resolveWc(spaceId);
      if (wc) await waitForLoadSettled(wc, 8000);
    }
    return { ok: true, spaceId, url: args.url };
  },
);

const closeTab = make(
  'browser.close_tab',
  'Close a tab by spaceId. The last open tab cannot be closed.',
  { type: 'object', properties: { spaceId: { type: 'string' } }, required: ['spaceId'] },
  async (args, ops) => {
    await ops.closeTab(args.spaceId);
    return { ok: true, spaceId: args.spaceId };
  },
);

const focusTab = make(
  'browser.focus_tab',
  'Make a tab the active tab by spaceId. Useful before multi-step read/write flows when the user is on a different tab.',
  { type: 'object', properties: { spaceId: { type: 'string' } }, required: ['spaceId'] },
  async (args, ops) => {
    await ops.focusTab(args.spaceId);
    return { ok: true, spaceId: args.spaceId };
  },
);

const duplicateTab = make(
  'browser.duplicate_tab',
  'Open a new tab with the same URL as an existing tab. Returns the new spaceId. Useful for comparing two views of the same page or running a branch in isolation.',
  { type: 'object', properties: { spaceId: { type: 'string' } }, required: ['spaceId'] },
  async (args, ops, toolCtx) => {
    const reg = (toolCtx && toolCtx.tabRegistry) || tabRegistry;
    const src = reg && reg.get ? reg.get(args.spaceId) : null;
    if (!src || !src.url) return { ok: false, error: 'source_tab_not_found' };
    const res = await ops.openTab(src.url);
    return { ok: true, fromSpaceId: args.spaceId, spaceId: res.spaceId || null, url: src.url };
  },
);

const forkTab = make(
  'browser.fork_tab',
  'Open a duplicate of a tab and switch focus back to the source tab. Used for speculative/dry-run branches: the agent can work in the fork without touching the source. Returns {fromSpaceId, spaceId}.',
  { type: 'object', properties: { spaceId: { type: 'string' } }, required: ['spaceId'] },
  async (args, ops, toolCtx) => {
    const reg = (toolCtx && toolCtx.tabRegistry) || require('../../services/tabRegistry');
    const src = reg && reg.get ? reg.get(args.spaceId) : null;
    if (!src || !src.url) return { ok: false, error: 'source_tab_not_found' };
    const res = await ops.openTab(src.url);
    const forkId = res && res.spaceId;
    // Switch focus back to source so the agent can continue seeing the source view.
    try { await ops.focusTab(args.spaceId); } catch (_) { /* non-fatal */ }
    return { ok: true, fromSpaceId: args.spaceId, spaceId: forkId, url: src.url };
  },
);

module.exports = [openTab, closeTab, focusTab, duplicateTab, forkTab];
