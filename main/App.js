const { app, globalShortcut } = require('electron');
const configService = require('./services/ConfigService');
const adblockerService = require('./services/AdblockerService');
const certService = require('./services/CertificateService');
const shortcutService = require('./services/ShortcutService'); const memoryService = require('./services/MemoryService');
const trayService = require('./services/TrayService'); const menuService = require('./services/MenuService');
const httpAllowlistService = require('./services/HttpAllowlistService');
const llmService = require('./services/LLMService');
const modelManagerService = require('./services/ModelManagerService'); const engineDiscoveryService = require('./services/EngineDiscoveryService');
const permissionService = require('./services/PermissionService');
const agentService = require('./services/AgentService'); const agentTabOps = require('./services/AgentTabOpsService');
const approvalService = require('./services/AgentApprovalService'); const skillsService = require('./services/SkillsService'); const routineService = require('./services/RoutineService');
const personaService = require('./services/PersonaService'); const personaRouter = require('./services/PersonaRouterService'); const userMemoryService = require('./services/UserMemoryService'); const voiceService = require('./services/VoiceService'); const mcpService = require('./services/McpService'); const projectService = require('./services/ProjectService');
const sessionService = require('./services/SessionService'); const historyService = require('./services/HistoryService'); const dnsService = require('./services/DnsService'); const agentHistoryService = require('./services/AgentHistoryService'); const agentWorkspaceService = require('./services/AgentWorkspaceService');
const bookmarkService = require('./services/BookmarkService'); const downloadService = require('./services/DownloadService'); const extensionService = require('./services/ExtensionService'); const notificationService = require('./services/NotificationService'); const permissionPromptService = require('./services/PermissionPromptService'); const badgeService = require('./services/BadgeService');
const { registerAll } = require('./ipc');

class App {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.spaceStates = new Map();
    this.errorHandler = null;
    this.recoveryMode = null;
    this.isAppQuitting = false;
  }

  initialize(mainWindow, { errorHandler, recoveryMode } = /** @type {{ errorHandler?: typeof import('./utils/errorHandler'), recoveryMode?: any }} */ ({})) {
    // mainWindow updates even on a re-init — index.js's macOS activate-after-window-loss path hands back a fresh BrowserWindow. Everything else below registers process-global state; running it twice throws "Attempted to register a second handler" and stacks the tray + every per-service listener (pinned in App.test.js 'initialize idempotency'). _initialized is set only when wiring completes, so an interrupted init stays retryable rather than permanently skipped.
    this.mainWindow = mainWindow; if (!this._initialized) { this.errorHandler = errorHandler; this.recoveryMode = recoveryMode; } else return this.tray;

    try { const lg = /** @type {any} */ (require('./utils/logger')); if (lg.setLevel) lg.setLevel(configService.get('settings.logLevel', 'info')); } catch (_) { /* ignore */ }
    for (const n of ['HistoryService', 'DownloadService', 'ScreenshotService', 'MemoryService', 'LLMClientService']) { try { require(`./services/${n}`).bindConfig(configService); } catch (_) { /* ignore */ } }

    certService.initialize();
    permissionPromptService.initialize({ permissionService });
    permissionService.initialize(configService, { promptService: permissionPromptService });
    const browsingPrivacy = require('./services/BrowsingPrivacyService'); browsingPrivacy.initialize(configService); sessionService.initialize({ adblockerService, permissionService, browsingPrivacy, downloadService });
    dnsService.bindConfig(configService); dnsService.applyFromConfig();
    historyService.load(); bookmarkService.load(); downloadService.load();
    extensionService.initialize(configService); notificationService.initialize(configService);
    badgeService.initialize(mainWindow, { notificationService });
    try { const { session } = require('electron'); if (session && session.defaultSession) downloadService.attachToSession(session.defaultSession); } catch (err) { console.error('App: download attach failed:', (err instanceof Error && err.message) || err); }
    this.tray = trayService.createTray();
    menuService.initialize(mainWindow, trayService, shortcutService);
    shortcutService.initialize(mainWindow, () => menuService.buildAndSetMenus());
    memoryService.start(mainWindow);

    // Restore the remote endpoint ONLY when it was explicitly selected — settings.llm.remote persists past "Clear Remote" (which sets mode back to 'local' but keeps the saved URL/key for re-use), so an unconditional restore here would silently reactivate a paid API after every restart. mode is the local-vs-remote choice; activeBackend doubles as the local-engine picker and gets overwritten by any engine selection, so it cannot carry that decision alone.
    const llmCfg = configService.get('settings.llm', {}) || {};
    if ((llmCfg.mode === 'remote' || llmCfg.activeBackend === 'remote') && llmCfg.remote && llmCfg.remote.endpoint) { try { llmService.setRemoteEndpoint(llmCfg.remote.endpoint, llmCfg.remote.apiKey, llmCfg.remote.model, llmCfg.remote.visionCapable); } catch (err) { console.error('App: remote endpoint restore failed:', err instanceof Error ? err.message : err); } }
    try { modelManagerService.startWatching(configService.get('settings.llm.scanDirs', null)); } catch (err) { console.error('App: model watch failed:', (err instanceof Error && err.message) || err); }
    agentService._bindConfig(configService); userMemoryService.bindConfig(configService); voiceService.bindConfig(configService); mcpService.bindConfig(configService); projectService.bindConfig(configService); try { projectService.setScreenshotService(require('./services/ScreenshotService')); projectService.setTabRegistry(require('./services/tabRegistry')); } catch (err) { console.error('App: project wiring failed:', (err instanceof Error && err.message) || err); } if (mcpService.isAvailable()) agentService.bindMcp(mcpService);
    try {
      const { ipcMain } = require('electron');
      agentTabOps.bind(mainWindow, ipcMain);
      approvalService.bind(mainWindow, ipcMain, configService);
      skillsService.bind({ agentService }); routineService.bind({ configService, agentService }); routineService.start(mainWindow);
      try { agentHistoryService.initialize({}); } catch (err) { console.error('App: agent history init failed:', (err instanceof Error && err.message) || err); }
      agentWorkspaceService.bindWindow(mainWindow); agentWorkspaceService.bindHistory(agentHistoryService); agentWorkspaceService.bindConfig(configService);
    } catch (err) { console.error('App: agent wiring failed:', (err instanceof Error && err.message) || err); }

    // Register all IPC handlers
    registerAll(mainWindow, {
      configService,
      adblockerService,
      certService,
      shortcutService,
      memoryService,
      trayService,
      menuService,
      errorHandler,
      httpAllowlistService,
      llmService,
      modelManagerService,
      engineDiscoveryService,
      permissionService,
      agentService,
      personaService,
      personaRouter,
      userMemoryService,
      voiceService,
      skillsService,
      sessionService,
      historyService,
      bookmarkService,
      downloadService,
      extensionService,
      notificationService,
      permissionPromptService,
      badgeService,
      dnsService,
      agentWorkspaceService, routineService, mcpService, projectService,
      spaceStates: this.spaceStates,
    });

    menuService.setupWebviewContextMenu();
    menuService.buildAndSetMenus();
    this._initialized = true; // last line on purpose: an error partway through leaves _initialized unset so the next attempt can retry cleanly instead of being permanently skipped.
    return this.tray;
  }

  setupLifecycleHandlers() {
    app.on('before-quit', () => {
      this.isAppQuitting = true;
      menuService.setAppQuitting(true);
      try { if (global.gc) global.gc(); } catch (error) { console.error('shutdown cleanup:', error); }
      configService.flushSync(); historyService.flushSync();
      try { agentService.flushOnQuit(); } catch (err) { console.error('App: flushOnQuit failed:', (err instanceof Error && err.message) || err); }
      if (this.errorHandler && this.errorHandler.close) this.errorHandler.close();
    });
    app.on('will-quit', () => {
      shortcutService.unregisterAll(); globalShortcut.unregisterAll(); memoryService.cleanup(); routineService.stop();
      try { llmService.stop({ silent: true }); modelManagerService.stopWatching(); mcpService.stopAll(); } catch (err) { console.error('will-quit service shutdown failed', (err instanceof Error && err.message) || err); }
    });
  }
}

module.exports = App;
