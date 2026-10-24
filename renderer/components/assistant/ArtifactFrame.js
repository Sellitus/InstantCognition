// ArtifactFrame — renders one artifact version inside a sandboxed iframe.
//
// Isolation contract (security-critical):
//   - sandbox="allow-scripts" only. Never add allow-same-origin: with it, an
//     artifact's script could reach the shell and its IPC bridge.
//   - The document is staged in main and loaded from ic-artifact://frame/<token>
//     (main/services/artifactFrames.js), whose response carries FRAME_CSP as a
//     header; a srcdoc frame would inherit the shell's stricter CSP. The same
//     policy is also the first child of <head>, before anything an artifact
//     contributes, so no request leaves the frame (img-src data:).
//   - CSP does not govern WebRTC, so the first script (right after the CSP)
//     removes the peer-connection constructors and navigator.mediaDevices
//     from the frame and from any nested frame reached via contentWindow /
//     contentDocument or inserted into the DOM. A nested frame read through
//     window[n] alone escapes it; the main window's WebRTC IP policy is the
//     backstop for that.
//   - Artifact text never lands inside a <script> the frame builds: mermaid
//     source and titles are HTML-escaped text, markdown/code go through the
//     mdToHtml sanitizer, and SVG is shown as a data: <img> (no script runs).
//     Mermaid loads by URL from the one asset FRAME_CSP allows.
//     Only the html type is the artifact's own document, by design.
// The frame reports its height with postMessage; messages are trusted only
// from this iframe's contentWindow and the height is clamped. CSP cannot stop
// the frame navigating itself (a link, location=, meta refresh), so any load
// after the one a render started replaces the frame with a notice. The
// iframe element is created once and never reparented; re-rendering swaps
// src and releases the previous staged document.

const { mdToHtml } = require('../../utils/markdown');
const { escapeHtml, escapeAttr } = require('../../utils/html');
const { FRAME_CSP, MERMAID_URL } = require('../../../shared/artifactFrame');

const SIZE_MESSAGE = 'ic-artifact:size';
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 4000;
const NAVIGATION_BLOCKED = { type: 'html', title: 'Navigation blocked', content: '<p class="ic-error">This artifact tried to open another page. The navigation was stopped.</p>' };

// Host design tokens copied into the frame (it cannot see the app's CSS).
const THEME_TOKENS = [
  '--surface-base', '--surface-raised', '--text-primary', '--text-secondary', '--border-default',
  '--accent', '--status-error', '--font-sans', '--font-mono', '--font-size-md', '--font-size-sm',
  '--syntax-keyword', '--syntax-string', '--syntax-number', '--syntax-comment', '--syntax-function',
  '--syntax-title', '--syntax-attr', '--syntax-tag', '--syntax-variable', '--syntax-meta',
  '--syntax-addition', '--syntax-deletion',
];
const UNSAFE_TOKEN_VALUE_RX = /[<>{};\\]/;

const BASE_CSS = `
html,body{margin:0;background:var(--surface-base,transparent);color:var(--text-primary,inherit);font-family:var(--font-sans,system-ui,sans-serif);font-size:var(--font-size-md,14px);line-height:1.5}
body{padding:12px;overflow-wrap:anywhere}
.md pre{background:var(--surface-raised,transparent);border:1px solid var(--border-default,#8884);border-radius:8px;padding:10px;overflow:auto;font-family:var(--font-mono,monospace);font-size:var(--font-size-sm,13px)}
.md code{font-family:var(--font-mono,monospace)}
.md a{color:var(--accent,inherit)}
.md table{border-collapse:collapse}.md th,.md td{border:1px solid var(--border-default,#8884);padding:4px 8px}
.md .md-copy{display:none}
.ic-svg{display:block;max-width:100%;height:auto;margin:0 auto}
pre.mermaid{margin:0;text-align:center;background:none;border:0}
.ic-error{color:var(--status-error,#c00);font-family:var(--font-mono,monospace);white-space:pre-wrap}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in,.hljs-literal,.hljs-type,.hljs-doctag{color:var(--syntax-keyword)}
.hljs-string,.hljs-regexp,.hljs-template-tag,.hljs-symbol{color:var(--syntax-string)}
.hljs-number,.hljs-bullet,.hljs-link{color:var(--syntax-number)}
.hljs-comment,.hljs-quote{color:var(--syntax-comment);font-style:italic}
.hljs-title.function_{color:var(--syntax-function)}
.hljs-title,.hljs-title.class_,.hljs-section,.hljs-selector-id,.hljs-selector-class{color:var(--syntax-title)}
.hljs-attr,.hljs-attribute,.hljs-property,.hljs-params{color:var(--syntax-attr)}
.hljs-tag,.hljs-name{color:var(--syntax-tag)}
.hljs-variable,.hljs-template-variable,.hljs-subst{color:var(--syntax-variable)}
.hljs-meta,.hljs-operator,.hljs-punctuation{color:var(--syntax-meta)}
.hljs-addition{color:var(--syntax-addition)}.hljs-deletion{color:var(--syntax-deletion)}`;

const RTC_GLOBALS = [
  'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate',
  'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCDtlsTransport', 'RTCIceTransport',
  'RTCSctpTransport', 'RTCCertificate', 'RTCDTMFSender',
];
const WEBRTC_PRELUDE_JS = `(function(){var N=${JSON.stringify(RTC_GLOBALS)};var seen=new WeakSet();
function lock(o,n){delete o[n];Object.defineProperty(o,n,{value:undefined,writable:false,configurable:false});}
function scrub(w){if(!w||seen.has(w))return;seen.add(w);for(var i=0;i<N.length;i++)lock(w,N[i]);
var NP=w.Navigator&&w.Navigator.prototype;if(NP)delete NP.mediaDevices;if(w.navigator)lock(w.navigator,'mediaDevices');
var IF=w.HTMLIFrameElement&&w.HTMLIFrameElement.prototype;if(IF){['contentWindow','contentDocument'].forEach(function(p){var d=Object.getOwnPropertyDescriptor(IF,p);if(!d||!d.get)return;
Object.defineProperty(IF,p,{configurable:false,enumerable:d.enumerable,get:function(){var v=d.get.call(this);scrub(p==='contentWindow'?v:v&&v.defaultView);return v;}});});}
if(typeof w.MutationObserver==='function'&&w.document){new w.MutationObserver(function(){var fs=w.document.getElementsByTagName('iframe');for(var j=0;j<fs.length;j++)scrub(fs[j].contentWindow);}).observe(w.document,{childList:true,subtree:true});}}
scrub(self);})();`;
const FRAME_PERMISSIONS = "camera 'none'; microphone 'none'; display-capture 'none'; geolocation 'none'";

const AUTOSIZE_JS = `(function(){var last=-1;function post(){var h=Math.ceil(document.documentElement.scrollHeight);if(h!==last){last=h;parent.postMessage({type:'${SIZE_MESSAGE}',height:h},'*');}}
addEventListener('load',post);if(typeof ResizeObserver==='function'){new ResizeObserver(post).observe(document.documentElement);}})();`;

function mermaidRunJs(theme) {
  return `(function(){var el=document.querySelector('pre.mermaid');
function fail(e){var p=document.createElement('p');p.className='ic-error';p.textContent='Diagram error: '+((e&&e.message)||String(e));document.body.insertBefore(p,el);}
var m=globalThis.mermaid;if(!m||typeof m.run!=='function'){fail(new Error('Mermaid did not load'));return;}
try{m.initialize({startOnLoad:false,securityLevel:'strict',theme:${JSON.stringify(theme)}});m.run({nodes:[el]}).catch(fail);}catch(e){fail(e);}})();`;
}

// `</script` would end the inline <script> early. In JS it can only occur in
// strings, regexes or comments, where `<\/script` means the same thing.
function scriptSafe(js) {
  return String(js).replace(/<\/(script)/gi, '<\\/$1');
}

function longestRun(text, ch) {
  let max = 0;
  let cur = 0;
  for (const c of text) {
    cur = c === ch ? cur + 1 : 0;
    if (cur > max) max = cur;
  }
  return max;
}

function codeAsMarkdown(content, language) {
  const fence = '`'.repeat(Math.max(3, longestRun(content, '`') + 1));
  const lang = typeof language === 'string' && /^[\w+#.-]{1,32}$/.test(language) ? language : '';
  return `${fence}${lang}\n${content}\n${fence}`;
}

/** @param {Record<string, string>} tokens */
function themeCss(tokens) {
  const decls = Object.entries(tokens || {})
    .filter(([name, value]) => THEME_TOKENS.includes(name) && typeof value === 'string' && value.trim() && !UNSAFE_TOKEN_VALUE_RX.test(value))
    .map(([name, value]) => `${name}:${value.trim()}`);
  return decls.length ? `:root{${decls.join(';')}}` : '';
}

function bodyFor(artifact, opts) {
  const content = String(artifact.content == null ? '' : artifact.content);
  switch (artifact.type) {
    case 'html':
      return content;
    case 'svg':
      return `<img class="ic-svg" alt="${escapeAttr(artifact.title || 'SVG image')}" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}">`;
    case 'markdown':
      return `<main class="md">${mdToHtml(content)}</main>`;
    case 'code':
      return `<main class="md">${mdToHtml(codeAsMarkdown(content, artifact.language))}</main>`;
    case 'mermaid':
      return `<pre class="mermaid">${escapeHtml(content)}</pre>`
        + `<script src="${MERMAID_URL}"></script>`
        + `<script>${scriptSafe(mermaidRunJs(opts.dark ? 'dark' : 'default'))}</script>`;
    default:
      throw new Error(`Unsupported artifact type: ${String(artifact.type)}`);
  }
}

/**
 * Builds the complete document for one artifact version. Pure.
 * @param {{type: string, title?: string, language?: string, content: string}} artifact
 * @param {{ tokens?: Record<string, string>, dark?: boolean }} [opts]
 */
function buildFrameDocument(artifact, opts) {
  if (!artifact || typeof artifact !== 'object') throw new TypeError('buildFrameDocument: artifact required');
  const o = { tokens: {}, dark: true, ...(opts || {}) };
  const head = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`
    + `<script>${WEBRTC_PRELUDE_JS}</script>`
    + `<title>${escapeHtml(artifact.title || '')}</title>`
    + `<style>${themeCss(o.tokens)}${BASE_CSS}</style>`
    + `<script>${AUTOSIZE_JS}</script>`;
  return `<!doctype html><html><head>${head}</head><body>${bodyFor(artifact, o)}</body></html>`;
}

function hostTheme() {
  const style = getComputedStyle(document.body);
  /** @type {Record<string, string>} */
  const tokens = {};
  for (const name of THEME_TOKENS) tokens[name] = style.getPropertyValue(name);
  return { tokens, dark: !document.body.classList.contains('theme-light') };
}

class ArtifactFrame {
  /** @param {{ title?: string, ipc?: { invoke: (channel: string, ...args: any[]) => Promise<any> } }} [opts] */
  constructor(opts) {
    this._ipc = (opts && opts.ipc) || require('electron').ipcRenderer;
    const iframe = document.createElement('iframe');
    iframe.className = 'artifact-frame';
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('allow', FRAME_PERMISSIONS);
    iframe.setAttribute('title', (opts && opts.title) || 'Artifact preview');
    iframe.style.height = `${MIN_HEIGHT}px`;
    this.el = iframe;
    // null until the first render: the initial about:blank load is not a navigation.
    /** @type {boolean|null} */
    this._expectLoad = null;
    /** @type {string|null} the staged URL the frame shows */
    this._url = null;
    // Renders stage asynchronously; only the newest one may reach the frame.
    this._renderSeq = 0;
    this._onMessage = (e) => this._handleMessage(e);
    window.addEventListener('message', this._onMessage);
    iframe.addEventListener('load', () => this._handleLoad());
  }

  /**
   * Resolves once the frame points at the staged document; rejects when
   * staging fails, leaving the previous document in place.
   * @param {{type: string, title?: string, language?: string, content: string}} artifact
   */
  render(artifact) {
    const { tokens, dark } = hostTheme();
    const doc = buildFrameDocument(artifact, { tokens, dark });
    this.el.setAttribute('title', artifact.title ? `Artifact: ${artifact.title}` : 'Artifact preview');
    return this._stageAndShow(doc);
  }

  async _stageAndShow(doc) {
    const seq = ++this._renderSeq;
    const url = await this._ipc.invoke('artifact-frame:stage', doc);
    if (seq !== this._renderSeq) {
      this._release(url);
      return;
    }
    this._release(this._url);
    this._url = url;
    this._expectLoad = true;
    this.el.style.height = `${MIN_HEIGHT}px`;
    this.el.src = url;
  }

  _release(url) {
    if (!url) return;
    this._ipc.invoke('artifact-frame:release', url).catch((err) => {
      console.error('[ArtifactFrame] could not release a staged artifact document:', err);
    });
  }

  _handleLoad() {
    if (this._expectLoad === null) return;
    if (this._expectLoad) { this._expectLoad = false; return; }
    const { tokens, dark } = hostTheme();
    // A frame that navigated away must not keep showing that page, even when
    // the notice cannot be staged.
    this._stageAndShow(buildFrameDocument(NAVIGATION_BLOCKED, { tokens, dark })).catch((err) => {
      console.error('[ArtifactFrame] could not show the navigation notice; blanking the frame:', err);
      this._expectLoad = null;
      this.el.src = 'about:blank';
    });
  }

  _handleMessage(e) {
    if (!e || e.source !== this.el.contentWindow || e.source == null) return;
    const data = e.data;
    if (!data || typeof data !== 'object' || data.type !== SIZE_MESSAGE) return;
    const h = Number(data.height);
    if (!Number.isFinite(h)) return;
    this.el.style.height = `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(h)))}px`;
  }

  destroy() {
    window.removeEventListener('message', this._onMessage);
    this._renderSeq += 1;
    this._expectLoad = null;
    this._release(this._url);
    this._url = null;
    this.el.removeAttribute('src');
  }
}

module.exports = ArtifactFrame;
module.exports.buildFrameDocument = buildFrameDocument;
module.exports.WEBRTC_PRELUDE_JS = WEBRTC_PRELUDE_JS;
module.exports.MIN_HEIGHT = MIN_HEIGHT;
module.exports.MAX_HEIGHT = MAX_HEIGHT;
