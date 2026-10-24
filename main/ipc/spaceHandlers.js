const { ipcMain, webContents: WebContents } = require('electron');
const tabRegistry = require('../services/tabRegistry');
const { safeSend } = require('../utils/safeSend');

function register(mainWindow, { spaceStates, configService, sessionService }) {
  let lastSpaceSwitch = 0;

  const spaceName = (spaceId) => {
    if (!configService) return '';
    const s = configService.get(`spaces.${spaceId}`, null) || configService.get(`state.adHocSpaces.${spaceId}`, null);
    return (s && s.name) || '';
  };

  // Background throttling is deliberately NOT managed here. Chromium already
  // throttles a display:none guest through its own page-visibility path, and
  // calling setBackgroundThrottling on an already-hidden widget desyncs
  // Chromium's visibility state badly enough that the FrameEvictor blanks the
  // pane minutes later — see the HAZARD note in services/visibilityThrottling.js.
  ipcMain.on('space-activity', (_event, { spaceId, isActive, webContentsId, kind, sessionId }) => {
    const wc = webContentsId ? WebContents.fromId(webContentsId) : null;
    const state = spaceStates.get(spaceId) || {};

    if (webContentsId != null) {
      tabRegistry.set(spaceId, webContentsId, isActive);
      // kind: 'agent' for tabs owned by AgentWorkspaceManager, 'user' for the
      // normal tab area. Scopes agent tools so they never act on user tabs.
      tabRegistry.setMeta(spaceId, { name: spaceName(spaceId), kind: kind || 'user', private: !!(wc && sessionService && sessionService.isPrivateContents(wc)) });
      // The opening session, echoed by the renderer so the tab is never briefly untagged.
      if (kind === 'agent' && typeof sessionId === 'string' && sessionId) tabRegistry.setMeta(spaceId, { sessionId });
      if (wc) tabRegistry.attach(wc, spaceId);
    }

    spaceStates.set(spaceId, { ...state, isActive: !!isActive });
  });

  ipcMain.on('space-closed', (_, { spaceId }) => {
    spaceStates.delete(spaceId);
    tabRegistry.remove(spaceId);
  });

  ipcMain.on('select-previous-space', () => {
    safeSend(mainWindow, 'select-previous-space');
  });

  ipcMain.on('select-next-space', () => {
    safeSend(mainWindow, 'select-next-space');
  });

  ipcMain.on('switch-space', (_, index) => {
    const now = Date.now();
    if (now - lastSpaceSwitch < 100) return;
    lastSpaceSwitch = now;

    const spaceId = index === 0 ? 'custom10' : `custom${index}`;
    safeSend(mainWindow, 'selectSpace', spaceId);
  });
}

module.exports = { register };
