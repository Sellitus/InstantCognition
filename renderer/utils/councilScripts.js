// councilScripts.js — page-injected scripts and the research task template used
// by the unified chat's /council and /research actions. Kept as pure string
// builders (no DOM, no IPC) so the assembly is unit-testable and the runtime
// only has to executeJavaScript the result inside each AI-service pane.

// Reads the latest assistant turn out of common LLM-site DOMs. Heuristic: try
// known assistant-message selectors newest-last, falling back to <main>.
const COUNCIL_EXTRACTOR = `(function(){
  const sels = [
    '[data-message-author-role="assistant"]',
    '[data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
    '.font-claude-message',
    'div[class*="ProseMirror"]',
    '.markdown.prose',
    'article',
    '.message',
  ];
  let last = null;
  for (const s of sels) {
    const els = document.querySelectorAll(s);
    if (els && els.length) { last = els[els.length - 1]; break; }
  }
  if (!last) {
    const main = document.querySelector('main') || document.body;
    return (main.innerText || '').trim().slice(-4000);
  }
  return (last.innerText || '').trim().slice(0, 8000);
})();`;

// Build the prompt-injection IIFE for one AI-service pane: type `text` into the
// page's composer (textarea / contenteditable / text input) and, when
// `autoSubmit`, click the send button (or submit the form / press Enter).
function buildInjectScript(text, autoSubmit) {
  return `
    (function() {
      const text = ${JSON.stringify(String(text == null ? '' : text))};
      const autoSubmit = ${JSON.stringify(!!autoSubmit)};

      function findSendButton() {
        const selectors = [
          'button[data-testid="send-button"]',
          'button[aria-label="Send Message"]',
          'button[aria-label="Send message"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="submit"]',
          'form button[type="submit"]',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled) return btn;
        }
        return null;
      }

      function submitAfterDelay(el) {
        if (!autoSubmit) return;
        setTimeout(() => {
          const sendBtn = findSendButton();
          if (sendBtn) { sendBtn.click(); return; }
          const form = el.closest('form');
          if (form) { form.requestSubmit(); return; }
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }, 100);
      }

      const ta = document.querySelector('textarea');
      if (ta) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(ta, text);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        submitAfterDelay(ta);
        return 'textarea';
      }
      const ce = document.querySelector('div[contenteditable="true"]');
      if (ce) {
        ce.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
        submitAfterDelay(ce);
        return 'contenteditable';
      }
      const inp = document.querySelector('input[type="text"]');
      if (inp) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(inp, text);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        submitAfterDelay(inp);
        return 'input';
      }
      return null;
    })();
  `;
}

// The Research Report agent task: web-search, open cited sources as panes, and
// write a markdown report whose [N] citations map to the opened sources.
function buildResearchTask(question) {
  const q = String(question == null ? '' : question).trim();
  return [
    'Research Report Mode. Research the question below and produce a',
    'well-structured, cited markdown report.',
    '',
    'Question: ' + q,
    '',
    'Process:',
    '1. Use browser.web_search to find 3-8 strong, diverse, credible sources.',
    '2. Call browser.open_research_sources ONCE with the final ordered list.',
    '3. Read the sources as needed, then write the report in markdown with',
    '   clear sections. Cite every factual claim inline using the [index]',
    '   numbers returned by browser.open_research_sources (e.g. "...[2]").',
    '4. End with a "## Sources" list mapping each [index] to its title + URL.',
    'Cite only opened sources; never fabricate citations or URLs.',
  ].join('\n');
}

module.exports = { COUNCIL_EXTRACTOR, buildInjectScript, buildResearchTask };
