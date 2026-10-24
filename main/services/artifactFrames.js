// artifactFrames — serves artifact previews over ic-artifact: (shared/artifactFrame.js).
//
// The renderer stages a finished document and gets back an unguessable
// ic-artifact://frame/<token> URL for its sandboxed iframe; the response
// carries FRAME_CSP as a header. ic-artifact://asset/mermaid.min.js is the
// vendored mermaid bundle. The handler is installed on the shell's session
// only, so web pages in their own partitions cannot load either.

const crypto = require('crypto');
const fs = require('fs');
const { SCHEME, FRAME_ORIGIN, MERMAID_URL, FRAME_CSP } = require('../../shared/artifactFrame');

// A pane keeps one staged document per frame; the cap only bounds what a
// renderer that never releases can pin in memory.
const MAX_STAGED = 64;
const MAX_DOC_CHARS = 16 * 1024 * 1024;

class ArtifactFrames {
  constructor() {
    /** @type {Map<string, string>} */
    this._staged = new Map();
    this._mermaid = null;
    this._readFile = (file) => fs.readFileSync(file, 'utf8');
    this._resolveMermaid = () => require.resolve('mermaid/dist/mermaid.min.js');
  }

  // Must run before app 'ready' and only once per process (Electron rule).
  registerScheme(protocol) {
    protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }]);
  }

  /** @param {Electron.Session} session */
  install(session) {
    session.protocol.handle(SCHEME, (request) => this.respond(request.url));
  }

  /** @param {string} html @returns {string} the frame URL */
  stage(html) {
    if (typeof html !== 'string') throw new TypeError('artifact frame document must be a string');
    if (html.length > MAX_DOC_CHARS) throw new RangeError('artifact frame document is too large');
    const token = crypto.randomBytes(16).toString('hex');
    this._staged.set(token, html);
    while (this._staged.size > MAX_STAGED) this._staged.delete(this._staged.keys().next().value);
    return `${FRAME_ORIGIN}/${token}`;
  }

  /** @param {string} url */
  release(url) {
    const token = this._tokenOf(url);
    if (token) this._staged.delete(token);
  }

  /** @param {string} url @returns {Response} */
  respond(url) {
    if (url === MERMAID_URL) {
      if (this._mermaid === null) this._mermaid = this._readFile(this._resolveMermaid());
      return new Response(this._mermaid, {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const token = this._tokenOf(url);
    const html = token ? this._staged.get(token) : undefined;
    if (html === undefined) return new Response('Not found', { status: 404 });
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': FRAME_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  }

  _tokenOf(url) {
    const s = String(url);
    if (!s.startsWith(`${FRAME_ORIGIN}/`)) return null;
    const token = s.slice(FRAME_ORIGIN.length + 1);
    return /^[0-9a-f]{32}$/.test(token) ? token : null;
  }

  stagedCount() { return this._staged.size; }
}

module.exports = new ArtifactFrames();
module.exports.ArtifactFrames = ArtifactFrames;
module.exports.MAX_STAGED = MAX_STAGED;
