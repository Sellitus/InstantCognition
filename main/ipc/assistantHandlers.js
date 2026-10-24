// Assistant platform IPC group: sessions, runs, permissions, checkpoints,
// artifacts, skills, the inbox and the recorder. Registered from index.js as
// one unit so the assistant surface can grow without pushing index.js past its
// line cap.
const agentPermissionHandlers = require('./agentPermissionHandlers');
const checkpointHandlers = require('./checkpointHandlers');
const artifactHandlers = require('./artifactHandlers');
const skillHandlers = require('./skillHandlers');
const agentSessionHandlers = require('./agentSessionHandlers');
const agentRunHandlers = require('./agentRunHandlers');
const launcherHandlers = require('./launcherHandlers');
const inboxHandlers = require('./inboxHandlers');
const recorderHandlers = require('./recorderHandlers');
const workspaceSearchHandlers = require('./workspaceSearchHandlers');
const { getSessionServices } = require('../agent/sessions/sessionServices');

/**
 * Attach the session layer to `services` (services.sessionStore,
 * services.sessionManager, services.llmGate, services.checkpointStore — see
 * agent/sessions/sessionServices). Must run before any handler that reads them.
 * @param {object} services
 */
function attachSessionServices(services) {
  if (!services.agentService) return;
  const sessions = getSessionServices(services);
  Object.assign(services, {
    sessionStore: sessions.sessionStore,
    sessionManager: sessions.sessionManager,
    llmGate: sessions.llmGate,
    checkpointStore: sessions.checkpointStore,
  });
  attachBackgroundWork(services, sessions.sessionManager);
  sessions.startMaintenance({ history: require('../services/AgentHistoryService') });
}

/**
 * Background work wiring: the inbox ({userData}/inbox.json) receives finished
 * background runs, agent.spawn_subagent resolves the manager, and routines
 * start as background sessions (services.inboxService is attached here).
 * @param {any} services
 * @param {any} manager
 */
function attachBackgroundWork(services, manager) {
  const path = require('path');
  const inbox = require('../services/InboxService');
  inbox.configure({ filePath: path.join(require('electron').app.getPath('userData'), 'inbox.json') });
  services.inboxService = inbox;
  manager.bindInbox(inbox);
  const cfg = services.configService;
  manager.setSubagentSettings(() => (cfg ? cfg.get('settings.llm.agent.subagents', {}) : {}));
  require('../agent/tools/subagentTool').bindSubagentManager(manager);
  if (services.routineService) services.routineService.bind({ sessionManager: manager, inboxService: inbox });
}

/**
 * @param {Electron.BrowserWindow} mainWindow
 * @param {object} services
 */
function register(mainWindow, services) {
  agentPermissionHandlers.register(mainWindow, services);
  workspaceSearchHandlers.register(mainWindow, services);
  checkpointHandlers.register(mainWindow, services);
  artifactHandlers.register(mainWindow, services);
  skillHandlers.register(mainWindow, services);
  agentSessionHandlers.register(mainWindow, services);
  agentRunHandlers.register(mainWindow, services);
  launcherHandlers.register(mainWindow, services);
  inboxHandlers.register(mainWindow, services);
  recorderHandlers.register(mainWindow, services);
}

module.exports = { register, attachSessionServices };
