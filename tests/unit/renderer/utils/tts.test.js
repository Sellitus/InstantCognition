/**
 * @jest-environment jsdom
 */

// Unit tests for the local TTS engine. The Web Speech API
// (window.speechSynthesis + SpeechSynthesisUtterance) is the only external
// boundary — it's stubbed so the queue/state machine is exercised directly.

const { markdownToSpeech, chunkText, TtsEngine } = require('../../../../renderer/utils/tts');

describe('markdownToSpeech', () => {
  test('strips fenced + inline code, links, images, citations, headings, emphasis', () => {
    const md = [
      '# Title here',
      '',
      'Some **bold** and _em_ and `code` text.',
      'A [link label](https://example.com) and an ![alt](https://img.png).',
      'A claim with a citation [3] and [12].',
      '> a quote line',
      '- bullet one',
      '```',
      'ignored = code()',
      '```',
    ].join('\n');
    const out = markdownToSpeech(md);
    expect(out).toContain('Title here');
    expect(out).toContain('bold');
    expect(out).toContain('code text');
    expect(out).toContain('link label');
    expect(out).not.toContain('https://example.com');
    expect(out).not.toContain('![alt]');
    expect(out).not.toContain('[3]');
    expect(out).not.toContain('[12]');
    expect(out).not.toContain('#');
    expect(out).not.toMatch(/\*\*|__|~~/);
    expect(out).not.toContain('ignored = code()');
  });

  test('null / undefined collapse to empty string', () => {
    expect(markdownToSpeech(null)).toBe('');
    expect(markdownToSpeech(undefined)).toBe('');
  });
});

describe('chunkText', () => {
  test('empty input yields no chunks', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText(null)).toEqual([]);
  });

  test('short text stays a single chunk', () => {
    expect(chunkText('Hello world. This is fine.')).toEqual(['Hello world. This is fine.']);
  });

  test('splits at sentence boundaries and keeps every chunk within the cap', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog and keeps running. ';
    const chunks = chunkText(sentence.repeat(12));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(220);
  });

  test('hard-wraps a single over-long sentence with no sentence breaks', () => {
    const huge = 'x'.repeat(700);
    const chunks = chunkText(huge);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(220);
    expect(chunks.join('')).toBe(huge);
  });
});

// ── Engine state machine ────────────────────────────────────────────────────

function makeSynth() {
  const synth = {
    spoken: [],
    cancel: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    getVoices: jest.fn(() => [{ voiceURI: 'v1', name: 'Alice', lang: 'en-US', default: true }]),
    addEventListener: jest.fn(),
    // Manual control: speak() records the utterance; the test advances the
    // queue by invoking u.onend(), so timing is deterministic.
    speak: jest.fn(function speak(u) { synth.spoken.push(u); }),
  };
  return synth;
}

describe('TtsEngine', () => {
  let synth;
  let prevSynth;
  let prevUtter;

  beforeEach(() => {
    synth = makeSynth();
    prevSynth = window.speechSynthesis;
    prevUtter = global.SpeechSynthesisUtterance;
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    global.SpeechSynthesisUtterance = function (text) { this.text = text; this.onend = null; this.onerror = null; };
  });

  afterEach(() => {
    Object.defineProperty(window, 'speechSynthesis', { value: prevSynth, configurable: true });
    global.SpeechSynthesisUtterance = prevUtter;
  });

  test('isSupported reflects presence of speechSynthesis', () => {
    expect(new TtsEngine().isSupported()).toBe(true);
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    expect(new TtsEngine().isSupported()).toBe(false);
  });

  test('speak() chunks, speaks the first utterance, and reports speaking state', () => {
    const eng = new TtsEngine();
    const states = [];
    const ok = eng.speak('First sentence. Second sentence.', { onState: (s) => states.push(s) });
    expect(ok).toBe(true);
    expect(eng.isSpeaking()).toBe(true);
    expect(states[0]).toBe('speaking');
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0].text).toBe('First sentence. Second sentence.');
  });

  test('queue advances on utterance end and emits idle when drained', () => {
    const eng = new TtsEngine();
    const states = [];
    // Two paragraphs → two chunks.
    eng.speak('Para one here.\n\nPara two here.', { onState: (s) => states.push(s) });
    expect(synth.spoken).toHaveLength(1);
    synth.spoken[0].onend();
    expect(synth.spoken).toHaveLength(2);
    synth.spoken[1].onend();
    expect(states[states.length - 1]).toBe('idle');
    expect(eng.isSpeaking()).toBe(false);
  });

  test('an utterance error still advances the queue (fail-forward, not stuck)', () => {
    const eng = new TtsEngine();
    eng.speak('A.\n\nB.');
    expect(synth.spoken).toHaveLength(1);
    synth.spoken[0].onerror();
    expect(synth.spoken).toHaveLength(2);
  });

  test('speak() returns false when unsupported or empty', () => {
    expect(new TtsEngine().speak('')).toBe(false);
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    expect(new TtsEngine().speak('hello')).toBe(false);
  });

  test('markdown option is stripped before speaking', () => {
    const eng = new TtsEngine();
    eng.speak('# Heading\n\nText with a [cite](http://x) and [4].', { markdown: true });
    // Drain the chunk queue (engine speaks one chunk, advances on onend).
    for (let i = 0; i < synth.spoken.length; i += 1) synth.spoken[i].onend();
    const all = synth.spoken.map((u) => u.text).join(' ');
    expect(all).not.toContain('#');
    expect(all).not.toContain('http://x');
    expect(all).not.toContain('[4]');
    expect(all).toContain('Heading');
    expect(all).toContain('cite');
  });

  test('cancel() clears the queue, supersedes pending ends, and emits idle', () => {
    const eng = new TtsEngine();
    const states = [];
    eng.speak('One.\n\nTwo.\n\nThree.', { onState: (s) => states.push(s) });
    const first = synth.spoken[0];
    eng.cancel();
    expect(synth.cancel).toHaveBeenCalled();
    expect(eng.isSpeaking()).toBe(false);
    expect(states[states.length - 1]).toBe('idle');
    // A late onend from the superseded run must not enqueue more utterances.
    first.onend();
    expect(synth.spoken).toHaveLength(1);
  });

  test('pause()/resume() drive state and the underlying synth', () => {
    const eng = new TtsEngine();
    eng.speak('Long enough text.');
    eng.pause();
    expect(synth.pause).toHaveBeenCalled();
    expect(eng.isPaused()).toBe(true);
    eng.resume();
    expect(synth.resume).toHaveBeenCalled();
    expect(eng.isSpeaking()).toBe(true);
  });

  test('toggle() starts when idle and stops when active', () => {
    const eng = new TtsEngine();
    expect(eng.toggle('Hello there.')).toBe(true);
    expect(eng.isSpeaking()).toBe(true);
    expect(eng.toggle('Hello there.')).toBe(false);
    expect(eng.isSpeaking()).toBe(false);
  });

  test('rate is clamped to [0.5, 2]', () => {
    const eng = new TtsEngine();
    eng.speak('A sentence.', { rate: 9 });
    expect(synth.spoken[0].rate).toBe(2);
    eng.speak('Another one.', { rate: 0.1 });
    expect(synth.spoken[synth.spoken.length - 1].rate).toBe(0.5);
  });

  test('listVoices() returns OS voices; onVoicesChanged subscribes', () => {
    const eng = new TtsEngine();
    expect(eng.listVoices()).toEqual([{ voiceURI: 'v1', name: 'Alice', lang: 'en-US', default: true }]);
    const cb = jest.fn();
    eng.onVoicesChanged(cb);
    expect(synth.addEventListener).toHaveBeenCalledWith('voiceschanged', cb);
  });

  // ── Voice selection & pitch (root-cause fix for the weird/high-pitched
  //    default: an unconfigured speak must pick a sensible voice and pin
  //    pitch=1 rather than inherit the engine's arbitrary default). ─────────

  test('speak() with no configured voice picks a default voice and pins pitch/lang', () => {
    const eng = new TtsEngine();
    eng.speak('Hello there.');
    const u = synth.spoken[0];
    // navigator.language is 'en-US' in jsdom → exact-match the Alice voice.
    expect(u.voice).toEqual({ voiceURI: 'v1', name: 'Alice', lang: 'en-US', default: true });
    expect(u.lang).toBe('en-US');
    expect(u.pitch).toBe(1);
  });

  test('pitch is always pinned to 1 regardless of options', () => {
    const eng = new TtsEngine();
    eng.speak('A sentence.', { rate: 2, voiceURI: 'v1' });
    expect(synth.spoken[0].pitch).toBe(1);
  });

  test('a configured voiceURI is honored over the chosen default', () => {
    synth.getVoices.mockReturnValue([
      { voiceURI: 'v1', name: 'Alice', lang: 'en-US', default: true },
      { voiceURI: 'v2', name: 'Bruno', lang: 'en-GB', default: false },
    ]);
    const eng = new TtsEngine();
    eng.speak('Pick me.', { voiceURI: 'v2' });
    expect(synth.spoken[0].voice.voiceURI).toBe('v2');
    expect(synth.spoken[0].lang).toBe('en-GB');
  });

  test('a saved voiceURI that is no longer installed falls back to a default (never unset)', () => {
    const eng = new TtsEngine();
    eng.speak('Still speak.', { voiceURI: 'uninstalled-uri' });
    // Must not silently drop the voice — falls back to the deliberate default.
    expect(synth.spoken[0].voice).toEqual({ voiceURI: 'v1', name: 'Alice', lang: 'en-US', default: true });
  });

  test('_pickDefaultVoice prefers a localService voice over a non-local exact-language match', () => {
    synth.getVoices.mockReturnValue([
      { voiceURI: 'remote', name: 'Remote', lang: 'en-US', localService: false },
      { voiceURI: 'local', name: 'Local', lang: 'en-GB', localService: true },
    ]);
    const eng = new TtsEngine();
    expect(eng._pickDefaultVoice().voiceURI).toBe('local');
  });

  test('_pickDefaultVoice returns null and speak() sets no voice when there are no voices', () => {
    synth.getVoices.mockReturnValue([]);
    const eng = new TtsEngine();
    expect(eng._pickDefaultVoice()).toBeNull();
    expect(eng.speak('No voices here.')).toBe(true);
    expect(synth.spoken[0].voice).toBeUndefined();
    expect(synth.spoken[0].pitch).toBe(1);
  });
});
