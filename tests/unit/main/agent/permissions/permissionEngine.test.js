const { decide, MODES } = require('../../../../../main/agent/permissions/permissionEngine');
const { compileList, parse } = require('../../../../../main/agent/permissions/ruleMatch');

const rules = (r) => ({
  allow: compileList(r.allow || []),
  ask: compileList(r.ask || []),
  deny: compileList(r.deny || []),
});
const call = (name, args) => ({ name, args: args || {} });
const PAGE = 'https://example.com/page';

describe('permissionEngine.decide — required invariants', () => {
  test('a deny rule beats Bypass mode and an allow rule for the same call', () => {
    const v = decide(call('shell.run', { argv: ['rm', '-rf', 'build'] }), {
      mode: 'bypass',
      rules: rules({ deny: ['shell.run:rm *'], allow: ['shell.run:rm *'] }),
      facts: { cwd: '/w', cwdRel: '.' },
    });
    expect(v).toMatchObject({ verdict: 'deny', reason: 'rule_deny:shell.run:rm *' });
  });

  test('an MCP tool asks in Ask mode and suggests only that exact tool', () => {
    const v = decide(call('mcp.github.create_issue', { title: 'x' }), { mode: 'ask', rules: rules({}) });
    expect(v.verdict).toBe('ask');
    expect(v.cls).toBe('external');
    expect(v.suggestedRule).toBe('mcp.github.create_issue');
  });

  test('an ask rule beats an allow rule', () => {
    const v = decide(call('shell.run', { argv: ['git', 'push'] }), {
      mode: 'ask',
      rules: rules({ allow: ['shell.run:git *'], ask: ['shell.run:git push'] }),
    });
    expect(v).toMatchObject({ verdict: 'ask', reason: 'rule_ask:shell.run:git push' });
  });

  test('Auto-edit allows ordinary edits but asks for a protected path like .env', () => {
    const ok = decide(call('fs.write', { path: 'src/a.js' }), { mode: 'auto-edit', facts: { rel: 'src/a.js', protected: false } });
    expect(ok).toMatchObject({ verdict: 'allow', reason: 'mode:auto-edit:edit' });
    const env = decide(call('fs.write', { path: '.env' }), { mode: 'auto-edit', facts: { rel: '.env', protected: true } });
    expect(env).toMatchObject({ verdict: 'ask', reason: 'protected_path' });
  });

  test('protected paths ask even under Bypass and a matching allow rule', () => {
    const v = decide(call('fs.edit', { path: '.env' }), {
      mode: 'bypass', rules: rules({ allow: ['fs.edit'] }), facts: { rel: '.env', protected: true },
    });
    expect(v).toMatchObject({ verdict: 'ask', reason: 'protected_path' });
  });

  test('Plan mode denies fs.write with plan_mode_read_only but still allows reads', () => {
    expect(decide(call('fs.write', { path: 'a' }), { mode: 'plan', facts: { rel: 'a' } }))
      .toMatchObject({ verdict: 'deny', reason: 'plan_mode_read_only' });
    expect(decide(call('fs.read', { path: 'a' }), { mode: 'plan', facts: { rel: 'a' } }).verdict).toBe('allow');
  });

  test('Plan mode beats an allow rule for a mutating tool', () => {
    const v = decide(call('shell.run', { argv: ['ls'] }), { mode: 'plan', rules: rules({ allow: ['shell.run'] }) });
    expect(v.reason).toBe('plan_mode_read_only');
  });

  test('an unknown tool asks (never auto-allowed) in Ask and Auto-edit', () => {
    for (const mode of ['ask', 'auto-edit']) {
      const v = decide(call('somevendor.do_thing'), { mode });
      expect(v).toMatchObject({ verdict: 'ask', cls: 'unknown' });
    }
  });

  test('unknown browser.* tools ask instead of inheriting the click policy', () => {
    const v = decide(call('browser.future_tool'), { mode: 'ask', url: PAGE });
    expect(v).toMatchObject({ verdict: 'ask', cls: 'unknown', origin: 'https://example.com' });
  });
});

describe('permissionEngine.decide — ordering and edge cases', () => {
  test('a tool outside ctx.allowedTools is denied in every mode, Bypass included', () => {
    for (const allowedTools of [new Set(['fs.read']), ['fs.read'], (n) => n === 'fs.read']) {
      expect(decide(call('fs.write'), { mode: 'bypass', allowedTools }).reason).toBe('tool_not_available');
      expect(decide(call('fs.read'), { mode: 'bypass', allowedTools, facts: { rel: 'a' } }).verdict).toBe('allow');
    }
    expect(decide(call('fs.read'), { allowedTools: 'fs.read' }).reason).toBe('tool_not_available');
  });

  test('a missing or non-string tool name is denied', () => {
    expect(decide({}, { mode: 'bypass' }).verdict).toBe('deny');
    expect(decide(null, { mode: 'bypass' }).verdict).toBe('deny');
  });

  test('blocked facts (path escape, shell disabled) deny even in Bypass', () => {
    const v = decide(call('fs.read', { path: '../x' }), { mode: 'bypass', facts: { blocked: 'path_outside_workspace' } });
    expect(v).toMatchObject({ verdict: 'deny', reason: 'path_outside_workspace' });
  });

  test('an invalid deny rule in config fails closed to ask, even under Bypass', () => {
    const v = decide(call('fs.read', { path: 'a' }), { mode: 'bypass', rules: rules({ deny: ['fs.read:/etc/**'] }), facts: { rel: 'a' } });
    expect(v).toMatchObject({ verdict: 'ask', reason: 'invalid_deny_rule:fs.read:/etc/**' });
  });

  test('an invalid allow rule is ignored, not treated as allow-all', () => {
    const v = decide(call('shell.run', { argv: ['ls'] }), { mode: 'ask', rules: rules({ allow: ['shell.run:'] }) });
    expect(v.verdict).toBe('ask');
  });

  test('exec asks in Ask and Auto-edit; Bypass allows; an exact allow rule allows', () => {
    const c = call('shell.run', { argv: ['git', 'status'] });
    expect(decide(c, { mode: 'ask' }).verdict).toBe('ask');
    expect(decide(c, { mode: 'auto-edit' }).verdict).toBe('ask');
    expect(decide(c, { mode: 'bypass' }).reason).toBe('mode_bypass');
    expect(decide(c, { mode: 'ask', rules: rules({ allow: ['shell.run:git status'] }) }).reason).toBe('rule_allow:shell.run:git status');
    expect(decide(call('shell.run', { argv: ['git', 'status', ';rm'] }), { mode: 'ask', rules: rules({ allow: ['shell.run:git status'] }) }).verdict).toBe('ask');
  });

  test('session rules allow only what they match', () => {
    const sessionRules = [parse('fs.write:src/**')];
    expect(decide(call('fs.write'), { mode: 'ask', sessionRules, facts: { rel: 'src/a.js' } }).reason).toBe('session_rule:fs.write:src/**');
    expect(decide(call('fs.write'), { mode: 'ask', sessionRules, facts: { rel: 'lib/a.js' } }).verdict).toBe('ask');
  });

  test('legacy class deny and per-origin deny beat Bypass', () => {
    expect(decide(call('browser.click'), { mode: 'bypass', url: PAGE, classDeny: ['click'] }).reason).toBe('denied_by_policy:click');
    const perOrigin = { 'https://example.com': { click: 'deny' } };
    expect(decide(call('browser.click'), { mode: 'bypass', url: PAGE, perOrigin }).reason).toBe('origin_deny:https://example.com');
  });

  test('browser classes follow BROWSER_CLASS_POLICY in Ask mode', () => {
    expect(decide(call('browser.click', { ref: 1 }), { mode: 'ask', url: PAGE }).verdict).toBe('allow');
    expect(decide(call('browser.click', { ref: 1 }), { mode: 'ask', url: 'https://shop.com/checkout/1' }))
      .toMatchObject({ verdict: 'ask', cls: 'payment' });
    const v = decide(call('browser.close_tab'), { mode: 'ask', url: PAGE });
    expect(v).toMatchObject({ verdict: 'ask', cls: 'destructive' });
    const sessionGrants = new Set(['https://example.com::destructive']);
    expect(decide(call('browser.close_tab'), { mode: 'ask', url: PAGE, sessionGrants }).reason).toBe('session_grant');
    expect(decide(call('browser.close_tab'), { mode: 'ask', url: 'https://other.com/', sessionGrants }).verdict).toBe('ask');
  });

  test('egress: a blocked destination is denied in Bypass; an unlisted one asks as class egress', () => {
    const egress = { mode: 'allowlist', allow: ['example.com'], block: ['evil.com'], onViolation: 'prompt' };
    expect(decide(call('browser.navigate', { url: 'https://evil.com/' }), { mode: 'bypass', url: PAGE, egress }).reason)
      .toBe('egress_blocked:https://evil.com');
    const v = decide(call('browser.navigate', { url: 'https://other.org/' }), { mode: 'bypass', url: PAGE, egress });
    expect(v).toMatchObject({ verdict: 'ask', reason: 'egress_unlisted', cls: 'egress', origin: 'https://other.org', suggestedRule: null });
    const denyEgress = { ...egress, onViolation: 'deny' };
    expect(decide(call('browser.navigate', { url: 'https://other.org/' }), { mode: 'ask', url: PAGE, egress: denyEgress }).reason)
      .toBe('egress_unlisted:https://other.org');
  });

  test('meta tools are always allowed and unknown modes fall back to Ask', () => {
    expect(decide(call('agent.done'), { mode: 'plan' }).verdict).toBe('allow');
    expect(decide(call('fs.write'), { mode: 'yolo', facts: { rel: 'a' } }).reason).toBe('mode_ask:ask:edit');
    expect(MODES).toEqual(['ask', 'auto-edit', 'plan', 'bypass']);
  });
});

describe('permissionEngine.decide — research sources fan-out', () => {
  const research = (...urls) => call('browser.open_research_sources', { sources: urls.map((url) => ({ url, title: url })) });
  const egress = { mode: 'open', allow: [], block: ['evil.test'], onViolation: 'prompt' };

  test('a blocked source among several denies the whole call, Bypass included', () => {
    for (const mode of ['ask', 'plan', 'bypass']) {
      const v = decide(research('https://ok.test/a', 'https://evil.test:8443/b'), { mode, url: PAGE, egress });
      expect(v).toMatchObject({ verdict: 'deny', reason: 'egress_blocked:https://evil.test:8443' });
    }
  });

  test('a host deny rule on any one source denies the call', () => {
    const v = decide(research('https://ok.test/a', 'https://bad.test/b'), { mode: 'bypass', url: PAGE, rules: rules({ deny: ['browser.*:bad.test'] }) });
    expect(v).toMatchObject({ verdict: 'deny', reason: 'rule_deny:browser.*:bad.test' });
  });

  test('allowlist: unlisted sources ask once, naming every unlisted origin', () => {
    const allowEg = { mode: 'allowlist', allow: ['ok.test'], block: [], onViolation: 'prompt' };
    const v = decide(research('https://ok.test/a', 'https://x.test/b', 'https://y.test/c'), { mode: 'bypass', url: PAGE, egress: allowEg });
    expect(v).toMatchObject({ verdict: 'ask', reason: 'egress_unlisted', cls: 'egress', origin: 'https://x.test', origins: ['https://x.test', 'https://y.test'] });
    const granted = new Set(['https://x.test::egress', 'https://y.test::egress']);
    expect(decide(research('https://x.test/b', 'https://y.test/c'), { mode: 'ask', url: PAGE, egress: allowEg, sessionGrants: granted }).verdict).toBe('allow');
  });

  test('an ask rule on any source asks; an allow rule must cover every source', () => {
    const askV = decide(research('https://ok.test/a', 'https://watch.test/b'), { mode: 'bypass', url: PAGE, rules: rules({ ask: ['browser.open_research_sources:watch.test'] }) });
    expect(askV).toMatchObject({ verdict: 'ask', reason: 'rule_ask:browser.open_research_sources:watch.test' });
    const allow = rules({ allow: ['browser.open_research_sources:ok.test'] });
    const ctx = { mode: 'ask', url: PAGE, rules: allow, perOrigin: { 'https://other.test': { navigate: 'deny' } } };
    expect(decide(research('https://ok.test/a'), ctx).reason).toBe('rule_allow:browser.open_research_sources:ok.test');
    expect(decide(research('https://ok.test/a', 'https://other.test/b'), ctx).reason).toBe('origin_deny:https://other.test');
    const listed = { mode: 'allowlist', allow: [], block: [], onViolation: 'prompt' };
    expect(decide(research('https://ok.test/a'), { mode: 'ask', url: PAGE, rules: allow, egress: listed }).verdict).toBe('allow');
    expect(decide(research('https://ok.test/a', 'https://other.test/b'), { mode: 'ask', url: PAGE, rules: allow, egress: listed }))
      .toMatchObject({ verdict: 'ask', reason: 'egress_unlisted', origins: ['https://ok.test', 'https://other.test'] });
  });

  test('sources that all pass are allowed as before; several hosts suggest no rule', () => {
    const v = decide(research('https://ok.test/a', 'https://fine.test/b'), { mode: 'ask', url: PAGE, egress });
    expect(v).toMatchObject({ verdict: 'allow', origin: 'https://ok.test', suggestedRule: null });
  });
});

describe('permissionEngine.decide — destination-keyed grants', () => {
  test('a navigate grant is keyed on the destination origin, not the current page', () => {
    const v = decide(call('browser.navigate', { url: 'https://shop.test/checkout' }), { mode: 'ask', url: PAGE });
    expect(v).toMatchObject({ verdict: 'ask', cls: 'payment', origin: 'https://shop.test' });
    const pageGrant = new Set(['https://example.com::payment']);
    expect(decide(call('browser.navigate', { url: 'https://evil.test/checkout' }), { mode: 'ask', url: PAGE, sessionGrants: pageGrant }).verdict).toBe('ask');
    const destGrant = new Set(['https://shop.test::payment']);
    expect(decide(call('browser.navigate', { url: 'https://shop.test/checkout' }), { mode: 'ask', url: 'https://any.test/', sessionGrants: destGrant }).reason).toBe('session_grant');
  });

  test('per-origin rules for navigation apply to the destination', () => {
    const perOrigin = { 'https://evil.test': { navigate: 'deny' } };
    expect(decide(call('browser.navigate', { url: 'https://evil.test./x' }), { mode: 'bypass', url: PAGE, perOrigin }).reason).toBe('origin_deny:https://evil.test');
    expect(decide(call('browser.navigate', { url: 'https://fine.test/' }), { mode: 'bypass', url: 'https://evil.test/', perOrigin }).verdict).toBe('allow');
  });

  test('a call without a destination still keys on the page origin', () => {
    expect(decide(call('browser.close_tab'), { mode: 'ask', url: 'https://example.com./x' }).origin).toBe('https://example.com');
  });
});

describe('permissionEngine.decide — walking tools and denied subtrees', () => {
  const ctxFor = (deny, rel) => ({ mode: 'bypass', rules: rules({ deny }), facts: { rel } });

  test('fs.search / fs.list over a tree holding a denied path fail closed', () => {
    expect(decide(call('fs.search', { pattern: 'k' }), ctxFor(['fs.*:secret/**'], '.')))
      .toMatchObject({ verdict: 'deny', reason: 'deny_rule_in_subtree:fs.*:secret/**' });
    expect(decide(call('fs.list', { depth: 3 }), ctxFor(['fs.list:**/.env'], 'src')).reason).toBe('deny_rule_in_subtree:fs.list:**/.env');
    expect(decide(call('fs.search', { pattern: 'k' }), ctxFor(['fs.read:Secret/**'], 'secret/sub')).reason).toBe('deny_rule_in_subtree:fs.read:Secret/**');
  });

  test('a walk outside the denied subtree, or a rule for another tool, is unaffected', () => {
    expect(decide(call('fs.search', { pattern: 'k' }), ctxFor(['fs.*:secret/**'], 'src')).verdict).toBe('allow');
    expect(decide(call('fs.search', { pattern: 'k' }), ctxFor(['fs.*:*.pem'], 'src')).verdict).toBe('allow');
    expect(decide(call('fs.list'), ctxFor(['fs.write:secret/**'], '.')).verdict).toBe('allow');
    expect(decide(call('fs.list'), ctxFor(['fs.read:secret/**'], '.')).verdict).toBe('allow');
    expect(decide(call('fs.read', { path: 'a' }), ctxFor(['fs.*:secret/**'], 'a')).verdict).toBe('allow');
  });
});
