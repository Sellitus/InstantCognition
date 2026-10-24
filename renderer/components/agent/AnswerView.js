// AnswerView — renders the agent's final summary as markdown, typed out
// character-by-character at the measured throughput (clamped to a nice range).
// Includes a live tokens/sec readout and a copy-markdown button.

const { mdToHtml, bindCodeCopy } = require('../../utils/markdown');
const { startTypewriter } = require('../../utils/typewriter');
const tts = require('../../utils/tts');
const configBridge = require('../../core/configBridge');
const { escapeHtml } = require('./format');
const fx = require('../../fx');

function ttsSettings() {
  const t = configBridge.get('settings.tts', {}) || {};
  return {
    enabled: t.enabled !== false,
    rate: Number(t.rate) || 1,
    voiceURI: t.voiceURI || '',
  };
}

class AnswerView {
  constructor({ root }) {
    this._root = root;
    this._el = this._build();
    this._typer = null;
    this._raw = '';
    this._lastHtml = '';
    this._throughput = { tokPerSec: 0, tokensTotal: 0, elapsedMs: 0 };
    this._citeMap = null;
    this._onCite = null;
    this._bodyEl.addEventListener('click', (e) => this._onCiteActivate(e));
    this._bodyEl.addEventListener('keydown', (e) => {
      const ev = /** @type {any} */ (e);
      if (ev.key === 'Enter' || ev.key === ' ') this._onCiteActivate(ev);
    });
    root.appendChild(this._el);
    this.clear();
  }

  _onCiteActivate(e) {
    const a = e.target && e.target.closest && e.target.closest('.agent-cite');
    if (!a) return;
    e.preventDefault();
    const sid = a.getAttribute('data-cite-pane');
    if (sid && typeof this._onCite === 'function') this._onCite(sid);
  }

  // Wire Research Report citations. `map` is { "<index>": spaceId }; after
  // this is set, every [N] whose N is in the map renders as a clickable link
  // that calls onCite(spaceId). Safe to call mid-stream — the next render
  // tick re-applies citations (and we re-render now if the answer is static).
  setCitationMap(map, onCite) {
    this._citeMap = (map && typeof map === 'object' && Object.keys(map).length) ? map : null;
    this._onCite = typeof onCite === 'function' ? onCite : null;
    this._lastHtml = '';
    if (this._raw && !this._typer) this._renderPrefix(this._raw);
  }

  _linkifyCitations(html) {
    if (!this._citeMap) return html;
    const map = this._citeMap;
    // Match whole tags OR a [N] token; rewrite [N] only when it falls in text
    // (tags are consumed as one match, so attributes are never touched).
    return html.replace(/(<[^>]+>)|\[(\d+)\]/g, (m, tag, num) => {
      if (tag) return tag;
      const sid = map[num];
      if (!sid) return m;
      return `<a class="agent-cite" data-cite-pane="${escapeHtml(sid)}" title="Jump to source ${num}" role="button" tabindex="0">[${num}]</a>`;
    });
  }

  _build() {
    const wrap = document.createElement('section');
    wrap.className = 'agent-answer';
    wrap.setAttribute('aria-live', 'polite');
    wrap.innerHTML = ''
      + '<div class="agent-answer-header">'
      + '  <span class="agent-answer-title">Answer</span>'
      + '  <span class="agent-answer-persona" hidden></span>'
      + '  <span class="agent-answer-partial" hidden></span>'
      + '  <span class="agent-answer-stats" aria-live="polite"></span>'
      + '  <div class="agent-answer-actions">'
      + '    <button type="button" class="agent-answer-copy" title="Copy as markdown">Copy</button>'
      + '    <button type="button" class="agent-answer-listen" title="Read this answer aloud" hidden>Listen</button>'
      + '    <button type="button" class="agent-answer-skip" title="Skip animation">Skip</button>'
      + '  </div>'
      + '</div>'
      + '<div class="agent-answer-body md"></div>'
      + '<div class="agent-answer-followups" hidden></div>';
    this._statsEl = /** @type {HTMLElement} */ (wrap.querySelector('.agent-answer-stats'));
    this._bodyEl = /** @type {HTMLElement} */ (wrap.querySelector('.agent-answer-body'));
    bindCodeCopy(this._bodyEl);
    this._personaEl = /** @type {HTMLElement} */ (wrap.querySelector('.agent-answer-persona'));
    this._partialEl = /** @type {HTMLElement} */ (wrap.querySelector('.agent-answer-partial'));
    this._followUpsEl = /** @type {HTMLElement} */ (wrap.querySelector('.agent-answer-followups'));
    this._copyBtn = /** @type {HTMLButtonElement} */ (wrap.querySelector('.agent-answer-copy'));
    this._listenBtn = /** @type {HTMLButtonElement} */ (wrap.querySelector('.agent-answer-listen'));
    this._skipBtn = /** @type {HTMLButtonElement} */ (wrap.querySelector('.agent-answer-skip'));
    this._copyBtn.addEventListener('click', () => this._copy());
    this._listenBtn.addEventListener('click', () => this._listen());
    this._skipBtn.addEventListener('click', () => this.skip());
    this._syncListen();
    return wrap;
  }

  _listen() {
    if (!tts.isSupported()) return;
    if (tts.isSpeaking() || tts.isPaused()) { tts.cancel(); this._syncListen(); return; }
    if (!this._raw) return;
    const { rate, voiceURI } = ttsSettings();
    tts.speak(this._raw, {
      markdown: true,
      rate,
      voiceURI,
      onState: () => this._syncListen(),
    });
    this._syncListen();
  }

  _syncListen() {
    if (!this._listenBtn) return;
    const { enabled } = ttsSettings();
    const supported = tts.isSupported() && enabled;
    this._listenBtn.hidden = !supported;
    this._listenBtn.disabled = !(supported && !!this._raw);
    const speaking = tts.isSpeaking() || tts.isPaused();
    this._listenBtn.textContent = speaking ? 'Stop' : 'Listen';
    this._listenBtn.title = speaking ? 'Stop reading aloud' : 'Read this answer aloud';
  }

  // Set persona context for the answer view. AgentPanel calls this when
  // agent:task-started fires (so the chip shows during typing) AND when
  // task-completed fires (so the follow-up chips render once the answer lands).
  setPersonaContext(ctx) {
    const { personaLabel, source, followUps, onFollowUp, partial } = ctx || {};
    if (this._partialEl) {
      if (partial) { this._partialEl.textContent = partial; this._partialEl.hidden = false; }
      else { this._partialEl.hidden = true; this._partialEl.textContent = ''; }
    }
    if (this._personaEl) {
      if (personaLabel) {
        const tag = source === 'lock' ? 'locked' : (source || 'auto');
        this._personaEl.textContent = `${personaLabel} · ${tag}`;
        this._personaEl.dataset.source = source || 'auto';
        this._personaEl.hidden = false;
      } else {
        this._personaEl.hidden = true;
        this._personaEl.textContent = '';
      }
    }
    if (this._followUpsEl) {
      this._followUpsEl.innerHTML = '';
      const list = Array.isArray(followUps) ? followUps.filter((s) => typeof s === 'string' && s.trim()) : [];
      if (list.length === 0 || typeof onFollowUp !== 'function') {
        this._followUpsEl.hidden = true;
      } else {
        for (const f of list) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'agent-answer-followup-chip';
          btn.textContent = f;
          btn.addEventListener('click', () => onFollowUp(f));
          this._followUpsEl.appendChild(btn);
        }
        this._followUpsEl.hidden = false;
      }
    }
  }

  clear() {
    this._raw = '';
    this._lastHtml = '';
    this._citeMap = null;
    this._onCite = null;
    this._streaming = false;
    this._bodyEl.innerHTML = '';
    fx.streamReset(this._bodyEl);
    this._statsEl.textContent = '';
    if (this._personaEl) { this._personaEl.hidden = true; this._personaEl.textContent = ''; }
    if (this._partialEl) { this._partialEl.hidden = true; this._partialEl.textContent = ''; }
    if (this._followUpsEl) { this._followUpsEl.hidden = true; this._followUpsEl.innerHTML = ''; }
    this._setRunning(false);
    if (this._typer) { this._typer.cancel(); this._typer = null; }
    tts.cancel();
    this._syncListen();
    // Hide the whole section when idle so a fresh / new-chat panel doesn't
    // show a "Waiting for agent…" caption before the user submits.
    if (this._el) this._el.hidden = true;
  }

  // Show the section with the "Waiting for agent…" idle caption. Called by
  // AgentPanel when a task is actually starting (input submitted) so the user
  // sees an immediate response, but NOT during the idle / new-chat state.
  markWaiting() {
    this._raw = '';
    this._lastHtml = '';
    this._bodyEl.innerHTML = '<span class="agent-answer-idle">Waiting for agent…</span>';
    fx.streamReset(this._bodyEl);
    this._statsEl.textContent = '';
    if (this._typer) { this._typer.cancel(); this._typer = null; }
    if (this._el) this._el.hidden = false;
    this._setRunning(true);
  }

  _setRunning(running) {
    this._el.classList.toggle('is-typing', !!running);
    if (this._skipBtn) this._skipBtn.disabled = !running;
  }

  // Update the live throughput chip — driven by AgentService 'throughput'
  // events. Also adjusts typewriter speed when the typer is active.
  updateThroughput({ tokPerSec, tokensThisTurn, elapsedMs }) {
    if (Number.isFinite(tokPerSec) && tokPerSec > 0) this._throughput.tokPerSec = tokPerSec;
    if (Number.isFinite(tokensThisTurn)) this._throughput.tokensTotal += tokensThisTurn;
    if (Number.isFinite(elapsedMs)) this._throughput.elapsedMs += elapsedMs;
    this._renderStats();
    if (this._typer && Number.isFinite(tokPerSec) && tokPerSec > 0) {
      // Rough heuristic: ~4 chars per token
      this._typer.setSpeed(tokPerSec * 4);
    }
  }

  _renderStats() {
    const { tokPerSec, tokensTotal, elapsedMs } = this._throughput;
    const bits = [];
    if (tokPerSec > 0) bits.push(`${tokPerSec.toFixed(0)} tok/s`);
    if (tokensTotal > 0) bits.push(`${formatTokens(tokensTotal)} tokens`);
    if (elapsedMs > 0) bits.push(`${(elapsedMs / 1000).toFixed(1)}s`);
    this._statsEl.textContent = bits.join(' · ');
  }

  // Start streaming the final summary. Called from 'agent:task-completed'.
  // If we've already been receiving live chunks via appendChunk(), skip the
  // typewriter entirely (the body is already populated) and just finalize.
  present(summary) {
    if (this._el) this._el.hidden = false;
    const text = String(summary || '').trim();
    if (!text) {
      // If we streamed something live, keep what we have; otherwise show the idle caption.
      if (!this._streaming || !this._raw) {
        this._bodyEl.innerHTML = '<span class="agent-answer-idle">No summary produced.</span>';
      }
      this._streaming = false;
      this._setRunning(false);
      return;
    }
    if (this._streaming) {
      // Streamed answer is already displayed; replace with the canonical
      // summary in case parsing improved on the buffered text.
      this._raw = text;
      this._lastHtml = '';
      this._renderPrefix(text);
      this._setRunning(false);
      this._streaming = false;
      return;
    }
    this._raw = text;
    fx.streamReset(this._bodyEl);
    const estCps = Math.max(40, Math.min(160, (this._throughput.tokPerSec || 20) * 4));
    this._setRunning(true);
    this._typer = startTypewriter({
      text,
      charsPerSec: estCps,
      onTick: (prefix) => this._renderPrefix(prefix),
      onDone: () => { this._setRunning(false); this._renderPrefix(text); },
    });
  }

  // Live-streaming entry point. Called when the first agent:assistant-chunk
  // arrives. Subsequent chunks just append. The cursor is the existing
  // typewriter glyph (▍) — added in _renderPrefix.
  presentStream() {
    if (this._el) this._el.hidden = false;
    if (this._typer) { this._typer.cancel(); this._typer = null; }
    this._raw = '';
    this._lastHtml = '';
    this._bodyEl.innerHTML = '';
    fx.streamReset(this._bodyEl);
    this._streaming = true;
    this._setRunning(true);
  }

  appendChunk(text) {
    if (!text) return;
    if (!this._streaming) this.presentStream();
    this._raw += String(text);
    this._renderPrefix(this._raw);
  }

  _renderPrefix(prefix) {
    const html = this._linkifyCitations(mdToHtml(prefix)) + '<span class="agent-answer-caret" aria-hidden="true">▍</span>';
    if (html !== this._lastHtml) {
      this._bodyEl.innerHTML = html;
      this._lastHtml = html;
      fx.streamAfterRender(this._bodyEl);
    }
    this._syncListen();
  }

  skip() {
    if (this._typer) this._typer.skip();
  }

  // Render immediately without animation (used when opening past runs).
  renderStatic(summary) {
    if (this._el) this._el.hidden = false;
    const text = String(summary || '').trim();
    this._raw = text;
    this._setRunning(false);
    fx.streamReset(this._bodyEl);
    this._bodyEl.innerHTML = text ? this._linkifyCitations(mdToHtml(text)) : '<span class="agent-answer-idle">No summary.</span>';
    this._lastHtml = this._bodyEl.innerHTML;
    this._syncListen();
  }

  getMarkdown() { return this._raw; }

  _copy() {
    if (!this._raw) return;
    const failed = (err) => {
      console.warn('[AnswerView] copy failed:', (err && err.message) || err);
      this._flashCopy('Copy failed');
    };
    try {
      const { clipboard } = require('electron');
      clipboard.writeText(this._raw);
      this._flashCopy('Copied');
    } catch (_electronErr) {
      // Electron's clipboard is missing in sandboxed contexts; the web
      // clipboard is the fallback and only its failure is reported.
      try {
        Promise.resolve(navigator.clipboard.writeText(this._raw))
          .then(() => this._flashCopy('Copied'), failed);
      } catch (err) { failed(err); }
    }
  }

  _flashCopy(label) {
    if (!this._copyBtn) return;
    const prev = this._copyBtn.textContent;
    this._copyBtn.textContent = label;
    setTimeout(() => { this._copyBtn.textContent = prev; }, 1400);
  }
}

function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Export as an object to avoid confusing escapeHtml used only for fallback.
module.exports = AnswerView;
module.exports.escapeHtml = escapeHtml;
