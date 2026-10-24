const {
  AgentApprovalService, classify, upgradeClass, originOf, MODE_POLICY,
} = require('../../../../main/services/AgentApprovalService');

function fakeConfig(rules) {
  const map = new Map();
  if (rules) map.set('settings.llm.agent.approval', rules);
  return {
    get: (k, fallback) => (map.has(k) ? map.get(k) : fallback),
    set: (k, v) => map.set(k, v),
  };
}

function makeBind(svc, rules) {
  const sent = [];
  const listeners = {};
  const mw = { isDestroyed: () => false, webContents: { send: (ch, p) => sent.push({ ch, p }) } };
  const ipc = { on: (ch, fn) => { listeners[ch] = fn; } };
  svc.bind(mw, ipc, fakeConfig(rules));
  return { sent, fire: (ch, payload) => listeners[ch] && listeners[ch](null, payload) };
}

describe('AgentApprovalService.classify', () => {
  test('maps tool name to action class', () => {
    expect(classify('browser.read_tab')).toBe('read');
    expect(classify('browser.click_idx')).toBe('click');
    expect(classify('browser.type_text')).toBe('type');
    expect(classify('browser.navigate')).toBe('navigate');
    expect(classify('browser.close_tab')).toBe('destructive');
    expect(classify('agent.done')).toBe('meta');
    // Unmapped tools classify as 'unknown' so the permission engine asks.
    expect(classify('browser.unknown_future_tool')).toBe('unknown');
  });

  test('upgradeClass lifts payment/auth from URL hints on navigate', () => {
    expect(upgradeClass('navigate', { name: 'browser.navigate', args: { url: 'https://shop.example.com/checkout' } }, {})).toBe('payment');
    expect(upgradeClass('navigate', { name: 'browser.navigate', args: { url: 'https://id.example.com/oauth/authorize' } }, {})).toBe('auth');
    expect(upgradeClass('navigate', { name: 'browser.navigate', args: { url: 'https://example.com/about' } }, {})).toBe('navigate');
  });

  test('upgradeClass lifts payment/auth from open_tab and every research source', () => {
    expect(upgradeClass('navigate', { name: 'browser.open_tab', args: { url: 'https://shop.example.com/checkout?x=1' } }, {})).toBe('payment');
    const sources = (...urls) => ({ name: 'browser.open_research_sources', args: { sources: urls.map((url) => ({ url })) } });
    expect(upgradeClass('navigate', sources('https://a.example.com/doc', 'https://id.example.com/login'), {})).toBe('auth');
    expect(upgradeClass('navigate', sources('https://a.example.com/doc', 'https://b.example.com/billing/'), {})).toBe('payment');
    expect(upgradeClass('navigate', sources('https://a.example.com/doc', 'https://b.example.com/payments-guide'), {})).toBe('navigate');
    expect(upgradeClass('navigate', { name: 'browser.duplicate_tab', args: { url: 'https://shop.example.com/checkout' } }, {})).toBe('navigate');
  });

  test('originOf extracts protocol + host or returns empty', () => {
    expect(originOf('https://a.com/x?y')).toBe('https://a.com');
    expect(originOf('not a url')).toBe('');
    expect(originOf(undefined)).toBe('');
  });
});

describe('AgentApprovalService.decide', () => {
  test('read and meta calls are allowed under balanced mode', () => {
    const svc = new AgentApprovalService();
    const calls = [
      { id: '1', name: 'browser.read_tab', args: {} },
      { id: '2', name: 'agent.set_plan', args: { steps: ['a'] } },
    ];
    const { allowed, prompts, denied } = svc.decide(calls, { mode: { name: 'balanced' } });
    expect(allowed).toHaveLength(2);
    expect(prompts).toHaveLength(0);
    expect(denied).toHaveLength(0);
  });

  test('destructive calls need prompt under balanced mode', () => {
    const svc = new AgentApprovalService();
    const calls = [{ id: '1', name: 'browser.close_tab', args: { spaceId: 's1' } }];
    const { prompts } = svc.decide(calls, { mode: { name: 'balanced' }, url: 'https://a.com' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].class).toBe('destructive');
    expect(prompts[0].origin).toBe('https://a.com');
  });

  test('hard-deny in rules blocks without prompting', () => {
    const svc = new AgentApprovalService();
    svc.bind({ isDestroyed: () => true, webContents: { send: () => {} } }, { on: () => {} }, fakeConfig({ deny: ['destructive'] }));
    const { denied, prompts } = svc.decide(
      [{ id: '1', name: 'browser.close_tab', args: { spaceId: 's1' } }],
      { mode: { name: 'balanced' } },
    );
    expect(denied).toHaveLength(1);
    expect(prompts).toHaveLength(0);
  });

  test('per-origin allow lets the action through without prompt', () => {
    const svc = new AgentApprovalService();
    svc.bind({ isDestroyed: () => true, webContents: { send: () => {} } }, { on: () => {} }, fakeConfig({
      perOrigin: { 'https://safe.example': { destructive: 'allow' } },
    }));
    const { allowed, prompts } = svc.decide(
      [{ id: '1', name: 'browser.close_tab', args: {} }],
      { mode: { name: 'balanced' }, url: 'https://safe.example/x' },
    );
    expect(allowed).toHaveLength(1);
    expect(prompts).toHaveLength(0);
  });

  test('approve_session grant lets subsequent same-origin/class calls through', () => {
    const svc = new AgentApprovalService();
    svc.applyDecision({ class: 'destructive', origin: 'https://a.com' }, 'approve_session');
    const { allowed, prompts } = svc.decide(
      [{ id: '1', name: 'browser.close_tab', args: {} }],
      { mode: { name: 'balanced' }, url: 'https://a.com/x' },
    );
    expect(allowed).toHaveLength(1);
    expect(prompts).toHaveLength(0);
  });

  test('requestApproval resolves when renderer responds', async () => {
    const svc = new AgentApprovalService();
    const bind = makeBind(svc);
    const p = svc.requestApproval({ call: { name: 'browser.close_tab' }, class: 'destructive', origin: 'https://a.com' });
    const { requestId } = bind.sent[0].p;
    bind.fire('agent:approval-response', { requestId, decision: 'approve' });
    await expect(p).resolves.toMatchObject({ decision: 'approve' });
  });

  test('requestApproval times out and rejects cleanly', async () => {
    jest.useFakeTimers();
    const svc = new AgentApprovalService();
    makeBind(svc);
    const p = svc.requestApproval({ call: { name: 'browser.close_tab' }, class: 'destructive', origin: 'https://a.com' });
    jest.advanceTimersByTime(61000);
    await expect(p).resolves.toMatchObject({ decision: 'reject', reason: 'timeout' });
    jest.useRealTimers();
  });
});

describe('mode policy matrix (sanity)', () => {
  test('all three modes auto-allow read and meta', () => {
    for (const m of Object.keys(MODE_POLICY)) {
      expect(MODE_POLICY[m].read).toBe('allow');
      expect(MODE_POLICY[m].meta).toBe('allow');
    }
  });

  test('all three modes prompt on payment/auth/submit', () => {
    for (const m of Object.keys(MODE_POLICY)) {
      expect(MODE_POLICY[m].payment).toBe('prompt');
      expect(MODE_POLICY[m].auth).toBe('prompt');
      expect(MODE_POLICY[m].submit).toBe('prompt');
    }
  });
});

describe('AgentApprovalService.decide — egress control', () => {
  function svcWith({ egress, approval }) {
    const svc = new AgentApprovalService();
    const map = new Map();
    if (approval) map.set('settings.llm.agent.approval', approval);
    if (egress) map.set('settings.llm.agent.egress', egress);
    svc._configService = { get: (k, fb) => (map.has(k) ? map.get(k) : fb), set: (k, v) => map.set(k, v) };
    return svc;
  }
  const nav = (url) => ({ id: '1', name: 'browser.navigate', args: { url } });

  test('open mode (default) does not gate any destination', () => {
    const svc = svcWith({ egress: { mode: 'open', allow: [], block: [] } });
    const { allowed, prompts, denied } = svc.decide([nav('https://anything.com')], { mode: { name: 'balanced' } });
    expect(allowed).toHaveLength(1);
    expect(prompts).toHaveLength(0);
    expect(denied).toHaveLength(0);
  });

  test('blocked destination is denied unconditionally, even in open mode', () => {
    const svc = svcWith({ egress: { mode: 'open', allow: [], block: ['tracker.com'] } });
    const { allowed, denied } = svc.decide([nav('https://ads.tracker.com/x')], { mode: { name: 'balanced' } });
    expect(allowed).toHaveLength(0);
    expect(denied).toHaveLength(1);
    expect(denied[0].reason).toMatch(/^egress_blocked:/);
  });

  test('allowlist: listed domain passes, off-list prompts on the destination origin', () => {
    const svc = svcWith({ egress: { mode: 'allowlist', allow: ['python.org'], block: [], onViolation: 'prompt' } });
    const r1 = svc.decide([nav('https://docs.python.org/3/')], { mode: { name: 'balanced' } });
    expect(r1.allowed).toHaveLength(1);
    const r2 = svc.decide([nav('https://random.io/page')], { mode: { name: 'balanced' } });
    expect(r2.allowed).toHaveLength(0);
    expect(r2.prompts).toHaveLength(1);
    expect(r2.prompts[0].class).toBe('egress');
    expect(r2.prompts[0].origin).toBe('https://random.io');
  });

  test('allowlist + onViolation:deny refuses off-list without prompting', () => {
    const svc = svcWith({ egress: { mode: 'allowlist', allow: ['python.org'], block: [], onViolation: 'deny' } });
    const { prompts, denied } = svc.decide([nav('https://random.io/page')], { mode: { name: 'balanced' } });
    expect(prompts).toHaveLength(0);
    expect(denied).toHaveLength(1);
    expect(denied[0].reason).toBe('egress_unlisted:https://random.io');
  });

  test('a persisted per-origin egress grant short-circuits the prompt', () => {
    const svc = svcWith({
      egress: { mode: 'allowlist', allow: [], block: [], onViolation: 'prompt' },
      approval: { deny: [], perOrigin: { 'https://trusted.io': { egress: 'allow' } } },
    });
    const r = svc.decide([nav('https://trusted.io/page')], { mode: { name: 'balanced' } });
    expect(r.allowed).toHaveLength(1);
    expect(r.prompts).toHaveLength(0);

    const svc2 = svcWith({
      egress: { mode: 'allowlist', allow: [], block: [], onViolation: 'prompt' },
      approval: { deny: [], perOrigin: { 'https://blocked.io': { egress: 'deny' } } },
    });
    const r2 = svc2.decide([nav('https://blocked.io/page')], { mode: { name: 'balanced' } });
    expect(r2.denied).toHaveLength(1);
    expect(r2.denied[0].reason).toBe('egress_origin_deny:https://blocked.io');
  });

  test('a session grant for the destination origin short-circuits the prompt', () => {
    const svc = svcWith({ egress: { mode: 'allowlist', allow: [], block: [], onViolation: 'prompt' } });
    svc.applyDecision({ call: nav('https://session.io/'), class: 'egress', origin: 'https://session.io' }, 'approve_session');
    const r = svc.decide([nav('https://session.io/x')], { mode: { name: 'balanced' } });
    expect(r.allowed).toHaveLength(1);
    expect(r.prompts).toHaveLength(0);
  });

  test('research sources: approving the egress prompt for the session covers every unlisted origin', () => {
    const svc = svcWith({ egress: { mode: 'allowlist', allow: [], block: [], onViolation: 'prompt' } });
    const research = { id: '1', name: 'browser.open_research_sources', args: { sources: [{ url: 'https://a.io/1' }, { url: 'https://b.io/2' }] } };
    const { prompts } = svc.decide([research], { sessionId: 's_r1' });
    expect(prompts).toEqual([expect.objectContaining({ class: 'egress', origin: 'https://a.io', origins: ['https://a.io', 'https://b.io'] })]);
    svc.applyDecision(prompts[0], 'approve_session');
    expect(svc.decide([research], { sessionId: 's_r1' }).allowed).toHaveLength(1);
    expect(svc.decide([nav('https://b.io/x')], { sessionId: 's_r1' }).allowed).toHaveLength(1);
    expect(svc.decide([nav('https://c.io/x')], { sessionId: 's_r1' }).prompts).toHaveLength(1);
  });

  test('research sources: the approval request payload lists every origin the prompt covers', () => {
    const { buildRequestPayload } = require('../../../../main/agent/permissions/approvalContext');
    const call = { id: '1', name: 'browser.open_research_sources', args: { sources: [{ url: 'https://a.io/1' }] } };
    const multi = buildRequestPayload('r1', { call, class: 'egress', origin: 'https://a.io', origins: ['https://a.io', 'https://b.io'] }, {});
    expect(multi.origins).toEqual(['https://a.io', 'https://b.io']);
    const single = buildRequestPayload('r2', { call, class: 'egress', origin: 'https://a.io' }, {});
    expect(single).not.toHaveProperty('origins');
  });

  test('research sources: one blocked source denies the call', () => {
    const svc = svcWith({ egress: { mode: 'open', allow: [], block: ['evil.test'] } });
    const research = { id: '1', name: 'browser.open_research_sources', args: { sources: [{ url: 'https://ok.io/' }, { url: 'https://evil.test:8443/' }] } };
    expect(svc.decide([research], {}).denied[0].reason).toBe('egress_blocked:https://evil.test:8443');
  });

  test('non-navigate calls are unaffected by egress; internal URLs never gated', () => {
    const svc = svcWith({ egress: { mode: 'allowlist', allow: [], block: [] } });
    const r = svc.decide([
      { id: '1', name: 'browser.read_tab', args: {} },
      { id: '2', name: 'browser.navigate', args: { url: 'ic://llm-chat/' } },
    ], { mode: { name: 'balanced' } });
    expect(r.allowed).toHaveLength(2);
    expect(r.denied).toHaveLength(0);
  });
});

describe('AgentApprovalService.decide — per-origin deny + mode-deny', () => {
  test('a per-origin deny rule blocks a non-egress class without prompting', () => {
    const svc = new AgentApprovalService();
    svc.bind({ isDestroyed: () => true, webContents: { send: () => {} } }, { on: () => {} }, fakeConfig({
      perOrigin: { 'https://danger.example': { destructive: 'deny' } },
    }));
    const { allowed, denied, prompts } = svc.decide(
      [{ id: '1', name: 'browser.close_tab', args: {} }],
      { mode: { name: 'balanced' }, url: 'https://danger.example/x' },
    );
    expect(allowed).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    expect(denied).toHaveLength(1);
    expect(denied[0].reason).toBe('origin_deny:https://danger.example');
  });

  test('unknown mode name falls back to the balanced policy', () => {
    const svc = new AgentApprovalService();
    const { prompts } = svc.decide(
      [{ id: '1', name: 'browser.close_tab', args: {} }],
      { mode: { name: 'no-such-mode' }, url: 'https://x.com' },
    );
    expect(prompts).toHaveLength(1); // balanced prompts on destructive
  });

  test('decide with no ctx / no calls is a safe no-op', () => {
    const svc = new AgentApprovalService();
    expect(svc.decide()).toEqual({ allowed: [], denied: [], prompts: [] });
    expect(svc.decide([], undefined)).toEqual({ allowed: [], denied: [], prompts: [] });
  });
});

describe('AgentApprovalService.requestApproval — no-UI + send failure', () => {
  test('resolves reject/no_ui when there is no main window', async () => {
    const svc = new AgentApprovalService();
    const r = await svc.requestApproval({ call: { name: 'browser.close_tab' }, class: 'destructive', origin: 'https://a.com' });
    expect(r).toEqual({ decision: 'reject', reason: 'no_ui' });
  });

  test('resolves reject/no_ui when the window is destroyed', async () => {
    const svc = new AgentApprovalService();
    svc.bind({ isDestroyed: () => true, webContents: { send: () => {} } }, { on: () => {} }, fakeConfig());
    const r = await svc.requestApproval({ call: { name: 'x' }, class: 'destructive', origin: 'https://a.com' });
    expect(r).toEqual({ decision: 'reject', reason: 'no_ui' });
  });

  test('resolves reject/send_failed when webContents.send throws', async () => {
    const svc = new AgentApprovalService();
    svc.bind(
      { isDestroyed: () => false, webContents: { send: () => { throw new Error('renderer gone'); } } },
      { on: () => {} },
      fakeConfig(),
    );
    const r = await svc.requestApproval({ call: { name: 'x' }, class: 'destructive', origin: 'https://a.com' });
    expect(r).toEqual({ decision: 'reject', reason: 'send_failed' });
    // The pending entry must be cleaned up so it can't time out later.
    expect(svc._pending.size).toBe(0);
  });

  test('a window object without isDestroyed is treated as present', async () => {
    jest.useFakeTimers();
    const sent = [];
    const svc = new AgentApprovalService();
    svc.bind({ webContents: { send: (ch, p) => sent.push({ ch, p }) } }, { on: () => {} }, fakeConfig());
    const p = svc.requestApproval({ call: { name: 'x' }, class: 'destructive', origin: 'https://a.com' });
    expect(sent).toHaveLength(1);
    jest.advanceTimersByTime(61000);
    await expect(p).resolves.toMatchObject({ decision: 'reject', reason: 'timeout' });
    jest.useRealTimers();
  });
});

describe('AgentApprovalService.applyDecision — persistence + grants', () => {
  test('approve_session records a session grant honored by decide()', () => {
    const svc = new AgentApprovalService();
    svc.applyDecision({ class: 'destructive', origin: 'https://s.com' }, 'approve_session');
    const { allowed } = svc.decide(
      [{ id: '1', name: 'browser.close_tab', args: {} }],
      { mode: { name: 'balanced' }, url: 'https://s.com/x' },
    );
    expect(allowed).toHaveLength(1);
  });

  test('approve_session is a no-op without an origin', () => {
    const svc = new AgentApprovalService();
    svc.applyDecision({ class: 'destructive' }, 'approve_session');
    expect(svc._grants.isEmpty()).toBe(true);
  });

  test('a host-less browser prompt offers no rule and its session/origin approvals persist nothing', () => {
    const svc = new AgentApprovalService();
    const cfg = fakeConfig();
    cfg.set = jest.fn();
    svc.bind({ isDestroyed: () => true, webContents: { send: () => {} } }, { on: () => {} }, cfg);
    const close = { id: '1', name: 'browser.close_tab', args: {} };
    const { prompts } = svc.decide([close], { url: 'about:blank' });
    expect(prompts[0]).toMatchObject({ class: 'destructive', origin: '' });
    expect(prompts[0].suggestedRule).toBeUndefined();
    for (const d of ['approve_session', 'approve_origin', 'reject_origin', 'approve_rule_always']) {
      svc.applyDecision({ ...prompts[0], suggestedRule: 'browser.close_tab' }, d);
    }
    expect(svc._grants.isEmpty()).toBe(true);
    expect(cfg.set).not.toHaveBeenCalled();
    expect(svc.decide([close], { url: 'https://a.com/' }).prompts).toHaveLength(1);
    expect(svc.decide([close], { url: 'about:blank' }).prompts).toHaveLength(1);
  });

  test('approve_origin persists an allow rule into config', () => {
    const svc = new AgentApprovalService();
    const cfg = fakeConfig();
    svc.bind({ isDestroyed: () => true, webContents: { send: () => {} } }, { on: () => {} }, cfg);
    svc.applyDecision({ class: 'destructive', origin: 'https://o.com' }, 'approve_origin');
    const saved = cfg.get('settings.llm.agent.approval');
    expect(saved.perOrigin['https://o.com'].destructive).toBe('allow');
    // And it now takes effect on the next decision.
    const { allowed } = svc.decide(
      [{ id: '1', name: 'browser.close_tab', args: {} }],
      { mode: { name: 'balanced' }, url: 'https://o.com/p' },
    );
    expect(allowed).toHaveLength(1);
  });

  test('reject_origin persists a deny rule into config', () => {
    const svc = new AgentApprovalService();
    const cfg = fakeConfig();
    svc.bind({ isDestroyed: () => true, webContents: { send: () => {} } }, { on: () => {} }, cfg);
    svc.applyDecision({ class: 'destructive', origin: 'https://o.com' }, 'reject_origin');
    expect(cfg.get('settings.llm.agent.approval').perOrigin['https://o.com'].destructive).toBe('deny');
  });

  test('approve_origin without an origin does not write config', () => {
    const svc = new AgentApprovalService();
    const cfg = fakeConfig();
    let setCount = 0;
    cfg.set = () => { setCount += 1; };
    svc.bind({ isDestroyed: () => true, webContents: { send: () => {} } }, { on: () => {} }, cfg);
    svc.applyDecision({ class: 'destructive' }, 'approve_origin');
    expect(setCount).toBe(0);
  });

  test('an unrecognized decision is a no-op (no grant, no persist)', () => {
    const svc = new AgentApprovalService();
    svc.applyDecision({ class: 'destructive', origin: 'https://o.com' }, 'something-else');
    expect(svc._grants.isEmpty()).toBe(true);
  });

  test('_persistOriginRule is a no-op without a config service', () => {
    const svc = new AgentApprovalService();
    expect(() => svc.applyDecision({ class: 'destructive', origin: 'https://o.com' }, 'approve_origin')).not.toThrow();
  });

  test('_persistOriginRule swallows a throwing config.set (best-effort)', () => {
    const svc = new AgentApprovalService();
    const cfg = {
      get: () => ({ perOrigin: { 'https://o.com': { read: 'allow' } } }),
      set: () => { throw new Error('disk full'); },
    };
    svc.bind({ isDestroyed: () => true, webContents: { send: () => {} } }, { on: () => {} }, cfg);
    expect(() => svc.applyDecision({ class: 'destructive', origin: 'https://o.com' }, 'approve_origin')).not.toThrow();
  });

  test('_persistOriginRule tolerates a config service with no set()', () => {
    const svc = new AgentApprovalService();
    const cfg = { get: () => ({}) };
    svc.bind({ isDestroyed: () => true, webContents: { send: () => {} } }, { on: () => {} }, cfg);
    expect(() => svc.applyDecision({ class: 'destructive', origin: 'https://o.com' }, 'approve_origin')).not.toThrow();
  });
});

describe('AgentApprovalService session lifecycle', () => {
  test('resetSessionGrants clears prior session approvals', () => {
    const svc = new AgentApprovalService();
    svc.applyDecision({ class: 'destructive', origin: 'https://a.com' }, 'approve_session');
    expect(svc._grants.isEmpty()).toBe(false);
    svc.resetSessionGrants();
    expect(svc._grants.isEmpty()).toBe(true);
    const { prompts } = svc.decide(
      [{ id: '1', name: 'browser.close_tab', args: {} }],
      { mode: { name: 'balanced' }, url: 'https://a.com/x' },
    );
    expect(prompts).toHaveLength(1); // grant gone → prompt again
  });

  test('_reset rejects all pending approvals and clears session grants', async () => {
    jest.useFakeTimers();
    const svc = new AgentApprovalService();
    svc.bind({ isDestroyed: () => false, webContents: { send: () => {} } }, { on: () => {} }, fakeConfig());
    svc.applyDecision({ class: 'destructive', origin: 'https://a.com' }, 'approve_session');
    const p = svc.requestApproval({ call: { name: 'x' }, class: 'destructive', origin: 'https://a.com' });
    svc._reset();
    await expect(p).resolves.toEqual({ decision: 'reject', reason: 'reset' });
    expect(svc._pending.size).toBe(0);
    expect(svc._grants.isEmpty()).toBe(true);
    jest.useRealTimers();
  });

  const closeTab = { id: '1', name: 'browser.close_tab', args: {} };
  const grantIn = (svc, sessionId) => svc.applyDecision({ call: closeTab, class: 'destructive', origin: 'https://a.com', ...(sessionId ? { sessionId } : {}) }, 'approve_session');
  const promptsIn = (svc, sessionId) => svc.decide([closeTab], { url: 'https://a.com/x', ...(sessionId ? { sessionId } : {}) }).prompts.length;

  test('approve_session grants stay inside the session that approved them', () => {
    const svc = new AgentApprovalService();
    grantIn(svc, 's_a');
    expect(promptsIn(svc, 's_a')).toBe(0);
    expect(promptsIn(svc, 's_b')).toBe(1);
    expect(promptsIn(svc, null)).toBe(1);
    grantIn(svc, null);
    expect(promptsIn(svc, null)).toBe(0);
    expect(promptsIn(svc, 's_b')).toBe(1);
  });

  test('clearSession drops one session\'s grants and rules and leaves the others', () => {
    const svc = new AgentApprovalService();
    grantIn(svc, 's_a');
    grantIn(svc, 's_b');
    svc.applyDecision({ call: { name: 'mcp.gh.read' }, class: 'external', origin: '', sessionId: 's_a', suggestedRule: 'mcp.gh.read' }, 'approve_session');
    expect(svc.decide([{ name: 'mcp.gh.read', args: {} }], { sessionId: 's_a' }).allowed).toHaveLength(1);
    svc.clearSession('s_a');
    expect(promptsIn(svc, 's_a')).toBe(1);
    expect(svc.decide([{ name: 'mcp.gh.read', args: {} }], { sessionId: 's_a' }).prompts).toHaveLength(1);
    expect(promptsIn(svc, 's_b')).toBe(0);
  });

  test('cancelSession (run stop) also clears that session\'s grants', () => {
    const svc = new AgentApprovalService();
    grantIn(svc, 's_a');
    grantIn(svc, 's_b');
    svc.cancelSession('s_a', 'stopped');
    expect(promptsIn(svc, 's_a')).toBe(1);
    expect(promptsIn(svc, 's_b')).toBe(0);
    grantIn(svc, null);
    svc.cancelSession(null);
    expect(promptsIn(svc, null)).toBe(1);
  });

  test('_onResponse ignores unknown / malformed payloads', () => {
    const svc = new AgentApprovalService();
    expect(() => svc._onResponse(null)).not.toThrow();
    expect(() => svc._onResponse({})).not.toThrow();
    expect(() => svc._onResponse({ requestId: 'missing' })).not.toThrow();
  });
});

describe('agent:approval-resolved', () => {
  const prompt = (sessionId) => ({ call: { name: 'browser.close_tab' }, class: 'destructive', origin: 'https://a.com', ...(sessionId ? { sessionId } : {}) });
  const resolvedOf = (sent) => sent.filter((m) => m.ch === 'agent:approval-resolved').map((m) => m.p);

  afterEach(() => jest.useRealTimers());

  test('a renderer decision is announced once with the request and its session', async () => {
    const svc = new AgentApprovalService();
    const bind = makeBind(svc);
    const p = svc.requestApproval(prompt('s_abc123'));
    const { requestId } = bind.sent[0].p;
    bind.fire('agent:approval-response', { requestId, decision: 'approve' });
    await p;
    bind.fire('agent:approval-response', { requestId, decision: 'reject' });
    expect(resolvedOf(bind.sent)).toEqual([{ requestId, sessionId: 's_abc123', decision: 'approve' }]);
  });

  test('a timeout is announced as a reject with its reason', async () => {
    jest.useFakeTimers();
    const svc = new AgentApprovalService();
    const bind = makeBind(svc);
    const p = svc.requestApproval(prompt());
    const { requestId } = bind.sent[0].p;
    jest.advanceTimersByTime(61000);
    await p;
    expect(resolvedOf(bind.sent)).toEqual([{ requestId, sessionId: null, decision: 'reject', reason: 'timeout' }]);
  });

  test('a shorter per-request timeout applies with its own reason and reaches onResolved', async () => {
    jest.useFakeTimers();
    const svc = new AgentApprovalService();
    const bind = makeBind(svc);
    const onResolved = jest.fn();
    const p = svc.requestApproval(prompt('s_abc123'), { timeoutMs: 500, timeoutReason: 'background_timeout', onResolved });
    jest.advanceTimersByTime(499);
    expect(svc._pending.size).toBe(1);
    jest.advanceTimersByTime(1);
    await expect(p).resolves.toEqual({ decision: 'reject', reason: 'background_timeout' });
    const info = { requestId: bind.sent[0].p.requestId, sessionId: 's_abc123', decision: 'reject', reason: 'background_timeout' };
    expect(onResolved).toHaveBeenCalledWith(info);
    expect(resolvedOf(bind.sent)).toEqual([info]);
  });

  test('timeoutMs 0 waits for the user with no timer', async () => {
    jest.useFakeTimers();
    const svc = new AgentApprovalService();
    const bind = makeBind(svc);
    const p = svc.requestApproval(prompt('s_abc123'), { timeoutMs: 0, timeoutReason: 'background_timeout' });
    jest.advanceTimersByTime(24 * 3600 * 1000);
    expect(svc._pending.size).toBe(1);
    bind.fire('agent:approval-response', { requestId: bind.sent[0].p.requestId, decision: 'approve' });
    await expect(p).resolves.toMatchObject({ decision: 'approve' });
  });

  test('a per-request timeout longer than the default is honored, capped at 24h', async () => {
    jest.useFakeTimers();
    const svc = new AgentApprovalService();
    makeBind(svc);
    const p = svc.requestApproval(prompt('s_abc123'), { timeoutMs: 120000, timeoutReason: 'background_timeout' });
    jest.advanceTimersByTime(119999);
    expect(svc._pending.size).toBe(1);
    jest.advanceTimersByTime(1);
    await expect(p).resolves.toEqual({ decision: 'reject', reason: 'background_timeout' });
    const huge = svc.requestApproval(prompt('s_abc123'), { timeoutMs: 1e15, timeoutReason: 'background_timeout' });
    jest.advanceTimersByTime(24 * 3600 * 1000 - 1);
    expect(svc._pending.size).toBe(1);
    jest.advanceTimersByTime(1);
    await expect(huge).resolves.toEqual({ decision: 'reject', reason: 'background_timeout' });
  });

  test('no or an invalid per-request timeout keeps the 60s default', async () => {
    jest.useFakeTimers();
    const svc = new AgentApprovalService();
    makeBind(svc);
    const p = svc.requestApproval(prompt(), { timeoutMs: -5, timeoutReason: 'background_timeout' });
    jest.advanceTimersByTime(59999);
    expect(svc._pending.size).toBe(1);
    jest.advanceTimersByTime(1);
    await expect(p).resolves.toEqual({ decision: 'reject', reason: 'timeout' });
  });

  test('cancelSession rejects only that session\'s prompts and announces each', async () => {
    const svc = new AgentApprovalService();
    const bind = makeBind(svc);
    const mine = svc.requestApproval(prompt('s_abc123'));
    const other = svc.requestApproval(prompt('s_other99'));
    expect(svc.cancelSession('s_abc123', 'stopped')).toBe(1);
    await expect(mine).resolves.toEqual({ decision: 'reject', reason: 'stopped' });
    expect(svc._pending.size).toBe(1);
    expect(resolvedOf(bind.sent)).toEqual([{ requestId: bind.sent[0].p.requestId, sessionId: 's_abc123', decision: 'reject', reason: 'stopped' }]);
    svc._reset();
    await expect(other).resolves.toEqual({ decision: 'reject', reason: 'reset' });
    expect(resolvedOf(bind.sent).map((r) => r.reason)).toEqual(['stopped', 'reset']);
  });

  test('an unknown requestId announces nothing and leaves pending prompts alone', () => {
    const svc = new AgentApprovalService();
    const bind = makeBind(svc);
    svc.requestApproval(prompt());
    bind.fire('agent:approval-response', { requestId: 'approval_unknown', decision: 'approve' });
    expect(svc.cancelSession('s_nobody1')).toBe(0);
    expect(resolvedOf(bind.sent)).toEqual([]);
    expect(svc._pending.size).toBe(1);
    svc._reset();
  });

  test('a throwing onResolved is logged and the decision still resolves', async () => {
    const svc = new AgentApprovalService();
    const bind = makeBind(svc);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const p = svc.requestApproval(prompt(), { onResolved: () => { throw new Error('listener_broke'); } });
    bind.fire('agent:approval-response', { requestId: bind.sent[0].p.requestId, decision: 'approve' });
    await expect(p).resolves.toMatchObject({ decision: 'approve' });
    expect(errSpy.mock.calls.some((c) => String(c[1]).includes('listener_broke'))).toBe(true);
    errSpy.mockRestore();
  });
});
