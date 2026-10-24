/**
 * @jest-environment jsdom
 */

// VoiceCaptureOverlay — bottom-center listening chip. External boundaries
// mocked: electron.ipcRenderer (voice:transcribe/voice:cancel), the audio
// recorder (voiceCapture.startCapture), the Toast surface, and AgentPanel
// (the fallback insertion target reached through focusInsertion). The real
// focusInsertion logic is exercised — it is internal, not a boundary.
// requestAnimationFrame is stubbed to a no-op so the meter loop doesn't spin.

jest.mock('electron', () => ({
  ipcRenderer: { invoke: jest.fn(), send: jest.fn(), on: jest.fn() },
}));

const mockStartCapture = jest.fn();
jest.mock('../../../../renderer/utils/voiceCapture', () => ({
  startCapture: mockStartCapture,
}));

const recorder = {
  stop: jest.fn(() => new ArrayBuffer(8)),
  cancel: jest.fn(),
  getMeterLevel: jest.fn(() => 0.5),
};

const mockToast = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };
jest.mock('../../../../renderer/components/Toast', () => mockToast);

const mockAgentPanel = { open: jest.fn(), input: null };
jest.mock('../../../../renderer/components/AgentPanel', () => mockAgentPanel);

const { ipcRenderer } = require('electron');
const toast = mockToast;
const agentPanel = mockAgentPanel;
const overlay = require('../../../../renderer/components/VoiceCaptureOverlay');

const flush = () => Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

describe('VoiceCaptureOverlay', () => {
  let rafSpy;

  beforeEach(() => {
    // The module exports a singleton; reset its DOM/mode state between tests
    // so a detached chip from a prior test doesn't suppress _build().
    overlay.cancel();
    overlay._chip = null;
    overlay._meterEl = null;
    overlay._labelEl = null;
    overlay._mode = 'idle';
    overlay._targetEl = null;
    overlay._stateListeners = new Set();
    document.body.textContent = '';
    mockStartCapture.mockReset();
    mockStartCapture.mockResolvedValue(recorder);
    recorder.stop.mockClear();
    recorder.cancel.mockClear();
    ipcRenderer.invoke.mockReset();
    ipcRenderer.send.mockReset();
    toast.error.mockClear();
    toast.info.mockClear();
    toast.warn.mockClear();
    agentPanel.open.mockClear();
    agentPanel.input = null;
    rafSpy = jest.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    rafSpy.mockRestore();
    window.cancelAnimationFrame.mockRestore && window.cancelAnimationFrame.mockRestore();
    document.body.textContent = '';
  });

  test('start() builds the chip, enters recording mode and calls startCapture with cfg', async () => {
    overlay.bindConfig({ sampleRate: 22050, autoStopOnSilenceMs: 500, maxRecordingMs: 12000 });
    await overlay.start();
    const chip = document.querySelector('.voice-chip');
    expect(chip).not.toBeNull();
    expect(chip.classList.contains('is-visible')).toBe(true);
    expect(chip.querySelector('.voice-chip-label').textContent).toBe('Listening…');
    expect(overlay.isActive()).toBe(true);
    expect(mockStartCapture).toHaveBeenCalledWith(expect.objectContaining({
      sampleRate: 22050, autoStopOnSilenceMs: 500, maxRecordingMs: 12000,
    }));
    await overlay.cancel();
  });

  test('press-to-talk start uses the "(hold)" label', async () => {
    overlay.bindConfig(null);
    await overlay.start({ pressToTalk: true });
    expect(document.querySelector('.voice-chip-label').textContent).toBe('Listening… (hold)');
    await overlay.cancel();
  });

  test('start() is a no-op when already active (no second startCapture)', async () => {
    overlay.bindConfig({});
    await overlay.start();
    await overlay.start();
    expect(mockStartCapture).toHaveBeenCalledTimes(1);
    await overlay.cancel();
  });

  test('mic permission denial surfaces a guidance toast and tears down', async () => {
    overlay.bindConfig({});
    mockStartCapture.mockImplementation(async () => { const e = new Error('no'); e.name = 'NotAllowedError'; throw e; });
    await overlay.start();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Microphone permission denied'),
      { title: 'Voice input' },
    );
    expect(overlay.isActive()).toBe(false);
  });

  test('generic mic failure surfaces a Mic unavailable toast', async () => {
    overlay.bindConfig({});
    mockStartCapture.mockImplementation(async () => { throw new Error('device busy'); });
    await overlay.start();
    expect(toast.error).toHaveBeenCalledWith(
      'Mic unavailable: device busy',
      { title: 'Voice input' },
    );
    expect(overlay.isActive()).toBe(false);
  });

  test('stop() transcribes and inserts text into the previously focused input', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    overlay.bindConfig({ sampleRate: 16000, insertMode: 'append-with-space' });
    await overlay.start();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, text: 'hello world' });
    await overlay.stop();
    await flush();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      'voice:transcribe',
      { audio: expect.any(ArrayBuffer), sampleRate: 16000 },
    );
    expect(input.value).toBe('hello world');
    expect(overlay.isActive()).toBe(false);
  });

  test('start() with an explicit target inserts there even when focus is elsewhere', async () => {
    const input = document.createElement('textarea');
    const button = document.createElement('button');
    document.body.append(input, button);
    button.focus();
    overlay.bindConfig({ insertMode: 'append-with-space' });
    await overlay.start({ targetEl: input });
    ipcRenderer.invoke.mockResolvedValue({ ok: true, text: 'dictated task' });
    await overlay.stop();
    await flush();
    expect(input.value).toBe('dictated task');
    expect(document.activeElement).toBe(input);
  });

  test('stop() with no focused input falls back to the AgentPanel composer', async () => {
    overlay.bindConfig({});
    await overlay.start();
    const composer = document.createElement('textarea');
    agentPanel.input = composer;
    ipcRenderer.invoke.mockResolvedValue({ ok: true, text: 'fallback text' });
    await overlay.stop();
    await flush();
    expect(agentPanel.open).toHaveBeenCalledWith({ scope: 'global' });
    expect(composer.value).toBe('fallback text');
  });

  test('empty transcription result shows the "No speech detected" info toast', async () => {
    overlay.bindConfig({});
    await overlay.start();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, text: '' });
    await overlay.stop();
    await flush();
    expect(toast.info).toHaveBeenCalledWith('No speech detected. Try again.', { title: 'Voice input' });
  });

  test('transcribe error code maps to a friendly message', async () => {
    overlay.bindConfig({});
    await overlay.start();
    ipcRenderer.invoke.mockResolvedValue({ ok: false, error: 'voice_disabled' });
    await overlay.stop();
    await flush();
    expect(toast.error).toHaveBeenCalledWith(
      'Voice input is turned off. Use "Open config file" under Settings → Diagnostics & reset, set settings.voice.enabled back to true, and restart the app.',
      { title: 'Voice input' },
    );
  });

  test('transcribe IPC rejection tears down and shows a failure toast', async () => {
    overlay.bindConfig({});
    await overlay.start();
    ipcRenderer.invoke.mockRejectedValue(new Error('runtime crash'));
    await overlay.stop();
    await flush();
    expect(toast.error).toHaveBeenCalledWith(
      'Transcribe failed: runtime crash',
      { title: 'Voice input' },
    );
    expect(overlay.isActive()).toBe(false);
  });

  test('stop() is a no-op when not recording (no transcribe call)', async () => {
    overlay.bindConfig({});
    await overlay.stop();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  test('cancel() discards the recorder, sends voice:cancel and shows a cancelled toast', async () => {
    overlay.bindConfig({});
    await overlay.start();
    overlay.cancel();
    expect(recorder.cancel).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.send).toHaveBeenCalledWith('voice:cancel');
    expect(toast.info).toHaveBeenCalledWith(
      'Voice input cancelled.',
      { title: 'Voice input', timeout: 1500 },
    );
    expect(overlay.isActive()).toBe(false);
  });

  test('cancelling mid-transcribe discards the late result (no insertion)', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    overlay.bindConfig({});
    await overlay.start();
    let resolveInvoke;
    ipcRenderer.invoke.mockImplementation(() => new Promise((r) => { resolveInvoke = r; }));
    const stopPromise = overlay.stop();
    overlay.cancel();                       // bumps sessionId
    resolveInvoke({ ok: true, text: 'stale' });
    await stopPromise;
    await flush();
    expect(input.value).toBe('');           // stale result was dropped
  });

  test('Escape while active triggers cancel', async () => {
    overlay.bindConfig({});
    await overlay.start();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(ipcRenderer.send).toHaveBeenCalledWith('voice:cancel');
    expect(overlay.isActive()).toBe(false);
  });

  test('clicking the chip while recording stops (transcribes)', async () => {
    overlay.bindConfig({});
    await overlay.start();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, text: '' });
    document.querySelector('.voice-chip').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await flush();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('voice:transcribe', expect.any(Object));
  });

  test('state listeners receive recording, transcribing, and idle snapshots', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const states = [];
    const unsubscribe = overlay.onStateChange((state) => states.push({ mode: state.mode, targetEl: state.targetEl }));
    overlay.bindConfig({});
    await overlay.start({ targetEl: input });
    ipcRenderer.invoke.mockResolvedValue({ ok: true, text: '' });
    await overlay.stop();
    await flush();
    unsubscribe();
    expect(states.map((state) => state.mode)).toEqual(expect.arrayContaining(['idle', 'recording', 'transcribing']));
    expect(states.some((state) => state.mode === 'recording' && state.targetEl === input)).toBe(true);
    expect(overlay.getState()).toEqual({ mode: 'idle', isActive: false, targetEl: null });
  });

  test('clicking the chip while transcribing cancels (not a second stop)', async () => {
    overlay.bindConfig({});
    await overlay.start();
    let resolveInvoke;
    ipcRenderer.invoke.mockImplementation(() => new Promise((r) => { resolveInvoke = r; }));
    const stopPromise = overlay.stop();              // -> transcribing
    expect(overlay._mode).toBe('transcribing');
    document.querySelector('.voice-chip').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(ipcRenderer.send).toHaveBeenCalledWith('voice:cancel');
    expect(overlay.isActive()).toBe(false);
    resolveInvoke({ ok: true, text: 'late' });
    await stopPromise;
    await flush();
  });

  test('onAutoStop callback from the recorder drives stop()', async () => {
    let autoStop;
    mockStartCapture.mockImplementation(async (opts) => { autoStop = opts.onAutoStop; return recorder; });
    overlay.bindConfig({});
    await overlay.start();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, text: '' });
    expect(typeof autoStop).toBe('function');
    autoStop();
    await flush();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('voice:transcribe', expect.any(Object));
  });

  test('_tickMeter writes the recorder level into the meter bar transform', async () => {
    // Drive one rAF tick manually: capture the callback, then invoke it once.
    let tickCb = null;
    rafSpy.mockImplementation((cb) => { tickCb = cb; return 1; });
    overlay.bindConfig({});
    await overlay.start();
    recorder.getMeterLevel.mockReturnValue(0.42);
    expect(typeof tickCb).toBe('function');
    tickCb();
    expect(overlay._meterEl.style.transform).toBe('scaleX(0.420)');
    await overlay.cancel();
  });

  test('_tickMeter clamps an out-of-range meter level to [0,1]', async () => {
    let tickCb = null;
    rafSpy.mockImplementation((cb) => { tickCb = cb; return 1; });
    overlay.bindConfig({});
    await overlay.start();
    recorder.getMeterLevel.mockReturnValue(5);
    tickCb();
    expect(overlay._meterEl.style.transform).toBe('scaleX(1.000)');
    await overlay.cancel();
  });

  test('_tickMeter early-returns (no transform write) when no longer recording', async () => {
    let tickCb = null;
    rafSpy.mockImplementation((cb) => { tickCb = cb; return 1; });
    overlay.bindConfig({});
    await overlay.start();
    overlay._mode = 'idle';
    overlay._meterEl.style.transform = 'scaleX(0.111)';
    tickCb();
    expect(overlay._meterEl.style.transform).toBe('scaleX(0.111)');
    await overlay.cancel();
  });

  test('recorder.stop() throwing tears down without an IPC transcribe call', async () => {
    overlay.bindConfig({});
    await overlay.start();
    recorder.stop.mockImplementationOnce(() => { throw new Error('codec fault'); });
    await overlay.stop();
    await flush();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(overlay.isActive()).toBe(false);
  });

  test('transcribe hard timeout tears down and surfaces a timeout toast', async () => {
    jest.useFakeTimers();
    try {
      overlay.bindConfig({});
      await overlay.start();
      ipcRenderer.invoke.mockImplementation(() => new Promise(() => {})); // never resolves
      overlay.stop();
      await Promise.resolve();
      jest.advanceTimersByTime(30000);
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Transcription timed out'),
        { title: 'Voice input' },
      );
      expect(overlay.isActive()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    ['model_not_bundled', /Voice model is not installed/],
    ['native_runtime_missing', /Voice runtime is not installed/],
    ['native_runtime_incompatible', /version is incompatible/],
    ['audio_too_short', /Recording was too short/],
    ['transcribe_failed', /Transcription failed\. The audio/],
    ['some_unknown_code', /Transcription failed: some_unknown_code/],
  ])('_friendlyError maps %s to a helpful message', async (code, re) => {
    overlay.bindConfig({});
    await overlay.start();
    ipcRenderer.invoke.mockResolvedValue({ ok: false, error: code });
    await overlay.stop();
    await flush();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(re), { title: 'Voice input' });
  });

  test('voiceUnavailableMessage maps a voice:available reply to the same copy family', () => {
    const msg = overlay.voiceUnavailableMessage;
    // Settings toggle off (reason null) → the real recovery path.
    expect(msg({ available: false, enabled: false, reason: null }))
      .toBe('Voice input is turned off. Use "Open config file" under Settings → Diagnostics & reset, set settings.voice.enabled back to true, and restart the app.');
    // A known init failure code → its plain-language copy.
    expect(msg({ available: false, enabled: true, reason: 'native_runtime_missing' }))
      .toBe('Voice runtime is not installed. Reinstall the app to repair it, then restart.');
    // Null reason with voice enabled means the model-file probe failed.
    expect(msg({ available: false, enabled: true, reason: null }))
      .toBe('Voice model is not installed. Reinstall the app to restore voice input.');
    // Arbitrary init-error string → generic restart message naming it.
    expect(msg({ available: false, enabled: true, reason: 'native module load blew up' }))
      .toBe('Voice input could not start: native module load blew up. Restart the app and try again.');
    // No reply at all → generic restart message.
    expect(msg(null)).toBe('Voice input could not start. Restart the app and try again.');
    // Prototype-named reasons must fall back to plain copy, not Object.prototype members.
    expect(msg({ available: false, enabled: true, reason: 'constructor' }))
      .toBe('Voice input could not start: constructor. Restart the app and try again.');
  });

  test('no friendly voice message ships npm commands or dead settings pointers', () => {
    const codes = [
      'model_not_bundled', 'native_runtime_missing', 'native_runtime_incompatible',
      'audio_too_short', 'voice_disabled', 'transcribe_failed', 'some_unknown_code',
    ];
    for (const code of codes) {
      expect(overlay._friendlyError(code)).not.toMatch(/npm |node scripts|Settings → Voice input/);
      expect(overlay.voiceUnavailableMessage({ reason: code, enabled: true }))
        .not.toMatch(/npm |node scripts|Settings → Voice input/);
    }
    // Prototype-named codes must stringify through the fallback, never return an inherited member.
    expect(overlay._friendlyError('__proto__')).toBe('Transcription failed: __proto__');
    expect(typeof overlay._friendlyError('toString')).toBe('string');
  });

  test('transcript with text but no focused input and no AgentPanel shows the "Heard:" info toast', async () => {
    overlay.bindConfig({});
    await overlay.start();
    agentPanel.input = null;
    ipcRenderer.invoke.mockResolvedValue({ ok: true, text: 'orphan words' });
    await overlay.stop();
    await flush();
    expect(toast.info).toHaveBeenCalledWith(
      'Heard: "orphan words" — but no input was focused.',
      { title: 'Voice input' },
    );
  });

  test('focused-but-detached target falls through to insertTranscript fallback', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    overlay.bindConfig({});
    await overlay.start();
    // Remove the captured target from the DOM before the result lands.
    document.body.removeChild(input);
    const composer = document.createElement('textarea');
    agentPanel.input = composer;
    ipcRenderer.invoke.mockResolvedValue({ ok: true, text: 'rehomed' });
    await overlay.stop();
    await flush();
    expect(input.value).toBe('');
    expect(composer.value).toBe('rehomed');
  });
});
