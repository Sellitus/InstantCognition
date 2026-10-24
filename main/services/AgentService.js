// AgentService — lifecycle + IPC + event surface around AgentRuntime.
const llmClient = require('./LLMClientService');
const llmService = require('./LLMService');
const screenshotService = require('./ScreenshotService');
const tabRegistry = require('./tabRegistry');
const tabOps = require('./AgentTabOpsService');
const qualityModeService = require('./QualityModeService');
const personaService = require('./PersonaService');
const personaRouter = require('./PersonaRouterService');
const approvalService = require('./AgentApprovalService');
const { createRegistry } = require('../agent/toolRegistry');
const { AgentRuntime } = require('../agent/AgentRuntime');
const browserTools = require('../agent/tools/browser');
const cdpTools = require('../agent/tools/cdpTools');
const tabsTools = require('../agent/tools/tabsTools');
const advancedTools = require('../agent/tools/advancedTools');
const agentCoreTools = require('../agent/tools/agentCore');
const cognitizerTools = require('../agent/tools/cognitizers');
const historyTools = require('../agent/tools/historyTool'); const searchTools = require('../agent/tools/searchTool'); const askBrowsingTools = require('../agent/tools/askBrowsingTool'); const researchReportTools = require('../agent/tools/researchReport'); const projectTools = require('../agent/tools/projectTools'); const fsTools = require('../agent/tools/fsTools'); const shellTools = require('../agent/tools/shellTools'); const planTools = require('../agent/tools/planTools');
const { bindAgentConfig } = require('../agent/agentConfigBindings');
const { bindMcpToAgent } = require('../agent/tools/mcpTools');
const { createStore: createConversationStore } = require('../agent/conversationStore');
const { AgentHost } = require('../agent/sessions/hostMixin');
const { runTurn } = require('../agent/sessions/runTurn');
const { gate } = require('../agent/sessions/llmGate');
const { registerArtifactTools } = require('../agent/tools/artifactTool');
const { registerSkillTools } = require('../agent/tools/skillTool');
const { registerSubagentTools } = require('../agent/tools/subagentTool');
const skillsService = require('./SkillsService');

// Run control (pause/resume/stop/reattach, step + budget bookkeeping) lives in
// AgentHost, shared with background SessionRuns; one turn's body is runTurn().
// Every LLM call goes through the process-wide gate so foreground and
// background runs share the engine's slots.
class AgentService extends AgentHost {
  // Field declarations: TS infers no shape from the constructor's Object.assign,
  // so every field read in a method must be declared here or it's TS2339.
  /** @type {any} */ _llm; _screenshots; _tabRegistry; _runtime; _getVisionConfig;
  /** @type {(() => string)|null} */ _getActiveModel; /** @type {(() => any)|null} */ _getAgentConfig;
  /** @type {((sessionId: string) => boolean)|null} */ _sessionBusy;
  /** @type {any} */ _configService; _tabOps; _qualityMode; _approval; _personaService; _personaRouter; _conversations; _conversation; _ledgerState; _sessionSink; _checkpointStore;
  constructor() {
    super();
    this._registry = createRegistry();
    this._registry.registerAll([...cdpTools, ...advancedTools, ...tabsTools, ...browserTools, ...agentCoreTools, ...planTools, ...cognitizerTools, ...historyTools, ...searchTools, ...askBrowsingTools, ...researchReportTools, ...projectTools, ...fsTools, ...shellTools]);
    registerArtifactTools(this._registry);
    registerSkillTools(this._registry, { skillsService });
    registerSubagentTools(this._registry);
    // _conversations: per-scope multi-turn store ('__global__' / 'tab:<id>'); _conversation: working pointer to the active scope during a task.
    Object.assign(this, {
      _running: false, _stopRequested: false, _task: null, _steps: [],
      _llm: gate.wrap(llmClient), _llmService: llmService, _screenshots: screenshotService,
      _tabRegistry: tabRegistry, _webContentsModule: null, _tabOps: tabOps,
      _getVisionConfig: null, _getActiveModel: null, _getAgentConfig: null,
      _qualityMode: qualityModeService, _approval: approvalService,
      _personaService: personaService, _personaRouter: personaRouter,
      _ledgerState: null, _currentLog: null, _paused: false,
      _resumePromise: null, _resumeResolver: null, _toolCtx: null,
      _conversations: createConversationStore(), _conversation: null,
      _sessionSink: null, _checkpointStore: null, _sessionBusy: null,
    });
    this._runtime = new AgentRuntime({ registry: this._registry, llm: this._llm });
  }

  resetConversation(opts) {
    // No args: clear EVERY conversation (global + every tab); with { scope, tabId }, only that thread.
    if (opts === undefined) this._conversations.clear();
    else this._conversations.clear(opts);
    this._conversation = null;
  }

  hasConversation(opts) {
    return this._conversations.has(opts || { scope: 'global' });
  }

  // Test hooks (only the ones the test suite actually uses).
  _setLLMClient(c) { this._llm = gate.wrap(c); this._runtime = new AgentRuntime({ registry: this._registry, llm: this._llm }); }
  _setWebContentsModule(m) { this._webContentsModule = m; }
  _setMaxSteps(n) { this._maxStepsOverride = n; }

  /** Session persistence for foreground runs: sink from sessionRecorder.createSessionSink, store from checkpointStore. */
  bindSessions({ sessionSink, checkpointStore }) { this._sessionSink = sessionSink || null; this._checkpointStore = checkpointStore || null; }

  _bindConfig(configService) { bindAgentConfig(this, configService); } bindMcp(mcpService) { if (this._mcpUnsub) { try { this._mcpUnsub(); } catch (err) { console.error('AgentService.bindMcp: prev unsub failed:', (err instanceof Error && err.message) || err); } } this._mcpUnsub = bindMcpToAgent(this._registry, mcpService || null); }

  /**
   * allowedTools: a skill's tool rules (skills:run); the run is narrowed to tools matching them.
   * instructions: system-side guidance for this turn only (a skill's body); never persisted.
   * @param {{ description?: string, webContentsId?: number, maxSteps?: number, qualitySkillOverride?: Record<string, any>|null, scope?: string, tabId?: string|number, priorTurns?: Array<{role: string, content: string}>|null, sessionId?: string|null, fromNodeId?: string|null, allowedTools?: string[]|null, instructions?: string }} task
   */
  async startTask(task) {
    if (this._running) throw new Error('Agent already running');
    if (!task || (!task.description && !task.fromNodeId)) throw new Error('description required');
    if (task.webContentsId == null) throw new Error('webContentsId required');
    if (task.sessionId && this._sessionBusy && this._sessionBusy(task.sessionId)) throw new Error('session_busy');
    const narrow = Array.isArray(task.allowedTools) ? skillsService.toolFilterFor({ tools: task.allowedTools }) : null;
    return runTurn(this, { ...task, toolFilter: narrow || undefined, source: 'agent' });
  }

  // Called from before-quit so a task in flight when the user quits gets a
  // clean task-end (no "processing" ghost in history).
  flushOnQuit() {
    try { if (this._currentLog && typeof this._currentLog.logTaskEnd === 'function') { this._currentLog.logTaskEnd({ ok: false, reason: 'app_quit' }); this._currentLog = null; } } catch (err) { console.error('[AgentService] quit flush failed:', (err instanceof Error && err.message) || err); }
  }
}

const instance = new AgentService();
module.exports = instance;
