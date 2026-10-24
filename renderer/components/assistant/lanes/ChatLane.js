// ChatLane — the fast single-turn answer path: grounds the message (project
// attachments, @-tokens, the active page, optional web search), streams the
// reply over chat:ask / chat:token, and records the turn in the shared thread.
// State lives on the panel (host) so its long-standing field names stay valid.

const { ipcRenderer } = require('electron');
const ProjectComposer = require('../../agent/ProjectComposer');
const configBridge = require('../../../core/configBridge');
const { errMsg } = require('../../../../shared/errMsg');
const { buildReadableScript } = require('../../../../main/agent/readableExtractor');
const { buildMessages } = require('../../../utils/copilotPrompts');
const { PRIVATE_PARTITION } = require('../../../utils/historyRecorder');
const {
  parseSlashAction, formatPageBlock, formatBrowsing, formatWebResults,
  DEFAULT_CHAT_FEATURES, parseInlineContext, ACTIVE_PAGE_AUTO_LIMIT,
} = require('../../../utils/chatContext');
const { CHAT_HISTORY_TURNS } = require('../AssistantController');
const toast = require('../../Toast');

function isPrivateTab(wv) {
  return !!wv && typeof wv.getAttribute === 'function' && wv.getAttribute('partition') === PRIVATE_PARTITION;
}

class ChatLane {
  /** @param {import('../../AgentPanel')} host */
  constructor(host) {
    this.host = host;
  }

  // Read persisted feature flags; all three default ON and are opt-out via
  // Settings → Chat, so a plain question arrives web-grounded with no
  // per-message choice. A missing/malformed block falls back to
  // DEFAULT_CHAT_FEATURES rather than breaking the panel.
  loadFeatures() {
    const fromCfg = configBridge.get('settings.chat.features', null);
    this.host._chatFeatures = (fromCfg && typeof fromCfg === 'object')
      ? { ...DEFAULT_CHAT_FEATURES, ...fromCfg }
      : DEFAULT_CHAT_FEATURES;
  }

  async run(prefillDescription) {
    const h = this.host;
    const text = typeof prefillDescription === 'string' && prefillDescription.trim()
      ? prefillDescription.trim() : (h.input.value || '').trim();
    if (!text) return;
    // Multi-step actions (fan-out to spaces / hand to the agent) are routed out
    // of the single-turn chat path before we claim the streaming slot.
    const slash = parseSlashAction(text);
    if (slash && slash.action === 'research') { h.input.value = ''; h.input.style.height = ''; return h._councilLane.runResearch(slash.rest); }
    if (slash && slash.action === 'council') return h._councilLane.runCouncil(slash.rest);
    if (h._chatReqId) return; // one streamed turn at a time
    // Claim the slot BEFORE any await so a second send can't slip past the
    // guard above while we extract page/selection context.
    const id = 'chat_' + (++h._chatSeq) + '_' + Date.now();
    h._chatReqId = id;
    // One-shot transforms (/summarize, /explain, /compare) send a generated
    // prompt, not the user's words, so they stay out of the saved thread.
    const sessionP = slash ? Promise.resolve(null) : h._sessionStore.ensureSession();
    h._transcript.setStartersVisible(false);
    h._composer.recordPrompt(text);
    // The previous answer moves into the thread before the new question so
    // markWaiting below does not wipe it from the screen.
    h._transcript.prepareFollowUpTurn();
    const shownText = ProjectComposer.stripMentionTokens(text) || text;
    h._transcript.renderUserMessage(shownText, { lane: 'chat' });
    h.input.value = '';
    h.input.style.height = '';
    if (h._projectComposer) h._projectComposer.clearPending();
    h._pendingProjectImages = [];
    h._answerView.markWaiting();
    h._transcript.setStatus('running');

    const composed = await this.composeMessages(text);
    // Stop or New chat released the slot during the await: this turn is dead.
    if (h._chatReqId !== id) return;
    if (composed.error) {
      this.teardownStream(id);
      h._answerView.present(composed.error);
      h._transcript.setStatus('error');
      h.input.value = text;
      h._transcript.setStartersVisible(true);
      return;
    }
    const sessionId = await sessionP;
    if (h._chatReqId !== id) return;
    const persist = sessionId ? { sessionId, userText: shownText } : null;
    const res = await this.streamAnswer(id, composed.messages, persist);
    this.finishTurn(text, res, { restoreInput: true });
  }

  // Answer an existing user turn of the session again (edit & resend,
  // regenerate). The thread already shows the turn, and main answers that node
  // instead of appending a new user message.
  async resend(userNode) {
    const h = this.host;
    const sessionId = h._sessionStore.activeSessionId;
    if (!sessionId || !userNode || !userNode.id) throw new Error('This message is not saved yet.');
    if (h._chatReqId) throw new Error('A reply is already streaming.');
    const id = 'chat_' + (++h._chatSeq) + '_' + Date.now();
    h._chatReqId = id;
    h._transcript.setStartersVisible(false);
    h._answerView.markWaiting();
    h._transcript.setStatus('running');
    const text = String(userNode.content || '');
    const composed = await this.composeMessages(text);
    if (h._chatReqId !== id) return;
    if (composed.error) {
      this.teardownStream(id);
      h._answerView.present(composed.error);
      h._transcript.setStatus('error');
      return;
    }
    const res = await this.streamAnswer(id, composed.messages, { sessionId, userNodeId: userNode.id });
    this.finishTurn(text, res, { restoreInput: false });
  }

  finishTurn(text, res, { restoreInput }) {
    const h = this.host;
    // A later turn, New chat or another session owns the view now.
    if (res.stale) {
      if (res.persistError) h.warnPersistFailure(`This reply was not saved: ${res.persistError}`);
      return;
    }
    if (res.ok && res.answer.trim()) {
      h._answerView.present(res.answer);
      h._transcript.setStatus('done');
      h._controller.pushThreadTurn(text, res.answer);
    } else if (res.error === 'cancelled') {
      h._answerView.present(res.answer); // keep whatever streamed before the stop
      h._transcript.setStatus('idle');
    } else {
      // A stream that reported success but delivered no text is a failed turn, not an empty answer.
      h._answerView.present(this.friendlyError(res.ok ? 'empty_response' : res.error));
      h._transcript.setStatus('error');
      if (restoreInput) {
        h.input.value = text; // don't lose the user's message on a hard failure
        h._transcript.setStartersVisible(true);
      }
    }
    this.bindPersisted(res);
  }

  // Attach the saved node ids to the turn's views so its actions work, then
  // refresh the cached tree for the version switchers.
  bindPersisted(res) {
    const h = this.host;
    if (res.persistError) h.warnPersistFailure(`This reply was not saved: ${res.persistError}`);
    else if (res.userNodeId) h.clearPersistWarning();
    if (!res.userNodeId || res.sessionId !== h._sessionStore.activeSessionId) return;
    h._chatThread.bindTurn({ userNodeId: res.userNodeId, assistantNodeId: res.assistantNodeId || null, lane: 'chat', answer: res.answer });
    h._sessionStore.refresh().catch((err) => {
      console.error('[ChatLane] session refresh failed:', errMsg(err));
      toast.error(`Couldn’t reload the conversation: ${errMsg(err)}`);
    });
  }

  // Stream one chat:ask request into the AnswerView, holding the chat:token
  // subscription only for the request's lifetime. The caller must already own
  // the slot (_chatReqId === id); it is released before this resolves.
  // `persist` ({sessionId, userNodeId?, userText?}) saves the turn into the
  // session; userText is what the thread shows for the user's message, since
  // the last message also carries the grounding context.
  // Resolves { ok, error, answer, stale, sessionId?, userNodeId?,
  // assistantNodeId?, persistError? } — never rejects. `stale` is true when
  // another turn started or supersede() ran while this one was in flight.
  async streamAnswer(id, messages, persist) {
    const h = this.host;
    const seq = h._chatSeq;
    let answer = '';
    h._chatTokenHandler = (_e, payload) => {
      if (!payload || payload.id !== id) return;
      answer += payload.delta || '';
      h._answerView.appendChunk(payload.delta || '');
    };
    ipcRenderer.on('chat:token', h._chatTokenHandler);

    let res;
    try {
      res = await ipcRenderer.invoke('chat:ask', persist ? { id, messages, ...persist } : { id, messages });
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.teardownStream(id);
    }
    const r = res || {};
    return {
      ok: !!r.ok, error: r.error, answer, stale: h._chatSeq !== seq,
      sessionId: r.sessionId, userNodeId: r.userNodeId, assistantNodeId: r.assistantNodeId, persistError: r.persistError,
    };
  }

  // With an id, only that request's slot and token handler are released: a
  // stopped turn settling late must not tear down the turn that replaced it.
  /** @param {string} [id] */
  teardownStream(id) {
    const h = this.host;
    if (id !== undefined && h._chatReqId !== id) return;
    if (h._chatTokenHandler) {
      ipcRenderer.removeListener('chat:token', h._chatTokenHandler);
      h._chatTokenHandler = null;
    }
    h._chatReqId = null;
  }

  // Invalidate any in-flight turn so its late result never presents.
  supersede() {
    this.host._chatSeq++;
  }

  cancel() {
    const h = this.host;
    if (h._chatReqId) ipcRenderer.send('chat:cancel', { id: h._chatReqId });
  }

  friendlyError(error) {
    const e = String(error || 'Request failed.');
    if (e === 'session_busy') return 'The previous reply is still stopping. Try again in a moment.';
    if (e === 'engine_busy') return 'The model is busy with another task. Try again in a moment.';
    if (e === 'empty_messages' || e === 'missing_request_id') return 'Could not send that message.';
    if (e === 'reasoning_budget_exhausted') return 'The model spent its whole token budget thinking and never wrote an answer. Raise the response length in Settings → LLM, or use a model with shorter reasoning.';
    if (e === 'empty_response') return 'The model returned no answer text. Try again, or check the endpoint in Settings → LLM.';
    const hint = /endpoint|no active llm|no model/i.test(e)
      ? ' — start a model or set a remote endpoint in Settings → LLM.' : '';
    return e + hint;
  }

  buildMessages(text, contextBlocks, opts) {
    const h = this.host;
    const o = opts || {};
    let systemContent = 'You are a fast, concise assistant inside a web browser. Answer the user directly in clear Markdown. Be accurate and to the point.';
    if (o.thinkStepByStep) systemContent += ' For multi-part, math, or logic questions, reason step by step before giving the final answer.';
    // A compacted session's summary joins the one system message: strict chat templates reject a second.
    const summary = h._chatThread.compactionSummary();
    if (summary) systemContent += `\n\nSummary of the earlier conversation:\n${summary}`;
    const system = { role: 'system', content: systemContent };
    // Keep the last few turns for continuity without unbounded growth.
    const history = h._chatHistory.slice(-CHAT_HISTORY_TURNS * 2);
    // Mention markup ([[file:Name]]) and typed @context tokens both resolve into context blocks above; the model only sees their content, never the raw markers. Newlines are preserved (only token-boundary runs collapse).
    const cleanText = parseInlineContext(ProjectComposer.stripMentionTokens(text)).text;

    const userContent = contextBlocks ? `${contextBlocks}\n\n${cleanText}` : cleanText;
    // Multimodal: when project image attachments are present, send the message
    // as OpenAI-compatible content parts (text + image_url) so a vision-capable
    // model can see the images. Text-only path stays a plain string.
    const images = Array.isArray(h._pendingProjectImages) ? h._pendingProjectImages : [];
    const userMessage = images.length
      ? { role: 'user', content: [{ type: 'text', text: userContent }, ...images.map((im) => ({ type: 'image_url', image_url: { url: im.dataUrl } }))] }
      : { role: 'user', content: userContent };
    return [system, ...history, userMessage];
  }

  // Turn the user's text into chat-completion messages. A leading transform
  // command (/summarize, /explain, /compare) routes to a one-shot prompt built
  // from extracted page content; otherwise the attached context is resolved
  // and prepended to the message. When webSearch is enabled, a live web search
  // (and optionally the top result's body) is run first and injected as
  // grounding context. Returns { messages } or { error }.
  async composeMessages(text) {
    const slash = parseSlashAction(text);
    if (slash) return this.composeActionMessages(slash);
    // Blocks are resolved from the RAW text: gatherContextBlocks re-parses inline tokens itself, so a pre-stripped string would yield no keys at all. The search query stays token-free via its own strip below.
    const blocks = await this.gatherContextBlocks(text);
    const webBlock = await this.gatherWebBlock(parseInlineContext(text).text);
    const allBlocks = [webBlock, blocks].filter(Boolean).join('\n\n');
    return { messages: this.buildMessages(text, allBlocks, { thinkStepByStep: !!this.host._chatFeatures.thinkStepByStep }) };
  }

  // When the webSearch feature is on, run a web search for the user's query and
  // format the results as a grounding block. readTopPage (default on) also
  // fetches the top result's readable body. Returns '' on any failure so a
  // search glitch never blocks the chat turn — the model answers ungrounded.
  async gatherWebBlock(query) {
    const features = this.host._chatFeatures;
    if (!features || !features.webSearch) return '';
    const readTop = features.readTopPage !== false;
    let res;
    try {
      res = await ipcRenderer.invoke('chat:web-search', { query, readTop });
    } catch (err) {
      console.error('chat:web-search failed', (err instanceof Error && err.message) || err);
      toast.warn('Web search failed — answering without live results');
      return '';
    }
    if (!res || !res.ok || !Array.isArray(res.results) || !res.results.length) {
      if (!res || !res.ok) {
        toast.warn('Web search failed — answering without live results',
          { title: res && res.error ? `Search error: ${res.error}` : undefined });
      }
      return '';
    }
    const block = formatWebResults(res);
    return block || '';
  }

  async composeActionMessages({ action }) {
    if ((action === 'summarize' || action === 'explain') && isPrivateTab(this.host._agentLane.resolveTargetWebview())) {
      return { error: 'Page commands are off in private tabs, so nothing from them is saved or sent to the model.' };
    }
    if (action === 'summarize') {
      const page = await this.extractActivePage();
      if (!page) return { error: 'No readable page in view to summarize. Open a page first.' };
      return { messages: buildMessages('summarize', { page }) };
    }
    if (action === 'explain') {
      const selection = await this.extractSelection();
      if (!selection) return { error: 'Select some text on the page first, then run /explain.' };
      const page = await this.extractActivePage();
      return { messages: buildMessages('explain', { selection, page: page || {} }) };
    }
    if (action === 'compare') {
      const pages = await this.extractPages();
      if (pages.length < 2) return { error: 'Open at least two panes side-by-side, then run /compare.' };
      return { messages: buildMessages('compare', { pages }) };
    }
    return { error: 'Unknown command.' };
  }

  // Resolve context into text blocks for the next chat message: project
  // attachments, then any inline @-tokens typed in the message
  // (@selection/@spaces/@browsing), and always a capped block of the active
  // page so plain questions are grounded in what is on screen. A source that
  // yields nothing (no selection, empty page) is skipped; the page, selection
  // and browsing extractors log their own failures and yield nothing.
  async gatherContextBlocks(query) {
    const h = this.host;
    const blocks = [];
    h._pendingProjectImages = [];
    if (h._projectComposer) {
      const proj = await h._projectComposer.collectAttachments();
      if (proj && proj.text) blocks.push(proj.text);
      if (proj && Array.isArray(proj.images)) h._pendingProjectImages = proj.images;
    }
    // Explicit @tokens typed into the message (selection/spaces/browsing). The active page needs no token — it always attaches, capped.
    const inline = parseInlineContext(query);
    if (inline.keys.includes('selection')) {
      const s = await this.extractSelection();
      if (s) blocks.push(`--- Selected text ---\n${s}`);
    }
    if (inline.keys.includes('spaces')) {
      const pages = await this.extractPages();
      pages.forEach((p, i) => blocks.push(`--- Pane ${i + 1} ---\n${formatPageBlock(p, ACTIVE_PAGE_AUTO_LIMIT)}`));
    }
    if (inline.keys.includes('browsing')) {
      const r = await this.askBrowsing(inline.text); // stripped text — the history/bookmark query must not carry raw tokens either
      const t = formatBrowsing(r);
      if (t) blocks.push(`--- From your history & bookmarks ---\n${t}`);
    }
    // Active page always attached: the user is looking at it, so answers should be about what they see. Capped to keep plain prompts small.
    const active = await this.extractActivePage();
    if (active) blocks.push(`--- Active page ---\n${formatPageBlock(active, ACTIVE_PAGE_AUTO_LIMIT)}`);
    return blocks.join('\n\n');
  }

  // -- Context extraction (logged and skipped on failure; never throws) -----
  // Private tabs are never read: the text would be saved with the session
  // under userData and sent to the model.

  async extractActivePage() {
    const wv = this.host._agentLane.resolveTargetWebview();
    if (!wv || typeof wv.executeJavaScript !== 'function' || isPrivateTab(wv)) return null;
    try { return await wv.executeJavaScript(buildReadableScript({ maxMainText: 6000 }), true); }
    catch (err) {
      console.warn('[AgentPanel] page context extraction failed; sending without it:', errMsg(err));
      return null;
    }
  }

  async extractSelection() {
    const wv = this.host._agentLane.resolveTargetWebview();
    if (!wv || typeof wv.executeJavaScript !== 'function' || isPrivateTab(wv)) return '';
    try {
      const s = await wv.executeJavaScript('String((window.getSelection && window.getSelection().toString()) || "")', true);
      return (s || '').trim();
    } catch (err) {
      console.warn('[AgentPanel] selection extraction failed; sending without it:', errMsg(err));
      return '';
    }
  }

  visibleWebviews() {
    const ctx = this.host.contextProvider() || {};
    const state = ctx.state;
    if (!state || typeof state.get !== 'function') return [];
    const open = state.get('openTabs') || [];
    const hidden = state.get('hiddenTabs') || [];
    return open
      .filter((tabId) => !hidden.includes(tabId))
      .map((tabId) => /** @type {any} */ (document.getElementById(tabId)))
      .filter((el) => el && typeof el.executeJavaScript === 'function' && !isPrivateTab(el));
  }

  async extractPages() {
    const wvs = this.visibleWebviews();
    const out = [];
    for (const wv of wvs) {
      try {
        const p = await wv.executeJavaScript(buildReadableScript({ maxMainText: 3000 }), true);
        if (p) out.push(p);
      } catch (err) {
        console.warn('[AgentPanel] skipping a pane that would not extract:', errMsg(err));
      }
    }
    return out;
  }

  async askBrowsing(query) {
    try { return await ipcRenderer.invoke('browsing:ask', { query, limit: 5 }); }
    catch (err) {
      console.warn('[AgentPanel] browsing:ask failed; answering without browsing context:', errMsg(err));
      return null;
    }
  }
}

module.exports = ChatLane;
