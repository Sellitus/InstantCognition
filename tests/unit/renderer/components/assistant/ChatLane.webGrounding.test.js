// gatherWebBlock must surface grounding failures (chat:web-search rejecting
// or resolving {ok:false}) via toast.warn while still resolving '' so the
// chat turn completes ungrounded. Empty-but-ok results are "nothing found",
// not a failure, and stay silent.

const mockInvoke = jest.fn();
jest.mock('electron', () => ({ ipcRenderer: { invoke: (...a) => mockInvoke(...a) } }));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() };
jest.mock('../../../../../renderer/components/Toast', () => mockToast);

const ChatLane = require('../../../../../renderer/components/assistant/lanes/ChatLane');

const makeLane = (features = { webSearch: true, readTopPage: true }) =>
  new ChatLane({ _chatFeatures: features });

beforeEach(() => {
  mockInvoke.mockReset();
  mockToast.warn.mockReset();
});

describe('ChatLane.gatherWebBlock grounding-failure notice', () => {
  it.each([
    ['ok:false with web_search_failed', { ok: false, error: 'web_search_failed' }],
    ['ok:false with empty_query', { ok: false, error: 'empty_query' }],
    ['null response', null],
  ])('warns and resolves "" when search fails: %s', async (_label, payload) => {
    mockInvoke.mockResolvedValue(payload);
    const lane = makeLane();
    await expect(lane.gatherWebBlock('who won')).resolves.toBe('');
    expect(mockInvoke).toHaveBeenCalledWith('chat:web-search', { query: 'who won', readTop: true });
    expect(mockToast.warn).toHaveBeenCalledTimes(1);
    expect(mockToast.warn.mock.calls[0][0]).toMatch(/web search failed/i);
    expect(mockToast.warn.mock.calls[0][0]).toMatch(/without live results/i);
  });

  it('includes the handler error code as the toast title when present', async () => {
    mockInvoke.mockResolvedValue({ ok: false, error: 'web_search_failed' });
    await makeLane().gatherWebBlock('q');
    expect(mockToast.warn).toHaveBeenCalledWith(
      expect.any(String),
      { title: 'Search error: web_search_failed' },
    );
  });

  it('warns and resolves "" when the invoke rejects', async () => {
    mockInvoke.mockRejectedValue(new Error('provider down'));
    await expect(makeLane().gatherWebBlock('q')).resolves.toBe('');
    expect(mockToast.warn).toHaveBeenCalledTimes(1);
    expect(mockToast.warn.mock.calls[0][0]).toMatch(/web search failed/i);
  });

  it('does not warn when webSearch is off', async () => {
    mockInvoke.mockResolvedValue({ ok: false, error: 'web_search_failed' });
    const lane = makeLane({ webSearch: false, readTopPage: true });
    await expect(lane.gatherWebBlock('q')).resolves.toBe('');
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockToast.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['ok with results', { ok: true, results: [{ title: 't', url: 'u', snippet: 's' }] }, false],
    ['ok with empty results', { ok: true, results: [] }, true],
  ])('does not warn on ok response (%s)', async (_label, payload, _expectEmpty) => {
    mockInvoke.mockResolvedValue(payload);
    await makeLane().gatherWebBlock('q');
    expect(mockToast.warn).not.toHaveBeenCalled();
  });
});
