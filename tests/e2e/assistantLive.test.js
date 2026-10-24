/**
 * assistantLive.test.js — the assistant platform against a REAL local model:
 * a chat answer and an agent turn that writes a workspace file through a
 * genuine tool call. Proves the request shapes the app sends are ones a real
 * engine (llama-server --jinja, strict templates) accepts and acts on.
 *
 * RUN IT
 *   E2E_LLM_ENDPOINT=http://127.0.0.1:8080 [E2E_LLM_MODEL=name] npm run test:e2e:assistant-live
 *
 * GATING
 * Without RUN_LLM_E2E=1 every test here is a SKIP — never a pass. With it,
 * a missing E2E_LLM_ENDPOINT fails loudly instead of skipping.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppHarness } = require('./helpers/appHarness');

const RUN = process.env.RUN_LLM_E2E === '1';
const describeFn = RUN ? describe : describe.skip;

const T = 240000;

describeFn('Assistant flows (real app, live model)', () => {
  /** @type {AppHarness} */
  let h;
  /** @type {import('playwright').Page} */
  let page;
  let workspace;
  const shell = '#assistant-shell';
  const endpoint = (process.env.E2E_LLM_ENDPOINT || '').replace(/\/+$/, '');

  const statusOf = () => page.locator(`${shell} .agent-panel-status`).getAttribute('data-status');
  const waitSettled = (timeout) => page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    return !!el && ['done', 'idle', 'error'].includes(el.getAttribute('data-status'));
  }, `${shell} .agent-panel-status`, { timeout });
  const setRoute = async (mode) => {
    await page.click(`${shell} .agent-panel-modeswitch-btn[data-mode="${mode}"]`);
    await page.waitForSelector(`${shell} .agent-panel-modeswitch-btn[data-mode="${mode}"].is-active`, { timeout: 5000 });
  };
  const send = async (text) => {
    await page.fill(`${shell} .agent-panel-input`, text);
    await page.click(`${shell} .agent-panel-run`);
  };
  const answerText = () => page.locator(`${shell} .agent-panel-answer-slot .agent-answer-body`).innerText();

  beforeAll(async () => {
    if (!endpoint) throw new Error('RUN_LLM_E2E=1 needs E2E_LLM_ENDPOINT (an OpenAI-compatible base URL)');
    const models = await fetch(`${endpoint}/v1/models`);
    if (!models.ok) throw new Error(`live endpoint ${endpoint} answered ${models.status} on /v1/models`);
    const listed = await models.json();
    const model = process.env.E2E_LLM_MODEL || (listed.data && listed.data[0] && listed.data[0].id);
    if (!model) throw new Error(`live endpoint ${endpoint} lists no model; set E2E_LLM_MODEL`);
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ic-e2e-live-')));
    h = await new AppHarness().launch();
    page = h.page;
    await h.autoDismissSiteBlocked();
    await h.dismissWelcome();
    const set = await h.invoke('llm:set-remote', { endpoint, apiKey: '', model, visionCapable: false });
    expect(set && set.ok !== false).toBe(true);
    await h.send('config:set', { path: 'settings.llm.agent.workspace.roots', value: [workspace] });
    await h.send('config:set', { path: 'settings.chat.features', value: { webSearch: false, readTopPage: false, thinkStepByStep: false } });
    await h.press('Mod+E');
    await page.waitForFunction(() => document.body.classList.contains('app-mode-assistant'), undefined, { timeout: 10000 });
  }, 120000);

  afterAll(async () => {
    if (h) await h.close();
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  }, 60000);

  test('a chat question gets a real streamed answer', async () => {
    await setRoute('chat');
    await send('What is the capital of France? Answer in one short sentence.');
    await waitSettled(T - 10000);
    expect(await statusOf()).toBe('done');
    expect(await answerText()).toMatch(/paris/i);
  }, T);

  test('an agent turn writes a workspace file through a real fs.write tool call', async () => {
    await setRoute('agent');
    await send('Use the fs.write tool to create the file live.txt with exactly this content: hello from the live model');
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      return !!el && el.getAttribute('data-status') === 'running';
    }, `${shell} .agent-panel-status`, { timeout: 30000 });
    const target = path.join(workspace, 'live.txt');
    const deadline = Date.now() + (T - 20000);
    // Approve every write the model asks for until the run settles.
    while (Date.now() < deadline) {
      const s = await statusOf();
      if (['done', 'idle', 'error'].includes(s) && await page.locator(`${shell} .approval-card`).count() === 0) break;
      const approve = page.locator(`${shell} .approval-card__btn[data-decision="approve"]`).first();
      if (await approve.isVisible()) await approve.click();
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain('hello from the live model');
  }, T);
});
