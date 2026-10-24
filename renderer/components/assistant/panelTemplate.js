// Static markup for the Assistant panel. The element classes are the contract
// the assistant/ modules query and the agent-panel stylesheets target.

const { iconHTML } = require('../Icon');

function panelTemplate() {
  return ''
    + '<aside class="agent-panel-sidebar"></aside>'
    + '<section class="agent-panel-main">'
    + '  <header class="agent-panel-header">'
    + `    <button type="button" class="agent-panel-history-toggle agent-panel-icon-btn">${iconHTML('panelLeft')}</button>`
    + '    <span class="agent-panel-title">Assistant</span>'
    + '    <span class="agent-panel-status" data-status="idle" role="status">Ready</span>'
    + '    <span class="agent-panel-scope" data-scope="global">Global</span>'
    + '    <span class="agent-panel-cost" aria-live="polite"></span>'
    + '    <span class="agent-panel-header-spacer"></span>'
    + `    <button type="button" class="agent-panel-new" title="Start a new chat (clears this thread and its agent tabs)">${iconHTML('plus')}<span>New chat</span></button>`
    + '    <div class="agent-panel-menu-slot"></div>'
    + `    <button type="button" class="agent-panel-close agent-panel-icon-btn" aria-label="Close Assistant" title="Close (Esc)">${iconHTML('close')}</button>`
    + '  </header>'
    + '  <!-- Hidden controls adopted into the AssistantMenu (engine / quality / persona / conversation actions / project bar). Kept in the DOM so existing state-machine listeners and held references stay valid; the menu rehosts them. -->'
    + '  <div class="agent-panel-control-vault" hidden>'
    + '    <button type="button" class="agent-panel-engine" data-engine-state="unknown" title="Inference engine controls">Engine…</button>'
    + '    <div class="agent-engine-popover" role="dialog" aria-label="Inference engine">'
    + '      <label class="agent-engine-row"><span>Backend</span><select class="agent-engine-backend" aria-label="Backend"></select></label>'
    + '      <label class="agent-engine-row"><span>Model</span><select class="agent-engine-model" aria-label="Model"><option value="">(default)</option></select></label>'
    + '      <button type="button" class="agent-engine-startstop">Start engine</button>'
    + '      <p class="agent-engine-hint">Deep tuning lives in Settings → LLM.</p>'
    + '    </div>'
    + '    <div class="agent-panel-quality" role="radiogroup" aria-label="Quality mode">'
    + '      <button class="agent-panel-quality-btn" data-mode="efficient" type="button" aria-pressed="false" title="Efficient — minimal tokens, AX-only observations">Efficient</button>'
    + '      <button class="agent-panel-quality-btn is-active" data-mode="balanced" type="button" aria-pressed="true" title="Balanced (default)">Balanced</button>'
    + '      <button class="agent-panel-quality-btn" data-mode="ultra" type="button" aria-pressed="false" title="Ultra — best-of-N, world-model, judges, no token cap">Ultra</button>'
    + '    </div>'
    + '    <label class="agent-panel-persona-wrap" title="Persona — auto-routed; pick one to lock for this session (Cmd+Shift+P)">'
    + '      <span class="agent-panel-persona-label">Persona</span>'
    + '      <select class="agent-panel-persona" aria-label="Persona"><option value="">Auto</option></select>'
    + '    </label>'
    + '    <button class="agent-panel-export" type="button" title="Copy the transcript as Markdown">Copy transcript</button>'
    + '    <button class="agent-panel-shortcuts" type="button" title="Keyboard shortcuts">Shortcuts</button>'
    + '    <label class="agent-panel-enter-to-send" title="When on, plain Enter sends. When off (default), Shift+Enter sends and Enter adds a newline.">'
    + '      <input type="checkbox" class="agent-panel-enter-to-send-cb" />'
    + '      <span>Enter to send</span>'
    + '    </label>'
    + '    <div class="agent-panel-project-slot"></div>'
    + '  </div>'
    + '  <div class="agent-panel-egress" aria-live="polite" hidden></div>'
    + '  <div class="agent-panel-reattach-slot"></div>'
    + '  <div class="agent-panel-scroll">'
    + '    <div class="agent-panel-empty">'
    + '      <div class="agent-panel-hero">'
    + `        <span class="agent-panel-hero-icon" aria-hidden="true">${iconHTML('sparkles')}</span>`
    + '        <div class="agent-panel-hero-text">'
    + '          <h2 class="agent-panel-hero-title">How can I help?</h2>'
    + '          <p class="agent-panel-hero-sub">Ask about what’s on screen, or describe a task to run across your tabs.</p>'
    + '        </div>'
    + '        <div class="agent-panel-hero-engine"></div>'
    + '      </div>'
    + '      <div class="agent-panel-starters" aria-label="Starter tasks">'
    + '        <button type="button" data-starter="Summarize the active page and list the main takeaways.">Summarize page</button>'
    + '        <button type="button" data-starter="Find reliable sources for this topic and open the best ones side by side.">Find sources</button>'
    + '        <button type="button" data-starter="Compare the visible pages and call out agreements, disagreements, and next steps.">Compare pages</button>'
    + '      </div>'
    + '    </div>'
    + '    <ol class="agent-panel-transcript" aria-label="Transcript"></ol>'
    + '    <div class="agent-panel-answer-slot"></div>'
    + '  </div>'
    + '  <div class="agent-panel-approval" aria-live="assertive" hidden></div>'
    + '  <div class="agent-panel-composer">'
    + '    <textarea class="agent-panel-input" rows="2" data-autofocus="true" spellcheck="false" aria-label="Message the Assistant"></textarea>'
    + '    <div class="agent-panel-controls">'
    + '      <span class="agent-panel-mode-slot"></span>'
    + '      <button type="button" class="agent-panel-engine-chip" data-tone="busy"><span class="agent-panel-engine-chip-dot" aria-hidden="true"></span><span class="agent-panel-engine-chip-label"></span></button>'
    + '      <span class="agent-panel-budget" aria-live="polite"></span>'
    + '      <span class="agent-panel-controls-spacer"></span>'
    + `      <button class="agent-panel-stop" type="button" disabled hidden>${iconHTML('stop')}<span>Stop</span></button>`
    + '      <button class="agent-panel-pause" type="button" disabled hidden>Pause</button>'
    + `      <button class="agent-panel-run" type="button">${iconHTML('send')}<span>Send</span></button>`
    + '    </div>'
    + '  </div>'
    + '</section>';
}

module.exports = { panelTemplate };
