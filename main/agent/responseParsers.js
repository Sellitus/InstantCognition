// responseParsers — extract tool calls from model output across every common
// dialect. Try each parser in priority order; first non-empty result wins.
//
// Supported thinking-tag formats (stripped before parsing):
//   <think>…</think>              Qwen3, DeepSeek-R1 distills
//   <thinking>…</thinking>        Claude-style wrappers
//   <reasoning>…</reasoning>      assorted
//   <reflection>…</reflection>    assorted
//   <scratchpad>…</scratchpad>    ReAct variants
//   [THINK]…[/THINK]              bracketed variant
//   <|im_start|>think\n…<|im_end|>  Qwen chat-template leakage
//   <|channel|>analysis…<|message|> / <|start|>assistant<|channel|>analysis
//
// Supported tool-call formats (current as of May 2026):
//   OpenAI native tool_calls[]                       (handled upstream)
//   Hermes / Qwen-Agent / Granite 3.x+:              also covers Granite 4 + Qwen3+
//                             <tool_call>{…}</tool_call>  (also <tool_calls>[…]</tool_calls>)
//   Llama-3.1 XML w/ params: <function=N><parameter=K>V</parameter></function>
//   Llama-3.1 JSON payload:   <function=N>{json}</function>
//   Llama python-tag:         <|python_tag|>{json}<|eom_id|>  or  <|python_tag|>{json}
//   Llama-3.2/3.3/4 pythonic: [func(arg='val', n=2), other_func(x=3.14)]
//   Mistral:                  [TOOL_CALLS][{name,arguments}]
//   Claude XML:               <invoke name="N"><parameter name="K">V</parameter></invoke>
//                             (optionally wrapped in <function_calls>…</function_calls>)
//   DeepSeek:                 <｜tool▁calls▁begin｜>…<｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME\n```json\n{json}\n```<｜tool▁call▁end｜>…<｜tool▁calls▁end｜>
//   GPT-OSS Harmony:          <|channel|>commentary to=functions.NAME<|message|>{json}<|call|>
//   Phi-4-mini functools:     functools[{"name":"X","arguments":{…}}]
//   ReAct prose:              Action: NAME\nAction Input: {json}
//   Fenced JSON:              ```json\n{…}\n```  or  ```\n[…]\n```
//   "call:" hallucination:    call:NAME{relaxed-json}     (small/weaker models)
//   Raw JSON:                 {…} / […]
//
// JSON auto-healing (applied as last-resort fallback in parseJsonBlock): trailing
// commas, Python literals (None/True/False), JS-style comments, smart quotes,
// BOM, and truncated string/braces/brackets are all repaired pre-parse.

const THINK_RX = [
  /<think>[\s\S]*?<\/think>/gi,
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<reasoning>[\s\S]*?<\/reasoning>/gi,
  /<reflection>[\s\S]*?<\/reflection>/gi,
  /<scratchpad>[\s\S]*?<\/scratchpad>/gi,
  /\[THINK\][\s\S]*?\[\/THINK\]/gi,
  // Qwen chat template: <|im_start|>think\n...<|im_end|>
  /<\|im_start\|>\s*think[\s\S]*?<\|im_end\|>/gi,
  // GPT-style analysis channel: <|channel|>analysis<|message|>...<|end|>
  /<\|channel\|>\s*analysis[\s\S]*?<\|(?:end|start)\|>/gi,
  /<\|start\|>assistant<\|channel\|>analysis[\s\S]*?<\|end\|>/gi,
];

// Orphan close-tag patterns: a model that started reasoning without first
// emitting the opening `<think>` (or similar) but DID emit the close tag.
// Anything from the start of the content up to and including the orphan close
// tag is treated as thinking prose and stripped.
const ORPHAN_THINK_CLOSE_RX = [
  /^[\s\S]*?<\/think>/i,
  /^[\s\S]*?<\/thinking>/i,
  /^[\s\S]*?<\/reasoning>/i,
  /^[\s\S]*?<\/reflection>/i,
  /^[\s\S]*?<\/scratchpad>/i,
  /^[\s\S]*?\[\/THINK\]/i,
];

function stripThink(s) {
  if (!s || typeof s !== 'string') return '';
  let out = s;
  for (const rx of THINK_RX) out = out.replace(rx, '');
  // Handle orphan close tags AFTER the paired strip so we never double-strip
  // a well-formed block. Only fires if a close tag still remains in the text.
  for (const rx of ORPHAN_THINK_CLOSE_RX) {
    if (rx.test(out)) out = out.replace(rx, '');
  }
  return out.trim();
}

// Strip special-token leakage that confuses tool-call parsing. Targets:
//   - <|"|> rendered instead of literal `"` (some tokenizers do this)
//   - <eos>/<bos>/</eos> and <|endoftext|>-family chat-template control tokens
//   - HALF-MALFORMED special tokens like <|tool_response> (no closing `|`) or
//     <tool_call|> (no opening `|`) which the model invents when it can't
//     produce the real special token sequence
// Deliberately leaves WELL-FORMED dialect tokens intact (<|python_tag|>,
// <|tool_call_begin|>, <tool_call>...</tool_call>, <function=>, <invoke>) so
// their dialect parsers below still match.
function stripSpecialTokens(s) {
  if (!s || typeof s !== 'string') return s || '';
  let out = s;
  out = out.replace(/<\|"\|>/g, '"');
  // Chat-template control tokens that should be invisible to the parser.
  out = out.replace(/<\|(?:end_of_text|endoftext|eos|bos|im_end|eot_id|eom_id|return|end|start)\|>/gi, '');
  // SentencePiece / Mistral style: <eos>, <bos>, </eos>.
  out = out.replace(/<\/?\s*(?:eos|bos|endoftext)\s*>/gi, '');
  // Half-malformed pseudo-tokens — always wrong, never part of a dialect:
  //   <|name>   (open pipe, no close pipe before `>`)
  //   <name|>   (close pipe `|>`, no open pipe `<|`)
  out = out.replace(/<\|[a-zA-Z_][\w]*>/g, '');
  out = out.replace(/<[a-zA-Z_][\w]*\|>/g, '');
  return out;
}

// Generic helpers --------------------------------------------------------

function makeId(i) { return `call_${Date.now()}_${i}`; }

function normalizeName(n, fallbackNamespace) {
  if (!n || typeof n !== 'string') return '';
  const t = n.trim();
  if (t.includes('.')) return t;
  if (['done', 'ask_user', 'set_plan'].includes(t)) return `agent.${t}`;
  return `${fallbackNamespace || 'browser'}.${t}`;
}

function coerceValue(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
    try { return JSON.parse(t); } catch (_) { /* fall through */ }
  }
  return v;
}

function parseMaybeJson(s) {
  if (s == null) return {};
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch (_) {
    // Tolerant retry: many small models emit relaxed-JSON for tool args.
    try { return JSON.parse(softenJson(s)); } catch (__) { return {}; }
  }
}

function parseJsonBlock(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  const a = t.indexOf('['); const az = t.lastIndexOf(']');
  const b = t.indexOf('{'); const bz = t.lastIndexOf('}');
  // Outermost container first: an object whose args hold an array must not
  // parse as just that inner array.
  const spans = [[a, az], [b, bz]];
  if (b !== -1 && (a === -1 || b < a)) spans.reverse();
  for (const [open, close] of spans) {
    if (open === -1 || close <= open) continue;
    const slice = t.slice(open, close + 1);
    try { return JSON.parse(slice); } catch (_) { /* fall through */ }
    try { return JSON.parse(softenJson(slice)); } catch (_) { /* fall through */ }
  }
  // Last resort: try to repair JSON truncated by max_tokens. Find the first
  // `[` or `{` and pass the open suffix through repair (close strings + braces)
  // followed by softenJson (trailing commas, Python literals, etc.).
  const openIdx = (() => {
    if (b !== -1 && (a === -1 || b < a)) return b;
    if (a !== -1) return a;
    return -1;
  })();
  if (openIdx !== -1) {
    const repaired = repairTruncatedJson(t.slice(openIdx));
    if (repaired) {
      try { return JSON.parse(repaired); } catch (_) { /* fall through */ }
      try { return JSON.parse(softenJson(repaired)); } catch (_) { /* give up */ }
    }
  }
  return null;
}

// Best-effort repair for JSON cut off mid-stream (typical when the model
// hits max_tokens). Closes any unterminated string then walks the brace/
// bracket stack and appends the matching closers. Does NOT attempt to
// recover from corruption inside the parsed structure — only truncation.
function repairTruncatedJson(s) {
  if (!s || typeof s !== 'string') return null;
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const want = ch === '}' ? '{' : '[';
      if (stack.length && stack[stack.length - 1] === want) stack.pop();
    }
  }
  if (!stack.length && !inString) return s; // nothing to repair
  let out = s;
  // Drop any trailing partial token (e.g. `"foo: ` with no value yet).
  // Heuristic: if we end mid-string, just close the string.
  if (inString) out += '"';
  // Append closers in reverse order.
  while (stack.length) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  return out;
}

// Walk `s` and apply `transform` only to substrings OUTSIDE of string
// literals. Both `"…"` and `'…'` are recognized so Python-style JSON survives.
// Backslash escapes and BOMs handled.
function _transformOutsideStrings(s, transform) {
  let out = '';
  let buf = '';
  let inString = false;
  let escape = false;
  let quoteChar = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quoteChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      out += transform(buf); buf = '';
      inString = true; quoteChar = ch; out += ch;
      continue;
    }
    buf += ch;
  }
  out += transform(buf);
  return out;
}

// Soften relaxed-JSON to strict JSON. Idempotent: passing valid JSON through
// returns it unchanged. String contents are left untouched.
//   - BOM at start
//   - smart/curly quotes (outside strings)
//   - // and /* … */ comments (outside strings)
//   - Python literals: True/False/None → true/false/null (outside strings)
//   - trailing commas before } or ] (outside strings)
//   - unquoted identifier keys → "key":
// One rung of a parse ladder: the parsed value, or undefined if this rung does
// not apply. Callers distinguish "did not parse" from a parsed null.
function tryParse(s) {
  try { return JSON.parse(s); } catch (err) { void err; return undefined; }
}

function softenJson(s) {
  if (!s || typeof s !== 'string') return s || '';
  let out = s;
  // BOM
  if (out.charCodeAt(0) === 0xFEFF) out = out.slice(1);
  // Smart quotes — universally safe even inside content.
  out = out.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // Apply structure-changing transforms only outside string literals.
  out = _transformOutsideStrings(out, (chunk) => {
    let c = chunk;
    // Strip line comments and block comments.
    c = c.replace(/\/\/[^\n\r]*/g, '');
    c = c.replace(/\/\*[\s\S]*?\*\//g, '');
    // Python literal conversion (word-boundary-anchored so `Truex` is safe).
    c = c.replace(/\bTrue\b/g, 'true');
    c = c.replace(/\bFalse\b/g, 'false');
    c = c.replace(/\bNone\b/g, 'null');
    // Trailing commas before } or ].
    c = c.replace(/,(\s*[}\]])/g, '$1');
    // Quote unquoted identifier keys (top-level + nested).
    c = c.replace(/(^|[{,])(\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1$2"$3"$4');
    return c;
  });
  return out;
}

function flattenJsonCalls(parsed, start) {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  let i = start || 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = item.tool || item.name || item.action || (item.function && item.function.name) || '';
    const rawArgs = item.args || item.arguments || item.parameters || (item.function && item.function.arguments) || null;
    const args = rawArgs == null
      ? omit(item, ['tool', 'name', 'action', 'function', 'args', 'arguments', 'parameters'])
      : (typeof rawArgs === 'string' ? parseMaybeJson(rawArgs) : rawArgs);
    if (name) out.push({ id: makeId(i++), name: normalizeName(name), args: args || {} });
  }
  return out;
}

function omit(obj, keys) {
  const o = {};
  for (const k of Object.keys(obj || {})) if (!keys.includes(k)) o[k] = obj[k];
  return o;
}

// Dialect parsers --------------------------------------------------------

// Hermes / Qwen-Agent: <tool_call>{json}</tool_call> (single or repeated).
// Also handles <tool_calls>[...]</tool_calls> wrapping multiple JSON calls.
function parseHermesToolCalls(text) {
  const out = [];
  let i = 0;
  const plural = /<tool_calls>([\s\S]*?)<\/tool_calls>/gi;
  let pm;
  while ((pm = plural.exec(text))) {
    const arr = parseJsonBlock(pm[1] || '');
    out.push(...flattenJsonCalls(arr, i)); i = out.length;
  }
  const single = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let sm;
  while ((sm = single.exec(text))) {
    const inner = (sm[1] || '').trim();
    const parsed = parseJsonBlock(inner);
    if (parsed) { out.push(...flattenJsonCalls(parsed, i)); i = out.length; continue; }
    const llama = parseLlamaXmlToolCalls(inner);
    for (const c of llama) { c.id = makeId(i++); out.push(c); }
  }
  return out;
}

// Llama-3.1 custom tool format with named parameters.
// <function=NAME><parameter=KEY>VAL</parameter>…</function>
function parseLlamaXmlToolCalls(text) {
  const out = [];
  const rx = /<function=([a-zA-Z0-9_.-]+)>([\s\S]*?)<\/function>/gi;
  let m; let i = 0;
  while ((m = rx.exec(text))) {
    const name = m[1];
    const body = m[2] || '';
    // If body is JSON (no <parameter> tags), parse it as arguments payload.
    if (!/<parameter=/.test(body)) {
      const j = parseJsonBlock(body);
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        out.push({ id: makeId(i++), name: normalizeName(name), args: j });
        continue;
      }
    }
    const args = {};
    const prx = /<parameter=([a-zA-Z0-9_]+)>([\s\S]*?)<\/parameter>/gi;
    let pm;
    while ((pm = prx.exec(body))) args[pm[1]] = coerceValue((pm[2] || '').trim());
    out.push({ id: makeId(i++), name: normalizeName(name), args });
  }
  return out;
}

// Llama python-tag: <|python_tag|>{json}<|eom_id|> or <|python_tag|>{json}\n
function parseLlamaPythonTagToolCalls(text) {
  const out = [];
  const rx = /<\|python_tag\|>([\s\S]*?)(?:<\|eom_id\|>|<\|eot_id\|>|$)/gi;
  let m; let i = 0;
  while ((m = rx.exec(text))) {
    const body = (m[1] || '').trim();
    if (!body) continue;
    const parsed = parseJsonBlock(body);
    if (parsed) out.push(...flattenJsonCalls(parsed, i));
    i = out.length;
  }
  return out;
}

// Mistral v0.3+: [TOOL_CALLS][{name,arguments}, …]
function parseMistralToolCalls(text) {
  const rx = /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/i;
  const m = rx.exec(text);
  if (!m) return [];
  const parsed = parseJsonBlock(m[1]);
  if (!parsed) return [];
  return flattenJsonCalls(parsed, 0);
}

// Claude tool-use XML: <invoke name="NAME"><parameter name="K">V</parameter></invoke>
// Sometimes wrapped in <function_calls>…</function_calls>.
function parseClaudeInvokeToolCalls(text) {
  const out = [];
  const rx = /<invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/invoke>/gi;
  let m; let i = 0;
  while ((m = rx.exec(text))) {
    const name = m[1];
    const body = m[2] || '';
    const args = {};
    const prx = /<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi;
    let pm;
    while ((pm = prx.exec(body))) args[pm[1]] = coerceValue((pm[2] || '').trim());
    out.push({ id: makeId(i++), name: normalizeName(name), args });
  }
  return out;
}

// DeepSeek: <｜tool▁calls▁begin｜>…<｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME\n```json\n{…}\n```<｜tool▁call▁end｜>…<｜tool▁calls▁end｜>
// The vertical-bar separator characters are U+FF5C / U+2581 variants depending on model.
function parseDeepseekToolCalls(text) {
  if (!/tool.?calls.?begin|tool.?call.?begin/i.test(text)) return [];
  const out = [];
  // Normalize the fancy separators so the regex is simpler.
  const norm = text.replace(/[｜]/g, '|').replace(/[▁]/g, '_');
  const rx = /<\|tool_call_begin\|>[\s\S]*?<\|tool_sep\|>\s*([^\n`<]+?)\s*(?:```(?:json)?\s*)?(\{[\s\S]*?\})\s*(?:```)?\s*<\|tool_call_end\|>/gi;
  let m; let i = 0;
  while ((m = rx.exec(norm))) {
    const name = (m[1] || '').trim();
    const parsed = parseJsonBlock(m[2]);
    if (name && parsed) out.push({ id: makeId(i++), name: normalizeName(name), args: parsed });
  }
  return out;
}

// ReAct prose: Action: NAME\nAction Input: {json|kv}
function parseReActToolCalls(text) {
  const rx = /Action:\s*([a-zA-Z0-9_.-]+)\s*[\r\n]+\s*Action Input:\s*([\s\S]*?)(?=(?:\r?\n\s*(?:Thought|Action|Observation|Final Answer):|$))/gi;
  const out = [];
  let m; let i = 0;
  while ((m = rx.exec(text))) {
    const name = m[1];
    const rawArgs = (m[2] || '').trim();
    const parsed = parseJsonBlock(rawArgs);
    const args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { _input: rawArgs };
    out.push({ id: makeId(i++), name: normalizeName(name), args });
  }
  return out;
}

// GPT-OSS Harmony format (OpenAI open-weights):
//   <|channel|>commentary to=functions.NAME[ <|constrain|>json]<|message|>{json}<|call|>
// `<|return|>` and `<|end|>` are also valid stop tokens. The `functions.`
// namespace prefix is stripped — we route to NAME directly. The constrain
// hint is informational and skipped.
function parseHarmonyToolCalls(text) {
  if (!/<\|channel\|>\s*commentary[\s\S]*?<\|message\|>/i.test(text)) return [];
  const out = [];
  const rx = /<\|channel\|>\s*commentary\s+to\s*=\s*([a-zA-Z_][\w.]*)[^<]*?(?:<\|constrain\|>\s*\w+\s*)?<\|message\|>\s*([\s\S]*?)\s*<\|(?:call|return|end)\|>/gi;
  let m; let i = 0;
  while ((m = rx.exec(text))) {
    let name = m[1] || '';
    if (name.startsWith('functions.')) name = name.slice('functions.'.length);
    const parsed = parseJsonBlock(m[2] || '');
    const args = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    if (name) out.push({ id: makeId(i++), name: normalizeName(name), args });
  }
  return out;
}

// Phi-4-mini "functools" format:
//   functools[{"name":"X","arguments":{…}}, {"name":"Y","arguments":{…}}]
// The literal `functools` prefix is required and there is no closing marker.
function parseFunctoolsToolCalls(text) {
  const m = /\bfunctools\s*(\[[\s\S]*\])/i.exec(text);
  if (!m) return [];
  const parsed = parseJsonBlock(m[1]);
  if (!parsed) return [];
  return flattenJsonCalls(parsed, 0);
}

// Llama-3.2 / 3.3 / 4 pythonic tool-call format:
//   [get_weather(city='SF', units='c'), search.find(q="hi", n=5)]
// Args use Python keyword syntax: identifier=expression. Expressions: single-
// or double-quoted strings, numbers, True/False/None, [list], {dict}.
function parsePythonicToolCalls(text) {
  // Find a top-level bracketed list of function calls. Require an immediate
  // identifier-followed-by-`(` after the `[` so we don't match plain JSON arrays.
  const blockRx = /\[\s*([A-Za-z_][\w.]*\s*\([\s\S]*?)\s*\]/g;
  const out = [];
  let i = 0;
  let bm;
  while ((bm = blockRx.exec(text))) {
    const block = bm[1];
    // Walk the block extracting each name(args) call with balanced parens.
    let pos = 0;
    while (pos < block.length) {
      // Skip leading whitespace + commas
      while (pos < block.length && /[\s,]/.test(block[pos])) pos++;
      if (pos >= block.length) break;
      const nameMatch = /^([A-Za-z_][\w.]*)\s*\(/.exec(block.slice(pos));
      if (!nameMatch) break;
      const name = nameMatch[1];
      pos += nameMatch[0].length; // now after the `(`
      const argsEnd = _findMatchingClose(block, pos - 1, '(', ')');
      if (argsEnd === -1) break;
      const argsStr = block.slice(pos, argsEnd);
      const args = _parsePythonKwargs(argsStr);
      out.push({ id: makeId(i++), name: normalizeName(name), args });
      pos = argsEnd + 1;
    }
  }
  return out;
}

// Walk forward from `openIdx` in `s` and return the index of the matching
// close char, respecting string literals. Returns -1 if not balanced.
function _findMatchingClose(s, openIdx, openCh, closeCh) {
  if (s[openIdx] !== openCh) return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  let quoteChar = '';
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quoteChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quoteChar = ch; continue; }
    if (ch === openCh) depth++;
    else if (ch === closeCh) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Parse Python kwargs list: `key='val', n=2, deep=True` → object.
function _parsePythonKwargs(s) {
  const args = {};
  if (!s || !s.trim()) return args;
  // Split on top-level commas (respecting strings + nested () [] {}).
  const parts = _splitTopLevel(s, ',');
  for (const part of parts) {
    const t = part.trim(); if (!t) continue;
    const eq = _findTopLevel(t, '=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const valRaw = t.slice(eq + 1).trim();
    if (!/^[A-Za-z_][\w]*$/.test(key)) continue;
    args[key] = _coercePythonValue(valRaw);
  }
  return args;
}

function _splitTopLevel(s, sep) {
  const out = [];
  let buf = '';
  let depth = 0;
  let inString = false;
  let escape = false;
  let quoteChar = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      buf += ch;
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quoteChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quoteChar = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; buf += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; buf += ch; continue; }
    if (ch === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function _findTopLevel(s, ch) {
  let inString = false;
  let escape = false;
  let quoteChar = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === quoteChar) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; quoteChar = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (c === ch && depth === 0) return i;
  }
  return -1;
}

function _coercePythonValue(raw) {
  if (raw == null) return null;
  const t = raw.trim();
  if (!t) return '';
  // Strings: single or double quoted.
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    // Convert Python single-quoted to JSON double-quoted for parsing.
    if (t[0] === "'") {
      // Replace outer single quotes with double, escape internal `"`, leave \' as '.
      const inner = t.slice(1, -1).replace(/"/g, '\\"').replace(/\\'/g, "'");
      try { return JSON.parse(`"${inner}"`); } catch (_) { return t.slice(1, -1); }
    }
    try { return JSON.parse(t); } catch (_) { return t.slice(1, -1); }
  }
  if (t === 'True') return true;
  if (t === 'False') return false;
  if (t === 'None' || t === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  // Lists / dicts: try strict JSON, fall back to softened JSON.
  if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
    // A parse ladder, not error handling: a model emits JSON, near-JSON, or
    // prose that merely looks bracketed. Each rung is a narrower guess and the
    // raw string is a legitimate final answer, so a rung failing is not a
    // failure of the function.
    const parsed = tryParse(t) ?? tryParse(softenJson(t));
    if (parsed !== undefined) return parsed;
  }
  return t;
}

// Fenced JSON blocks: ```json\n...\n``` (or plain ```...```).
function parseFencedJsonToolCalls(text) {
  const out = [];
  let i = 0;
  const rx = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = rx.exec(text))) {
    const inner = (m[1] || '').trim();
    if (!inner) continue;
    const parsed = parseJsonBlock(inner);
    if (parsed) { out.push(...flattenJsonCalls(parsed, i)); i = out.length; }
  }
  return out;
}

// Raw JSON fallback (the content is (mostly) a JSON object or array).
function parseRawJsonToolCalls(text) {
  const parsed = parseJsonBlock(text);
  if (!parsed) return [];
  return flattenJsonCalls(parsed, 0);
}

// "Custom-call" dialect — an invented format some smaller / weaker models
// produce when asked to use tools but they don't actually speak any standard
// protocol:
//   call:browser.open_tab{url:"https://example.com/"}
//   call:agent.done{summary:"<answer>"}
// Body is relaxed-JSON (unquoted keys are common). We auto-quote the keys and
// JSON.parse, with a tolerant kv-regex fallback if that still fails.
function parseCallSyntaxToolCalls(text) {
  const out = [];
  let i = 0;
  // Use a manual scan instead of a single regex so we can correctly handle
  // bodies with nested braces.
  const rx = /\bcall\s*:\s*([a-zA-Z][\w.-]*)\s*\{/g;
  let m;
  while ((m = rx.exec(text))) {
    const name = m[1];
    const bodyStart = m.index + m[0].length;
    const body = sliceBalancedBraces(text, bodyStart - 1); // includes trailing }
    if (body == null) continue;
    const inner = body.slice(1, -1);
    const args = parseRelaxedKvBody(inner);
    out.push({ id: makeId(i++), name: normalizeName(name), args });
    rx.lastIndex = bodyStart - 1 + body.length;
  }
  return out;
}

// Walk forward from openIdx (index of `{`) and return the matching balanced
// "{...}" substring, or null if braces are unbalanced.
function sliceBalancedBraces(text, openIdx) {
  if (text[openIdx] !== '{') return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
}

function parseRelaxedKvBody(body) {
  if (!body || !body.trim()) return {};
  const trimmed = body.trim();
  // Quote bare identifier keys (top-level AND inside nested {…} objects),
  // then try strict JSON.parse. The leading-context class includes `{` so
  // keys at the start of a nested object also get quoted.
  const quoted = trimmed.replace(/(^|[{,])\s*([a-zA-Z_][\w]*)(\s*:)/g, '$1"$2"$3');
  try {
    const parsed = JSON.parse(`{${quoted}}`);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) { /* fall through */ }
  // Tolerant fallback: pull out key:value pairs by regex.
  const out = {};
  const kv = /([a-zA-Z_][\w]*)\s*:\s*("(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?|\{[^{}]*\}|\[[^[\]]*\])/g;
  let m;
  while ((m = kv.exec(trimmed))) {
    let v = m[2];
    if (v.startsWith('"')) {
      try { v = JSON.parse(v); } catch (_) { v = v.slice(1, -1); }
    } else if (v.startsWith('{') || v.startsWith('[')) {
      try { v = JSON.parse(v); } catch (_) { /* leave as string */ }
    } else {
      v = coerceValue(v);
    }
    out[m[1]] = v;
  }
  return out;
}

// Orchestrator: strip thinking + special-token leakage, then run dialect
// parsers in priority order.
function extractToolCalls(rawContent) {
  const text = stripSpecialTokens(stripThink(rawContent || ''));
  if (!text) return [];
  const parsers = [
    parseHermesToolCalls,            // Qwen3, Granite 3.x/4.x, Hermes, Qwen-Agent
    parseHarmonyToolCalls,           // GPT-OSS Harmony commentary channels
    parseMistralToolCalls,
    parseClaudeInvokeToolCalls,
    parseDeepseekToolCalls,
    parseLlamaPythonTagToolCalls,
    parseLlamaXmlToolCalls,
    parsePythonicToolCalls,          // Llama 3.2 / 3.3 / 4 pythonic
    parseFunctoolsToolCalls,         // Phi-4-mini functools[…]
    parseFencedJsonToolCalls,
    parseReActToolCalls,
    parseCallSyntaxToolCalls,        // hallucinated "call:" syntax
    parseRawJsonToolCalls,           // fallback (with auto-heal inside)
  ];
  for (const fn of parsers) {
    const out = fn(text);
    if (out && out.length) return out;
  }
  return [];
}

// Sentinel: does the content contain tool-call markers of any known dialect?
function looksLikeToolCall(rawContent) {
  if (!rawContent) return false;
  const t = stripSpecialTokens(stripThink(rawContent));
  return /<tool_call[s]?[\s>]|<function=|<invoke\s+name=|<\|python_tag\|>|\[TOOL_CALLS\]|<\|tool[_▁]call[s_]?[_▁]?begin\|>|tool.?calls.?begin|<\|channel\|>\s*commentary\s+to\s*=|\bfunctools\s*\[|Action:\s*\w+[\s\S]*?Action Input:|\bcall\s*:\s*[\w.-]+\s*\{|\[\s*[A-Za-z_][\w.]*\s*\([^)]*\)\s*[,\]]|\{\s*"(tool|name|action|function)"\s*:/i.test(t);
}

module.exports = {
  stripThink,
  stripSpecialTokens,
  softenJson,
  extractToolCalls,
  looksLikeToolCall,
  // individual parsers exported for unit testing
  parseHermesToolCalls,
  parseLlamaXmlToolCalls,
  parseLlamaPythonTagToolCalls,
  parseMistralToolCalls,
  parseClaudeInvokeToolCalls,
  parseDeepseekToolCalls,
  parseReActToolCalls,
  parseFencedJsonToolCalls,
  parseRawJsonToolCalls,
  parseCallSyntaxToolCalls,
  parseHarmonyToolCalls,
  parseFunctoolsToolCalls,
  parsePythonicToolCalls,
  normalizeName,
};
