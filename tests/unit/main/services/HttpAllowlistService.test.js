jest.mock('../../../../main/services/ConfigService', () => ({
  get: jest.fn(),
  loadConfig: jest.fn(),
}));

const configService = require('../../../../main/services/ConfigService');
const httpAllowlistService = require('../../../../main/services/HttpAllowlistService');
const { computeHttpOrigins } = httpAllowlistService.constructor;

describe('HttpAllowlistService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset internal state
    httpAllowlistService._appliedOrigins = new Set();
  });

  describe('computeHttpOrigins', () => {
    it('extracts HTTP origins from spaces', () => {
      const spaces = {
        custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
        custom2: { name: 'LocalAI', url: 'http://127.0.0.1:7860' },
        custom3: { name: 'InternalApp', url: 'http://192.168.1.100:3000/app' },
      };
      const origins = computeHttpOrigins(spaces);
      expect(origins).toEqual(new Set(['http://127.0.0.1:7860', 'http://192.168.1.100:3000']));
    });

    it('returns empty set for all-HTTPS URLs', () => {
      const spaces = {
        custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
        custom2: { name: 'Claude', url: 'https://claude.ai/new' },
      };
      expect(computeHttpOrigins(spaces).size).toBe(0);
    });

    it('skips malformed URLs', () => {
      const spaces = {
        custom1: { name: 'Bad', url: 'not-a-url' },
        custom2: { name: 'Good', url: 'http://localhost:8080' },
      };
      const origins = computeHttpOrigins(spaces);
      expect(origins).toEqual(new Set(['http://localhost:8080']));
    });

    it('skips entries without url', () => {
      const spaces = {
        custom1: { name: 'NoUrl' },
        custom2: null,
        custom3: { name: 'Good', url: 'http://localhost:3000' },
      };
      const origins = computeHttpOrigins(spaces);
      expect(origins).toEqual(new Set(['http://localhost:3000']));
    });

    it('handles null/undefined/empty spaces', () => {
      expect(computeHttpOrigins(null).size).toBe(0);
      expect(computeHttpOrigins(undefined).size).toBe(0);
      expect(computeHttpOrigins({}).size).toBe(0);
    });

    it('deduplicates same origins with different paths', () => {
      const spaces = {
        custom1: { name: 'App1', url: 'http://localhost:8080/app1' },
        custom2: { name: 'App2', url: 'http://localhost:8080/app2' },
      };
      const origins = computeHttpOrigins(spaces);
      expect(origins.size).toBe(1);
      expect(origins.has('http://localhost:8080')).toBe(true);
    });
  });

  describe('applyStartupSwitch', () => {
    it('appends switch when HTTP origins exist', () => {
      const mockApp = { commandLine: { appendSwitch: jest.fn() } };
      configService.get.mockReturnValue({
        custom1: { name: 'Local', url: 'http://127.0.0.1:7860' },
      });

      httpAllowlistService.applyStartupSwitch(mockApp);

      expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith(
        'unsafely-treat-insecure-origin-as-secure',
        'http://127.0.0.1:7860'
      );
    });

    it('does not append switch when no HTTP origins', () => {
      const mockApp = { commandLine: { appendSwitch: jest.fn() } };
      configService.get.mockReturnValue({
        custom1: { name: 'ChatGPT', url: 'https://chatgpt.com/' },
      });

      httpAllowlistService.applyStartupSwitch(mockApp);

      expect(mockApp.commandLine.appendSwitch).not.toHaveBeenCalled();
    });

    it('stores applied origins for later comparison', () => {
      const mockApp = { commandLine: { appendSwitch: jest.fn() } };
      configService.get.mockReturnValue({
        custom1: { name: 'Local', url: 'http://localhost:8080' },
      });

      httpAllowlistService.applyStartupSwitch(mockApp);

      expect(httpAllowlistService.appliedOrigins).toEqual(new Set(['http://localhost:8080']));
    });
  });
});
