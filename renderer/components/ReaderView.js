// ReaderView.js — distraction-free reading view + local text-to-speech.
//
// Extracts the page in view with the same readableExtractor the agent and
// Page Copilot use (run inside the target webview via executeJavaScript),
// strips it to title / byline / body, and renders it in the unified
// .app-dropdown shell (size xl), mirroring the PageCopilot family so it folds
// into the existing UI. A header "Listen" button reads the article aloud via
// renderer/utils/tts (window.speechSynthesis — offline, OS voices, zero
// dependency), honoring the user's settings.tts rate/voice.

const { buildReadableScript } = require('../../main/agent/readableExtractor');
const { escapeHtml } = require('../utils/markdown');
const tts = require('../utils/tts');
const configBridge = require('../core/configBridge');
const Dropdown = require('./dropdown/Dropdown');
const { icon } = require('./Icon');

// Convert readableExtractor's light markup (lines: `#`-prefixed headings,
// `• ` bullets, `> ` blockquotes, plain paragraphs) to safe HTML. Every
// segment is HTML-escaped — page content is untrusted, no raw passthrough.
function renderArticle(mainText) {
  const lines = String(mainText == null ? '' : mainText).split('\n');
  const out = [];
  let listBuf = [];
  const flushList = () => {
    if (!listBuf.length) return;
    out.push('<ul class="reader-list">'
      + listBuf.map((t) => `<li>${escapeHtml(t)}</li>`).join('')
      + '</ul>');
    listBuf = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushList(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushList();
      const lvl = Math.min(6, h[1].length);
      out.push(`<h${lvl} class="reader-h reader-h${lvl}">${escapeHtml(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^•\s+/.test(line)) { listBuf.push(line.replace(/^•\s+/, '')); continue; }
    flushList();
    if (/^>\s?/.test(line)) {
      out.push(`<blockquote class="reader-quote">${escapeHtml(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    out.push(`<p class="reader-p">${escapeHtml(line)}</p>`);
  }
  flushList();
  return out.join('');
}

function ttsSettings() {
  const t = configBridge.get('settings.tts', {}) || {};
  return {
    enabled: t.enabled !== false,
    rate: Number(t.rate) || 1,
    voiceURI: t.voiceURI || '',
  };
}

class ReaderView {
  constructor() {
    this.contextProvider = null;
    this.content = null;
    this._dropdown = null;
    this._spaceId = null;
    this._page = null;
  }

  initialize(contextProvider) {
    this.contextProvider = typeof contextProvider === 'function' ? contextProvider : () => ({});
    this._buildContent();
    this._dropdown = new Dropdown({
      id: 'reader-view',
      size: 'xl',
      ariaLabel: 'Reader',
      onClose: () => tts.cancel(),
    });
    this._dropdown.setHeader({ title: 'Reader', slot: this._buildListenSlot() });
    this._dropdown.mount(this.content);
  }

  // ── DOM ───────────────────────────────────────────────────────────────────

  _buildListenSlot() {
    const slot = document.createElement('div');
    slot.className = 'reader-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reader-listen-btn';
    btn.addEventListener('click', () => this._toggleListen());
    this._listenBtn = btn;
    slot.appendChild(btn);
    this._syncListen();
    return slot;
  }

  _buildContent() {
    const root = document.createElement('div');
    root.className = 'reader-content';

    const meta = document.createElement('div');
    meta.className = 'reader-meta';
    this._metaEl = meta;

    const body = document.createElement('article');
    body.className = 'reader-body';
    this._bodyEl = body;

    root.appendChild(meta);
    root.appendChild(body);
    this.content = root;
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  open(opts = {}) {
    if (!this._dropdown) return;
    this._spaceId = (opts && opts.spaceId) || null;
    this._page = null;
    tts.cancel();
    this._syncListen();
    this._metaEl.textContent = '';
    this._bodyEl.innerHTML = '<div class="reader-status">Extracting readable content…</div>';
    this._dropdown.open();
    this._load();
  }

  close() { if (this._dropdown) this._dropdown.close(); }

  toggle(opts) {
    if (!this._dropdown) return;
    if (this._dropdown.isOpen()) this.close();
    else this.open(opts);
  }

  get isOpen() { return !!(this._dropdown && this._dropdown.isOpen()); }

  // ── Target resolution ─────────────────────────────────────────────────────

  _ctx() { return (this.contextProvider && this.contextProvider()) || {}; }

  _activeWebview() {
    if (this._spaceId) {
      const el = document.getElementById(this._spaceId);
      if (el) return el;
    }
    const { navigationManager } = this._ctx();
    if (navigationManager && typeof navigationManager.getActiveWebview === 'function') {
      return navigationManager.getActiveWebview();
    }
    return null;
  }

  // ── Load + render ─────────────────────────────────────────────────────────

  async _load() {
    const wv = this._activeWebview();
    if (!wv || typeof wv.executeJavaScript !== 'function') {
      this._renderError('No page in view.');
      return;
    }
    let page;
    try {
      page = await wv.executeJavaScript(buildReadableScript({ maxMainText: 80000 }), true);
    } catch (err) {
      this._renderError((err instanceof Error && err.message) || 'Could not read the page.');
      return;
    }
    if (!page || (!page.mainText && !page.title)) {
      this._renderError('No readable content found on this page.');
      return;
    }
    this._page = page;
    this._renderArticle(page);
  }

  _renderArticle(page) {
    const bits = [];
    if (page.byline) bits.push(escapeHtml(page.byline));
    if (page.wordCount) {
      const mins = Math.max(1, Math.round(page.wordCount / 220));
      bits.push(`${page.wordCount} words · ~${mins} min read`);
    }
    let host = '';
    try { host = page.url ? new URL(page.url).hostname : ''; } catch (_) { host = ''; }
    if (host) bits.push(escapeHtml(host));
    this._metaEl.innerHTML = ''
      + `<h1 class="reader-title">${escapeHtml(page.title || 'Untitled')}</h1>`
      + (bits.length ? `<div class="reader-byline">${bits.join(' · ')}</div>` : '');
    const html = renderArticle(page.mainText);
    this._bodyEl.innerHTML = html || '<div class="reader-status">No article text could be extracted.</div>';
    this._bodyEl.scrollTop = 0;
    this._syncListen();
  }

  _renderError(msg) {
    this._page = null;
    this._metaEl.textContent = '';
    this._bodyEl.innerHTML = `<div class="reader-status reader-status--error">${escapeHtml(msg)}</div>`;
    this._syncListen();
  }

  // ── Listen (text-to-speech) ───────────────────────────────────────────────

  _speakable() {
    if (!this._page) return '';
    const title = this._page.title ? `${this._page.title}. ` : '';
    // Drop the `• ` bullet glyph (markdownToSpeech handles #/>/links) so the
    // engine doesn't vocalize the bullet character.
    const body = String(this._page.mainText || '').replace(/^[ \t]*•[ \t]+/gm, '');
    return (title + body).trim();
  }

  _toggleListen() {
    if (!tts.isSupported()) return;
    if (tts.isSpeaking() || tts.isPaused()) { tts.cancel(); this._syncListen(); return; }
    const text = this._speakable();
    if (!text) return;
    const { rate, voiceURI } = ttsSettings();
    tts.speak(text, {
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
    const available = tts.isSupported() && enabled && !!this._page;
    this._listenBtn.hidden = !(tts.isSupported() && enabled);
    this._listenBtn.disabled = !available;
    const speaking = tts.isSpeaking() || tts.isPaused();
    const label = speaking ? 'Stop' : 'Listen';
    this._listenBtn.title = speaking ? 'Stop reading aloud' : 'Read this article aloud';
    this._listenBtn.setAttribute('aria-label', this._listenBtn.title);
    this._listenBtn.classList.toggle('is-speaking', speaking);
    while (this._listenBtn.firstChild) this._listenBtn.removeChild(this._listenBtn.firstChild);
    this._listenBtn.appendChild(icon(speaking ? 'speakerMute' : 'speaker'));
    const span = document.createElement('span');
    span.textContent = label;
    this._listenBtn.appendChild(span);
  }
}

module.exports = new ReaderView();
module.exports.ReaderView = ReaderView;
module.exports.renderArticle = renderArticle;
