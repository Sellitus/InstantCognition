// Lightweight spaces editor backing channels for the v2 settings UI.
const { ipcMain } = require('electron');

function broadcast(mw, payload) {
  if (mw && typeof mw.isDestroyed === 'function' && !mw.isDestroyed()) {
    try { mw.webContents.send('config:changed', payload); } catch (_) {}
  }
}

function register(mainWindow, services) {
  const { configService } = services || {};

  ipcMain.on('spaces:add', (_e, payload) => {
    if (!configService || !payload || typeof payload !== 'object') return;
    const id = `custom${Date.now()}`;
    const entry = { name: String(payload.name || 'New space'), url: String(payload.url || ''), type: payload.type || 'web-page' };
    configService.set(`spaces.${id}`, entry);
    broadcast(mainWindow, { kind: 'set', path: `spaces.${id}`, newValue: entry });
  });

  ipcMain.on('spaces:remove', (_e, id) => {
    if (!configService || !id) return;
    const all = configService.get('spaces') || {};
    if (!all[id]) return;
    const next = { ...all }; delete next[id];
    configService.set('spaces', next);
    // A removed library entry can still be open as a tab. Strip it from the
    // persisted tab model so the id can't linger (or resurrect on boot), and
    // re-point focus if the removed space was current. The renderer tears down
    // the mounted webview when it mirrors this change on the broadcast below.
    _removeIdFromTabModel(configService, id);
    broadcast(mainWindow, { kind: 'set', path: 'spaces', newValue: next });
  });

  // Drop `id` from the persisted tab arrays in a single `state` write (one
  // change emit, one broadcast) and re-point currentSpaceId if it was current.
  // No-op when the id is absent from the tab model, so removing an
  // un-opened space never touches state.
  function _removeIdFromTabModel(cs, id) {
    const state = cs.get('state') || {};
    const nextState = { ...state };
    let changed = false;
    // activeSpaces is the legacy fallback the renderer reads when openTabs is
    // missing — strip it too so the id can't survive via that path.
    for (const key of ['openTabs', 'hiddenTabs', 'pinnedTabs', 'activeSpaces']) {
      if (!Array.isArray(state[key])) continue;
      const next = state[key].filter((x) => x !== id);
      if (next.length !== state[key].length) {
        nextState[key] = next;
        changed = true;
      }
    }
    if (state.currentSpaceId === id) {
      // Focus the first surviving open tab; '' (boot re-validates against
      // openTabs) when none survive.
      const remaining = (Array.isArray(state.openTabs) ? state.openTabs : []).filter((x) => x !== id);
      nextState.currentSpaceId = remaining[0] || '';
      changed = true;
    }
    if (changed) cs.set('state', nextState);
  }

  ipcMain.on('spaces:reset', () => {
    if (!configService) return;
    try {
      const { DEFAULT_CONFIG } = require('../../shared/configDefaults');
      const fresh = JSON.parse(JSON.stringify(DEFAULT_CONFIG.spaces));
      configService.set('spaces', fresh);
      broadcast(mainWindow, { kind: 'set', path: 'spaces', newValue: fresh });
    } catch (_) {}
  });
}

module.exports = { register };
