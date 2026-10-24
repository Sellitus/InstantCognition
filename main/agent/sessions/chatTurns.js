// chatTurns — session persistence for the chat lane (chat:ask with a
// sessionId). checkChatTurn validates before the request runs; recordChatTurn
// writes the user and assistant nodes once the answer is complete, then
// promotes ```artifact:<type> blocks in the answer into the artifact store.
//
// Nothing is written for a request that never reached the model (engine busy,
// malformed request), so a retry does not leave duplicate user turns behind.
// A request with userNodeId (edit / regenerate) answers that existing user
// node instead of appending a new one.
//
// The user node holds what the user typed: req.userText when the renderer
// sends it (the last message also carries grounding blocks the user never
// wrote), else the text of the last user message. Image parts are counted
// into data.attachments; their base64 payload is never persisted.

const { assertSessionId, assertNodeId } = require('./sessionStore');
const { extractArtifactBlocks } = require('../artifacts/promote');

const NOT_STARTED = new Set(['engine_busy', 'missing_request_id', 'empty_messages']);
const MAX_USER_TEXT = 100000;
const errText = (err) => (err && err.code) || (err instanceof Error && err.message) || String(err);

const textOf = (content) => (typeof content === 'string' ? content
  : content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n'));
const imageCount = (content) => (Array.isArray(content) ? content.filter((p) => p && p.type === 'image_url').length : 0);
const hasContent = (m) => (typeof m.content === 'string' ? !!m.content.trim() : Array.isArray(m.content) && m.content.length > 0);

/**
 * @param {any} store SessionStore
 * @param {{ sessionId?: any, userNodeId?: any, messages?: any, userText?: any }} req
 * @returns {{ sessionId: string, userNode: any|null, userText: string, attachments?: { images: number } }|null} null when the request carries no session
 */
function checkChatTurn(store, req) {
  if (req.sessionId === undefined || req.sessionId === null) return null;
  const sessionId = assertSessionId(req.sessionId);
  if (!store.exists(sessionId)) throw new Error('session_not_found');
  if (req.userNodeId !== undefined && req.userNodeId !== null) {
    const node = store.getPath(sessionId, assertNodeId(req.userNodeId)).pop();
    if (!node || node.role !== 'user' || node.kind !== 'message') throw new Error('not_a_user_message');
    return { sessionId, userNode: node, userText: node.content };
  }
  const given = req.userText !== undefined && req.userText !== null;
  if (given && (typeof req.userText !== 'string' || req.userText.length > MAX_USER_TEXT)) throw new Error('invalid_user_text');
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  const last = [...msgs].reverse().find((m) => m && m.role === 'user' && hasContent(m));
  if (!last) throw new Error('no_user_message');
  const images = imageCount(last.content);
  const userText = given ? req.userText : textOf(last.content);
  if (!userText.trim() && !images) throw new Error('no_user_message');
  return images ? { sessionId, userNode: null, userText, attachments: { images } } : { sessionId, userNode: null, userText };
}

function promoteArtifacts({ artifactStore, onEvent }, sessionId, text) {
  const blocks = extractArtifactBlocks(text);
  if (!blocks.length) return { artifacts: [], artifactErrors: [] };
  const artifacts = [];
  const artifactErrors = [];
  let n = 0;
  try { n = artifactStore.list(sessionId).length; } catch (err) {
    artifactErrors.push({ index: -1, error: errText(err) });
  }
  blocks.forEach((block, index) => {
    try {
      n += 1;
      const a = artifactStore.create(sessionId, { ...block, title: block.title || `${block.type} artifact ${n}` });
      artifacts.push({ id: a.id, version: a.version, type: a.type, title: a.title });
    } catch (err) {
      artifactErrors.push({ index, error: errText(err) });
    }
  });
  if (artifactErrors.length) {
    console.error(`[chatTurns] ${artifactErrors.length} artifact block(s) failed to save for ${sessionId}:`, artifactErrors.map((e) => e.error).join(', '));
    onEvent(sessionId, 'artifact-failed', { errors: artifactErrors });
  }
  return { artifacts, artifactErrors };
}

/**
 * @param {{ store: any, artifactStore: any, onEvent: (sessionId: string, channel: string, payload: any) => void }} deps
 * @param {{ sessionId: string, userNode: any|null, userText: string, attachments?: { images: number } }} turn from checkChatTurn
 * @param {string} text the streamed answer
 * @param {{ ok: boolean, error?: string }} result ChatStreamService.ask result
 */
function recordChatTurn(deps, turn, text, result) {
  if (!result.ok && NOT_STARTED.has(String(result.error))) return {};
  const { store } = deps;
  const { sessionId } = turn;
  let userNodeId;
  if (turn.userNode) {
    store.setHead(sessionId, turn.userNode.id);
    userNodeId = turn.userNode.id;
  } else {
    const data = turn.attachments ? { lane: 'chat', attachments: turn.attachments } : { lane: 'chat' };
    userNodeId = store.append(sessionId, { role: 'user', content: turn.userText, data }).id;
  }
  if (!result.ok) {
    const failed = store.append(sessionId, { role: 'assistant', kind: 'error', content: text ? `${text}\n\n[${result.error}]` : String(result.error), data: { lane: 'chat', error: result.error } });
    return { sessionId, userNodeId, assistantNodeId: failed.id };
  }
  const answer = store.append(sessionId, { role: 'assistant', content: text, data: { lane: 'chat' } });
  return { sessionId, userNodeId, assistantNodeId: answer.id, ...promoteArtifacts(deps, sessionId, text) };
}

module.exports = { checkChatTurn, recordChatTurn, promoteArtifacts, NOT_STARTED };
