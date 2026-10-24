/**
 * assistantFlows.test.js — drives the REAL app's assistant platform end to end
 * against a scripted OpenAI-compatible endpoint: chat and agent lanes,
 * persisted branching sessions, approvals with diffs, workspace fs + shell,
 * checkpoints and rewind, plan mode, permission rules, artifacts, skills,
 * subagents, background sessions and the inbox.
 *
 * The endpoint is the only test double: it is the external HTTP boundary. It
 * also rejects any request a strict chat template (Gemma / Mistral / jinja)
 * would reject, so every flow here doubles as a role-alternation check.
 *
 * RUN IT
 *   npm run test:e2e:assistant
 *
 * GATING
 * Without RUN_ASSISTANT_E2E=1 every test here is a SKIP — never a pass.
 *
 * ORDER MATTERS. One app instance serves the whole file; tests run in
 * declaration order and later flows build on the session earlier ones made.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppHarness } = require('./helpers/appHarness');
const { ScriptedLlmServer, textOf } = require('./helpers/scriptedLlmServer');

const RUN = process.env.RUN_ASSISTANT_E2E === '1';
const describeFn = RUN ? describe : describe.skip;

const T = 60000;

describeFn('Assistant flows (real app, scripted endpoint)', () => {
  /** @type {AppHarness} */
  let h;
  /** @type {import('playwright').Page} */
  let page;
  /** @type {ScriptedLlmServer} */
  let llm;
  let workspace;

  const shell = '#assistant-shell';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const status = () => page.locator(`${shell} .agent-panel-status`).getAttribute('data-status');
  // On timeout the error names what the screen showed instead.
  const waitStatus = async (want, timeout = 30000) => {
    const wanted = Array.isArray(want) ? want : [want];
    try {
      await page.waitForFunction(([sel, w]) => {
        const el = document.querySelector(sel);
        return !!el && w.includes(el.getAttribute('data-status'));
      }, [`${shell} .agent-panel-status`, wanted], { timeout });
    } catch (err) {
      const seen = await page.evaluate((s) => ({
        status: document.querySelector(`${s} .agent-panel-status`)?.getAttribute('data-status'),
        answer: document.querySelector(`${s} .agent-panel-answer-slot .agent-answer-body`)?.textContent.slice(0, 300),
        toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()),
      }), shell);
      throw new Error(`status never reached ${wanted.join('|')}: ${JSON.stringify(seen)}`, { cause: err });
    }
  };
  // The thread on screen is the most recently written session.
  const activeSessionId = async () => {
    const res = await h.invoke('session:list', {});
    const rows = (res.sessions || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return rows.length ? rows[0].id : null;
  };
  const setRoute = async (mode) => {
    await page.click(`${shell} .agent-panel-modeswitch-btn[data-mode="${mode}"]`);
    await page.waitForSelector(`${shell} .agent-panel-modeswitch-btn[data-mode="${mode}"].is-active`, { timeout: 5000 });
  };
  const send = async (text) => {
    await page.fill(`${shell} .agent-panel-input`, text);
    await page.click(`${shell} .agent-panel-run`);
  };
  // The active branch as node objects (session:get returns ids on `path`).
  const sessionPath = async (sid) => {
    const got = await h.invoke('session:get', { sessionId: sid });
    expect(got.ok).toBe(true);
    const byId = new Map(got.nodes.map((n) => [n.id, n]));
    return got.path.map((id) => byId.get(id));
  };
  // The live answer streams into the answer slot (typewriter-revealed), and
  // is frozen into the transcript when the next turn starts.
  const answerSel = `${shell} .agent-panel-answer-slot .agent-answer-body`;
  const waitAnswer = (needle, timeout = 15000) => page.waitForFunction(([sel, n]) => {
    const el = document.querySelector(sel);
    return !!el && el.textContent.includes(n);
  }, [answerSel, needle], { timeout });
  const threadMsg = (role, text) => page.locator(`${shell} ol.agent-panel-transcript li.chat-msg--${role}`, { hasText: text });
  const lastToolResult = (req) => req.body.messages.filter((m) => m.role === 'tool').map((m) => textOf(m.content)).pop() || '';

  beforeAll(async () => {
    llm = await new ScriptedLlmServer().start();
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-e2e-workspace-')));
    h = await new AppHarness().launch();
    page = h.page;
    await h.autoDismissSiteBlocked();
    await h.dismissWelcome();
    const set = await h.invoke('llm:set-remote', { endpoint: llm.baseUrl, apiKey: '', model: 'e2e-scripted', visionCapable: false });
    expect(set && set.ok !== false).toBe(true);
    await h.send('config:set', { path: 'settings.llm.agent.workspace.roots', value: [workspace] });
    await h.send('config:set', { path: 'settings.chat.features', value: { webSearch: false, readTopPage: false, thinkStepByStep: false } });
  }, 120000);

  afterAll(async () => {
    if (h) await h.close();
    if (llm) await llm.stop();
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  }, 60000);

  afterEach(() => {
    // Every request the app sent must be one a strict chat template accepts,
    // and every scripted step was used; leftovers would leak into later tests.
    const violations = llm.violations.splice(0);
    const leftover = llm.drainAgentSteps();
    expect(violations).toEqual([]);
    expect(leftover).toBe(0);
  });

  test('Mod+E opens assistant mode with the composer focused on a cold thread', async () => {
    await h.press('Mod+E');
    await page.waitForFunction(() => document.body.classList.contains('app-mode-assistant'), undefined, { timeout: 10000 });
    await page.waitForSelector(`${shell} .agent-panel-input`, { state: 'visible', timeout: 10000 });
    expect(await page.locator(`${shell} li.chat-msg`).count()).toBe(0);
  }, T);

  test('a chat turn streams from the endpoint, renders, and is persisted as a session', async () => {
    await setRoute('chat');
    llm.chatResponder = () => ({ content: 'Paris is the capital of **France**.', chunkGapMs: 20 });
    await send('What is the capital of France?');
    await waitStatus('done');
    await waitAnswer('Paris is the capital of France.');
    // Markdown renders, not raw asterisks.
    expect(await page.locator(`${answerSel} strong`).innerText()).toBe('France');
    const sid = await activeSessionId();
    expect(sid).toMatch(/^s_/);
    const nodes = await sessionPath(sid);
    expect(nodes.map((n) => n.role)).toEqual(['user', 'assistant']);
    expect(nodes[0].content).toBe('What is the capital of France?');
    expect(nodes[1].content).toBe('Paris is the capital of **France**.');
    const req = llm.chatRequests().pop();
    expect(req.body.stream).toBe(true);
    expect(req.body.model).toBe('e2e-scripted');
  }, T);

  test('a follow-up chat turn carries the history and alternates roles', async () => {
    llm.chatResponder = () => ({ content: 'About 2.1 million people.' });
    await send('And its population?');
    await waitStatus('done');
    const req = llm.chatRequests().pop();
    const roles = req.body.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(textOf(req.body.messages[2].content)).toContain('Paris');
    await waitAnswer('About 2.1 million people.');
    // The earlier answer froze into the transcript as rendered markdown.
    const frozen = page.locator(`${shell} li.chat-msg--assistant`).first();
    expect(await frozen.innerText()).toContain('Paris is the capital of France.');
    expect(await frozen.locator('strong').innerText()).toBe('France');
    expect(await sessionPath(await activeSessionId())).toHaveLength(4);
  }, T);

  test('an agent fs.write asks for approval with a diff, writes on Allow, and finishes', async () => {
    await setRoute('agent');
    llm.queueAgent(
      { calls: [{ name: 'fs.write', args: { path: 'notes/hello.txt', content: 'hello from e2e\n' } }] },
      { calls: [{ name: 'agent.done', args: { summary: 'Wrote notes/hello.txt with a greeting line.' } }] },
    );
    await send('Write a greeting into notes/hello.txt');
    await page.waitForSelector(`${shell} .approval-card`, { state: 'visible', timeout: 30000 });
    expect(await page.locator(`${shell} .approval-card .diff-view`).count()).toBe(1);
    expect(fs.existsSync(path.join(workspace, 'notes/hello.txt'))).toBe(false);
    await page.click(`${shell} .approval-card__btn[data-decision="approve"]`);
    await waitStatus('done');
    expect(fs.readFileSync(path.join(workspace, 'notes/hello.txt'), 'utf8')).toBe('hello from e2e\n');
    const toolReq = llm.agentRequests().pop();
    expect(lastToolResult(toolReq)).toMatch(/ok|written|bytes/i);
    await waitAnswer('Wrote notes/hello.txt');
    expect(llm.pendingAgentSteps).toBe(0);
    // Both earlier chat answers stay in the thread above the agent turn.
    const thread = await page.locator(`${shell} ol.agent-panel-transcript li.chat-msg--assistant`).allInnerTexts();
    expect(thread.join('\n')).toContain('Paris is the capital of France.');
    expect(thread.join('\n')).toContain('About 2.1 million people.');
    // The agent turn sees the chat history, roles still alternating.
    const first = llm.agentRequests().find((r) => r.body.messages.some((m) => textOf(m.content).includes('Write a greeting')));
    expect(textOf(first.body.messages.find((m) => m.role === 'assistant').content)).toContain('Paris');
  }, T);

  test('shell.run asks with the argv, runs without a shell on Allow, and returns literal output', async () => {
    llm.queueAgent(
      { calls: [{ name: 'shell.run', args: { argv: ['echo', '$(whoami)', '; ls'] } }] },
      { calls: [{ name: 'agent.done', args: { summary: 'Echoed the literal text without a shell.' } }] },
    );
    await send('Echo something');
    await page.waitForSelector(`${shell} .approval-card`, { state: 'visible', timeout: 30000 });
    expect(await page.locator(`${shell} .approval-card`).innerText()).toContain('$(whoami)');
    await page.click(`${shell} .approval-card__btn[data-decision="approve"]`);
    await waitStatus('done');
    const out = lastToolResult(llm.agentRequests().pop());
    expect(out).toContain('$(whoami) ; ls');
    await waitAnswer('Echoed the literal text');
  }, T);

  test('rewind to a user message deletes the file that turn created and trims the conversation', async () => {
    const target = path.join(workspace, 'notes/hello.txt');
    expect(fs.existsSync(target)).toBe(true);
    const sid = await activeSessionId();
    const turn = threadMsg('user', 'Write a greeting');
    await turn.locator('.chat-msg__more').click();
    await turn.locator('.chat-msg__menu-item--rewind').click();
    await page.waitForSelector('.rewind-dialog__box', { state: 'visible', timeout: 10000 });
    const row = page.locator('.rewind-dialog__file-list li', { hasText: 'notes/hello.txt' });
    expect(await row.getAttribute('class')).toContain('rewind-dialog__file--delete');
    expect(await page.locator('.rewind-dialog__files-opt input').isChecked()).toBe(true);
    await page.click('.rewind-dialog__confirm');
    await page.waitForSelector('.rewind-dialog__box', { state: 'detached', timeout: 10000 });
    expect(fs.existsSync(target)).toBe(false);
    const nodes = await sessionPath(sid);
    expect(nodes.filter((n) => n.role === 'user').map((n) => n.content)).toEqual(['What is the capital of France?', 'And its population?']);
    expect(await threadMsg('user', 'Write a greeting').count()).toBe(0);
    expect(await threadMsg('user', 'Echo something').count()).toBe(0);
    // The rewound message comes back into the composer for another try.
    expect(await page.inputValue(`${shell} .agent-panel-input`)).toContain('Write a greeting');
    await page.fill(`${shell} .agent-panel-input`, '');
  }, T);

  test('edit & resend makes a sibling branch the version switcher can flip between', async () => {
    llm.chatResponder = () => ({ content: 'About 105 square kilometres.' });
    const q = threadMsg('user', 'And its population?');
    await q.locator('.chat-msg__edit').click();
    await q.locator('.chat-msg__editor-input').fill('And its area?');
    await q.locator('.chat-msg__editor-save').click();
    await waitStatus('done');
    await waitAnswer('About 105 square kilometres.');
    expect(textOf(llm.chatRequests().pop().body.messages.pop().content)).toContain('And its area?');
    const edited = threadMsg('user', 'And its area?');
    expect(await edited.locator('.chat-branch-nav__label').innerText()).toBe('2/2');
    await edited.locator('.chat-branch-nav__btn[aria-label="Previous version"]').click();
    await page.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((li) => li.textContent.includes('About 2.1 million people.')),
      `${shell} li.chat-msg--assistant`, { timeout: 10000 });
    const original = threadMsg('user', 'And its population?');
    expect(await original.locator('.chat-branch-nav__label').innerText()).toBe('1/2');
    expect((await sessionPath(await activeSessionId())).map((n) => n.content)).toContain('About 2.1 million people.');
    await original.locator('.chat-branch-nav__btn[aria-label="Next version"]').click();
    await page.waitForFunction((sel) => [...document.querySelectorAll(sel)].some((li) => li.textContent.includes('About 105 square kilometres.')),
      `${shell} li.chat-msg--assistant`, { timeout: 10000 });
  }, T);

  test('regenerate on a chat answer adds a sibling answer', async () => {
    llm.chatResponder = () => ({ content: 'Roughly 105 km².' });
    const answer = page.locator(`${shell} li.chat-msg--assistant`, { hasText: 'About 105 square kilometres.' }).last();
    await answer.locator('.chat-msg__regenerate').click();
    await waitStatus('done');
    await waitAnswer('Roughly 105 km²');
    const nodes = await sessionPath(await activeSessionId());
    expect(nodes[nodes.length - 1].content).toBe('Roughly 105 km².');
    expect(nodes.filter((n) => n.role === 'user')).toHaveLength(2);
    expect(await page.locator(`${shell} .chat-live-actions .chat-branch-nav__label`).innerText()).toBe('2/2');
  }, T);

  test('regenerate on an agent answer re-runs the agent for that turn', async () => {
    await setRoute('agent');
    llm.queueAgent(
      { calls: [{ name: 'fs.list', args: { path: '.' } }] },
      { calls: [{ name: 'agent.done', args: { summary: 'Listed the workspace: it is empty now.' } }] },
    );
    await send('List the workspace');
    await waitStatus('done');
    await waitAnswer('Listed the workspace');
    llm.queueAgent({ calls: [{ name: 'agent.done', args: { summary: 'Second look: the workspace holds nothing.' } }] });
    await page.locator(`${shell} .chat-live-actions .chat-msg__regenerate`).click();
    await waitStatus('done');
    await waitAnswer('Second look');
    expect(llm.pendingAgentSteps).toBe(0);
    const nodes = await sessionPath(await activeSessionId());
    expect(nodes[nodes.length - 1].content).toContain('Second look');
    expect(nodes.filter((n) => n.role === 'user').pop().content).toBe('List the workspace');
  }, T);

  test('plan mode offers read-only tools, proposes a plan, and approval runs it with full tools', async () => {
    await page.click(`${shell} .permission-mode__pill`);
    await page.click(`${shell} .permission-mode__item[data-mode="plan"]`);
    await page.waitForSelector(`${shell} .permission-mode[data-mode="plan"]`, { timeout: 5000 });
    llm.queueAgent(
      { calls: [{ name: 'agent.todo_write', args: { todos: [{ content: 'Write plan.txt', status: 'pending' }] } }] },
      { calls: [{ name: 'agent.exit_plan', args: { summary: 'Create plan.txt with one line.' } }] },
    );
    await send('Plan a file');
    await page.waitForSelector(`${shell} .plan-panel__proposal`, { state: 'visible', timeout: 30000 });
    const planReq = llm.agentRequests().pop();
    const names = planReq.body.tools.map((t) => t.function.name);
    expect(names).toContain('agent.exit_plan');
    expect(names).not.toContain('fs.write');
    expect(names).not.toContain('shell.run');
    expect(await page.locator(`${shell} .plan-panel__summary`).innerText()).toContain('Create plan.txt');
    expect(await page.locator(`${shell} li.plan-panel__item`).first().innerText()).toContain('Write plan.txt');
    expect(await page.locator(answerSel).innerText()).not.toMatch(/ended without an answer/i);
    llm.queueAgent(
      { calls: [{ name: 'fs.write', args: { path: 'plan.txt', content: 'planned\n' } }] },
      { calls: [{ name: 'agent.done', args: { summary: 'Executed the approved plan and wrote plan.txt.' } }] },
    );
    await page.click(`${shell} .plan-panel__btn--approve`);
    await page.waitForSelector(`${shell} .approval-card`, { state: 'visible', timeout: 30000 });
    const execReq = llm.agentRequests().pop();
    expect(execReq.body.tools.map((t) => t.function.name)).toContain('fs.write');
    await page.click(`${shell} .approval-card__btn[data-decision="approve"]`);
    await waitStatus('done');
    await waitAnswer('Executed the approved plan');
    expect(fs.readFileSync(path.join(workspace, 'plan.txt'), 'utf8')).toBe('planned\n');
    await page.click(`${shell} .permission-mode__pill`);
    expect(await page.locator(`${shell} .permission-mode`).getAttribute('data-mode')).toBe('ask');
    await page.keyboard.press('Escape');
  }, T);

  test('a deny rule beats Bypass while Bypass auto-allows everything else', async () => {
    const added = await h.invoke('permissions:add-rule', { list: 'deny', rule: 'shell.run:rm *' });
    expect(added.ok).toBe(true);
    await page.click(`${shell} .permission-mode__pill`);
    await page.click(`${shell} .permission-mode__item[data-mode="bypass"]`);
    await page.click(`${shell} .permission-mode__confirm-yes`);
    await page.waitForSelector(`${shell} .permission-mode[data-mode="bypass"]`, { timeout: 5000 });
    fs.writeFileSync(path.join(workspace, 'keep.txt'), 'keep\n');
    llm.queueAgent(
      { calls: [{ name: 'shell.run', args: { argv: ['rm', '-f', 'keep.txt'] } }] },
      { calls: [{ name: 'fs.write', args: { path: 'bypass.txt', content: 'no prompt\n' } }] },
      { calls: [{ name: 'agent.done', args: { summary: 'The rm was denied and the write went through.' } }] },
    );
    await send('Remove keep.txt then write bypass.txt');
    await waitStatus('done');
    expect(await page.locator(`${shell} .approval-card`).count()).toBe(0);
    const reqs = llm.agentRequests();
    expect(lastToolResult(reqs[reqs.length - 2])).toContain('rule_deny:shell.run:rm *');
    expect(fs.existsSync(path.join(workspace, 'keep.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'bypass.txt'), 'utf8')).toBe('no prompt\n');
    await h.invoke('permissions:remove-rule', { list: 'deny', rule: 'shell.run:rm *' });
    await page.click(`${shell} .permission-mode__pill`);
    await page.click(`${shell} .permission-mode__item[data-mode="ask"]`);
    await page.waitForSelector(`${shell} .permission-mode[data-mode="ask"]`, { timeout: 5000 });
  }, T);

  test('artifact.create shows the artifact in a sandboxed frame with the CSP first', async () => {
    llm.queueAgent(
      { calls: [{ name: 'artifact.create', args: { type: 'html', title: 'E2E Card', content: '<h1 id="x">Artifact body</h1><script>document.title="ran"</script>' } }] },
      { calls: [{ name: 'agent.done', args: { summary: 'Created the E2E Card artifact for you.' } }] },
    );
    await send('Make an html card');
    await waitStatus('done');
    const listed = await h.invoke('artifact:list', { sessionId: await activeSessionId() });
    expect((listed.artifacts || listed.items || []).map((a) => a.title)).toContain('E2E Card');
    await page.click('#assistant-side-tab-artifacts');
    await page.click(`.artifacts-pane__item-btn:has-text("E2E Card")`);
    const frame = page.locator('iframe.artifact-frame');
    await frame.waitFor({ state: 'attached', timeout: 10000 });
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts');
    await page.waitForFunction(() => /^ic-artifact:\/\/frame\/[0-9a-f]{32}$/.test(
      (/** @type {HTMLIFrameElement} */ (document.querySelector('iframe.artifact-frame'))).src), null, { timeout: 10000 });
    const src = await frame.getAttribute('src');
    const inner = await (await frame.elementHandle()).contentFrame();
    await inner.waitForURL(src, { timeout: 10000 });
    // The artifact's own script ran, under the CSP that leads the document.
    await inner.waitForFunction(() => document.title === 'ran', null, { timeout: 10000 });
    const doc = await inner.evaluate(() => ({
      first: document.head.firstElementChild && document.head.firstElementChild.outerHTML,
      body: document.getElementById('x') && document.getElementById('x').textContent,
    }));
    expect(doc.first).toContain('Content-Security-Policy');
    expect(doc.first).toContain("default-src 'none'");
    expect(doc.body).toBe('Artifact body');
  }, T);

  test('a /skill command runs the skill with its body on the task', async () => {
    const saved = await h.invoke('skills:save', { skill: { name: 'e2e-greeter', description: 'Greets people in the workspace', body: 'Always answer with the word PINEAPPLE.' }, overwrite: true });
    expect(saved.ok).toBe(true);
    llm.queueAgent({ calls: [{ name: 'agent.done', args: { summary: 'PINEAPPLE greeting delivered to the user.' } }] });
    await send('/e2e-greeter say hello');
    await waitStatus('done');
    await waitAnswer('PINEAPPLE greeting');
    const req = llm.agentRequests().pop();
    const lastUser = req.body.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).pop();
    expect(lastUser).toContain('Follow the "e2e-greeter" skill.');
    expect(lastUser).toContain('Always answer with the word PINEAPPLE.');
    expect(lastUser).toContain('say hello');
  }, T);

  test('a subagent works in a fresh context and hands back only its summary', async () => {
    llm.queueAgent(
      { calls: [{ name: 'agent.spawn_subagent', args: { task: 'Count the files in the workspace' } }] },
      { calls: [{ name: 'agent.done', args: { summary: 'Child counted exactly three files.' } }] },
      { calls: [{ name: 'agent.done', args: { summary: 'Parent relayed: three files in the workspace.' } }] },
    );
    const before = llm.agentRequests().length;
    await send('Delegate a file count');
    await page.waitForSelector(`${shell} .approval-card`, { state: 'visible', timeout: 30000 });
    expect(await page.locator(`${shell} .approval-card`).innerText()).toContain('agent.spawn_subagent');
    await page.click(`${shell} .approval-card__btn[data-decision="approve"]`);
    await waitStatus('done');
    await waitAnswer('Parent relayed');
    const reqs = llm.agentRequests().slice(before);
    expect(reqs).toHaveLength(3);
    const child = reqs[1].body.messages.map((m) => textOf(m.content)).join('\n');
    expect(child).toContain('Count the files in the workspace');
    expect(child).not.toContain('Paris');
    expect(lastToolResult(reqs[2])).toContain('Child counted exactly three files.');
  }, T);

  test('a background session reports into the inbox and badges the flip pill', async () => {
    const before = (await h.invoke('inbox:list', {})).unread;
    llm.queueAgent({ calls: [{ name: 'agent.done', args: { summary: 'Background check finished with nothing to report.' } }] });
    const res = await h.invoke('session:send', { text: 'Run a background check', source: 'agent' });
    expect(res.ok).toBe(true);
    await page.waitForFunction(async (n) => {
      const r = await window.icShell.invoke('inbox:list', {});
      return r.unread > n;
    }, before, { timeout: 30000 });
    const inbox = await h.invoke('inbox:list', {});
    const item = inbox.items.find((i) => i.sessionId === res.sessionId);
    expect(item).toMatchObject({ ok: true, read: false });
    expect(item.summary).toContain('Background check finished');
    expect(await page.locator('#tabbar-flip .tab-bar-action-badge').getAttribute('hidden')).toBeNull();
    expect(await page.locator('#tabbar-flip .tab-bar-action-badge').textContent()).toBe(String(inbox.unread));
    await page.click('#assistant-side-tab-inbox');
    await page.waitForSelector(`li.inbox-pane__item[data-item-id="${item.id}"].is-unread`, { timeout: 10000 });
  }, T);

  test('compaction summarizes the thread and the next turn sends the summary, roles intact', async () => {
    await setRoute('chat');
    llm.chatResponder = (body) => (textOf(body.messages[0].content).startsWith('Summarize the conversation')
      ? { content: 'Summary: France, Paris, area and a few agent file tasks.' }
      : { content: 'Continuing after the summary.' });
    const sid = await activeSessionId();
    await page.click(`${shell} button.context-meter`);
    await page.waitForFunction(async (s) => {
      const r = await window.icShell.invoke('session:get', { sessionId: s });
      return r.nodes.some((n) => n.kind === 'compaction');
    }, sid, { timeout: 15000 });
    await send('What did we cover?');
    await waitStatus('done');
    await waitAnswer('Continuing after the summary.');
    const req = llm.chatRequests().pop();
    const all = req.body.messages.map((m) => textOf(m.content)).join('\n');
    expect(all).toContain('Summary: France, Paris');
    expect(all).not.toContain('About 2.1 million people.');
  }, T);

  test('Stop mid-stream keeps the partial answer and the next turn is clean', async () => {
    llm.chatResponder = () => ({ content: 'This is a deliberately slow answer that will be stopped part way through.', chunkGapMs: 1500 });
    await send('Tell me something slowly');
    await waitStatus('running');
    await sleep(1800);
    await page.click(`${shell} .agent-panel-stop`);
    await waitStatus(['idle', 'done']);
    llm.chatResponder = () => ({ content: 'A quick answer after the stop.' });
    await send('Now quickly');
    await waitStatus('done');
    await waitAnswer('A quick answer after the stop.');
    expect(await page.locator(answerSel).innerText()).not.toContain('slow answer');
  }, T);

  test('the history list reopens a saved session with its thread and the compaction divider', async () => {
    const sid = await activeSessionId();
    await page.click(`${shell} .agent-panel-new`);
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 0, `${shell} ol.agent-panel-transcript li.chat-msg`, { timeout: 10000 });
    if (!(await page.locator(`.session-list__row[data-session-id="${sid}"]`).isVisible())) await page.click(`${shell} .agent-panel-history-toggle`);
    await page.click(`.session-list__row[data-session-id="${sid}"] .session-list__open`);
    await page.waitForSelector(`${shell} li.chat-divider`, { timeout: 10000 });
    expect(await threadMsg('user', 'Now quickly').count()).toBe(1);
  }, T);

  test('every message the assistant sent passed main\'s IPC sender check', () => {
    expect(h.refusedIpc()).toEqual([]);
  });
});
