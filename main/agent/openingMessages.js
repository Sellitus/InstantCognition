// buildOpeningMessages — produces the opening system+user messages for a new
// agent task. Extracted from AgentService to keep it under the project's
// service-file line budget. The tool list is whatever the caller's registry
// lists (already filtered for plan mode / skills); the user's instruction
// files, the enabled-skills index and tool-tier guidance are appended.

// Prior turns arrive from the renderer's chat lane, so they are bounded here
// rather than trusted: an unbounded thread would push the task message out of
// the context window it is supposed to lead.
const PRIOR_TURN_LIMIT = 16;
const PRIOR_TURN_CHARS = 4000;
const SKILL_INDEX_LIMIT = 40;
const SKILL_DESCRIPTION_CHARS = 200;

const TIER_GUIDANCE = 'Tool tiers: tools are listed cheapest-first. Tier 1 is API-level (workspace files, shell, web search, projects, MCP, agent meta), '
  + 'tier 2 reads or drives a page through its DOM / accessibility tree, tier 3 looks at screenshots. Use the lowest tier that can do the job — '
  + 'read a workspace file with fs.read rather than opening it in a tab, search with browser.web_search rather than browsing to a search page, '
  + 'and take a screenshot only when the DOM cannot answer.';

// Enabled skills the model can load with agent.use_skill; '' when the tool is
// not offered or no skill is enabled.
function buildSkillsIndex(skills, toolNames) {
  if (!toolNames.has('agent.use_skill') || !Array.isArray(skills)) return '';
  const rows = skills
    .filter((sk) => sk && typeof sk.name === 'string' && sk.name && sk.enabled !== false)
    .slice(0, SKILL_INDEX_LIMIT)
    .map((sk) => {
      const d = String(sk.description || '').replace(/\s+/g, ' ').trim();
      return `  - ${sk.name}${d ? `: ${d.length > SKILL_DESCRIPTION_CHARS ? d.slice(0, SKILL_DESCRIPTION_CHARS) + '…' : d}` : ''}`;
    });
  if (!rows.length) return '';
  return `Skills: call agent.use_skill {name} to load a skill's full instructions when the task matches one.\n${rows.join('\n')}`;
}

// Earlier turns are folded into ONE user message instead of replayed as
// role-tagged assistant turns: the system prompt above demands tool calls only,
// and prose assistant messages in the history teach the model to answer in
// prose instead of calling agent.done.
function buildPriorTurnsMessage(turns) {
  if (!Array.isArray(turns)) return null;
  const usable = turns
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-PRIOR_TURN_LIMIT)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.length > PRIOR_TURN_CHARS ? m.content.slice(0, PRIOR_TURN_CHARS) + '…' : m.content}`);
  if (!usable.length) return null;
  return {
    role: 'user',
    content: `Earlier in this conversation:\n\n${usable.join('\n\n')}\n\n`
      + 'Use that context for the task below. Reply with tool calls only, exactly as instructed above.',
  };
}

/**
 * @param {{ registry: { list: () => any[] }, description: string, initial: string, visionOn?: boolean, qualityMode?: any, persona?: any,
 *   userMemoryBlock?: string, projectBlock?: string, priorTurns?: any, instructionsBlock?: string, skills?: Array<{ name: string, description?: string, enabled?: boolean }> }} opts
 */
function buildOpeningMessages({ registry, description, initial, visionOn, qualityMode, persona, userMemoryBlock, projectBlock, priorTurns, instructionsBlock, skills }) {
  const listed = registry.list();
  const tools = listed.map((t) => `  - ${t.function.name}: ${t.function.description || ''}`).join('\n');
  const skillsIndex = buildSkillsIndex(skills, new Set(listed.map((t) => t.function.name)));
  const system = [
    'You are a generic agent operating inside a multi-tab Electron browser.',
    'You have structured tools available. Respond with tool calls ONLY — no prose, no markdown.',
    'NEVER reply with planning prose ("I will...", "Let me try...", "Plan: 1..."). If you have a next action, ISSUE IT as a tool call. If you have the final answer, call agent.done. There is no third option — narrating intent without acting wastes a turn and the runtime will reject it.',
    '',
    'Preferred reply format (OpenAI-compatible): use the native tools/tool_calls schema.',
    'Fallback reply format (if your server does not support tools): a JSON array of calls, e.g.',
    '  [{"tool":"browser.read_tab","args":{"spaceId":"custom1"}}]',
    'A single object also works: {"tool":"agent.done","args":{"summary":"..."}}',
    '',
    'DO NOT invent custom syntax. The following formats are NOT parsed and will be rejected:',
    '  call:browser.open_tab{url:"..."}              ← invented "call:" syntax',
    '  <|tool_response>...<|tool_call>               ← malformed half-tokens',
    '  <|"|>some string<|"|>                         ← raw special-token quotes',
    'If you find yourself wanting to write any of those, switch to the JSON fallback above instead.',
    '',
    'You may issue MULTIPLE calls in one turn to read multiple tabs in parallel, or to fan out read-only work.',
    'Side-effecting tools (click, type, navigate, scroll, wait, press_key) on the SAME tab in one turn are',
    'rejected with intra_tab_conflict — serialize those across turns.',
    '',
    'Preferred interaction flow on a tab:',
    '  1. Call browser.snapshot_ax to get a numeric-indexed list of interactive elements.',
    '  2. Reference elements by idx: browser.click_idx {idx}, browser.hover_idx {idx},',
    '     browser.type_text {idx,text}, browser.press_key_real {key:"Enter"}.',
    '  3. After navigation or a click that changes the page, call browser.wait_for_load',
    '     then browser.snapshot_ax again before the next action — idx values reset per snapshot.',
    'Prefer idx-based tools over selector-based ones (browser.click, browser.type). Fall back to',
    'selector-based tools only if the idx tool returns cdp_unavailable.',
    '',
    'URL etiquette: NEVER fabricate or guess URLs from page titles. Reddit comment URLs need a real',
    'post id (e.g. /comments/abc1234/<slug>/) — synthesizing one from a title yields an HTTP error',
    'page that read_tab will return as "(untitled) · 3 words". To open a specific item linked from',
    'a feed, use browser.click_idx on the actual link element from snapshot_ax. Use open_tab only for',
    'URLs the user gave you, URLs you read verbatim from a page, or canonical site roots.',
    'When you do NOT have a URL for what you need, call browser.web_search {query} FIRST — it returns',
    'real {title,url,snippet} results — then browser.open_tab the best result. Do not guess a URL when',
    'you could search for it.',
    '',
    'Finishing the task:',
    '  - Before calling agent.done, you MUST have read the page content needed to answer.',
    '    If your last action was a navigation or click that loaded a new page, call browser.read_tab',
    '    (or browser.snapshot_ax / browser.extract) FIRST, then summarize from what you read.',
    '  - agent.done.summary MUST contain the actual findings (titles, bullet points, numbers, comparisons)',
    '    in natural language for the user. Not "task completed", not "done", not an empty string.',
    '  - If you cannot answer (blocked, no results, login required), call agent.done with a summary',
    '    that explains what was tried and what prevented completion.',
    visionOn ? 'Vision is enabled: you may call browser.screenshot_tabs to see pages visually.' : 'Vision is disabled: do not call browser.screenshot_tabs.',
    qualityMode ? `\nQuality mode: ${qualityMode.name}. Budget: maxSteps=${qualityMode.budget.maxSteps}, maxTokens=${qualityMode.budget.maxTokens || 'uncapped'}, maxSeconds=${qualityMode.budget.maxSeconds}.` : '',
    persona && persona.systemOverlay ? `\nPersona: ${persona.label || persona.name}. ${persona.systemOverlay}` : '',
    persona && persona.notes ? `\nUser notes for this persona:\n${persona.notes}` : '',
    userMemoryBlock ? `\n${userMemoryBlock}` : '',
    projectBlock ? `\n${projectBlock}\nYou can also call project.search {query} to find files by meaning, and project.read_file {fileId} to read a specific file's full contents.` : '',
    '',
    'Plan ledger: update it with agent.set_plan or agent.update_ledger when your plan changes.',
    'The ledger is re-read at every turn so you do not need to restate facts.',
    '',
    instructionsBlock ? `\n${instructionsBlock}` : '',
    skillsIndex ? `\n${skillsIndex}` : '',
    '',
    TIER_GUIDANCE,
    'Available tools:',
    tools,
  ].filter(Boolean).join('\n');
  const prior = buildPriorTurnsMessage(priorTurns);
  return [
    { role: 'system', content: system },
    ...(prior ? [prior] : []),
    { role: 'user', content: `Task: ${description}\n\n${initial}` },
  ];
}

module.exports = { buildOpeningMessages, buildPriorTurnsMessage, buildSkillsIndex, TIER_GUIDANCE };
