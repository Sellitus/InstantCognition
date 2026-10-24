// CouncilLane — the multi-source commands. /council fans a question to every
// visible AI pane, polls their answers until they settle, then streams a
// synthesis; /research hands a citation-mapped research task to the agent.
// State lives on the panel (host) so its long-standing field names stay valid.

const { errMsg } = require('../../../../shared/errMsg');
const { buildMessages } = require('../../../utils/copilotPrompts');
const { COUNCIL_EXTRACTOR, buildInjectScript, buildResearchTask } = require('../../../utils/councilScripts');
const fx = require('../../../fx');

// /council polling: how long to wait between answer captures and the max number
// of rounds before we synthesize whatever has arrived (round-count bound keeps
// the loop deterministic under test timer control).
const COUNCIL_POLL_MS = 3000;
const COUNCIL_MAX_ROUNDS = 12;
// Shorter captures are typing indicators or UI chrome, not an answer.
const MIN_ANSWER_CHARS = 8;

class CouncilLane {
  /** @param {import('../../AgentPanel')} host */
  constructor(host) {
    this.host = host;
  }

  runResearch(question) {
    const h = this.host;
    const q = (question || '').trim();
    if (!q) {
      // No question text: surface guidance in the chat pane, don't start anything.
      h._answerView.present('Add a question: `/research <your question>`');
      return undefined;
    }
    h._transcript.setStartersVisible(false);
    h._composer.recordPrompt('/research ' + q);
    // The agent web-searches, opens cited sources as panes, and writes a
    // citation-mapped report (capture handled by AgentLane.captureResearchSources).
    return h._agentLane.run(buildResearchTask(q));
  }

  delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  activeSpaceIds() {
    const ctx = this.host.contextProvider() || {};
    const state = ctx.state;
    if (!state || typeof state.get !== 'function') return [];
    const set = state.get('activeSpaces');
    if (set instanceof Set) return Array.from(set);
    if (Array.isArray(set)) return set.slice();
    if (set && typeof set === 'object') return Object.entries(set).filter(([, v]) => v).map(([k]) => k);
    return [];
  }

  injectQuestion(q) {
    const ids = this.activeSpaceIds().filter((tabId) => {
      const wv = /** @type {any} */ (document.getElementById(tabId));
      return wv && typeof wv.executeJavaScript === 'function';
    });
    ids.forEach((tabId) => {
      const wv = /** @type {any} */ (document.getElementById(tabId));
      try { wv.executeJavaScript(buildInjectScript(q, true)).catch((err) => console.error('executeJavaScript failed', (err instanceof Error && err.message) || err)); } catch (err) { console.error('executeJavaScript dispatch failed', (err instanceof Error && err.message) || err); }
    });
    return ids;
  }

  extractAnswer(tabId) {
    return new Promise((resolve) => {
      const wv = /** @type {any} */ (document.getElementById(tabId));
      if (!wv || typeof wv.executeJavaScript !== 'function') { resolve(''); return; }
      const failed = (err) => {
        console.warn('[AgentPanel] council answer extraction failed for', tabId, errMsg(err));
        resolve('');
      };
      try {
        wv.executeJavaScript(COUNCIL_EXTRACTOR)
          .then((t) => resolve(typeof t === 'string' ? t : ''), failed);
      } catch (err) { failed(err); }
    });
  }

  async captureAnswers(ids) {
    const ctx = this.host.contextProvider() || {};
    const state = ctx.state;
    const config = state && typeof state.get === 'function' ? state.get('config') : null;
    const spaces = (config && config.spaces) || {};
    const texts = await Promise.all(ids.map((tabId) => this.extractAnswer(tabId)));
    return ids.map((tabId, i) => ({
      name: (spaces[tabId] && spaces[tabId].name) || tabId,
      text: (texts[i] || '').trim(),
    }));
  }

  async runCouncil(question) {
    const h = this.host;
    const q = (question || '').trim();
    if (!q) { h._answerView.present('Add a question: `/council <your question>`'); return; }
    if (h._chatReqId) return;
    const id = 'chat_' + (++h._chatSeq) + '_' + Date.now();
    h._chatReqId = id;
    h._transcript.setStartersVisible(false);
    h._composer.recordPrompt('/council ' + q);
    h._transcript.prepareFollowUpTurn();
    h._transcript.renderUserMessage('/council ' + q);
    h.input.value = '';
    h.input.style.height = '';
    h._answerView.markWaiting();
    h._transcript.setStatus('running');

    const ids = this.injectQuestion(q);
    if (ids.length < 2) {
      h._chatLane.teardownStream();
      h._answerView.present('Open at least two AI services side-by-side to convene the council.');
      h._transcript.setStatus('error');
      return;
    }
    fx.councilStart(ids);

    // Poll until the captured answers stabilize across two rounds or we hit the
    // round cap. Bail if the user stopped (Stop clears _chatReqId). The wait
    // goes through the panel's _delay so tests can collapse it.
    let answers = [];
    let prevKey = '';
    for (let round = 0; round < COUNCIL_MAX_ROUNDS; round++) {
      if (h._chatReqId !== id) return;
      await h._delay(COUNCIL_POLL_MS);
      if (h._chatReqId !== id) return;
      answers = await this.captureAnswers(ids);
      fx.councilUpdate(answers);
      const usable = answers.filter((a) => a.text && a.text.length >= MIN_ANSWER_CHARS);
      const key = usable.map((a) => `${a.name}:${a.text.length}`).join('|');
      if (usable.length >= 2 && key === prevKey) break;
      prevKey = key;
    }
    if (h._chatReqId !== id) return;

    const usable = answers.filter((a) => a.text && a.text.length >= MIN_ANSWER_CHARS);
    if (usable.length < 2) {
      h._chatLane.teardownStream(id);
      h._answerView.present('Could not capture at least two councillor answers. Wait for the AI panes to reply, then run /council again.');
      h._transcript.setStatus('error');
      return;
    }

    fx.councilConverge();
    const messages = buildMessages('council', { question: q, answers: usable });
    const res = await h._chatLane.streamAnswer(id, messages);
    if (res.stale) return;
    if (res.ok && res.answer.trim()) {
      h._answerView.present(res.answer);
      h._transcript.setStatus('done');
      h._controller.pushThreadTurn('/council ' + q, res.answer);
    } else if (res.error === 'cancelled') {
      h._answerView.present(res.answer);
      h._transcript.setStatus('idle');
    } else {
      h._answerView.present(h._chatLane.friendlyError(res.ok ? 'empty_response' : res.error));
      h._transcript.setStatus('error');
    }
  }
}

module.exports = CouncilLane;
