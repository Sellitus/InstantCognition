// copilotPrompts.js — pure prompt assembly for the Page Copilot. No DOM, no
// IPC: takes extracted page content + a mode and returns OpenAI-style
// {role,content} messages. Kept separate so assembly is unit-testable without
// mounting the panel or driving a webview.

const MAX_PAGE_CHARS = 6000;
const MAX_COMPARE_CHARS = 3000;
const MAX_SELECTION_CHARS = 2000;
// Cap on the NUMBER of items too: per-item clips alone don't bound the message,
// so a many-pane compare or a long council can blow past a small local model's context.
const MAX_COMPARE_PAGES = 8;
const MAX_COUNCIL_ANSWERS = 8;

function clip(s, n) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function pageBlock(page, limit) {
  const p = page || {};
  const title = clip(p.title, 200) || 'Untitled';
  const url = clip(p.url, 300);
  const body = clip(p.mainText, limit) || '(no readable text was extracted from this page)';
  return `Title: ${title}\nURL: ${url}\n\n${body}`;
}

const SYSTEM = {
  summarize:
    'You are a concise reading assistant inside a web browser. Summarize the page the user is viewing: a 2-3 sentence overview, then a short bullet list of the key points. Use only the provided page content — do not invent facts or rely on outside knowledge.',
  ask:
    "You are a precise reading assistant inside a web browser. Answer the user's question using only the provided page content. If the answer is not present in the page, say so plainly instead of guessing.",
  explain:
    'You are a clear explainer inside a web browser. Explain the selected text simply and accurately, using the surrounding page only for context. Be concise.',
  compare:
    'You are an analytical assistant inside a web browser. Compare the pages the user has open. State where they agree, where they disagree or conflict, and what is unique to each. Use only the provided content and refer to pages by their title. Be specific.',
  council:
    'You are the synthesizer for an "AI Council": several AI assistants were asked the same question and each gave an answer. Produce one merged best answer to the question, then a short "Agreements" section, a "Disagreements / conflicts" section that explicitly names which councillors differ and how, and a "Unique points" section. Use only the councillors\' answers — do not add outside facts. Refer to each councillor by name.',
};

// mode: 'summarize' | 'ask' | 'explain' | 'compare'
// input: { page, question, selection, pages }
function buildMessages(mode, input = {}) {
  const m = SYSTEM[mode] ? mode : 'summarize';
  const sys = { role: 'system', content: SYSTEM[m] };

  if (m === 'compare') {
    const pages = Array.isArray(input.pages) ? input.pages : [];
    const parts = pages.slice(0, MAX_COMPARE_PAGES).map((p, i) => `=== Page ${i + 1} ===\n${pageBlock(p, MAX_COMPARE_CHARS)}`);
    return [sys, { role: 'user', content: `Compare the following ${parts.length} pages.\n\n${parts.join('\n\n')}` }];
  }

  if (m === 'council') {
    const answers = Array.isArray(input.answers) ? input.answers : [];
    const q = clip(input.question, 500);
    const capped = answers.slice(0, MAX_COUNCIL_ANSWERS);
    const blocks = capped.map((a, i) => {
      const name = clip(a && a.name, 80) || `Councillor ${i + 1}`;
      const body = clip(a && a.text, MAX_COMPARE_CHARS) || '(no answer captured)';
      return `### ${name}\n${body}`;
    });
    const head = q ? `Question asked of the council:\n${q}\n\n` : '';
    const note = answers.length > MAX_COUNCIL_ANSWERS ? `\n(Note: ${answers.length - MAX_COUNCIL_ANSWERS} additional councillor answers were omitted.)` : '';
    return [sys, { role: 'user', content: `${head}Councillor answers:\n\n${blocks.join('\n\n')}${note}` }];
  }

  const page = input.page || {};

  if (m === 'ask') {
    const q = clip(input.question, 500);
    return [sys, { role: 'user', content: `Question: ${q}\n\n--- Page content ---\n${pageBlock(page, MAX_PAGE_CHARS)}` }];
  }

  if (m === 'explain') {
    const sel = clip(input.selection, MAX_SELECTION_CHARS);
    return [sys, {
      role: 'user',
      content: `Selected text:\n"""\n${sel}\n"""\n\n--- Page context (${clip(page.title, 200) || 'Untitled'}) ---\n${clip(page.mainText, MAX_SELECTION_CHARS)}`,
    }];
  }

  return [sys, { role: 'user', content: `Summarize this page.\n\n${pageBlock(page, MAX_PAGE_CHARS)}` }];
}

module.exports = { buildMessages, MAX_PAGE_CHARS, MAX_COMPARE_CHARS, MAX_SELECTION_CHARS };
