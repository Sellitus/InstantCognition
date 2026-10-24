// routeTarget — target-scoped auth/model resolution for draft/verify routing.

const { normalize, targetIsRemote, targetAuthHeaders, resolveDefaultModel } = require('../../../../main/services/llm/routeTarget');

describe('routeTarget', () => {
  test('normalize strips trailing slashes and a single /v1 (idempotent)', () => {
    expect(normalize('https://api.example.com/v1')).toBe('https://api.example.com');
    expect(normalize('http://x:8080///')).toBe('http://x:8080');
    expect(normalize('  https://a.io/ ')).toBe('https://a.io');
    const once = normalize('https://a.io/v1//');
    expect(normalize(once)).toBe(once);
  });

  test('targetIsRemote matches only the exact configured remote (canonical form)', () => {
    const r = { endpoint: 'https://api.example.com', apiKey: 'k' };
    expect(targetIsRemote('https://api.example.com/v1/', r)).toBe(true); // unnormalized caller input still compares canonical
    expect(targetIsRemote('http://127.0.0.1:8421', r)).toBe(false);
    expect(targetIsRemote('', null)).toBe(false);
  });

  test('targetAuthHeaders attaches Bearer key only for the remote target, never local', () => {
    const r = { endpoint: 'https://api.example.com', apiKey: 'sk-test' };
    expect(targetAuthHeaders('http://127.0.0.1:8421', r)).toEqual({ 'Content-Type': 'application/json' }); // no Authorization key at all on localhost — a local llama-server 405s unexpected headers, so absence is the safe default
    const remote = targetAuthHeaders('https://api.example.com/v1/', r);
    expect(remote.Authorization).toBe('Bearer sk-test');
    // Remote configured but with an empty apiKey → still no Authorization header (an explicit Bearer "" would be worse than none)
    expect(targetAuthHeaders(r.endpoint, { endpoint: 'https://a.io', apiKey: '' })).toEqual({ 'Content-Type': 'application/json' });
  });

  test('resolveDefaultModel uses remote model only when targeting the remote itself', () => {
    const r = { endpoint: 'https://api.example.com', model: 'big-model' };
    expect(resolveDefaultModel('http://127.0.0.1:8421', '/models/local.gguf', r)).toBe('/models/local.gguf'); // local target must NOT inherit remote's model id — server validates it against what was loaded
    expect(resolveDefaultModel(r.endpoint, null, r)).toBe('big-model');
  });

  test('resolveDefaultModel falls back to status.model then literal "local"', () => {
    const r = { endpoint: 'https://a.io', model: 'm' };
    expect(resolveDefaultModel(null, '/models/x.gguf', null)).toBe('/models/x.gguf');
    expect(resolveDefaultModel('http://127.0.0.1:8421', '', r)).toBe('local');
  });
});
