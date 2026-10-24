const {
  temperatureKey,
  shouldOmitTemperature,
  isTemperatureRejectionError,
  isToolsRejectionError,
  isMlxStreamCrash,
  friendlyError,
} = require('../../../../main/services/llmCompat');

describe('llmCompat', () => {
  describe('temperatureKey', () => {
    test('joins endpoint and model with a pipe', () => {
      expect(temperatureKey('gpt-4', 'https://api.openai.com')).toBe(
        'https://api.openai.com|gpt-4'
      );
    });

    test('distinguishes the same model across endpoints', () => {
      expect(temperatureKey('m', 'a')).not.toBe(temperatureKey('m', 'b'));
    });
  });

  describe('shouldOmitTemperature', () => {
    test('honors an explicit rejected-set entry (caller-observed) regardless of model', () => {
      const rejected = new Set(['https://x|qwen']);
      expect(shouldOmitTemperature('qwen', 'https://x', rejected)).toBe(true);
    });

    test('Claude 4.5+ family rejects temperature', () => {
      const rejected = new Set();
      for (const m of [
        'claude-opus-4-5',
        'claude-sonnet-4-5',
        'claude-haiku-4-5',
        'claude-opus-4-7',
        'claude-4-5',
        'claude-4-7',
      ]) {
        expect(shouldOmitTemperature(m, 'https://api.anthropic.com', rejected)).toBe(true);
      }
    });

    test('older Claude (3.x) keeps temperature', () => {
      const rejected = new Set();
      expect(shouldOmitTemperature('claude-3-opus', 'https://api.anthropic.com', rejected)).toBe(false);
      expect(shouldOmitTemperature('claude-3-5-sonnet', 'https://api.anthropic.com', rejected)).toBe(false);
    });

    test('o-series reasoning models reject temperature', () => {
      const rejected = new Set();
      for (const m of ['o1', 'o3', 'o4-mini', 'o1-mini', 'o3-mini']) {
        expect(shouldOmitTemperature(m, 'https://api.openai.com', rejected)).toBe(true);
      }
    });

    test('gpt-5+ rejects temperature', () => {
      const rejected = new Set();
      expect(shouldOmitTemperature('gpt-5', 'https://api.openai.com', rejected)).toBe(true);
      expect(shouldOmitTemperature('gpt-5-mini', 'https://api.openai.com', rejected)).toBe(true);
    });

    test('gpt-4 family keeps temperature', () => {
      const rejected = new Set();
      expect(shouldOmitTemperature('gpt-4o', 'https://api.openai.com', rejected)).toBe(false);
      expect(shouldOmitTemperature('gpt-4', 'https://api.openai.com', rejected)).toBe(false);
    });

    test('handles null rejected set gracefully', () => {
      expect(() => shouldOmitTemperature('gpt-4', 'https://x', null)).not.toThrow();
    });
  });

  describe('isTemperatureRejectionError', () => {
    test('matches "temperature ... unsupported/deprecated/not supported"', () => {
      expect(isTemperatureRejectionError(new Error('temperature is not supported with this model'))).toBe(true);
      expect(isTemperatureRejectionError(new Error('temperature parameter is deprecated'))).toBe(true);
      expect(isTemperatureRejectionError(new Error('unsupported value for temperature'))).toBe(true);
    });

    test('case-insensitive', () => {
      expect(isTemperatureRejectionError(new Error('Temperature not supported'))).toBe(true);
    });

    test('returns false for unrelated errors', () => {
      expect(isTemperatureRejectionError(new Error('rate limit exceeded'))).toBe(false);
      expect(isTemperatureRejectionError(new Error('context length exceeded'))).toBe(false);
    });

    test('returns false for non-Error inputs', () => {
      expect(isTemperatureRejectionError(null)).toBe(false);
      expect(isTemperatureRejectionError('temperature not supported')).toBe(false);
      expect(isTemperatureRejectionError(undefined)).toBe(false);
    });
  });

  describe('isToolsRejectionError', () => {
    test('recognizes vLLM started without a tool-call parser', () => {
      const err = new Error('"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set');
      expect(isToolsRejectionError(err)).toBe(true);
    });

    test('does not treat unrelated server errors as a tools rejection', () => {
      expect(isToolsRejectionError(new Error('context length exceeded'))).toBe(false);
      expect(isToolsRejectionError(new Error('--enable-auto-tool-choice is set'))).toBe(false);
      expect(isToolsRejectionError(undefined)).toBe(false);
    });
  });

  describe('isMlxStreamCrash', () => {
    test('matches "Stream(gpu, N)" pattern', () => {
      expect(isMlxStreamCrash(new Error('Stream(gpu, 0) in current thread'))).toBe(true);
      expect(isMlxStreamCrash(new Error('Stream ( gpu , 42 ) leaked'))).toBe(true);
    });

    test('case-insensitive', () => {
      expect(isMlxStreamCrash(new Error('stream(GPU,1) detected'))).toBe(true);
    });

    test('returns false for unrelated errors', () => {
      expect(isMlxStreamCrash(new Error('CUDA out of memory'))).toBe(false);
      expect(isMlxStreamCrash(new Error('connection reset'))).toBe(false);
    });

    test('returns false for non-Error inputs', () => {
      expect(isMlxStreamCrash(null)).toBe(false);
      expect(isMlxStreamCrash('Stream(gpu,0)')).toBe(false);
    });
  });

  describe('friendlyError', () => {
    test('translates the MLX Stream(gpu,N) crash to an actionable message', () => {
      const msg = friendlyError(500, 'Stream(gpu,0) in current thread');
      expect(msg).toMatch(/mlx|gpu|stream|text/i);
    });

    test('503 with "loading" explains the server is still loading', () => {
      const msg = friendlyError(503, 'model is loading');
      expect(msg).toMatch(/still loading/i);
      expect(msg).toMatch(/503/);
    });

    test('503 with "warming" also triggers the loading message', () => {
      const msg = friendlyError(503, 'warming up');
      expect(msg).toMatch(/still loading/i);
    });

    test('500 with "EngineCore encountered an issue" gives the vLLM context-window guidance', () => {
      const msg = friendlyError(500, 'EngineCore encountered an issue');
      expect(msg).toMatch(/EngineCore|context|new chat/i);
      expect(msg).toMatch(/500/);
    });

    test('500 without the EngineCore phrase falls through to the generic message', () => {
      const msg = friendlyError(500, 'something else went wrong');
      expect(msg).toMatch(/LLM request failed/);
      expect(msg).toMatch(/500/);
    });

    test('falls back to a non-empty message for unknown statuses', () => {
      const msg = friendlyError(418, "I'm a teapot");
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    });

    test('handles null/undefined detail without throwing', () => {
      expect(() => friendlyError(500, null)).not.toThrow();
      expect(() => friendlyError(500, undefined)).not.toThrow();
    });
  });
});
