// toolCatalog — static classification of every agent tool name.
//
// classify(name) → { cls, tier, planSafe }
//   cls      — permission class: read | meta | navigate | click | type | edit |
//              exec | external | delegate | destructive | unknown
//   tier     — model preference order: 1 = API-level (MCP, project, fs, shell,
//              search, agent meta), 2 = DOM / accessibility tree, 3 = screenshot.
//              The registry lists tools sorted by tier so the model meets the
//              cheapest, most reliable surface first.
//   planSafe — callable while the session is in Plan (read-only) mode.
//
// A name the catalog does not know classifies as 'unknown' so the permission
// engine asks instead of treating it as a harmless click.

const CLASSES = Object.freeze([
  'read', 'meta', 'navigate', 'click', 'type', 'edit',
  'exec', 'external', 'delegate', 'destructive', 'unknown',
]);

// Plan mode is for research, so reading the web (navigating, scrolling,
// waiting) stays available; anything that types, submits, edits files, runs
// commands or calls third parties does not.
const PLAN_SAFE_CLASSES = new Set(['read', 'meta', 'navigate', 'delegate']);

// [cls, tier, planSafe?]; planSafe defaults to PLAN_SAFE_CLASSES membership.
/** @type {Record<string, [string, number, boolean?]>} */
const CATALOG = {
  // Agent meta
  'agent.done': ['meta', 1],
  'agent.ask_user': ['meta', 1],
  'agent.set_plan': ['meta', 1],
  'agent.update_ledger': ['meta', 1],
  'agent.todo_write': ['meta', 1],
  'agent.exit_plan': ['meta', 1],
  'agent.use_skill': ['meta', 1],
  'agent.spawn_subagent': ['delegate', 1],
  // Drives third-party AI sites with the user's prompt.
  'agent.broadcast_to_cognitizers': ['external', 2],
  // Artifacts live in app storage, never the user's workspace.
  'artifact.create': ['meta', 1],
  'artifact.update': ['meta', 1],

  // Workspace files and commands
  'fs.list': ['read', 1],
  'fs.read': ['read', 1],
  'fs.search': ['read', 1],
  'fs.diff': ['read', 1],
  'fs.write': ['edit', 1],
  'fs.edit': ['edit', 1],
  'shell.run': ['exec', 1],
  'project.search': ['read', 1],
  'project.read_file': ['read', 1],

  // Browser data and search APIs (no DOM involved)
  'browser.web_search': ['read', 1],
  'browser.search_history': ['read', 1],
  'browser.recent_history': ['read', 1],
  'browser.ask_browsing': ['read', 1],
  'browser.list_tabs': ['read', 1],

  // DOM / accessibility-tree reads
  'browser.read_tab': ['read', 2],
  'browser.extract': ['read', 2],
  'browser.get_selection': ['read', 2],
  'browser.snapshot_ax': ['read', 2],
  'browser.snapshot_ax_diff': ['read', 2],
  'browser.locate': ['read', 2],

  // Navigation
  'browser.navigate': ['navigate', 2],
  'browser.open_tab': ['navigate', 2],
  'browser.focus_tab': ['navigate', 2],
  'browser.duplicate_tab': ['navigate', 2],
  'browser.fork_tab': ['navigate', 2],
  'browser.go_back': ['navigate', 2],
  'browser.go_forward': ['navigate', 2],
  'browser.wait_for_load': ['navigate', 2],
  'browser.open_research_sources': ['navigate', 2],

  // Pointer interaction. Scrolling, hovering and waiting change nothing on
  // the page's server side, so they stay usable in Plan mode.
  'browser.click': ['click', 2],
  'browser.click_idx': ['click', 2],
  'browser.hover_idx': ['click', 2, true],
  'browser.scroll': ['click', 2, true],
  'browser.scroll_to_idx': ['click', 2, true],
  'browser.wait': ['click', 2, true],
  'browser.wait_for': ['click', 2, true],

  // Keyboard / form input
  'browser.type': ['type', 2],
  'browser.type_text': ['type', 2],
  'browser.fill_form': ['type', 2],
  'browser.press_key': ['type', 2],
  'browser.press_key_real': ['type', 2],

  // Destructive
  'browser.close_tab': ['destructive', 2],

  // Screenshots
  'browser.screenshot_tabs': ['read', 3],
};

// Namespaces whose members are generated at runtime.
/** @type {Array<[string, [string, number]]>} */
const PREFIXES = [
  ['mcp.', ['external', 1]],
  ['project.', ['read', 1]],
];

/** @param {string} cls @param {number} tier @param {boolean} [planSafe] */
function entry(cls, tier, planSafe) {
  return { cls, tier, planSafe: planSafe === undefined ? PLAN_SAFE_CLASSES.has(cls) : planSafe };
}

function classify(name) {
  if (typeof name !== 'string' || !name) return entry('unknown', 2);
  if (Object.prototype.hasOwnProperty.call(CATALOG, name)) return entry(...CATALOG[name]);
  for (const [prefix, spec] of PREFIXES) {
    if (name.length > prefix.length && name.startsWith(prefix)) return entry(...spec);
  }
  return entry('unknown', 2);
}

function knownNames() { return Object.keys(CATALOG); }

module.exports = { CLASSES, classify, knownNames };
