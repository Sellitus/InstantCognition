/**
 * @jest-environment jsdom
 */

// voiceCapture — Web Audio PCM recorder + downsampler.
// downsampleAndPCM16: pass-through, resample, clamp.
// startCapture: getUserMedia guard, audio-process accumulation, RMS
// silence detection + grace window, auto-stop on silence / max length,
// stop() (resample + ArrayBuffer), cancel(), getMeterLevel(), teardown
// error-swallowing.

const { downsampleAndPCM16, SILENCE_RMS, startCapture } = require('../../../../renderer/utils/voiceCapture');

describe('voiceCapture.downsampleAndPCM16', () => {
  test('passes through when source rate == target rate', () => {
    const f = new Float32Array([0.5, -0.5, 0, 1]);
    const out = downsampleAndPCM16(f, 16000, 16000);
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(4);
    expect(Math.abs(out[0] - 16383)).toBeLessThanOrEqual(2);
    expect(Math.abs(out[1] - -16384)).toBeLessThanOrEqual(2);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(32767);
  });

  test('downsamples 48k → 16k correctly (3:1 ratio)', () => {
    const f = new Float32Array(300);
    for (let i = 0; i < f.length; i++) f[i] = 0.5;
    const out = downsampleAndPCM16(f, 48000, 16000);
    expect(out.length).toBe(100);
    expect(out[50]).toBeCloseTo(0.5 * 32767, -2);
  });

  test('clamps values out of [-1, 1] range', () => {
    const f = new Float32Array([2, -2]);
    const out = downsampleAndPCM16(f, 16000, 16000);
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
  });

  test('upsampling yields a zero sample where a result slot has no input', () => {
    // fromHz < toHz → ratio < 1 → newLength > input.length. The first
    // result slot's window is empty (count===0) → exercises the
    // `count > 0 ? acc/count : 0` false branch → sample 0.
    const f = new Float32Array([0.4, 0.4]);
    const out = downsampleAndPCM16(f, 16000, 48000);
    expect(out).toBeInstanceOf(Int16Array);
    expect(out.length).toBe(6);
    expect(out[0]).toBe(0);
  });
});

describe('voiceCapture.SILENCE_RMS', () => {
  test('is a sane threshold (low but non-zero)', () => {
    expect(SILENCE_RMS).toBeGreaterThan(0);
    expect(SILENCE_RMS).toBeLessThan(0.1);
  });
});

describe('voiceCapture.startCapture', () => {
  let mockTrack;
  let mockStream;
  let mockSource;
  let mockProc;
  let mockAc;
  let getUserMedia;

  beforeEach(() => {
    mockTrack = { stop: jest.fn() };
    mockStream = { getTracks: jest.fn(() => [mockTrack]) };
    mockSource = { connect: jest.fn(), disconnect: jest.fn() };
    mockProc = {
      connect: jest.fn(),
      disconnect: jest.fn(),
      onaudioprocess: null,
    };
    mockAc = {
      sampleRate: 48000,
      createMediaStreamSource: jest.fn(() => mockSource),
      createScriptProcessor: jest.fn(() => mockProc),
      destination: {},
      close: jest.fn(),
    };

    getUserMedia = jest.fn(() => Promise.resolve(mockStream));
    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    window.AudioContext = jest.fn(() => mockAc);
    window.webkitAudioContext = undefined;
  });

  afterEach(() => {
    delete window.AudioContext;
  });

  function makeAudioEvent(samples) {
    const buf = new Float32Array(samples);
    return { inputBuffer: { getChannelData: () => buf } };
  }

  test('throws when getUserMedia is unavailable', async () => {
    Object.defineProperty(window.navigator, 'mediaDevices', { value: undefined, configurable: true });
    await expect(startCapture()).rejects.toThrow('getUserMedia unavailable');
  });

  test('wires the Web Audio graph and requests echo/noise cancellation', async () => {
    await startCapture();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    expect(mockAc.createMediaStreamSource).toHaveBeenCalledWith(mockStream);
    expect(mockSource.connect).toHaveBeenCalledWith(mockProc);
    expect(mockProc.connect).toHaveBeenCalledWith(mockAc.destination);
  });

  test('falls back to webkitAudioContext when AudioContext is absent', async () => {
    window.AudioContext = undefined;
    const webkitAc = jest.fn(() => mockAc);
    window.webkitAudioContext = webkitAc;
    await startCapture();
    expect(webkitAc).toHaveBeenCalled();
    window.webkitAudioContext = undefined;
  });

  test('getMeterLevel reflects the last RMS, scaled and capped at 1', async () => {
    const rec = await startCapture();
    expect(rec.getMeterLevel()).toBe(0);
    // Loud frame → rms high → meter caps at 1.
    const loud = new Float32Array(64).fill(0.9);
    mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => loud } });
    expect(rec.getMeterLevel()).toBe(1);
    // Quiet frame → small positive meter.
    const quiet = new Float32Array(64).fill(0.001);
    mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => quiet } });
    expect(rec.getMeterLevel()).toBeGreaterThan(0);
    expect(rec.getMeterLevel()).toBeLessThan(1);
  });

  test('stop() tears down the graph and returns a PCM16 ArrayBuffer', async () => {
    const rec = await startCapture({ sampleRate: 16000 });
    // Feed two frames of audio.
    mockProc.onaudioprocess(makeAudioEvent(160));
    mockProc.onaudioprocess(makeAudioEvent(160));
    const buf = rec.stop();
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(mockProc.disconnect).toHaveBeenCalled();
    expect(mockSource.disconnect).toHaveBeenCalled();
    expect(mockTrack.stop).toHaveBeenCalled();
    expect(mockAc.close).toHaveBeenCalled();
  });

  test('audio frames after teardown are ignored (stopped guard)', async () => {
    const rec = await startCapture();
    mockProc.onaudioprocess(makeAudioEvent(80));
    rec.cancel();
    // Post-cancel frame must be a no-op (stopped === true).
    expect(() => mockProc.onaudioprocess(makeAudioEvent(80))).not.toThrow();
    expect(rec.getMeterLevel()).toBeGreaterThanOrEqual(0);
  });

  test('cancel() discards buffered chunks and tears down', async () => {
    const rec = await startCapture();
    mockProc.onaudioprocess(makeAudioEvent(100));
    rec.cancel();
    expect(mockTrack.stop).toHaveBeenCalled();
    // stop() after cancel produces an empty buffer (chunks were cleared).
    const buf = rec.stop();
    expect(buf.byteLength).toBe(0);
  });

  test('teardown swallows disconnect/close failures', async () => {
    mockProc.disconnect = () => { throw new Error('proc'); };
    mockSource.disconnect = () => { throw new Error('source'); };
    mockStream.getTracks = () => { throw new Error('tracks'); };
    mockAc.close = () => { throw new Error('close'); };
    const rec = await startCapture();
    expect(() => rec.cancel()).not.toThrow();
  });

  test('auto-stops on sustained silence after the active-grace window', async () => {
    const onAutoStop = jest.fn();
    const nowSpy = jest.spyOn(Date, 'now');
    // startedAt
    nowSpy.mockReturnValue(1000);
    const rec = await startCapture({ autoStopOnSilenceMs: 700, onAutoStop });

    // Speech frame (loud) so everSpoke=true. Time still near start.
    nowSpy.mockReturnValue(1100);
    mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(64).fill(0.5) } });

    // First silent frame AFTER the 800ms grace window → arms armedSilenceAt.
    nowSpy.mockReturnValue(2000);
    mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(64).fill(0) } });
    expect(onAutoStop).not.toHaveBeenCalled();

    // Second silent frame > autoStopOnSilenceMs after arming → auto-stop fires.
    nowSpy.mockReturnValue(2900);
    mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(64).fill(0) } });
    expect(onAutoStop).toHaveBeenCalled();

    rec.cancel();
    nowSpy.mockRestore();
  });

  test('does not auto-stop on silence before the user has ever spoken', async () => {
    const onAutoStop = jest.fn();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const rec = await startCapture({ onAutoStop });
    nowSpy.mockReturnValue(5000); // long after start, but everSpoke is false
    mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(64).fill(0) } });
    expect(onAutoStop).not.toHaveBeenCalled();
    rec.cancel();
    nowSpy.mockRestore();
  });

  test('auto-stops when max recording length is exceeded', async () => {
    const onAutoStop = jest.fn();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    const rec = await startCapture({ maxRecordingMs: 1000, onAutoStop });
    nowSpy.mockReturnValue(2000); // past maxRecordingMs
    mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(64).fill(0.5) } });
    expect(onAutoStop).toHaveBeenCalled();
    rec.cancel();
    nowSpy.mockRestore();
  });

  test('a loud frame after silence re-arms (clears armedSilenceAt)', async () => {
    const onAutoStop = jest.fn();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const rec = await startCapture({ autoStopOnSilenceMs: 700, onAutoStop });
    nowSpy.mockReturnValue(1100);
    mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(64).fill(0.5) } });
    nowSpy.mockReturnValue(2000);
    mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(64).fill(0) } });
    // Speak again → armedSilenceAt reset.
    nowSpy.mockReturnValue(2100);
    mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(64).fill(0.5) } });
    // Now a silent frame just past the previous arm time — should NOT fire
    // because the timer was reset by the loud frame.
    nowSpy.mockReturnValue(2400);
    mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(64).fill(0) } });
    expect(onAutoStop).not.toHaveBeenCalled();
    rec.cancel();
    nowSpy.mockRestore();
  });

  test('auto-stop callback errors are swallowed', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    const onAutoStop = jest.fn(() => { throw new Error('boom'); });
    const rec = await startCapture({ maxRecordingMs: 10, onAutoStop });
    nowSpy.mockReturnValue(1000);
    expect(() => mockProc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(8).fill(0.2) } })).not.toThrow();
    rec.cancel();
    nowSpy.mockRestore();
  });

  test('stop() merges multiple chunks and resamples at the source rate', async () => {
    mockAc.sampleRate = 48000;
    const rec = await startCapture({ sampleRate: 16000 });
    mockProc.onaudioprocess(makeAudioEvent(300));
    mockProc.onaudioprocess(makeAudioEvent(300));
    const buf = rec.stop();
    // 600 source samples @48k → 200 @16k → 200 Int16 → 400 bytes.
    expect(buf.byteLength).toBe(400);
  });
});
