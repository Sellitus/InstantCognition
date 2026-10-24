// runTurn — one agent turn on a host. A host is the foreground AgentService
// or a background SessionRun; both extend AgentHost and carry the same
// collaborator fields (_runtime, _registry, _approval, _conversations, …), so
// one body serves both.
//
// Session persistence: when the host has a session sink (_sessionSink), the
// turn is recorded into the session store — user node, one tool_calls +
// tool_results pair per acted step, and the outcome. A host without a sink
// (unit tests of the bare service) keeps the in-memory conversation only.
//
// Conversation memory: the in-memory conversation for the scope is reused
// only while it still mirrors the session head; after a branch switch, edit,
// regenerate or restart the context is rebuilt from the session path.
//
// Plan mode (permission mode 'plan' for the session): tools that are not
// planSafe are left out of the tool list here AND denied by the permission
// engine (allowedTools), so a call the model invents anyway is refused twice.

const userMemoryService = require('../../services/UserMemoryService');
const projectService = require('../../services/ProjectService');
const { errMsg } = require('../../../shared/errMsg');
const ledgerModule = require('../ledger');
const { buildInitialObservation } = require('../agentProtocol');
const { buildReadableScript } = require('../readableExtractor');
const { createWriter } = require('../actionLog');
const { buildInterceptors } = require('../interceptors');
const { buildOpeningMessages } = require('../openingMessages');
const { wrapInterceptors, logBaseDir } = require('../lifecycleHooks');
const { keyFor: convoKeyFor } = require('../conversationStore');
const { classify } = require('../permissions/toolCatalog');
const { toAgentMessages, compactionRecap, countTokens } = require('./contextProjection');
const { compactionSettings } = require('../AgentRuntime');
const { resolveProfile, shouldStreamSteps, runtimeModeFor } = require('../harness/profiles');
const { loadInstructions, formatInstructionsBlock } = require('../workspace/instructions');
const { readAgentSettings } = require('../workspace/agentSettings');
const { readSkillSettings } = require('../skills/skillMatcher');
const { normalizeSubagentSettings } = require('./subagentRunner');
const { PRIVATE_TAB_REFUSAL } = require('./hostMixin');

const PLAN_NOTE = 'PLAN MODE: research only. File edits, shell commands, typing and form submission are unavailable until the user approves a plan. '
  + 'Investigate with the read-only tools, track the steps with agent.todo_write, then call agent.exit_plan {summary, todos} to propose the plan.';
const DETACHED_OBSERVATION = 'No browser tab is attached to this run. Use the workspace, search and tab tools; open a tab with browser.open_tab if a page is needed.';

// spawn / shell false (subagents or the shell switched off in settings) take
// those tools off the list, so the model is never offered a tool that refuses.
function buildToolFilter(planMode, userFilter, { spawn = true, shell = true } = {}) {
  return (name, tool) => {
    if (name === 'agent.exit_plan' && !planMode) return false;
    if (name === 'agent.spawn_subagent' && !spawn) return false;
    if (name === 'shell.run' && !shell) return false;
    if (planMode && !classify(name).planSafe) return false;
    return !userFilter || !!userFilter(name, tool);
  };
}

const isUserAsk = (m) => m.role === 'user' && !(typeof m.content === 'string' && m.content.startsWith('Results:\n'));

// Replayed history trimmed to budgetTokens by dropping the oldest whole turns.
// A cut lands only on a user ask, so no tool result or "Results:" message loses
// the assistant call it answers. The compaction recap rides in the system
// prompt, so no cut can drop it.
function fitHistory(history, budgetTokens) {
  if (countTokens(history) <= budgetTokens) return history;
  for (let i = 1; i < history.length; i++) {
    if (isUserAsk(history[i]) && countTokens(history.slice(i)) <= budgetTokens) return history.slice(i);
  }
  return [];
}

function withRecap(system, recap) {
  return recap ? { ...system, content: `${system.content}\n\n${recap}` } : system;
}

// Persistence must not abort a run that is already acting on the world, but
// a failed write is never silent: it is logged and surfaced as an event.
function persist(host, sessionId, fn) {
  try { return fn(); } catch (err) {
    console.error('[runTurn] session persist failed:', errMsg(err));
    host.emit('persist-failed', { sessionId, error: errMsg(err) });
    return null;
  }
}

// The session's workspace root, else the first configured root (the one the
// fs tools default to).
function workspaceRootFor(host, rec) {
  const meta = rec ? rec.meta() : null;
  if (meta && typeof meta.workspaceRoot === 'string' && meta.workspaceRoot) return meta.workspaceRoot;
  const roots = readAgentSettings(host._configService).workspace.roots;
  return roots.length ? roots[0] : null;
}

// Instruction files and the enabled-skills index for the opening prompt.
// Skipped instruction files (escaping symlinks, non-files) are reported, not
// read. With skills.autoTrigger off the index is left out (a picked skill
// still runs through skills:run); otherwise `matched` names the skills that
// fit this request. An unbound SkillsService (bare-service tests, early
// startup) means no skills; any other skills failure reaches the caller.
function openingContext(host, rec, agentCfg, requestText) {
  const userDataDir = host._userDataDir || require('electron').app.getPath('userData');
  const loaded = loadInstructions({ agentSettings: agentCfg, workspaceRoot: workspaceRootFor(host, rec), userDataDir });
  for (const s of loaded.skipped) console.warn(`[runTurn] instruction file ${s.name} skipped: ${s.reason}`);
  const instructionsBlock = formatInstructionsBlock(loaded);
  if (!readSkillSettings(host._configService).autoTrigger) return { instructionsBlock, skills: [], matched: [] };
  const skillsService = host._skillsService || require('../../services/SkillsService');
  try {
    const skills = (skillsService.list().skills || []).filter((sk) => sk.enabled);
    return { instructionsBlock, skills, matched: skillsService.match(requestText).map((m) => m.name) };
  } catch (err) {
    if (errMsg(err) !== 'skills_not_bound') throw err;
    return { instructionsBlock, skills: [], matched: [] };
  }
}

function openRecorder(host, task, existing) {
  const wanted = task.sessionId || (existing && existing.sessionId) || null;
  if (!host._sessionSink) {
    if (task.sessionId) throw new Error('sessions_unavailable');
    return null;
  }
  return host._sessionSink.open({ sessionId: wanted, source: task.source || 'agent' });
}

/**
 * @param {any} host AgentHost subclass
 * @param {{ description?: string, webContentsId?: number|null, maxSteps?: number, qualitySkillOverride?: any, scope?: string, tabId?: string|number,
 *   priorTurns?: Array<{role: string, content: string}>|null, sessionId?: string|null, fromNodeId?: string|null, source?: string,
 *   toolFilter?: (name: string, tool: any) => boolean, instructions?: string }} task
 *   instructions: extra guidance for this turn (a skill's body), sent on the turn's task message
 *   so later turns of the thread still see it; it never reaches the persisted user node, which holds `description`.
 */
async function runTurn(host, task) {
  const { webContentsId, maxSteps, qualitySkillOverride, scope, tabId, priorTurns } = task;
  if (host._running) throw new Error('Agent already running');
  if (!task.description && !task.fromNodeId) throw new Error('description required');
  const detached = webContentsId == null;
  if (detached && !host._allowDetached) throw new Error('webContentsId required');
  const wc = detached ? null : host._resolveWebContents(webContentsId);
  if (!detached && !wc) throw new Error(`webContents not found: ${webContentsId}`);
  if (wc && host._isPrivateTab(wc)) throw new Error(PRIVATE_TAB_REFUSAL);
  const normScope = scope === 'tab' ? 'tab' : 'global';
  const normTabId = normScope === 'tab' && tabId ? String(tabId) : null;
  const convoKey = convoKeyFor({ scope: normScope, tabId: normTabId });
  const rec = openRecorder(host, task, host._conversations.get(convoKey));
  const sessionId = rec ? rec.sessionId : null;
  // fromNodeId re-runs an existing user message (edit / regenerate): its text is the task.
  const fromNode = rec && task.fromNodeId ? host._sessionSink.store.getPath(sessionId, task.fromNodeId).pop() : null;
  if (task.fromNodeId && (!fromNode || fromNode.role !== 'user')) throw new Error('not_a_user_message');
  const description = fromNode ? fromNode.content : String(task.description);
  host._running = true; host._stopRequested = false; host._abort = new AbortController(); host._sessionId = sessionId;
  // setup-phase throws must reach the finally below (or _running leaks and deadlocks every later run); hoisted vars let the catch roll back even when setup throws early.
  let taskId = null, rollbackLen = 0, convoTouched = false;
  try {
    host._task = { description, webContentsId: detached ? null : webContentsId, scope: normScope, tabId: normTabId, sessionId };
    host._steps = []; host._ledgerState = ledgerModule.init({ task: description }); host._paused = false;
    const personaRoute = await host._personaRouter.route(description);
    const persona = host._personaService.resolve(personaRoute.name);
    const qualityMode = host._personaService.mergeQuality(host._qualityMode.resolve(qualitySkillOverride || null), persona);
    if (persona && Array.isArray(persona.starterTabs) && persona.starterTabs.length) { try { require('../../services/AgentWorkspaceService').seedStarterTabs(persona.starterTabs); } catch (err) { console.error('[runTurn] seedStarterTabs failed:', errMsg(err)); } }
    const agentCfg = typeof host._getAgentConfig === 'function' ? host._getAgentConfig() : {};
    const budget = { ...(qualityMode.budget || {}) };
    const ceiling = maxSteps || host._maxStepsOverride || budget.maxSteps || agentCfg.maxSteps || 12;
    const visionOn = host._visionEnabled() || qualityMode.vision === 'forced';
    const modelName = typeof host._getActiveModel === 'function' ? host._getActiveModel() : '';
    const endpoint = host._llmService && typeof host._llmService.getEndpoint === 'function' ? host._llmService.getEndpoint() : '';
    const permissionMode = host._approval && typeof host._approval.getMode === 'function' ? host._approval.getMode(sessionId || undefined) : null;
    const planMode = permissionMode === 'plan';
    const subagentCfg = normalizeSubagentSettings(host._configService ? host._configService.get('settings.llm.agent.subagents', {}) : {});
    const toolFilter = buildToolFilter(planMode, typeof task.toolFilter === 'function' ? task.toolFilter : null,
      { spawn: subagentCfg.enabled && subagentCfg.maxDepth >= 1, shell: readAgentSettings(host._configService).shell.enabled });
    const toolCtx = {
      defaultWebContents: wc,
      resolveWc: (sid) => { const entry = host._tabRegistry.get ? host._tabRegistry.get(sid) : null; return entry && entry.webContentsId != null ? host._resolveWebContents(entry.webContentsId) : null; },
      tabRegistry: host._tabRegistry, screenshots: host._screenshots, tabOps: host._tabOps, qualityMode, ledger: host._ledgerState,
      sessionId, permissionMode, turnNodeId: null, checkpoints: null,
    };
    host._toolCtx = toolCtx;
    host._watchTab(wc);

    // Tool format: explicit agent.mode wins; a remote only drops to text-JSON when its toolMode says so ('json' is the opt-out for vLLM/proxies whose models lack a tool-call template), otherwise it negotiates like local. One settings.llm read serves both tool-mode and the ctx-size AgentRuntime compacts at (0.8× ctxSize).
    const isRemote = !!(host._llmService && host._llmService.getStatus && host._llmService.getStatus().isRemote), llmSettings = (host._configService && host._configService.get('settings.llm', {})) || {};
    const explicitMode = agentCfg.mode && agentCfg.mode !== 'auto' ? agentCfg.mode : null;
    const ctxBackend = llmSettings.activeBackend || 'llamaCpp', ctxCfg = llmSettings[ctxBackend] || {}, contextSize = (ctxBackend === 'llamaCpp' ? ctxCfg.contextSize : ctxBackend === 'vllm' ? ctxCfg.maxModelLen : ctxCfg.contextLength) || 65536;
    const remoteToolMode = (llmSettings.remote && llmSettings.remote.toolMode) || 'native';
    // Harness profile (model family or a user glob): tool format below the explicit settings, plus system-role style, temperature and step streaming.
    const profile = resolveProfile(modelName, endpoint, agentCfg.harness && agentCfg.harness.profiles);
    const forceMode = explicitMode || (isRemote && remoteToolMode === 'json' ? 'json' : null) || runtimeModeFor(profile);
    const invCtx = { endpoint, modelName, visionEnabled: visionOn, contextSize, toolTimeoutMs: agentCfg.toolTimeoutMs || 15000, forceMode, maxSteps: ceiling, qualityMode, signal: host._abort.signal, llmTimeoutMs: host._configService ? host._configService.get('settings.llmClientTimeoutMs') : undefined, toolFilter,
      harnessProfile: profile.name, systemStyle: profile.systemStyle, compaction: agentCfg.compaction, streamSteps: shouldStreamSteps(agentCfg.streamSteps, profile), ...(profile.temperature !== null ? { temperature: profile.temperature } : {}) };

    // Initial observation scopes to agent-workspace tabs only; user tabs live in a separate view, unreachable by tools.
    const listTabs = host._tabRegistry.list ? host._tabRegistry.list().filter((t) => t.webContentsId != null && (t.kind || 'user') === 'agent') : [];
    const initial = wc ? await buildInitialObservation(listTabs, wc, buildReadableScript) : DETACHED_OBSERVATION;
    const context = openingContext(host, rec, agentCfg, description);
    const useSkill = host._registry.get('agent.use_skill');
    const skillNote = context.matched.length && useSkill && toolFilter('agent.use_skill', useSkill)
      ? `Skills matching this request: ${context.matched.join(', ')}. Load the best fit with agent.use_skill before acting.` : '';
    const taskText = [description, planMode ? PLAN_NOTE : '', skillNote].filter(Boolean).join('\n\n');
    const turnInstructions = typeof task.instructions === 'string' ? task.instructions.trim() : '';
    // The system prompt is rebuilt each turn, so the turn's guidance rides on its task message.
    const newTaskMessage = () => ({ role: 'user', content: [`New task: ${taskText}`, turnInstructions, initial].filter(Boolean).join('\n\n') });
    // Rebuilt every turn from current settings so instruction files, skills, memory and persona edits reach a
    // continuing thread. Nothing request-specific goes in the system prompt: an unchanged one keeps the server's prefix cache.
    const openingArgs = {
      registry: { list: () => host._registry.list(toolFilter) }, description: taskText, initial, visionOn, qualityMode, persona,
      userMemoryBlock: userMemoryService.isEnabled() ? userMemoryService.buildPromptBlock() : '', projectBlock: projectService.buildActiveBlock(), skills: context.skills,
    };

    const existing = host._conversations.get(convoKey);
    const prior = rec ? (fromNode ? host._sessionSink.store.getPath(sessionId, fromNode.id).slice(0, -1) : rec.priorPath()) : [];
    const mirrorsSession = !rec || (existing && existing.sessionId === sessionId && existing.headId === (prior.length ? prior[prior.length - 1].id : null));
    host._conversation = mirrorsSession ? existing : null;
    const isFollowUp = !!(host._conversation && Array.isArray(host._conversation.messages) && host._conversation.messages.length);
    let messages;
    if (isFollowUp) {
      messages = host._conversation.messages;
      if (messages[0].role === 'system') messages[0] = withRecap(buildOpeningMessages({ ...openingArgs, instructionsBlock: context.instructionsBlock })[0], host._conversation.recap);
      messages.push(newTaskMessage());
    } else {
      // A session with history replays it (tool calls included); priorTurns
      // (the panel's chat-lane thread) seeds only a session with none.
      const replay = prior.length ? toAgentMessages(prior, { mode: forceMode || host._runtime._modeCache.get(`${endpoint}::${modelName}`) || 'json' }) : [];
      const recap = prior.length ? compactionRecap(prior) : '';
      const opening = buildOpeningMessages({ ...openingArgs, description: [taskText, turnInstructions].filter(Boolean).join('\n\n'),
        priorTurns: replay.length ? null : priorTurns, instructionsBlock: context.instructionsBlock });
      opening[0] = withRecap(opening[0], recap);
      // The replay gets what the compaction threshold leaves after the system prompt and the new task.
      const replayBudget = contextSize * compactionSettings(agentCfg.compaction).threshold - countTokens([opening[0], newTaskMessage()]);
      const history = replay.length ? fitHistory(replay, replayBudget) : [];
      messages = history.length ? [opening[0], ...history, newTaskMessage()] : opening;
      host._conversation = { messages, sessionId, recap };
      host._conversations.set(convoKey, host._conversation);
    }
    // Pre-"New task:" push length of the active thread: a zero-step failure truncates back to it
    // (earlier turns survive the retry) instead of clearing the whole conversation. 0 = fresh thread.
    rollbackLen = isFollowUp ? messages.length - 1 : 0;
    convoTouched = true;

    if (rec) {
      const userNode = rec.user(description, planMode ? { permissionMode } : undefined, fromNode ? fromNode.id : undefined);
      toolCtx.turnNodeId = userNode.id;
      if (host._checkpointStore) toolCtx.checkpoints = host._checkpointStore.forTurn({ sessionId, turnId: userNode.id });
    }

    taskId = `task_${Date.now()}`;
    host._currentLog = createWriter({ taskId, baseDir: logBaseDir() });
    host._currentLog.logTaskStart({ description, mode: qualityMode, budget, webContentsId, scope: normScope, tabId: normTabId, persona: persona.name, routerSource: personaRoute.source });
    host.emit('task-started', { task: host._task, taskId, mode: qualityMode.name, budget, isFollowUp, scope: normScope, tabId: normTabId, persona: persona.name, personaLabel: persona.label, routerSource: personaRoute.source, sessionId, turnNodeId: toolCtx.turnNodeId, permissionMode });
    const emit = (channel, payload) => {
      if (rec && channel === 'step-acted') persist(host, sessionId, () => rec.step(payload));
      host._onRuntimeEvent(channel, payload);
    };
    const interceptors = wrapInterceptors({
      base: buildInterceptors({
        budget, qualityMode,
        approval: host._approval,
        log: host._currentLog,
        getUrl: () => host._currentUrl(),
        getUrlFor: (call) => host._urlForCall(call),
        getPaused: () => host._paused,
        getResumePromise: () => host._resumePromise,
        signal: host._abort.signal,
        recordBudget: (reason, usage, b) => host._recordBudget(reason, usage, b),
        llm: host._llm,
        task: host._task && host._task.description,
        sessionId: sessionId || undefined,
        allowedTools: (name) => toolFilter(name, host._registry.get(name)),
      }),
      service: host,
    });
    const result = await host._runtime.run({
      task: description, messages, toolCtx, invCtx,
      maxSteps: ceiling,
      shouldStop: () => host._stopRequested,
      emit,
      interceptors,
    });
    if (result && result.ok && result.summary) host._currentLog.logResponseBegin({ summary: result.summary });
    host._currentLog.logTaskEnd({ ok: !!(result && result.ok), summary: result && result.summary, reason: result && result.reason });
    // Append assistant summary so follow-up turns see the final answer. agent.done ends the runtime loop before the final turn is appended, so record it here.
    if (result && result.ok && result.summary && host._conversation) {
      host._conversation.messages.push({ role: 'assistant', content: String(result.summary) });
    }
    const outcome = rec ? persist(host, sessionId, () => rec.finish(result)) : null;
    if (rec && host._conversation) host._conversation.headId = outcome ? outcome.id : persist(host, sessionId, () => rec.headId());
    if (result && result.ok) userMemoryService.capture({ messages: (host._conversation && host._conversation.messages) || messages, answer: result.summary }).catch((err) => { console.error('[runTurn] auto-capture failed:', errMsg(err)); });
    if (result && result.reason === 'awaiting_plan_approval') {
      host.emit('plan-proposed', { sessionId, taskId, plan: result.result && result.result.plan, webContentsId: host._task.webContentsId, scope: normScope, tabId: normTabId });
    }
    // assistantNodeId names the persisted outcome node so the panel can bind it without refetching the tree.
    host.emit('task-completed', { ...result, taskId, scope: normScope, tabId: normTabId, sessionId, ...(outcome ? { assistantNodeId: outcome.id } : {}) });
    return result;
  } catch (err) {
    if (host._currentLog) host._currentLog.logTaskEnd({ ok: false, summary: '', reason: errMsg(err) });
    // Zero-step failure: undo only the "New task:" push so retries don't duplicate the "You" bubble; convoTouched guards setup throws that happened before the conversation was touched.
    if (convoTouched && (!host._steps || host._steps.length === 0)) {
      try { const c = host._conversations.get(convoKey); if (c && Array.isArray(c.messages) && c.messages.length > rollbackLen) c.messages.length = rollbackLen; if (rollbackLen === 0 || !c || !Array.isArray(c.messages)) host._conversations.clear(convoKey); } catch (clearErr) { console.error('[runTurn] conversation rollback failed:', errMsg(clearErr)); }
      host._conversation = null;
    }
    if (rec && rec.turnId) {
      const failNode = persist(host, sessionId, () => rec.fail(err));
      const c = host._conversations.get(convoKey);
      if (c && failNode) c.headId = failNode.id;
    }
    host.emit('task-failed', { error: errMsg(err), steps: host.getSteps(), taskId, scope: normScope, tabId: normTabId, sessionId });
    throw err;
  } finally {
    host._watchTab(null);
    host._running = false;
    host._currentLog = null;
    host._ledgerState = null;
    host._toolCtx = null;
  }
}

module.exports = { runTurn, buildToolFilter, PLAN_NOTE };
