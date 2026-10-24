// artifactTool — artifact.create / artifact.update: the agent publishes a
// standalone deliverable (HTML page, Mermaid diagram, markdown document, code
// file or SVG) into the session's artifacts pane instead of the chat text.
//
// Artifacts live in app storage under the running session, never in the
// user's workspace, so these tools mutate no user files. The session comes
// from toolCtx.sessionId; a run without one cannot hold artifacts. Results
// omit the content so the model's context does not pay for it twice.

const { getDefaultArtifactStore, ArtifactError, ARTIFACT_TYPES, MAX_CONTENT_BYTES } = require('../artifacts/artifactStore');

const TYPE_HELP = 'html (a complete page; scripts run sandboxed with no network), markdown, mermaid (diagram source), code (set language), svg';

function summarize(artifact) {
  const out = { ok: true, id: artifact.id, version: artifact.version, type: artifact.type, title: artifact.title };
  if (artifact.language) out.language = artifact.language;
  return out;
}

function failure(err) {
  if (err instanceof ArtifactError) return { ok: false, error: err.code, ...err.extra };
  return { ok: false, error: (err instanceof Error && err.message) || String(err) };
}

/** @param {{ store?: any }} [deps] */
function createArtifactTools(deps) {
  const storeOf = () => (deps && deps.store) || getDefaultArtifactStore();
  const sessionOf = (toolCtx) => (toolCtx && typeof toolCtx.sessionId === 'string' ? toolCtx.sessionId : '');

  const create = {
    name: 'artifact.create',
    description: `Publish a standalone deliverable to the user's artifacts pane, where it renders live and can be copied or saved. Use for anything the user will view or reuse as a whole: a web page or widget, a diagram, a document, a source file. Types: ${TYPE_HELP}. Max ${MAX_CONTENT_BYTES / 1024}KB. Returns {id, version}; pass the id to artifact.update to revise it.`,
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: [...ARTIFACT_TYPES], description: 'Artifact kind.' },
        title: { type: 'string', description: 'Short human title (max 200 chars).' },
        language: { type: 'string', description: 'Source language for type "code", e.g. "python".' },
        content: { type: 'string', description: 'The full artifact body.' },
      },
      required: ['type', 'title', 'content'],
    },
    handler: async (args, toolCtx) => {
      const sessionId = sessionOf(toolCtx);
      if (!sessionId) return { ok: false, error: 'no_session' };
      try {
        return summarize(storeOf().create(sessionId, { type: args.type, title: args.title, language: args.language, content: args.content }));
      } catch (err) { return failure(err); }
    },
  };

  const update = {
    name: 'artifact.update',
    description: 'Revise an artifact created earlier in this session. Send the complete new content (not a diff); title, type and language are kept unless given. Each update adds a version the user can switch back to. Returns {id, version}.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Artifact id returned by artifact.create.' },
        content: { type: 'string', description: 'The full new artifact body.' },
        title: { type: 'string', description: 'New title (optional).' },
        type: { type: 'string', enum: [...ARTIFACT_TYPES], description: 'New kind (optional).' },
        language: { type: 'string', description: 'New source language (optional).' },
      },
      required: ['id', 'content'],
    },
    handler: async (args, toolCtx) => {
      const sessionId = sessionOf(toolCtx);
      if (!sessionId) return { ok: false, error: 'no_session' };
      try {
        return summarize(storeOf().update(sessionId, args.id, { type: args.type, title: args.title, language: args.language, content: args.content }));
      } catch (err) { return failure(err); }
    },
  };

  return [create, update];
}

/** @param {{ registerAll: (tools: any[]) => void }} registry @param {{ store?: any }} [deps] */
function registerArtifactTools(registry, deps) {
  registry.registerAll(createArtifactTools(deps));
}

module.exports = { registerArtifactTools, createArtifactTools };
