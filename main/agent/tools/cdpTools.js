// cdpTools — high-fidelity agent tools built on Chrome DevTools Protocol
// (via Electron's webContents.debugger). These replace selector-based
// click/type with indexed-element actions grounded in the accessibility tree.
//
// Coexists with the legacy selector-based browser tools in browser.js.
// Tools here gracefully fall back to executeJavaScript when CDP attach fails
// (e.g. DevTools already open on the tab).

const cdpSessions = require('../../services/CdpSessionManager');
const { normalizeAxTree, renderForPrompt, diffSnapshots } = require('../axSnapshot');
const { errMsg } = require('../../../shared/errMsg');

function activeWc(toolCtx, spaceId) {
  if (spaceId) {
    if (typeof toolCtx.resolveWc === 'function') return toolCtx.resolveWc(spaceId) || toolCtx.defaultWebContents;
    return toolCtx.defaultWebContents;
  }
  const reg = toolCtx.tabRegistry;
  if (reg && typeof reg.list === 'function' && typeof toolCtx.resolveWc === 'function') {
    const active = reg.list().find((t) => t.isActive && t.webContentsId != null);
    if (active) {
      const wc = toolCtx.resolveWc(active.spaceId);
      if (wc) return wc;
    }
  }
  return toolCtx.defaultWebContents;
}

// Try CDP path first; if attach fails, the tool should signal cdp_unavailable
// so the caller (or agent) can fall back to selector-based tools.
async function ensureCdp(wc) {
  if (!wc) return { ok: false, error: 'webcontents_unavailable' };
  if (!cdpSessions.isAttached(wc) && !cdpSessions.tryAttach(wc)) return { ok: false, error: 'cdp_unavailable' };
  return { ok: true };
}

async function enableDomains(wc) {
  // Idempotent — CDP domains can be enabled repeatedly.
  await cdpSessions.send(wc, 'Accessibility.enable').catch((err) => { console.error('[cdpTools] Accessibility.enable failed:', (err instanceof Error && err.message) || err); });
  await cdpSessions.send(wc, 'DOM.enable').catch((err) => { console.error('[cdpTools] DOM.enable failed:', (err instanceof Error && err.message) || err); });
}

async function getBoxCenter(wc, backendNodeId) {
  try {
    const res = await cdpSessions.send(wc, 'DOM.getBoxModel', { backendNodeId });
    const q = res && res.model && res.model.content;
    if (!Array.isArray(q) || q.length < 8) return null;
    const x = (q[0] + q[2] + q[4] + q[6]) / 4;
    const y = (q[1] + q[3] + q[5] + q[7]) / 4;
    return { x, y, width: res.model.width, height: res.model.height };
  } catch (_) { return null; }
}

function resolveIdx(wc, idx) {
  const snap = cdpSessions.getSnapshot(wc);
  if (!snap || !Array.isArray(snap.elements)) {
    const reason = cdpSessions.isStaleDueToNavigation(wc) ? 'navigated' : 'no_snapshot';
    return { element: null, reason, count: 0 };
  }
  const count = snap.elements.length;
  if (idx == null || idx < 0 || idx >= count) return { element: null, reason: 'out_of_range', count };
  return { element: snap.elements[idx] || null, reason: snap.elements[idx] ? 'ok' : 'empty_slot', count };
}

// Shape the idx-lookup failure so the model can self-correct. Tells it (a) why
// it failed, (b) what the valid range is, and (c) what to do next.
function idxErr(resolved, requestedIdx) {
  if (resolved.reason === 'no_snapshot') {
    return { ok: false, error: 'idx_not_in_snapshot', reason: 'no_snapshot', hint: 'Call browser.snapshot_ax first, then use idx values from its output.' };
  }
  if (resolved.reason === 'navigated') {
    return { ok: false, error: 'idx_not_in_snapshot', reason: 'navigated', hint: 'The page navigated since the last snapshot_ax — the cached idx values are stale. Call browser.snapshot_ax again, then use the fresh idx values.' };
  }
  if (resolved.reason === 'out_of_range') {
    const max = Math.max(0, resolved.count - 1);
    return { ok: false, error: 'idx_not_in_snapshot', reason: 'out_of_range', requestedIdx, snapshotElementCount: resolved.count, validIdxRange: [0, max], hint: `Snapshot has ${resolved.count} elements (valid idx 0..${max}). Re-read the last snapshot_ax output or call snapshot_ax again — do not guess idx.` };
  }
  return { ok: false, error: 'idx_not_in_snapshot', reason: resolved.reason };
}

const snapshotAx = {
  name: 'browser.snapshot_ax',
  description: 'Snapshot the accessibility tree of a tab as a numeric-indexed list of interactive and landmark elements. Use this FIRST before clicking or typing — the LLM then references elements by their idx (e.g. click_idx idx=5). Returns {token, elements, rendered}.',
  parameters: { type: 'object', properties: { spaceId: { type: 'string' }, maxNodes: { type: 'number' } }, required: [] },
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    const attach = await ensureCdp(wc);
    if (!attach.ok) return attach;
    try {
      await enableDomains(wc);
      const res = await cdpSessions.send(wc, 'Accessibility.getFullAXTree', {});
      const normalized = normalizeAxTree(res && res.nodes, { maxNodes: args.maxNodes || 300 });
      cdpSessions.setSnapshot(wc, normalized);
      return {
        ok: true,
        token: normalized.token,
        elementCount: normalized.elements.length,
        elements: normalized.elements,
        rendered: renderForPrompt(normalized.elements),
      };
    } catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

async function dispatchClickAt(wc, x, y, button, clickCount) {
  const btn = button || 'left';
  const count = clickCount || 1;
  await cdpSessions.send(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await cdpSessions.send(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: btn, clickCount: count });
  await cdpSessions.send(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: btn, clickCount: count });
}

const clickIdx = {
  name: 'browser.click_idx',
  description: 'Click an element by its idx from the last snapshot_ax. Dispatches real pointer events via CDP — triggers hover handlers, analytics, and bot-detection-friendly events that el.click() misses.',
  parameters: { type: 'object', properties: { spaceId: { type: 'string' }, idx: { type: 'number' }, button: { type: 'string' }, clickCount: { type: 'number' } }, required: ['idx'] },
  sideEffect: true,
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    const attach = await ensureCdp(wc);
    if (!attach.ok) return attach;
    const resolved = resolveIdx(wc, args.idx);
    const el = resolved.element;
    if (!el) return idxErr(resolved, args.idx);
    if (el.backendNodeId == null) return { ok: false, error: 'no_backend_node_id' };
    try {
      const center = await getBoxCenter(wc, el.backendNodeId);
      if (!center) return { ok: false, error: 'box_model_unavailable' };
      await dispatchClickAt(wc, center.x, center.y, args.button, args.clickCount);
      return { ok: true, clicked: { idx: el.idx, role: el.role, name: el.name }, at: { x: center.x, y: center.y } };
    } catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

const hoverIdx = {
  name: 'browser.hover_idx',
  description: 'Move the pointer over an element by idx. Triggers hover-gated menus and tooltips.',
  parameters: { type: 'object', properties: { spaceId: { type: 'string' }, idx: { type: 'number' } }, required: ['idx'] },
  sideEffect: true,
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    const attach = await ensureCdp(wc);
    if (!attach.ok) return attach;
    const resolved = resolveIdx(wc, args.idx);
    const el = resolved.element;
    if (!el) return idxErr(resolved, args.idx);
    try {
      const center = await getBoxCenter(wc, el.backendNodeId);
      if (!center) return { ok: false, error: 'box_model_unavailable' };
      await cdpSessions.send(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y, button: 'none' });
      return { ok: true, hovered: { idx: el.idx, role: el.role, name: el.name } };
    } catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

async function focusBackendNode(wc, backendNodeId) {
  try { await cdpSessions.send(wc, 'DOM.focus', { backendNodeId }); return true; }
  catch (_) { return false; }
}

const typeText = {
  name: 'browser.type_text',
  description: 'Type text into an element. If idx is given, focus that element first. Uses Input.insertText for speed; dispatches real key events when delayMs > 0 so JS listeners fire per character.',
  parameters: { type: 'object', properties: { spaceId: { type: 'string' }, idx: { type: 'number' }, text: { type: 'string' }, delayMs: { type: 'number' }, clearFirst: { type: 'boolean' } }, required: ['text'] },
  sideEffect: true,
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    const attach = await ensureCdp(wc);
    if (!attach.ok) return attach;
    try {
      if (args.idx != null) {
        const resolved = resolveIdx(wc, args.idx);
        const el = resolved.element;
        if (!el) return idxErr(resolved, args.idx);
        if (el.backendNodeId != null) await focusBackendNode(wc, el.backendNodeId);
      }
      if (args.clearFirst) {
        // Select all in the focused field, then backspace — works for most inputs.
        await cdpSessions.send(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 });
        await cdpSessions.send(wc, 'Input.dispatchKeyEvent', { type: 'keyUp',   key: 'a', code: 'KeyA', modifiers: 4 });
        await cdpSessions.send(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
        await cdpSessions.send(wc, 'Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Backspace', code: 'Backspace' });
      }
      const text = String(args.text || '');
      const delay = Number(args.delayMs || 0);
      if (delay <= 0) {
        await cdpSessions.send(wc, 'Input.insertText', { text });
      } else {
        for (const ch of text) {
          await cdpSessions.send(wc, 'Input.insertText', { text: ch });
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }
      }
      return { ok: true, typed: text.length };
    } catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

// Map common key names to CDP codes. The key string is what JS sees.
const KEY_MAP = {
  Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 },
  Tab:    { code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { code: 'Backspace', key: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { code: 'Delete', key: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp:    { code: 'ArrowUp', key: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown:  { code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft:  { code: 'ArrowLeft', key: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { code: 'PageUp', key: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { code: 'PageDown', key: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { code: 'Home', key: 'Home', windowsVirtualKeyCode: 36 },
  End: { code: 'End', key: 'End', windowsVirtualKeyCode: 35 },
  Space: { code: 'Space', key: ' ', windowsVirtualKeyCode: 32 },
};

function modifierMask(mods) {
  if (!mods) return 0;
  let m = 0;
  const arr = Array.isArray(mods) ? mods : String(mods).split(/[,+]/);
  for (const raw of arr) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'alt') m |= 1;
    else if (s === 'ctrl' || s === 'control') m |= 2;
    else if (s === 'meta' || s === 'cmd' || s === 'command') m |= 4;
    else if (s === 'shift') m |= 8;
  }
  return m;
}

const pressKeyReal = {
  name: 'browser.press_key_real',
  description: 'Dispatch a real OS-level keyboard event via CDP. Use for keys that page JS listens to (Enter to submit forms, Tab to navigate, Escape to close modals). Supports modifiers like ["ctrl","shift"].',
  parameters: { type: 'object', properties: { spaceId: { type: 'string' }, key: { type: 'string' }, modifiers: { type: ['array', 'string'] } }, required: ['key'] },
  sideEffect: true,
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    const attach = await ensureCdp(wc);
    if (!attach.ok) return attach;
    const spec = KEY_MAP[args.key] || { code: args.key, key: args.key };
    const modifiers = modifierMask(args.modifiers);
    try {
      await cdpSessions.send(wc, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: spec.key, code: spec.code,
        windowsVirtualKeyCode: spec.windowsVirtualKeyCode || 0, modifiers,
      });
      await cdpSessions.send(wc, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: spec.key, code: spec.code,
        windowsVirtualKeyCode: spec.windowsVirtualKeyCode || 0, modifiers,
      });
      return { ok: true, key: args.key };
    } catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

const fillForm = {
  name: 'browser.fill_form',
  description: 'Fill multiple form fields in one call. Pass fields as [{idx, value}] pairs (idx from snapshot_ax). Optional clearFirst clears each field before typing. Use this instead of N type_text calls so a form submit costs 2 steps (snapshot_ax + fill_form), not N+1.',
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string' },
      fields: {
        type: 'array',
        items: { type: 'object', properties: { idx: { type: 'number' }, value: { type: 'string' } }, required: ['idx', 'value'] },
      },
      clearFirst: { type: 'boolean' },
      delayMs: { type: 'number' },
    },
    required: ['fields'],
  },
  sideEffect: true,
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    const attach = await ensureCdp(wc);
    if (!attach.ok) return attach;
    const fields = Array.isArray(args.fields) ? args.fields : [];
    if (!fields.length) return { ok: false, error: 'no_fields' };
    const filled = [];
    try {
      for (const f of fields) {
        const idx = f && typeof f.idx === 'number' ? f.idx : null;
        if (idx == null) return { ok: false, error: 'field_missing_idx', filledSoFar: filled };
        const resolved = resolveIdx(wc, idx);
        const el = resolved.element;
        if (!el) return { ok: false, error: 'idx_not_in_snapshot', ...idxErr(resolved, idx), filledSoFar: filled };
        if (el.backendNodeId != null) {
          const focused = await focusBackendNode(wc, el.backendNodeId);
          if (!focused) return { ok: false, error: 'focus_failed', idx, filledSoFar: filled };
        }
        if (args.clearFirst) {
          await cdpSessions.send(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4 });
          await cdpSessions.send(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
          await cdpSessions.send(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
          await cdpSessions.send(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
        }
        const text = String(f.value == null ? '' : f.value);
        const delay = Number(args.delayMs || 0);
        if (delay <= 0) {
          await cdpSessions.send(wc, 'Input.insertText', { text });
        } else {
          for (const ch of text) {
            await cdpSessions.send(wc, 'Input.insertText', { text: ch });
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          }
        }
        filled.push({ idx, typed: text.length });
      }
      return { ok: true, filledCount: filled.length, filled };
    } catch (err) { return { ok: false, error: (err instanceof Error && err.message) || String(err), filledSoFar: filled }; }
  },
};

const waitForLoad = {
  name: 'browser.wait_for_load',
  description: 'Wait until a tab finishes loading (no network activity for ~500ms, up to timeoutMs). Use after navigate or after clicks that load new pages.',
  parameters: { type: 'object', properties: { spaceId: { type: 'string' }, timeoutMs: { type: 'number' } }, required: [] },
  sideEffect: true,
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    if (!wc) return { ok: false, error: 'webcontents_unavailable' };
    const timeoutMs = Number(args.timeoutMs) || 10000;
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'timeout' }); } }, timeoutMs);
      const finish = (ok, detail) => {
        if (done) return; done = true;
        clearTimeout(timer);
        try { wc.removeListener('did-stop-loading', onStop); } catch (err) { console.error('[cdpTools] removeListener did-stop-loading failed:', (err instanceof Error && err.message) || err); }
        try { wc.removeListener('did-finish-load', onStop); } catch (err) { console.error('[cdpTools] removeListener did-finish-load failed:', (err instanceof Error && err.message) || err); }
        resolve(ok ? { ok: true, detail } : { ok: false, error: detail || 'failed' });
      };
      const onStop = () => finish(true, 'did-stop-loading');
      // If already idle, resolve quickly.
      if (typeof wc.isLoading === 'function' && !wc.isLoading()) {
        return finish(true, 'already-idle');
      }
      if (typeof wc.once === 'function') {
        wc.once('did-stop-loading', onStop);
        wc.once('did-finish-load', onStop);
      } else {
        finish(false, 'no-event-api');
      }
    });
  },
};

const snapshotAxDiff = {
  name: 'browser.snapshot_ax_diff',
  description: 'Differential snapshot: returns what changed vs the last snapshot_ax on this tab (addedIdx, removedDescriptors, changed). Preferred in Efficient mode to save tokens. Also updates the cached snapshot so idx references stay valid.',
  parameters: { type: 'object', properties: { spaceId: { type: 'string' }, maxNodes: { type: 'number' } }, required: [] },
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    const attach = await ensureCdp(wc);
    if (!attach.ok) return attach;
    try {
      await enableDomains(wc);
      const prev = cdpSessions.getSnapshot(wc);
      const res = await cdpSessions.send(wc, 'Accessibility.getFullAXTree', {});
      const next = normalizeAxTree(res && res.nodes, { maxNodes: args.maxNodes || 300 });
      cdpSessions.setSnapshot(wc, next);
      const diff = diffSnapshots(prev, next);
      return {
        ok: true,
        token: next.token,
        elementCount: next.elements.length,
        diff,
        // Always include the full element list for added idx values so the LLM
        // can target them immediately without a follow-up snapshot.
        addedElements: next.elements.filter((e) => diff.addedIdx.includes(e.idx)),
      };
    } catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

module.exports = [snapshotAx, snapshotAxDiff, clickIdx, hoverIdx, typeText, fillForm, pressKeyReal, waitForLoad];
module.exports.activeWc = activeWc;
