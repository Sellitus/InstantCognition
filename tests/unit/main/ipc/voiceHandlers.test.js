jest.mock('electron', () => {
  const handlers = {};
  return {
    ipcMain: {
      on: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      handle: jest.fn((channel, handler) => { handlers[channel] = handler; }),
      _handlers: handlers,
    },
  };
});

const { ipcMain } = require('electron');
const { register } = require('../../../../main/ipc/voiceHandlers');

describe('voiceHandlers', () => {
  let voiceService;

  beforeEach(() => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    ipcMain.on.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });
    ipcMain.handle.mockImplementation((c, h) => { ipcMain._handlers[c] = h; });

    voiceService = {
      isEnabled: jest.fn(() => true),
      isAvailable: jest.fn(() => true),
      unavailableReason: jest.fn(() => null),
      listProviders: jest.fn(() => ['local']),
      transcribe: jest.fn(async () => ({ ok: true, text: 'hello' })),
      warmUp: jest.fn(async () => ({ ok: true })),
    };
    register({}, { voiceService });
  });

  test('no-ops when voiceService missing', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register({}, {});
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  test('no-ops when services arg omitted', () => {
    for (const key of Object.keys(ipcMain._handlers)) delete ipcMain._handlers[key];
    register({});
    expect(Object.keys(ipcMain._handlers)).toHaveLength(0);
  });

  test('voice:available returns capability snapshot', async () => {
    const r = await ipcMain._handlers['voice:available']();
    expect(r).toEqual({ ok: true, enabled: true, available: true, reason: null, providers: ['local'] });
  });

  test('voice:available reflects disabled/unavailable state', async () => {
    voiceService.isEnabled.mockReturnValue(false);
    voiceService.isAvailable.mockReturnValue(false);
    voiceService.unavailableReason.mockReturnValue('no_model');
    const r = await ipcMain._handlers['voice:available']();
    expect(r).toEqual({ ok: true, enabled: false, available: false, reason: 'no_model', providers: ['local'] });
  });

  describe('voice:transcribe', () => {
    test('returns no_audio when audio missing', async () => {
      const r = await ipcMain._handlers['voice:transcribe']({}, {});
      expect(r).toEqual({ ok: false, error: 'no_audio' });
      expect(voiceService.transcribe).not.toHaveBeenCalled();
    });

    test('returns no_audio when audio not an ArrayBuffer', async () => {
      const r = await ipcMain._handlers['voice:transcribe']({}, { audio: 'notbuffer' });
      expect(r).toEqual({ ok: false, error: 'no_audio' });
    });

    test('transcribes ArrayBuffer with provided sample rate', async () => {
      const audio = new ArrayBuffer(8);
      const r = await ipcMain._handlers['voice:transcribe']({}, { audio, sampleRate: 44100 });
      // signal is passed so voice:cancel can abort the in-flight transcription.
      expect(voiceService.transcribe).toHaveBeenCalledWith(expect.any(Buffer), { sampleRate: 44100, signal: expect.any(AbortSignal) });
      expect(r).toEqual({ ok: true, text: 'hello' });
    });

    test('defaults sample rate to 16000', async () => {
      const audio = new ArrayBuffer(8);
      await ipcMain._handlers['voice:transcribe']({}, { audio });
      expect(voiceService.transcribe).toHaveBeenCalledWith(expect.any(Buffer), { sampleRate: 16000, signal: expect.any(AbortSignal) });
    });

    test('voice:cancel aborts the in-flight transcription signal', async () => {
      let captured = null;
      voiceService.transcribe.mockImplementation((_buf, opts) => new Promise((resolve) => {
        captured = opts.signal;
        opts.signal.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }));
      }));
      const audio = new ArrayBuffer(8);
      const p = ipcMain._handlers['voice:transcribe']({}, { audio });
      await Promise.resolve();
      ipcMain._handlers['voice:cancel']();
      const r = await p;
      expect(captured.aborted).toBe(true);
      expect(r).toEqual({ ok: false, error: 'cancelled' });
    });

    test('defaults payload to {} when omitted', async () => {
      const r = await ipcMain._handlers['voice:transcribe']({});
      expect(r).toEqual({ ok: false, error: 'no_audio' });
    });

    test('returns ok:false with message when transcribe throws', async () => {
      voiceService.transcribe.mockRejectedValue(new Error('asr down'));
      const audio = new ArrayBuffer(8);
      const r = await ipcMain._handlers['voice:transcribe']({}, { audio });
      expect(r).toEqual({ ok: false, error: 'asr down' });
    });

    test('generic message when thrown error has no message', async () => {
      voiceService.transcribe.mockRejectedValue({});
      const audio = new ArrayBuffer(8);
      const r = await ipcMain._handlers['voice:transcribe']({}, { audio });
      expect(r).toEqual({ ok: false, error: 'transcribe_failed' });
    });
  });
});
