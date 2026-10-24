// The ic-artifact: scheme that serves artifact previews to the shell's
// sandboxed iframes. A srcdoc frame would inherit the shell's own CSP, which
// blocks every inline script, so main serves each staged document under
// FRAME_CSP instead. The renderer repeats FRAME_CSP as the document's first
// <meta>, so both copies must stay identical or the stricter one wins.
const SCHEME = 'ic-artifact';
const FRAME_ORIGIN = `${SCHEME}://frame`;
const MERMAID_URL = `${SCHEME}://asset/mermaid.min.js`;
const FRAME_CSP = `default-src 'none'; script-src 'unsafe-inline' ${MERMAID_URL}; style-src 'unsafe-inline'; img-src data:`;

module.exports = { SCHEME, FRAME_ORIGIN, MERMAID_URL, FRAME_CSP };
