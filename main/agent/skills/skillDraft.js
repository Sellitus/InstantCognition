// skillDraft — turn a finished conversation into a draft SKILL.md.
//
// The model is asked (via chatCompletionJson) for a reusable procedure, not a
// summary of this one conversation. Its output is validated like any other
// skill: a bad name, an empty description or empty instructions is an error,
// never an empty skill. The draft is returned for the user to review; this
// module writes nothing.

const { parseSkill, serializeSkill, slugifyName } = require('./skillFormat');

const MAX_TRANSCRIPT_CHARS = 24000;
const MAX_MESSAGES = 500;
const ROLES = new Set(['user', 'assistant', 'tool', 'system']);
const DRAFT_SCHEMA = { name: 'string', description: 'string', instructions: 'string' };

const SYSTEM_PROMPT = [
  'You turn a conversation between a user and an AI assistant into a reusable skill: instructions another',
  'assistant can follow to do the same kind of task again for different inputs.',
  'Reply with ONLY a JSON object:',
  '{"name":"<lowercase-hyphenated, max 64 chars>","description":"<one or two sentences: what the skill does and when to use it>",',
  '"instructions":"<markdown: numbered steps, inputs to ask for, checks, output format>","allowedTools":["<tool names the steps need>"]}',
  'Generalize: no names, secrets or one-off details from this conversation in the instructions.',
].join(' ');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}

/** Render the transcript tail as plain text, newest turns kept when over the cap. */
function renderTranscript(messages) {
  const lines = [];
  for (const m of messages.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== 'object' || !ROLES.has(m.role)) continue;
    const text = textOf(m.content).trim();
    if (text) lines.push(`${m.role.toUpperCase()}: ${text}`);
  }
  const joined = lines.join('\n\n');
  return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(joined.length - MAX_TRANSCRIPT_CHARS) : joined;
}

/**
 * Validate a chatCompletionJson draft response ({name, description,
 * instructions, allowedTools?}) and serialize it as SKILL.md. Shared by every
 * drafting path so a draft is held to the same rules wherever it came from.
 * @param {any} res chatCompletionJson result
 * @param {string[]} [extraWarnings] caller warnings, listed after the tool-format one
 * @returns {{ ok: true, skill: any, markdown: string, warnings: string[] } | { ok: false, error: string }}
 */
function buildDraftFromResponse(res, extraWarnings = []) {
  if (!res || res.ok !== true || !res.value) return { ok: false, error: `draft_failed: ${(res && res.error) || 'no response'}` };
  const v = res.value;
  const name = slugifyName(v.name);
  if (!name) return { ok: false, error: 'draft_invalid_name' };
  if (!v.description.trim()) return { ok: false, error: 'draft_missing_description' };
  if (!v.instructions.trim()) return { ok: false, error: 'draft_empty_instructions' };
  const warnings = [];
  let allowedTools;
  if (Array.isArray(v.allowedTools)) allowedTools = v.allowedTools.filter((t) => typeof t === 'string' && t.trim());
  else if (v.allowedTools !== undefined) warnings.push('The draft listed tools in an unreadable form; no tool restriction was added');
  warnings.push(...extraWarnings);
  let markdown;
  try {
    markdown = serializeSkill({ name, description: v.description.slice(0, 1024), body: v.instructions, allowedTools });
  } catch (err) {
    return { ok: false, error: `draft_invalid: ${(err instanceof Error && err.message) || String(err)}` };
  }
  const parsed = parseSkill(markdown);
  if (parsed.ok === false) return { ok: false, error: `draft_invalid: ${parsed.error}` };
  return { ok: true, skill: parsed.skill, markdown, warnings: warnings.concat(parsed.warnings) };
}

/**
 * @param {{ chatCompletionJson: Function }} llm LLMClientService (or a test double)
 * @param {Array<{role:string, content:any}>} messages
 * @param {{ hint?: string }} [opts]
 * @returns {Promise<{ ok: true, skill: any, markdown: string, warnings: string[] } | { ok: false, error: string }>}
 */
async function draftSkill(llm, messages, opts = {}) {
  if (!llm || typeof llm.chatCompletionJson !== 'function') return { ok: false, error: 'llm_unavailable' };
  if (!Array.isArray(messages)) return { ok: false, error: 'invalid_transcript' };
  const transcript = renderTranscript(messages);
  if (!transcript) return { ok: false, error: 'empty_transcript' };
  const hint = typeof opts.hint === 'string' && opts.hint.trim() ? `\n\nThe user describes the skill as: ${opts.hint.trim().slice(0, 500)}` : '';
  const res = await llm.chatCompletionJson([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Conversation:\n\n${transcript}${hint}` },
  ], DRAFT_SCHEMA, { temperature: 0.2, maxTokens: 1500 });
  return buildDraftFromResponse(res);
}

module.exports = { draftSkill, renderTranscript, buildDraftFromResponse, DRAFT_SCHEMA, MAX_TRANSCRIPT_CHARS };
