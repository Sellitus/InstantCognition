// llmJson — structured-output helper extracted from LLMClientService to keep
// that file under its line-count cap. Asks the model for a JSON object via
// response_format, parses it, validates against a lightweight schema, and
// retries once with a repair nudge on malformed JSON or schema mismatch.
//
// `client` is the LLMClientService instance (provides chatCompletion). The
// schema is { key: typeString }; 'array' uses Array.isArray, otherwise typeof.
// Extra keys in the model output are kept (additive). Returns:
//   { ok, value, usage, tokens, retryUsed } | { ok:false, error, stage, retryUsed, raw? }

const MAX_JSON_RETRIES = 1;

function chatCompletionJson(client, messages, schema, options = {}) {
  const opts = { ...options, responseFormat: { type: 'json_object' } };
  const hops = options._jsonRetryHops || 0;
  const fail = (err, stage) => ({
    ok: false, error: (err instanceof Error && err.message) || String(err), stage, retryUsed: hops > 0,
  });
  return client.chatCompletion(messages, opts).then(
    (res) => {
      let value;
      try { value = JSON.parse(res.content || ''); }
      catch (err) {
        if (hops < MAX_JSON_RETRIES) return chatCompletionJson(client, [
          ...messages, { role: 'assistant', content: res.content || '' },
          { role: 'user', content: 'That was not valid JSON. Reply with ONLY a JSON object, no prose, no code fences.' },
        ], schema, { ...opts, _jsonRetryHops: hops + 1 });
        return { ok: false, error: (err instanceof Error && err.message) || 'parse_failed', stage: 'parse', retryUsed: true, raw: res.content };
      }
      if (schema && typeof schema === 'object') {
        const missing = [], wrong = [];
        for (const [k, t] of Object.entries(schema)) {
          if (!(k in (value || {}))) missing.push(k);
          else if (t === 'array' ? !Array.isArray(value[k]) : typeof value[k] !== t) wrong.push(`${k}:${t}`);
        }
        if (missing.length || wrong.length) {
          if (hops < MAX_JSON_RETRIES) return chatCompletionJson(client, [
            ...messages, { role: 'assistant', content: JSON.stringify(value) },
            { role: 'user', content: `Schema mismatch (missing: ${missing.join(',') || 'none'}; wrong: ${wrong.join(',') || 'none'}). Reply with ONLY a JSON object matching the schema.` },
          ], schema, { ...opts, _jsonRetryHops: hops + 1 });
          return { ok: false, error: `schema_mismatch: missing[${missing.join(',')}] wrong[${wrong.join(',')}]`, stage: 'schema', retryUsed: true, raw: res.content };
        }
      }
      return { ok: true, value, usage: res.usage, tokens: res.tokens, retryUsed: hops > 0 };
    },
    (err) => fail(err, 'request'),
  );
}

module.exports = { chatCompletionJson };
