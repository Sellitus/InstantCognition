// axSnapshot — normalize Chrome's Accessibility.getFullAXTree output into a
// compact, numeric-indexed element list the agent can reference by `idx`.
//
// Why: LLM-generated CSS selectors are the #1 reliability failure mode of the
// current agent. Referencing elements by idx (Browser-Use / Nanobrowser /
// AriaAgent pattern) eliminates selector invention entirely — the list itself
// is the ground truth.
//
// Schema per element:
//   { idx, role, name, value?, tag?, href?, backendNodeId, nodeId?,
//     checked?, expanded?, disabled?, focused? }
//
// The snapshot also exposes a stable short `token` and a content hash for
// differential observations in later phases.

// Roles worth showing the agent. Anything interactive or text-bearing.
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'radiogroup', 'switch', 'slider', 'spinbutton',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem',
  'textarea', 'editable', 'togglebutton',
]);

const LANDMARK_ROLES = new Set([
  'heading', 'main', 'navigation', 'banner', 'contentinfo', 'region',
  'search', 'form', 'dialog', 'alertdialog', 'tooltip', 'status',
  'tabpanel', 'article', 'complementary',
]);

// Hidden/ignored/presentational nodes never reach the agent.
function isVisible(node) {
  if (!node) return false;
  if (node.ignored === true) return false;
  const role = axRole(node);
  if (role === 'none' || role === 'presentation' || role === 'generic') {
    // generic keeps children but drops itself via the caller's filter
    return false;
  }
  return true;
}

function axValue(field) {
  if (!field) return undefined;
  if (typeof field === 'string') return field;
  if (typeof field.value === 'string') return field.value;
  if (typeof field.value === 'number' || typeof field.value === 'boolean') return field.value;
  return undefined;
}

function axRole(node) {
  return axValue(node && node.role) || '';
}

function axName(node) {
  const n = axValue(node && node.name);
  return typeof n === 'string' ? n : '';
}

function axProp(node, propName) {
  const props = (node && node.properties) || [];
  for (const p of props) {
    if (!p || !p.name) continue;
    if (p.name === propName) return axValue(p.value);
  }
  return undefined;
}

// Normalize an Accessibility.getFullAXTree `nodes` array into a flat
// numeric-indexed list. Only interactive + landmark roles + nodes with
// visible text survive.
function normalizeAxTree(nodes, options) {
  const opts = options || {};
  const maxNodes = Number.isFinite(opts.maxNodes) && opts.maxNodes > 0 ? opts.maxNodes : 300;
  const elements = [];

  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!isVisible(node)) continue;
    const role = axRole(node);
    if (!role) continue;

    const name = truncate(axName(node), 160);
    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isLandmark = LANDMARK_ROLES.has(role);

    // Drop landmarks without a name and drop generic text nodes.
    if (!isInteractive && !(isLandmark && name)) continue;
    // Skip empty-name buttons/links — they're probably decorative or iframes.
    if (isInteractive && !name && !axValue(node.value)) {
      // Still keep form controls even when unnamed (they may have placeholder only).
      if (role !== 'textbox' && role !== 'searchbox' && role !== 'combobox' && role !== 'textarea') continue;
    }

    const idx = elements.length;
    const el = {
      idx,
      role,
      name,
      backendNodeId: numeric(node.backendDOMNodeId),
      nodeId: numeric(node.nodeId),
    };
    const value = axValue(node.value);
    if (value != null && value !== '') el.value = truncate(String(value), 160);

    const checked = axProp(node, 'checked');
    if (checked != null) el.checked = !!checked;
    const expanded = axProp(node, 'expanded');
    if (expanded != null) el.expanded = !!expanded;
    const disabled = axProp(node, 'disabled');
    if (disabled != null) el.disabled = !!disabled;
    const focused = axProp(node, 'focused');
    if (focused != null) el.focused = !!focused;

    elements.push(el);
    if (elements.length >= maxNodes) break;
  }

  const token = tokenFor(elements);
  return { token, elements };
}

function numeric(n) {
  if (n == null) return undefined;
  const v = typeof n === 'string' ? Number(n) : n;
  return Number.isFinite(v) ? v : undefined;
}

function truncate(s, max) {
  if (!s) return '';
  const str = stripInjections(String(s)).replace(/\s+/g, ' ').trim();
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// Trust-boundary scrubbing — defangs instruction-shaped strings that a
// malicious page might inject into AX name/value fields. We don't drop the
// text entirely (that would make element names unrecoverable) — we prefix
// it with a literal "[untrusted]" marker so the LLM sees it is page content,
// and we neutralize the most blatant patterns ("ignore previous instructions",
// role tags, markdown-fenced system messages).
function stripInjections(s) {
  if (!s) return s;
  let out = s;
  // Neutralize explicit override-attempts (allow up to 3 words between
  // "ignore" and "instructions/prompts/commands" so "ignore all previous
  // instructions" matches).
  out = out.replace(/ignore\s+(?:\S+\s+){0,3}(?:instructions?|prompts?|commands?)/gi, '[neutralized]');
  // Neutralize role header-shaped text that the LLM might misread as a system turn.
  out = out.replace(/^\s*(system|assistant|developer)\s*[:-]/gim, '$1_');
  // Neutralize XML-style prompt wrappers.
  out = out.replace(/<(system|user|assistant|instructions?)>/gi, '[$1]');
  return out;
}

// Cheap non-crypto hash — stable across processes, safe as a snapshot token.
function tokenFor(elements) {
  let h = 0x811c9dc5;
  for (const el of elements) {
    const s = `${el.idx}|${el.role}|${el.name}|${el.value || ''}|${el.backendNodeId || 0}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

// Render the elements as a compact string the LLM can scan.
function renderForPrompt(elements) {
  return elements.map((el) => {
    const bits = [`[${el.idx}]`, el.role];
    if (el.name) bits.push(JSON.stringify(el.name));
    if (el.value != null) bits.push(`value=${JSON.stringify(el.value)}`);
    if (el.checked != null) bits.push(`checked=${el.checked}`);
    if (el.expanded != null) bits.push(`expanded=${el.expanded}`);
    if (el.disabled) bits.push('disabled');
    return bits.join(' ');
  }).join('\n');
}

// Compute a delta between a previous and current snapshot.
// Returns { token, addedIdx[], removedDescriptors[], changed[{idx, before, after}], unchangedCount }.
function diffSnapshots(prev, next) {
  const prevEls = (prev && prev.elements) || [];
  const nextEls = (next && next.elements) || [];
  const prevByKey = new Map();
  for (const el of prevEls) {
    const k = keyOf(el);
    prevByKey.set(k, el);
  }
  const nextByKey = new Map();
  for (const el of nextEls) {
    const k = keyOf(el);
    nextByKey.set(k, el);
  }

  const addedIdx = [];
  const changed = [];
  let unchanged = 0;
  for (const el of nextEls) {
    const k = keyOf(el);
    const before = prevByKey.get(k);
    if (!before) addedIdx.push(el.idx);
    else if (before.value !== el.value || before.checked !== el.checked || before.expanded !== el.expanded || before.disabled !== el.disabled) {
      changed.push({ idx: el.idx, before: { value: before.value, checked: before.checked, expanded: before.expanded, disabled: before.disabled },
                                 after: { value: el.value, checked: el.checked, expanded: el.expanded, disabled: el.disabled } });
    } else unchanged += 1;
  }

  const removedDescriptors = [];
  for (const el of prevEls) {
    if (!nextByKey.has(keyOf(el))) removedDescriptors.push({ role: el.role, name: el.name });
  }

  return {
    token: (next && next.token) || '',
    addedIdx, changed, removedDescriptors, unchangedCount: unchanged,
    elementCount: nextEls.length,
  };
}

// Stable cross-snapshot identity: role + name + backendNodeId, falling back
// to role+name only. idx itself is NOT stable across snapshots.
function keyOf(el) {
  if (!el) return '';
  if (el.backendNodeId != null) return `${el.role}|${el.name}|${el.backendNodeId}`;
  return `${el.role}|${el.name}`;
}

module.exports = { normalizeAxTree, renderForPrompt, tokenFor, diffSnapshots, stripInjections };
