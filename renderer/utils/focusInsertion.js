// focusInsertion.js — drop transcribed text into whatever input the user
// has focused (URL bar, agent panel composer, broadcast composer, etc).
// Falls back to opening the agent panel if no input is focused.

function isEditableElement(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' && el.type !== 'submit' && el.type !== 'button' && el.type !== 'checkbox' && el.type !== 'radio') return true;
  if (tag === 'TEXTAREA') return true;
  if (el.isContentEditable) return true;
  return false;
}

function insertIntoElement(el, text, { mode = 'append-with-space' } = {}) {
  if (!isEditableElement(el)) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    if (mode === 'replace') {
      el.value = String(text);
    } else {
      const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
      const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
      const before = el.value.slice(0, start);
      const after = el.value.slice(end);
      const sep = before && !/\s$/.test(before) ? ' ' : '';
      const inserted = sep + String(text);
      el.value = before + inserted + after;
      const cursor = (before + inserted).length;
      try { el.setSelectionRange(cursor, cursor); } catch (_) {}
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el.isContentEditable) {
    if (mode === 'replace') { el.textContent = String(text); }
    else {
      try { document.execCommand('insertText', false, (el.textContent && !/\s$/.test(el.textContent) ? ' ' : '') + String(text)); }
      catch (_) { el.textContent = (el.textContent || '') + ' ' + String(text); }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return false;
}

// Public entry point. Returns { ok, where: 'focused'|'agent'|'none' }.
function insertTranscript(text, { mode = 'append-with-space' } = {}) {
  if (!text || typeof text !== 'string') return { ok: false, where: 'none' };
  const focused = (typeof document !== 'undefined') ? document.activeElement : null;
  if (focused && insertIntoElement(focused, text, { mode })) return { ok: true, where: 'focused' };
  // Fallback: open the agent panel and drop text into its composer.
  try {
    const agentPanel = require('../components/AgentPanel');
    if (agentPanel && typeof agentPanel.open === 'function') {
      agentPanel.open({ scope: 'global' });
      const input = agentPanel.input;
      if (input) {
        if (mode === 'replace') input.value = text;
        else input.value = (input.value || '').replace(/\s+$/, '') + (input.value ? ' ' : '') + text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        try { input.focus(); } catch (_) {}
        return { ok: true, where: 'agent' };
      }
    }
  } catch (_) { /* AgentPanel unavailable in some builds */ }
  return { ok: false, where: 'none' };
}

module.exports = { insertTranscript, insertIntoElement, isEditableElement };
