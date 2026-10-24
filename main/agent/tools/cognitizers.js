// cognitizers.js — agent tool for fanning a single prompt to multiple AI
// services (ChatGPT, Claude, Gemini, etc.) in parallel using the existing
// in-app cognitizer spaces. Each target opens as a tab in the AGENT workspace
// (not the user's view), the prompt is typed and submitted, and the spaceId
// is returned so the agent can later read the response with browser.read_tab.
//
// The prompt-injection script mirrors the unified chat's /council fan-out
// (renderer/utils/councilScripts.buildInjectScript) but runs from the main
// process against agent-workspace webContents.

const tabOps = require('../../services/AgentTabOpsService');
const configService = require('../../services/ConfigService');

const DEFAULT_SUBMIT_DELAY_MS = 1500;
const MAX_FANOUT = 8;

function safeJsonString(s) { return JSON.stringify(String(s == null ? '' : s)); }

function buildInjectScript(text, autoSubmit) {
  // Same selector strategy as renderer.js:919-987 — kept verbatim for fidelity
  // with the user-facing broadcast feature so a prompt that works there works
  // here too.
  return `(function(){
    const text=${safeJsonString(text)};
    const autoSubmit=${JSON.stringify(!!autoSubmit)};
    function findSendButton(){
      const sels=['button[data-testid="send-button"]','button[aria-label="Send Message"]','button[aria-label="Send message"]','button[aria-label*="Send"]','button[aria-label*="submit"]','form button[type="submit"]'];
      for(const s of sels){const b=document.querySelector(s); if(b&&!b.disabled) return b;}
      return null;
    }
    function submitAfterDelay(el){
      if(!autoSubmit) return;
      setTimeout(()=>{
        const b=findSendButton(); if(b){b.click(); return;}
        const f=el.closest('form'); if(f){f.requestSubmit(); return;}
        el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
      }, ${DEFAULT_SUBMIT_DELAY_MS});
    }
    const ta=document.querySelector('textarea');
    if(ta){const ns=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; ns.call(ta,text); ta.dispatchEvent(new Event('input',{bubbles:true})); submitAfterDelay(ta); return 'textarea';}
    const ce=document.querySelector('div[contenteditable="true"]');
    if(ce){ce.focus(); document.execCommand('selectAll',false,null); document.execCommand('insertText',false,text); submitAfterDelay(ce); return 'contenteditable';}
    const inp=document.querySelector('input[type="text"]');
    if(inp){const ns=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; ns.call(inp,text); inp.dispatchEvent(new Event('input',{bubbles:true})); submitAfterDelay(inp); return 'input';}
    return null;
  })();`;
}

async function waitLoadSettled(wc, timeoutMs) {
  if (!wc || typeof wc.isLoading !== 'function') return;
  const deadline = Date.now() + Math.max(500, Math.min(timeoutMs || 8000, 15000));
  if (wc.isLoading()) {
    await new Promise((resolve) => {
      let done = false; const finish = () => { if (done) return; done = true; resolve(); };
      try { wc.once('did-finish-load', finish); } catch (_) {}
      setTimeout(finish, Math.max(250, deadline - Date.now()));
    });
  }
  await new Promise((r) => setTimeout(r, 600));
}

function listEnabledAiServices(spacesCfg, requestedNames) {
  const entries = Object.entries(spacesCfg || {})
    .filter(([, sp]) => sp && sp.type === 'ai-service' && sp.url);
  if (!Array.isArray(requestedNames) || requestedNames.length === 0) {
    return entries.slice(0, MAX_FANOUT).map(([id, sp]) => ({ id, name: sp.name || id, url: sp.url }));
  }
  const want = new Set(requestedNames.map((n) => String(n).toLowerCase()));
  const matched = entries.filter(([id, sp]) => want.has(String(id).toLowerCase()) || want.has(String(sp.name || '').toLowerCase()));
  return matched.slice(0, MAX_FANOUT).map(([id, sp]) => ({ id, name: sp.name || id, url: sp.url }));
}

const broadcastToCognitizers = {
  name: 'agent.broadcast_to_cognitizers',
  description: 'Open the configured AI-service tabs (ChatGPT, Claude, Gemini, etc.) in the agent workspace and type the same prompt into each in parallel. Returns the list of opened spaceIds — call browser.wait_for_load and browser.read_tab on each to harvest responses once they finish generating. Use this when the user wants opinions from multiple AIs, or when no single source is authoritative.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Prompt text to fan out.' },
      services: { type: 'array', items: { type: 'string' }, description: 'Optional subset of cognitizer space ids or names (e.g. ["ChatGPT","Claude"]). Default: all enabled ai-service spaces, capped at 8.' },
      autoSubmit: { type: 'boolean', description: 'Submit the form after typing. Default true.' },
    },
    required: ['prompt'],
  },
  sideEffect: true,
  targetSpaceKey: '_broadcastCognitizers',
  handler: async (args, toolCtx) => {
    const prompt = String((args && args.prompt) || '').trim();
    if (!prompt) return { ok: false, error: 'empty_prompt' };
    const ops = (toolCtx && toolCtx.tabOps) || tabOps;
    const autoSubmit = args && args.autoSubmit !== false;
    const cfg = configService.get('spaces', {}) || {};
    const targets = listEnabledAiServices(cfg, args && args.services);
    if (targets.length === 0) return { ok: false, error: 'no_ai_service_spaces_configured' };

    const opened = [];
    const errors = [];
    for (const t of targets) {
      try {
        const res = await ops.openTab(t.url);
        const spaceId = res && res.spaceId;
        if (!spaceId) { errors.push({ name: t.name, error: 'open_failed' }); continue; }
        if (toolCtx && typeof toolCtx.resolveWc === 'function') {
          const wc = toolCtx.resolveWc(spaceId);
          if (wc) {
            await waitLoadSettled(wc, 8000);
            try { await wc.executeJavaScript(buildInjectScript(prompt, autoSubmit)); }
            catch (err) { errors.push({ name: t.name, spaceId, error: (err instanceof Error && err.message) || 'inject_failed' }); continue; }
          }
        }
        opened.push({ spaceId, name: t.name, url: t.url });
      } catch (err) {
        errors.push({ name: t.name, error: (err instanceof Error && err.message) || 'open_failed' });
      }
    }

    return {
      ok: opened.length > 0,
      opened,
      errors: errors.length ? errors : undefined,
      hint: opened.length
        ? 'Tabs opened and prompt typed. Call browser.wait_for_load and then browser.read_tab on each spaceId after a few seconds to read the responses.'
        : 'No tabs opened. Check that ai-service spaces are configured in Settings → Spaces.',
    };
  },
};

module.exports = [broadcastToCognitizers];
module.exports.buildInjectScript = buildInjectScript;
module.exports.listEnabledAiServices = listEnabledAiServices;
