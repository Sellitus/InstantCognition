// advancedTools — higher-level browser tools that close the gaps exposed by
// real agent runs: a multi-condition `wait_for` that doesn't need a CSS
// selector, a `locate` that maps role/name → AX idx so the model never has
// to invent selectors, a `scroll_to_idx` helper, and simple back/forward
// navigation.

const cdpSessions = require('../../services/CdpSessionManager');
const { normalizeAxTree } = require('../axSnapshot');
const { errMsg } = require('../../../shared/errMsg');

function activeWc(toolCtx, spaceId) {
  if (spaceId && typeof toolCtx.resolveWc === 'function') {
    return toolCtx.resolveWc(spaceId) || toolCtx.defaultWebContents;
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

async function ensureCdp(wc) {
  if (!wc) return { ok: false, error: 'webcontents_unavailable' };
  if (!cdpSessions.isAttached(wc) && !cdpSessions.tryAttach(wc)) return { ok: false, error: 'cdp_unavailable' };
  return { ok: true };
}

// Polls in the page for selector / text / min_words with a shared deadline.
function buildWaitPollScript({ selector, text, minWords, timeoutMs, pollMs }) {
  const jsSel = JSON.stringify(selector || '');
  const jsText = JSON.stringify(text || '');
  const minW = Number(minWords) || 0;
  const deadlineMs = Number(timeoutMs) || 8000;
  const tick = Number(pollMs) || 150;
  return `
(function () {
  return new Promise(function (resolve) {
    var selector = ${jsSel};
    var needle = ${jsText};
    var minWords = ${minW};
    var deadline = Date.now() + ${deadlineMs};
    function bodyText() {
      var b = document.body;
      return b ? (b.innerText || b.textContent || '') : '';
    }
    function check() {
      try {
        if (selector) { var el = document.querySelector(selector); if (el) return { ok: true, via: 'selector' }; }
        if (needle) { var t = bodyText(); if (t.indexOf(needle) !== -1) return { ok: true, via: 'text' }; }
        if (minWords > 0) { var words = bodyText().split(/\\s+/).filter(Boolean).length; if (words >= minWords) return { ok: true, via: 'min_words', wordCount: words }; }
      } catch (_) { /* swallow */ }
      return null;
    }
    function tick() {
      var hit = check();
      if (hit) return resolve(hit);
      if (Date.now() >= deadline) return resolve({ ok: false, error: 'timeout', wordCount: bodyText().split(/\\s+/).filter(Boolean).length });
      setTimeout(tick, ${tick});
    }
    tick();
  });
})();`;
}

async function waitForNetworkIdle(wc, { timeoutMs, quietMs }) {
  const attach = await ensureCdp(wc);
  if (!attach.ok) return attach;
  try { await cdpSessions.send(wc, 'Network.enable'); } catch (_) { /* best effort */ }
  return new Promise((resolve) => {
    let inflight = 0;
    let idleTimer = null;
    let settled = false;
    const dbg = wc.debugger;
    const onMessage = (_ev, method) => {
      if (method === 'Network.requestWillBeSent') {
        inflight += 1;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        inflight = Math.max(0, inflight - 1);
        if (inflight === 0) armIdle();
      }
    };
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (idleTimer) clearTimeout(idleTimer);
      try { dbg.removeListener('message', onMessage); } catch (_) { /* ignore */ }
    };
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { cleanup(); resolve({ ok: true, via: 'network_idle' }); }, quietMs);
    };
    const deadline = setTimeout(() => { cleanup(); resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
    try { dbg.on('message', onMessage); }
    catch (_) { cleanup(); resolve({ ok: false, error: 'cdp_no_listener' }); return; }
    armIdle();
  });
}

const waitFor = {
  name: 'browser.wait_for',
  description: 'Wait until a page condition holds. Pass any combination of: {selector} (CSS appears), {text} (substring appears in body), {min_words} (body word count reaches N — use to detect SPA hydration), {network_idle:true} (no in-flight fetches for quietMs). Returns {ok, via} on success or {ok:false, error:"timeout"}. Prefer this over browser.wait — it does not require a selector.',
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string' },
      selector: { type: 'string' },
      text: { type: 'string' },
      min_words: { type: 'number' },
      network_idle: { type: 'boolean' },
      timeoutMs: { type: 'number' },
      quietMs: { type: 'number' },
    },
    required: [],
  },
  sideEffect: true,
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    if (!wc) return { ok: false, error: 'webcontents_unavailable' };
    const timeoutMs = Number(args.timeoutMs) || 8000;
    const quietMs = Number(args.quietMs) || 500;
    const hasJsCond = !!(args.selector || args.text || args.min_words);
    if (!hasJsCond && !args.network_idle) {
      return { ok: false, error: 'no_condition', hint: 'Pass at least one of: selector, text, min_words, network_idle.' };
    }
    const tasks = [];
    if (hasJsCond && typeof wc.executeJavaScript === 'function') {
      tasks.push(wc.executeJavaScript(buildWaitPollScript({
        selector: args.selector, text: args.text, minWords: args.min_words, timeoutMs, pollMs: 150,
      }), true).catch((err) => ({ ok: false, error: err.message || String(err) })));
    }
    if (args.network_idle) tasks.push(waitForNetworkIdle(wc, { timeoutMs, quietMs }));
    if (!tasks.length) return { ok: false, error: 'no_runnable_condition' };
    // First truthy condition wins. Promise.any isn't reliable for {ok:false} results,
    // so race manually: resolve on first ok, else return the last non-ok result.
    const results = await Promise.all(tasks);
    const winner = results.find((r) => r && r.ok);
    if (winner) return winner;
    return results[0] || { ok: false, error: 'timeout' };
  },
};

// name_pattern is a regex source, not a full JS regex literal. We honor
// implicit case-insensitivity: /foo/i by default, but callers can pass flags
// via name_flags.
function buildMatcher(args) {
  if (args.name_pattern) {
    try {
      const re = new RegExp(args.name_pattern, args.name_flags || 'i');
      return (s) => re.test(s || '');
    } catch (_) { /* fall through to exact/substring */ }
  }
  if (args.name != null && args.name !== '') {
    const needle = String(args.name).toLowerCase();
    return (s) => String(s || '').toLowerCase().includes(needle);
  }
  if (args.text != null && args.text !== '') {
    const needle = String(args.text).toLowerCase();
    return (s) => String(s || '').toLowerCase().includes(needle);
  }
  return () => true;
}

async function ensureSnapshot(wc) {
  let snap = cdpSessions.getSnapshot(wc);
  if (snap && Array.isArray(snap.elements)) return { ok: true, snapshot: snap, fresh: false };
  const attach = await ensureCdp(wc);
  if (!attach.ok) return attach;
  try {
    await cdpSessions.send(wc, 'Accessibility.enable').catch(() => {});
    const res = await cdpSessions.send(wc, 'Accessibility.getFullAXTree', {});
    snap = normalizeAxTree(res && res.nodes, { maxNodes: 300 });
    cdpSessions.setSnapshot(wc, snap);
    return { ok: true, snapshot: snap, fresh: true };
  } catch (err) { return { ok: false, error: errMsg(err) }; }
}

const locate = {
  name: 'browser.locate',
  description: 'Find elements in the accessibility snapshot by role and/or name. Pass {role} (exact role like "button"/"link"/"textbox"), {name_pattern} (regex), {name} (case-insensitive substring), or {text} (alias for name). Returns {ok, matches:[{idx,role,name,value}]} so you can immediately click_idx/type_text the result. Auto-snapshots if needed. Use this instead of inventing CSS selectors.',
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string' },
      role: { type: 'string' },
      name: { type: 'string' },
      name_pattern: { type: 'string' },
      name_flags: { type: 'string' },
      text: { type: 'string' },
      limit: { type: 'number' },
    },
    required: [],
  },
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    if (!wc) return { ok: false, error: 'webcontents_unavailable' };
    const snapRes = await ensureSnapshot(wc);
    if (!snapRes.ok) return snapRes;
    const elements = (snapRes.snapshot && snapRes.snapshot.elements) || [];
    const roleFilter = args.role ? String(args.role).toLowerCase() : null;
    const matchName = buildMatcher(args);
    const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
    const matches = [];
    for (const el of elements) {
      if (roleFilter && String(el.role || '').toLowerCase() !== roleFilter) continue;
      if (!matchName(el.name) && !matchName(el.value)) continue;
      matches.push({ idx: el.idx, role: el.role, name: el.name || '', value: el.value });
      if (matches.length >= limit) break;
    }
    return {
      ok: true,
      matches,
      snapshotToken: snapRes.snapshot.token,
      freshSnapshot: !!snapRes.fresh,
      totalElements: elements.length,
    };
  },
};

const scrollToIdx = {
  name: 'browser.scroll_to_idx',
  description: 'Scroll the element at the given idx from the last snapshot_ax into view. Use before click_idx when the element may be offscreen (long lists, lazy-loaded content).',
  parameters: { type: 'object', properties: { spaceId: { type: 'string' }, idx: { type: 'number' } }, required: ['idx'] },
  sideEffect: true,
  handler: async (args, toolCtx) => {
    const wc = activeWc(toolCtx, args.spaceId);
    const attach = await ensureCdp(wc);
    if (!attach.ok) return attach;
    const snap = cdpSessions.getSnapshot(wc);
    if (!snap || !Array.isArray(snap.elements)) {
      return { ok: false, error: 'idx_not_in_snapshot', reason: 'no_snapshot', hint: 'Call browser.snapshot_ax first.' };
    }
    const el = snap.elements[args.idx];
    if (!el) return { ok: false, error: 'idx_not_in_snapshot', reason: 'out_of_range', snapshotElementCount: snap.elements.length };
    if (el.backendNodeId == null) return { ok: false, error: 'no_backend_node_id' };
    try {
      await cdpSessions.send(wc, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: el.backendNodeId });
      return { ok: true, scrolled: { idx: el.idx, role: el.role, name: el.name } };
    } catch (err) { return { ok: false, error: errMsg(err) }; }
  },
};

function navHistoryTool(name, description, methodKey) {
  return {
    name, description,
    parameters: { type: 'object', properties: { spaceId: { type: 'string' }, timeoutMs: { type: 'number' } }, required: [] },
    sideEffect: true,
    handler: async (args, toolCtx) => {
      const wc = activeWc(toolCtx, args.spaceId);
      if (!wc || typeof wc[methodKey] !== 'function') return { ok: false, error: 'webcontents_unavailable' };
      const canCheck = methodKey === 'goBack' ? 'canGoBack' : 'canGoForward';
      if (typeof wc[canCheck] === 'function' && !wc[canCheck]()) return { ok: false, error: 'no_history' };
      const timeoutMs = Number(args.timeoutMs) || 8000;
      return new Promise((resolve) => {
        let done = false;
        const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { wc.removeListener('did-stop-loading', onStop); } catch (_) {} resolve(r); };
        const onStop = () => finish({ ok: true });
        const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
        try { wc.once('did-stop-loading', onStop); } catch (_) { /* ignore */ }
        try { wc[methodKey](); } catch (err) { finish({ ok: false, error: errMsg(err) }); }
      });
    },
  };
}

const goBack = navHistoryTool('browser.go_back', 'Navigate the tab back one entry in its history. Waits for the page to stop loading. Returns {ok:false, error:"no_history"} if the tab cannot go back.', 'goBack');
const goForward = navHistoryTool('browser.go_forward', 'Navigate the tab forward one entry in its history. Waits for the page to stop loading.', 'goForward');

module.exports = [waitFor, locate, scrollToIdx, goBack, goForward];
