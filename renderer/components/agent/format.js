// format — shared formatters for agent tool calls + results. Pulled out of
// AgentPanel so StepGroup, AnswerView, and transcript export all share one
// source of truth.

const { escapeHtml } = require('../../utils/html');

function shortName(name) {
  if (!name) return '';
  const i = name.indexOf('.');
  return i === -1 ? name : name.slice(i + 1);
}

function formatCall(call) {
  if (!call) return '';
  const d = { action: shortName(call.name), ...(call.args || {}) };
  return formatDecision(d);
}

function formatCallResult(call, result) {
  if (!call || !result) return '';
  const d = { action: shortName(call.name), ...(call.args || {}) };
  return formatResult(d, result);
}

function formatDecision(d) {
  if (!d || !d.action) return '';
  const target = d.spaceId ? ` (${d.spaceId})` : '';
  switch (d.action) {
    case 'list_tabs': return 'Listing open tabs';
    case 'read_tab': return `Reading tab${target || ' (active)'}`;
    case 'screenshot_tabs': return `Viewing tabs: ${(d.spaceIds || []).join(', ') || '(none)'}`;
    case 'click': return `Click ${d.selector || '?'}${target}`;
    case 'type': {
      const preview = String(d.text || '').slice(0, 40);
      return `Type "${preview}" → ${d.selector || '?'}${target}`;
    }
    case 'scroll': return `Scroll ${d.direction || 'down'} ${d.amount || 400}px${target}`;
    case 'wait': return `Wait for ${d.selector || '?'}${target}`;
    case 'navigate': return `Navigate to ${d.url || '?'}${target}`;
    case 'extract': return `Extract ${d.selector || '?'}${target}`;
    case 'get_selection': return `Get selection${target}`;
    case 'press_key': return `Press ${d.key || '?'}${target}`;
    case 'open_tab': return `Open tab: ${d.url || '?'}`;
    case 'close_tab': return `Close tab${target}`;
    case 'focus_tab': return `Focus tab${target}`;
    case 'done': return d.summary || 'Done';
    case 'ask_user': return `Ask user: ${d.question || ''}`;
    case 'set_plan': return `Plan: ${(d.steps || []).join(' → ')}`;
    default: return d.action;
  }
}

function formatResult(decision, result) {
  if (!decision || !result) return '';
  if (result.error === 'intra_tab_conflict') return `→ rejected: intra-tab conflict (retry next turn)`;
  if (result.error === 'tool_timeout') return `→ timed out after ${result.timeoutMs}ms`;
  if (!result.ok) return `→ failed: ${result.error || 'unknown'}${result.details ? ' (' + result.details.join(',') + ')' : ''}`;
  switch (decision.action) {
    case 'list_tabs': {
      const n = (result.tabs || []).length;
      return `→ ${n} open tab${n === 1 ? '' : 's'}`;
    }
    case 'read_tab': {
      const t = result.title || '(untitled)';
      const wc = result.wordCount != null ? ` · ${result.wordCount} words` : '';
      return `→ read ${t}${wc}`;
    }
    case 'screenshot_tabs': {
      const n = (result.images || []).length;
      return `→ captured ${n} image${n === 1 ? '' : 's'}`;
    }
    case 'extract':
      return `→ ${String(result.text || '').slice(0, 120)}`;
    case 'get_selection':
      return `→ "${String(result.text || '').slice(0, 100)}"`;
    case 'scroll':
      return `→ scrolled`;
    default:
      return `→ ok`;
  }
}

// Relative-time label suitable for history rows ("just now", "2m ago", etc.)
function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  if (!Number.isFinite(diff) || diff < 0) return '';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

module.exports = {
  escapeHtml, shortName,
  formatCall, formatCallResult, formatDecision, formatResult,
  relTime, formatDuration,
};
