// commandRegistry.js — Builds the command list shown by the Command Palette.
// Pure functions only: input is a context object, output is a flat array of
// command descriptors. No DOM access, no IPC. The palette component handles
// rendering, fuzzy matching, and execution.

function _spaceCommands(ctx) {
  if (!ctx || !ctx.spaces) return [];
  const out = [];
  Object.keys(ctx.spaces).forEach((id) => {
    const space = ctx.spaces[id];
    if (!space) return;
    out.push({
      id: 'space:' + id,
      type: 'space',
      title: space.name || id,
      subtitle: space.url || '',
      icon: space.type === 'local-llm' ? 'Local' : (space.type === 'web-page' ? 'Web' : 'AI'),
      keywords: [space.name, id, space.url, space.type].filter(Boolean).join(' '),
      action: () => ctx.spaceManager && ctx.spaceManager.select(id),
    });
  });
  return out;
}

function _actionCommands(ctx) {
  const c = ctx || {};
  // Every LLM surface is now the one chat panel. Page tools run as transform
  // slash-actions; council/research open the chat seeded with the command.
  const openChatTool = (action) => {
    const ap = c.agentPanel;
    if (!ap) return;
    if (action === 'ask-page' && ap.openChat) { ap.openChat({ context: 'page' }); return; }
    const slash = { 'summarize-page': 'summarize', 'explain-selection': 'explain', 'compare-pages': 'compare' }[action];
    if (slash && ap.openChatAction) ap.openChatAction(slash);
  };
  const openChatPrompt = (prefill) => {
    if (c.agentPanel && c.agentPanel.openChat) c.agentPanel.openChat({ prefill });
  };
  const openLibrary = (tab) => {
    if (c.libraryWindow && c.libraryWindow.open) c.libraryWindow.open({ tab });
  };
  const list = [
    // Navigation
    { id: 'action:navigate.back', title: 'Go Back', subtitle: 'Navigate back in history', icon: 'Nav', action: () => c.navigationManager && c.navigationManager.back && c.navigationManager.back() },
    { id: 'action:navigate.forward', title: 'Go Forward', subtitle: 'Navigate forward in history', icon: 'Nav', action: () => c.navigationManager && c.navigationManager.forward && c.navigationManager.forward() },
    { id: 'action:navigate.refresh', title: 'Reload', subtitle: 'Refresh current page', icon: 'Nav', action: () => c.navigationManager && c.navigationManager.refresh && c.navigationManager.refresh() },
    { id: 'action:navigate.home', title: 'Go Home', subtitle: 'Navigate to home page', icon: 'Nav', action: () => c.navigationManager && c.navigationManager.home && c.navigationManager.home() },
    // Zoom
    { id: 'action:zoom.in', title: 'Zoom In', subtitle: 'Increase zoom level', icon: 'Zoom', action: () => c.navigationManager && c.navigationManager.zoomIn && c.navigationManager.zoomIn() },
    { id: 'action:zoom.out', title: 'Zoom Out', subtitle: 'Decrease zoom level', icon: 'Zoom', action: () => c.navigationManager && c.navigationManager.zoomOut && c.navigationManager.zoomOut() },
    { id: 'action:zoom.reset', title: 'Reset Zoom', subtitle: 'Reset zoom to 100%', icon: 'Zoom', action: () => c.navigationManager && c.navigationManager.zoomReset && c.navigationManager.zoomReset() },
    // Find
    { id: 'action:find.toggle', title: 'Find in Page', subtitle: 'Open the find bar', icon: 'Find', action: () => c.findBarManager && c.findBarManager.toggle && c.findBarManager.toggle() },
    // View
    { id: 'action:view.multiSpace', title: 'Toggle Multi-Space', subtitle: 'Show multiple spaces side-by-side', icon: 'View', action: () => c.spaceManager && c.spaceManager.toggleMulti && c.spaceManager.toggleMulti() },
    { id: 'action:view.browser', title: 'Toggle Browser View', subtitle: 'Switch to the browser space', icon: 'View', action: () => c.browserViewManager && c.browserViewManager.toggle && c.browserViewManager.toggle() },
    { id: 'action:view.flip', title: 'Flip Assistant / Browser View', subtitle: 'Make the Assistant the main view, or return to the page', icon: 'View', keywords: 'assistant browser mode dock flip', action: () => c.viewShell && c.viewShell.flip && c.viewShell.flip() },
    { id: 'action:view.space', title: 'Toggle Space View', subtitle: 'Show or hide the space pane', icon: 'View', action: () => c.browserViewManager && c.browserViewManager.toggleSpace && c.browserViewManager.toggleSpace() },
    { id: 'action:links.external', title: 'Toggle Open Links Externally', subtitle: 'Send clicked links to the system browser', icon: 'View', keywords: 'external links system browser', action: () => c.toggleOpenLinkExternal && c.toggleOpenLinkExternal() },
    { id: 'action:bookmark.toggle', title: 'Bookmark This Page', subtitle: 'Add or remove a bookmark for the focused tab', icon: 'Data', keywords: 'bookmark star save page', action: () => c.bookmarkPage && c.bookmarkPage() },
    // Panels
    { id: 'action:panel.agent', title: 'Open Chat', subtitle: 'Chat, agent, page tools, all-space council, and research — one surface', icon: 'Agent', keywords: 'assistant agent chat copilot ask', action: () => c.agentPanel && c.agentPanel.toggle && c.agentPanel.toggle() },
    { id: 'action:panel.library', title: 'Open Library', subtitle: 'Ask Browsing, Bookmarks, History, Downloads, Notifications, and Extensions', icon: 'Data', action: () => openLibrary('ask') },
    // Page reading tools (routed into the unified chat)
    { id: 'action:copilot.summarize', title: 'Summarize This Page', subtitle: 'Summarize the page in view in the chat', icon: 'AI', action: () => openChatTool('summarize-page') },
    { id: 'action:copilot.ask', title: 'Ask About This Page', subtitle: 'Open chat with the active page attached', icon: 'AI', action: () => openChatTool('ask-page') },
    { id: 'action:copilot.explain', title: 'Explain Selection', subtitle: 'Explain the selected text in the chat', icon: 'AI', action: () => openChatTool('explain-selection') },
    { id: 'action:copilot.compare', title: 'Compare Page Contents', subtitle: 'Compare the visible panes in the chat', icon: 'AI', keywords: 'compare panes page contents visible panes chat', action: () => openChatTool('compare-pages') },
    { id: 'action:reader.open', title: 'Reader View', subtitle: 'Open a clean, readable view of the active page', icon: 'AI', action: () => c.readerView && c.readerView.open && c.readerView.open() },
    { id: 'action:panel.extensions', title: 'Open Extensions', subtitle: 'Manage browser extensions in Library', icon: 'Ext', action: () => openLibrary('extensions') },
    { id: 'action:panel.notifications', title: 'Open Notifications', subtitle: 'Open the notification inbox in Library', icon: 'Bell', action: () => openLibrary('notifications') },
    { id: 'action:notifications.clearAll', title: 'Clear All Notifications', subtitle: 'Remove every item from the Library inbox', icon: 'Bell', action: () => c.libraryWindow && c.libraryWindow.clearAll && c.libraryWindow.clearAll() },
    { id: 'action:notifications.markAllRead', title: 'Mark All Notifications as Read', subtitle: 'Zero the Library unread badge', icon: 'Bell', action: () => c.libraryWindow && c.libraryWindow.markAllRead && c.libraryWindow.markAllRead() },
    { id: 'action:council.convene', title: 'Ask and Compare All Spaces', subtitle: 'Ask all AI spaces, then merge their answers with the local LLM (/council)', icon: 'AI', keywords: 'council convene ask all ai spaces broadcast send prompt multi space compare responses answers consolidate answers merge responses merge answers synthesize responses synthesis side by side chat', action: () => openChatPrompt('/council ') },
    { id: 'action:research.report', title: 'Research Report', subtitle: 'Sourced, cited research report from the agent (/research)', icon: 'AI', action: () => openChatPrompt('/research ') },
    // Tab management
    { id: 'action:tab.new', title: 'New Tab', subtitle: 'Open a new space or URL', icon: 'Tab', action: () => c.newTabPicker && c.newTabPicker.open && c.newTabPicker.open() },
    { id: 'action:tab.close', title: 'Close Tab', subtitle: 'Close the current tab', icon: 'Tab', action: () => c.spaceManager && c.spaceManager.close && c.spaceManager.close() },
    { id: 'action:tab.reopenClosed', title: 'Reopen Closed Tab', subtitle: 'Bring back the last tab you closed', icon: 'Tab', keywords: 'undo close restore recently closed', action: () => c.spaceManager && c.spaceManager.reopenClosedTab && c.spaceManager.reopenClosedTab() },
    { id: 'action:tab.newPrivate', title: 'New Private Tab', subtitle: 'Browse without saving history, cookies or cache', icon: 'Tab', keywords: 'incognito private browsing window', action: () => c.spaceManager && c.spaceManager.openPrivateTab && c.spaceManager.openPrivateTab() },
    { id: 'action:tab.next', title: 'Next Tab', subtitle: 'Switch to next tab', icon: 'Tab', action: () => c.spaceManager && c.spaceManager.next && c.spaceManager.next() },
    { id: 'action:tab.previous', title: 'Previous Tab', subtitle: 'Switch to previous tab', icon: 'Tab', action: () => c.spaceManager && c.spaceManager.previous && c.spaceManager.previous() },
    // Layout
    { id: 'action:layout.sideBySide', title: 'Layout: Side by Side', subtitle: 'Arrange spaces side by side', icon: 'Layout', action: () => c.layoutManager && c.layoutManager.setLayout && c.layoutManager.setLayout('sideBySide') },
    { id: 'action:layout.grid', title: 'Layout: Grid', subtitle: 'Arrange spaces in a grid', icon: 'Layout', action: () => c.layoutManager && c.layoutManager.setLayout && c.layoutManager.setLayout('grid') },
    { id: 'action:layout.stacked', title: 'Layout: Stacked', subtitle: 'Stack spaces vertically', icon: 'Layout', action: () => c.layoutManager && c.layoutManager.setLayout && c.layoutManager.setLayout('stacked') },
    { id: 'action:layout.cycle', title: 'Cycle Layout', subtitle: 'Step through side by side, grid, and stacked', icon: 'Layout', keywords: 'layout cycle next arrangement', action: () => c.cycleLayout && c.cycleLayout() },
    // Settings & Window
    { id: 'action:settings.open', title: 'Open Settings', subtitle: 'Application settings', icon: 'Settings', action: () => c.openSettings && c.openSettings() },
    { id: 'action:window.toggle', title: 'Hide Window', subtitle: 'Hide the InstantCognition window', icon: 'Window', action: () => c.toggleWindow && c.toggleWindow() },
  ];
  return list.map((cmd) => ({
    ...cmd,
    type: 'action',
    keywords: [cmd.title, cmd.subtitle, cmd.id, cmd.keywords].filter(Boolean).join(' '),
  }));
}

function getCommands(ctx) {
  return [..._actionCommands(ctx), ..._spaceCommands(ctx)];
}

// Lightweight fuzzy scorer: returns 0 when query is empty, otherwise a positive
// score when every query character appears in the haystack in order, with
// bonuses for prefix and word-boundary matches. Returns -1 for no match.
function fuzzyScore(query, haystack) {
  if (!query) return 0;
  if (!haystack) return -1;
  const q = String(query).toLowerCase();
  const h = String(haystack).toLowerCase();
  if (h.startsWith(q)) return 1000 - (h.length - q.length);
  const exactAt = h.indexOf(q);
  if (exactAt >= 0) return 800 - exactAt;
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  for (let i = 0; i < h.length && qi < q.length; i++) {
    if (h[i] === q[qi]) {
      score += 10;
      if (i === 0 || h[i - 1] === ' ' || h[i - 1] === '-' || h[i - 1] === '_') score += 8;
      if (prevMatch === i - 1) score += 5;
      prevMatch = i;
      qi++;
    }
  }
  if (qi < q.length) return -1;
  return score - (h.length - q.length);
}

function filterAndRank(commands, query) {
  if (!query) return commands.slice(0);
  const scored = [];
  for (const cmd of commands) {
    const titleScore = fuzzyScore(query, cmd.title);
    const kwScore = fuzzyScore(query, cmd.keywords || '');
    const best = Math.max(titleScore, kwScore - 5);
    if (best >= 0) scored.push({ cmd, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.cmd);
}

module.exports = { getCommands, fuzzyScore, filterAndRank };
