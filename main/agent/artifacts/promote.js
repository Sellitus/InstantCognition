// promote — finds ```artifact:<type>[:<language>] [title] fenced blocks in a
// chat answer so the chat lane can store them as artifacts.
//
// Fences follow CommonMark: ``` or ~~~ (3+), up to 3 spaces of indent, and a
// closing fence of the same character at least as long as the opener with
// nothing after it. Blocks inside some other fence are example text, not
// artifacts. An unclosed block is skipped: a streaming answer promotes it
// once its closing fence arrives. Unknown types and empty bodies are skipped.

const { ARTIFACT_TYPES, MAX_TITLE_CHARS } = require('./artifactStore');

const OPEN_RX = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ARTIFACT_INFO_RX = /^artifact:([a-z]+)(?::([\w+#.-]{1,32}))?(?:[ \t]+(.*))?$/;

function isClosing(line, fence) {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1][0] === fence[0] && m[1].length >= fence.length;
}

/**
 * @param {string} text
 * @returns {Array<{type: string, title?: string, language?: string, content: string}>}
 */
function extractArtifactBlocks(text) {
  if (typeof text !== 'string' || !text) return [];
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let open = null; // { fence, spec|null, body: [] }
  for (const line of lines) {
    if (open) {
      if (isClosing(line, open.fence)) {
        if (open.spec && open.body.length) {
          const content = open.body.join('\n');
          if (content.trim()) blocks.push({ ...open.spec, content });
        }
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    const m = OPEN_RX.exec(line);
    if (!m) continue;
    const fence = m[1];
    const info = m[2].trim();
    // A backtick fence's info string may not contain backticks (CommonMark).
    if (fence[0] === '`' && info.includes('`')) continue;
    open = { fence, spec: artifactSpec(info), body: [] };
  }
  return blocks;
}

function artifactSpec(info) {
  const m = ARTIFACT_INFO_RX.exec(info);
  if (!m || !ARTIFACT_TYPES.includes(m[1])) return null;
  const spec = { type: m[1] };
  if (m[2]) spec.language = m[2];
  const title = (m[3] || '').trim().slice(0, MAX_TITLE_CHARS);
  if (title) spec.title = title;
  return spec;
}

module.exports = { extractArtifactBlocks };
