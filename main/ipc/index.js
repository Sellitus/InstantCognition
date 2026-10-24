const configHandlers = require('./configHandlers');
const navigationHandlers = require('./navigationHandlers');
const spaceHandlers = require('./spaceHandlers');
const viewHandlers = require('./viewHandlers');
const windowHandlers = require('./windowHandlers');
const shortcutHandlers = require('./shortcutHandlers');
const settingsHandlers = require('./settingsHandlers');
const settingsV2Handlers = require('./settingsV2Handlers');
const spacesV2Handlers = require('./spacesV2Handlers');
const findHandlers = require('./findHandlers');
const llmHandlers = require('./llmHandlers');
const engineHandlers = require('./engineHandlers');
const modelScanHandlers = require('./modelScanHandlers');
const agentHandlers = require('./agentHandlers');
const sessionHandlers = require('./sessionHandlers');
const browserDataHandlers = require('./browserDataHandlers');
const extensionHandlers = require('./extensionHandlers');
const notificationHandlers = require('./notificationHandlers');
const badgeHandlers = require('./badgeHandlers');
const dnsHandlers = require('./dnsHandlers');
const adblockerHandlers = require('./adblockerHandlers');
const agentWorkspaceHandlers = require('./agentWorkspaceHandlers');
const personaHandlers = require('./personaHandlers');
const userMemoryHandlers = require('./userMemoryHandlers');
const voiceHandlers = require('./voiceHandlers');
const mcpHandlers = require('./mcpHandlers');
const siteBlockedHandlers = require('./siteBlockedHandlers');
const searchSuggestHandlers = require('./searchSuggestHandlers');
const chatHandlers = require('./chatHandlers');
const chatSearchHandlers = require('./chatSearchHandlers');
const routineHandlers = require('./routineHandlers');
const projectHandlers = require('./projectHandlers');
const updaterHandlers = require('./updaterHandlers');
const engineUpdateHandlers = require('./engineUpdateHandlers');
const vllmSetupHandlers = require('./vllmSetupHandlers');
const assistantHandlers = require('./assistantHandlers');
const pageHandlers = require('./pageHandlers');
const passwordHandlers = require('./passwordHandlers');
const shellHandlers = require('./shellHandlers');
const artifactFrameHandlers = require('./artifactFrameHandlers');

/**
 * Register all IPC handlers. The session layer is attached to `services` first
 * (App.js is at its line cap) — see assistantHandlers.attachSessionServices.
 * @param {Electron.BrowserWindow} mainWindow
 * @param {object} services - all service instances
 */
function registerAll(mainWindow, services) {
  assistantHandlers.attachSessionServices(services);
  configHandlers.register(mainWindow, services);
  navigationHandlers.register(mainWindow);
  spaceHandlers.register(mainWindow, services);
  viewHandlers.register(mainWindow);
  windowHandlers.register(mainWindow, services);
  shortcutHandlers.register(mainWindow, services);
  settingsHandlers.register(mainWindow, services);
  settingsV2Handlers.register(mainWindow, services);
  spacesV2Handlers.register(mainWindow, services);
  findHandlers.register(mainWindow);
  llmHandlers.register(mainWindow, services);
  engineHandlers.register(mainWindow, services);
  modelScanHandlers.register(mainWindow, services);
  agentHandlers.register(mainWindow, services);
  sessionHandlers.register(mainWindow, services);
  browserDataHandlers.register(mainWindow, services);
  extensionHandlers.register(mainWindow, services);
  notificationHandlers.register(mainWindow, services);
  badgeHandlers.register(mainWindow, services);
  dnsHandlers.register(mainWindow, services);
  adblockerHandlers.register(mainWindow, services);
  agentWorkspaceHandlers.register(mainWindow, services);
  personaHandlers.register(mainWindow, services);
  userMemoryHandlers.register(mainWindow, services);
  voiceHandlers.register(mainWindow, services);
  mcpHandlers.register(mainWindow, services);
  siteBlockedHandlers.register(mainWindow, services);
  searchSuggestHandlers.register(mainWindow, services);
  chatHandlers.register(mainWindow, services);
  chatSearchHandlers.register(mainWindow, services);
  routineHandlers.register(mainWindow, services);
  projectHandlers.register(mainWindow, services);
  updaterHandlers.register(mainWindow, services);
  engineUpdateHandlers.register(mainWindow, services);
  vllmSetupHandlers.register(mainWindow, services);
  assistantHandlers.register(mainWindow, services);
  pageHandlers.register(mainWindow);
  passwordHandlers.register(mainWindow, services);
  shellHandlers.register(mainWindow, services);
  artifactFrameHandlers.register();
}

module.exports = { registerAll };
