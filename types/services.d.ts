// The service container assembled in main/App.js and handed to
// main/ipc/index.js:registerAll(). Every IPC handler and every service that
// receives collaborators destructures a subset of it, so the shape lives here
// once rather than being re-described per file.
//
// Each service module exports a singleton instance, so the type of the
// container value is the type of the module export.

type AssistantSessionServices = ReturnType<typeof import('../main/agent/sessions/sessionServices').createSessionServices>;

declare global {
  interface ICServices {
    configService: typeof import('../main/services/ConfigService');
    adblockerService: typeof import('../main/services/AdblockerService');
    certService: typeof import('../main/services/CertificateService');
    shortcutService: typeof import('../main/services/ShortcutService');
    memoryService: typeof import('../main/services/MemoryService');
    trayService: typeof import('../main/services/TrayService');
    menuService: typeof import('../main/services/MenuService');
    errorHandler: typeof import('../main/utils/errorHandler');
    httpAllowlistService: typeof import('../main/services/HttpAllowlistService');
    llmService: typeof import('../main/services/LLMService');
    modelManagerService: typeof import('../main/services/ModelManagerService');
    engineDiscoveryService: typeof import('../main/services/EngineDiscoveryService');
    permissionService: typeof import('../main/services/PermissionService');
    agentService: typeof import('../main/services/AgentService');
    personaService: typeof import('../main/services/PersonaService');
    personaRouter: typeof import('../main/services/PersonaRouterService');
    userMemoryService: typeof import('../main/services/UserMemoryService');
    voiceService: typeof import('../main/services/VoiceService');
    skillsService: typeof import('../main/services/SkillsService');
    sessionService: typeof import('../main/services/SessionService');
    historyService: typeof import('../main/services/HistoryService');
    bookmarkService: typeof import('../main/services/BookmarkService');
    downloadService: typeof import('../main/services/DownloadService');
    extensionService: typeof import('../main/services/ExtensionService');
    notificationService: typeof import('../main/services/NotificationService');
    permissionPromptService: typeof import('../main/services/PermissionPromptService');
    badgeService: typeof import('../main/services/BadgeService');
    dnsService: typeof import('../main/services/DnsService');
    agentWorkspaceService: typeof import('../main/services/AgentWorkspaceService');
    routineService: typeof import('../main/services/RoutineService');
    mcpService: typeof import('../main/services/McpService');
    projectService: typeof import('../main/services/ProjectService');
    agentHistoryService: typeof import('../main/services/AgentHistoryService');
    agentTabOps: typeof import('../main/services/AgentTabOpsService');
    approvalService: typeof import('../main/services/AgentApprovalService');
    promptService: typeof import('../main/services/PermissionPromptService');
    // Attached by main/ipc/assistantHandlers.js:attachSessionServices before
    // any handler registers; absent when the agent service failed to load.
    sessionStore?: AssistantSessionServices['sessionStore'];
    sessionManager?: AssistantSessionServices['sessionManager'];
    llmGate?: AssistantSessionServices['llmGate'];
    checkpointStore?: AssistantSessionServices['checkpointStore'];
    inboxService?: typeof import('../main/services/InboxService');
    recoveryMode: boolean;
    spaceStates: Record<string, unknown>;
  }
}

export {};
