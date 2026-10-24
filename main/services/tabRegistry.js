// tabRegistry — in-memory map of spaceId -> { webContentsId, name, title, url, isActive, kind, sessionId? }.
// Populated by space-activity IPC; `attach(wc, spaceId)` wires did-navigate and
// page-title-updated listeners so url/title stay fresh without polling.
// Consumed by AgentService + tools for multi-tab observation.
// Not persisted — webContentsId is process-bound anyway.
// sessionId marks an agent tab opened by that session's run (AgentTabOpsService
// tags it); forSession() gives a run a view that hides other sessions' tabs.
// private marks a tab in the private browsing session; no session view ever
// shows one, so agent tools cannot list, read or screenshot it.

const entries = new Map();
const attached = new WeakSet();
// sessionId -> spaceId of the tab that session last opened or focused. Only one
// tab is the renderer's current tab, so a session that is not on screen keeps
// its own notion of "active" here.
const sessionActive = new Map();

function set(spaceId, webContentsId, isActive) {
  if (!spaceId) return;
  const existing = entries.get(spaceId) || {};
  entries.set(spaceId, { ...existing, webContentsId, isActive: !!isActive });
}

function setMeta(spaceId, meta) {
  if (!spaceId) return;
  const existing = entries.get(spaceId) || {};
  entries.set(spaceId, { ...existing, ...meta });
}

function get(spaceId) { return entries.get(spaceId) || null; }

function remove(spaceId) {
  entries.delete(spaceId);
  dropSessionActive(spaceId);
}

function setSessionActive(sessionId, spaceId) {
  if (sessionId && spaceId) sessionActive.set(sessionId, spaceId);
}

function dropSessionActive(spaceId) {
  for (const [sid, active] of sessionActive) if (active === spaceId) sessionActive.delete(sid);
}

function list() {
  return Array.from(entries.entries()).map(([spaceId, v]) => ({ spaceId, ...v }));
}

function findBySpaceId(webContentsId) {
  for (const [spaceId, v] of entries.entries()) {
    if (v.webContentsId === webContentsId) return spaceId;
  }
  return null;
}

// Wire navigation listeners onto a webContents so title/url are kept current.
// Idempotent per-webContents via WeakSet; safe to call on every space-activity.
// A one-shot 'destroyed' listener drops the entry and removes the navigation
// listeners so a new wc for the same spaceId gets a fresh attach without the
// prior listeners firing update() against a dead wc on every navigate event.
function attach(webContents, spaceId) {
  if (!webContents || typeof webContents.on !== 'function' || !spaceId) return;
  try {
    setMeta(spaceId, { url: webContents.getURL ? webContents.getURL() : '', title: webContents.getTitle ? webContents.getTitle() : '' });
  } catch (_) { /* ignore pre-load access errors */ }
  if (attached.has(webContents)) return;
  attached.add(webContents);
  const update = () => {
    const sid = findBySpaceId(webContents.id);
    if (!sid) return;
    try { setMeta(sid, { url: webContents.getURL(), title: webContents.getTitle() }); }
    catch (_) { /* ignore */ }
  };
  webContents.on('did-navigate', update);
  webContents.on('did-navigate-in-page', update);
  webContents.on('page-title-updated', update);
  if (typeof webContents.once === 'function') {
    webContents.once('destroyed', () => {
      const sid = findBySpaceId(webContents.id);
      if (sid) remove(sid);
      try { webContents.removeListener('did-navigate', update); } catch (_) { /* ignore */ }
      try { webContents.removeListener('did-navigate-in-page', update); } catch (_) { /* ignore */ }
      try { webContents.removeListener('page-title-updated', update); } catch (_) { /* ignore */ }
    });
  }
}

function clear() { entries.clear(); sessionActive.clear(); }

/**
 * A session's read-only view: lookups skip private tabs and tabs tagged with a different
 * session; untagged tabs stay visible to every session. `session` is an id, null (sees untagged
 * tabs only) or a getter evaluated on each read.
 * @param {string|null|(() => string|null)} session
 */
function forSession(session) {
  const current = typeof session === 'function' ? session : () => session;
  const visible = (e) => !!e && !e.private && (!e.sessionId || e.sessionId === (current() || null));
  // A session with its own active tab sees that tab as the active one,
  // whichever tab the renderer is showing.
  const scoped = (spaceId, e) => {
    const sid = current() || null;
    const own = sid ? sessionActive.get(sid) : null;
    return own && entries.has(own) ? { ...e, isActive: spaceId === own } : e;
  };
  return {
    get(spaceId) { const e = get(spaceId); return visible(e) ? scoped(spaceId, e) : null; },
    list() { return list().filter(visible).map((e) => scoped(e.spaceId, e)); },
    findBySpaceId(webContentsId) { const sid = findBySpaceId(webContentsId); return sid && visible(entries.get(sid)) ? sid : null; },
    forSession,
  };
}

module.exports = { set, setMeta, get, remove, list, findBySpaceId, attach, clear, forSession, setSessionActive };
