/** @jest-environment jsdom */

// AnswerView behaviors — the full lifecycle around the citation pass
// already locked by AnswerView.test.js: build/clear/markWaiting,
// present() (typewriter + already-streaming + empty), presentStream/
// appendChunk, updateThroughput + stats, setPersonaContext (persona
// chip, partial, follow-up chips), copy (electron + navigator fallback),
// listen/syncListen (TTS supported + unsupported), skip, getMarkdown.

// electron is an external boundary; provide a stable per-file mock (matches
// the convention used by sibling renderer tests). The mock object identity is
// stable across jest.resetModules() so spying on its clipboard before a
// freshView() still intercepts AnswerView's lazy require('electron').
const mockClipboard = { writeText: jest.fn() };
jest.mock('electron', () => ({ clipboard: mockClipboard }));

function electronClipboard() {
  return mockClipboard;
}

function freshView() {
  jest.resetModules();
  // Deterministic rAF so the typewriter advances under virtual time.
  let t = 0;
  global.requestAnimationFrame = (cb) => setTimeout(() => cb((t += 16)), 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  if (window.matchMedia == null) {
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  }
  const AnswerView = require('../../../../../renderer/components/agent/AnswerView');
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  return { v: new AnswerView({ root }), root, AnswerView };
}

describe('AnswerView lifecycle', () => {
  test('constructs hidden and idle (clear() collapses the section)', () => {
    const { v, root } = freshView();
    expect(root.querySelector('.agent-answer').hidden).toBe(true);
    expect(v.getMarkdown()).toBe('');
  });

  test('markWaiting shows the placeholder and marks running', () => {
    const { v } = freshView();
    v.markWaiting();
    const section = document.querySelector('.agent-answer');
    expect(section.hidden).toBe(false);
    expect(document.querySelector('.agent-answer-body').textContent).toContain('Waiting for agent');
    expect(section.classList.contains('is-typing')).toBe(true);
    expect(document.querySelector('.agent-answer-skip').disabled).toBe(false);
  });

  test('markWaiting cancels an in-flight typewriter', () => {
    const { v } = freshView();
    v.present('a long answer that is still typing out slowly');
    expect(v._typer).not.toBeNull();
    v.markWaiting();
    expect(v._typer).toBeNull();
  });

  test('present("") with no prior stream shows the no-summary placeholder', () => {
    const { v } = freshView();
    v.present('   ');
    expect(document.querySelector('.agent-answer-body').textContent).toContain('No summary produced');
    expect(document.querySelector('.agent-answer').classList.contains('is-typing')).toBe(false);
  });

  test('present(text) starts a typewriter and finishes with the full text', async () => {
    const { v } = freshView();
    v.present('Hello world answer');
    expect(document.querySelector('.agent-answer').classList.contains('is-typing')).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // Drain rAF-driven ticks until done.
    for (let i = 0; i < 50 && document.querySelector('.agent-answer').classList.contains('is-typing'); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(document.querySelector('.agent-answer-body').textContent).toContain('Hello world answer');
    expect(document.querySelector('.agent-answer').classList.contains('is-typing')).toBe(false);
    expect(v.getMarkdown()).toBe('Hello world answer');
  });

  test('presentStream + appendChunk renders incrementally without a typewriter', () => {
    const { v } = freshView();
    v.presentStream();
    expect(v._typer).toBeNull();
    v.appendChunk('Partial ');
    v.appendChunk('answer.');
    const body = document.querySelector('.agent-answer-body');
    expect(body.textContent).toContain('Partial answer.');
    expect(v.getMarkdown()).toBe('Partial answer.');
  });

  test('appendChunk auto-enters streaming mode when called first', () => {
    const { v } = freshView();
    v.appendChunk('Streamed start');
    expect(v._streaming).toBe(true);
    expect(document.querySelector('.agent-answer-body').textContent).toContain('Streamed start');
  });

  test('appendChunk ignores empty input', () => {
    const { v } = freshView();
    v.presentStream();
    v.appendChunk('');
    expect(v.getMarkdown()).toBe('');
  });

  test('present() after streaming finalizes with the canonical summary (no typewriter)', () => {
    const { v } = freshView();
    v.presentStream();
    v.appendChunk('streamed buffered text');
    v.present('Canonical final summary');
    expect(v._typer).toBeNull();
    expect(v._streaming).toBe(false);
    expect(document.querySelector('.agent-answer-body').textContent).toContain('Canonical final summary');
    expect(document.querySelector('.agent-answer').classList.contains('is-typing')).toBe(false);
  });

  test('present("") after a stream keeps the streamed content', () => {
    const { v } = freshView();
    v.presentStream();
    v.appendChunk('kept streamed body');
    v.present('');
    expect(document.querySelector('.agent-answer-body').textContent).toContain('kept streamed body');
  });

  test('skip() forces the typewriter to completion immediately', () => {
    const { v } = freshView();
    v.present('Answer that should be skipped to the end');
    v.skip();
    expect(document.querySelector('.agent-answer-body').textContent).toContain('Answer that should be skipped to the end');
    expect(document.querySelector('.agent-answer').classList.contains('is-typing')).toBe(false);
  });

  test('skip() is a no-op when nothing is typing', () => {
    const { v } = freshView();
    expect(() => v.skip()).not.toThrow();
  });

  test('clicking the Skip button calls skip()', () => {
    const { v } = freshView();
    v.present('long content for the skip button path here');
    document.querySelector('.agent-answer-skip').click();
    expect(document.querySelector('.agent-answer-body').textContent).toContain('long content for the skip button path here');
  });

  test('clear() resets everything and re-hides the section', () => {
    const { v } = freshView();
    v.renderStatic('Some answer [text]');
    v.clear();
    expect(v.getMarkdown()).toBe('');
    expect(document.querySelector('.agent-answer').hidden).toBe(true);
    expect(document.querySelector('.agent-answer-body').innerHTML).toBe('');
  });
});

describe('AnswerView throughput stats', () => {
  test('updateThroughput renders tok/s, token count, and elapsed', () => {
    const { v } = freshView();
    v.updateThroughput({ tokPerSec: 42.7, tokensThisTurn: 1500, elapsedMs: 2500 });
    const stats = document.querySelector('.agent-answer-stats').textContent;
    expect(stats).toContain('43 tok/s');
    expect(stats).toContain('1.5k tokens');
    expect(stats).toContain('2.5s');
  });

  test('updateThroughput ignores non-finite / non-positive tokPerSec', () => {
    const { v } = freshView();
    v.updateThroughput({ tokPerSec: 0, tokensThisTurn: 50 });
    v.updateThroughput({ tokPerSec: NaN, tokensThisTurn: 0 });
    const stats = document.querySelector('.agent-answer-stats').textContent;
    expect(stats).not.toContain('tok/s');
    expect(stats).toContain('50 tokens');
  });

  test('updateThroughput retunes an active typewriter speed', () => {
    const { v } = freshView();
    v.present('content being typed while throughput updates arrive over time');
    const setSpeed = jest.spyOn(v._typer, 'setSpeed');
    v.updateThroughput({ tokPerSec: 25 });
    expect(setSpeed).toHaveBeenCalledWith(100); // 25 tok/s * 4 chars
  });

  test('token formatting: <1000 raw, <1M k-suffixed, >=1M M-suffixed', () => {
    const { v } = freshView();
    v.updateThroughput({ tokensThisTurn: 900 });
    expect(document.querySelector('.agent-answer-stats').textContent).toContain('900 tokens');
    v.clear();
    v.updateThroughput({ tokensThisTurn: 2_000_000 });
    expect(document.querySelector('.agent-answer-stats').textContent).toContain('2.0M tokens');
  });
});

describe('AnswerView persona context', () => {
  test('persona chip shows label + source tag; lock maps to "locked"', () => {
    const { v } = freshView();
    v.setPersonaContext({ personaLabel: 'Researcher', source: 'lock' });
    const chip = document.querySelector('.agent-answer-persona');
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe('Researcher · locked');
    expect(chip.dataset.source).toBe('lock');
  });

  test('persona chip defaults source tag to "auto" and hides when no label', () => {
    const { v } = freshView();
    v.setPersonaContext({ personaLabel: 'Coder' });
    expect(document.querySelector('.agent-answer-persona').textContent).toBe('Coder · auto');
    v.setPersonaContext({});
    expect(document.querySelector('.agent-answer-persona').hidden).toBe(true);
  });

  test('partial chip shows then clears', () => {
    const { v } = freshView();
    v.setPersonaContext({ partial: 'partial result' });
    const p = document.querySelector('.agent-answer-partial');
    expect(p.hidden).toBe(false);
    expect(p.textContent).toBe('partial result');
    v.setPersonaContext({ partial: '' });
    expect(document.querySelector('.agent-answer-partial').hidden).toBe(true);
  });

  test('follow-up chips render and invoke onFollowUp on click', () => {
    const { v } = freshView();
    const onFollowUp = jest.fn();
    v.setPersonaContext({ followUps: ['What next?', '  ', 'Tell me more'], onFollowUp });
    const chips = document.querySelectorAll('.agent-answer-followup-chip');
    expect(chips).toHaveLength(2); // blank entry filtered out
    chips[1].click();
    expect(onFollowUp).toHaveBeenCalledWith('Tell me more');
  });

  test('follow-ups hidden when list is empty or no handler provided', () => {
    const { v } = freshView();
    v.setPersonaContext({ followUps: ['a'], onFollowUp: null });
    expect(document.querySelector('.agent-answer-followups').hidden).toBe(true);
    v.setPersonaContext({ followUps: [], onFollowUp: jest.fn() });
    expect(document.querySelector('.agent-answer-followups').hidden).toBe(true);
  });

  test('setPersonaContext(undefined) does not throw', () => {
    const { v } = freshView();
    expect(() => v.setPersonaContext()).not.toThrow();
  });
});

describe('AnswerView copy', () => {
  test('copy uses electron clipboard and flashes "Copied"', () => {
    const { v } = freshView();
    const spy = jest.spyOn(electronClipboard(), 'writeText').mockImplementation(() => {});
    v.renderStatic('answer to copy');
    document.querySelector('.agent-answer-copy').click();
    expect(spy).toHaveBeenCalledWith('answer to copy');
    expect(document.querySelector('.agent-answer-copy').textContent).toBe('Copied');
    spy.mockRestore();
  });

  test('copy is a no-op when there is no answer', () => {
    freshView();
    const spy = jest.spyOn(electronClipboard(), 'writeText').mockImplementation(() => {});
    document.querySelector('.agent-answer-copy').click();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('_flashCopy restores the original label after the timeout', () => {
    jest.useFakeTimers();
    const { v } = freshView();
    jest.spyOn(electronClipboard(), 'writeText').mockImplementation(() => {});
    v.renderStatic('x');
    const btn = document.querySelector('.agent-answer-copy');
    btn.click();
    expect(btn.textContent).toBe('Copied');
    jest.advanceTimersByTime(1500);
    expect(btn.textContent).toBe('Copy');
    jest.useRealTimers();
  });

  test('falls back to navigator.clipboard when electron clipboard throws', async () => {
    const { v } = freshView();
    jest.spyOn(electronClipboard(), 'writeText').mockImplementation(() => { throw new Error('no electron'); });
    const navWrite = jest.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: navWrite }, configurable: true });
    v.renderStatic('fallback answer');
    document.querySelector('.agent-answer-copy').click();
    expect(navWrite).toHaveBeenCalledWith('fallback answer');
    // "Copied" only after the web clipboard's promise settles.
    expect(document.querySelector('.agent-answer-copy').textContent).toBe('Copy');
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.agent-answer-copy').textContent).toBe('Copied');
  });

  test('shows "Copy failed" (not "Copied") when the web clipboard rejects', async () => {
    const { v } = freshView();
    jest.spyOn(electronClipboard(), 'writeText').mockImplementation(() => { throw new Error('no electron'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('permission denied')) },
      configurable: true,
    });
    v.renderStatic('denied answer');
    document.querySelector('.agent-answer-copy').click();
    await Promise.resolve(); await Promise.resolve();
    expect(document.querySelector('.agent-answer-copy').textContent).toBe('Copy failed');
    expect(warn).toHaveBeenCalledWith('[AnswerView] copy failed:', 'permission denied');
    warn.mockRestore();
  });

  test('shows "Copy failed" when both clipboard paths throw', () => {
    const { v } = freshView();
    jest.spyOn(electronClipboard(), 'writeText').mockImplementation(() => { throw new Error('no electron'); });
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: () => { throw new Error('blocked'); } },
      configurable: true,
    });
    v.renderStatic('doomed answer');
    document.querySelector('.agent-answer-copy').click();
    expect(document.querySelector('.agent-answer-copy').textContent).toBe('Copy failed');
  });
});

describe('AnswerView listen (TTS)', () => {
  test('without speechSynthesis the Listen button stays hidden', () => {
    const { v } = freshView();
    v.renderStatic('content');
    const btn = document.querySelector('.agent-answer-listen');
    expect(btn.hidden).toBe(true);
    // Clicking is a guarded no-op (tts unsupported).
    expect(() => btn.click()).not.toThrow();
  });
});

describe('AnswerView listen with a stub speechSynthesis', () => {
  let speak;
  let cancel;
  function viewWithTts() {
    jest.resetModules();
    speak = jest.fn();
    cancel = jest.fn();
    window.speechSynthesis = {
      speak,
      cancel,
      pause: jest.fn(),
      resume: jest.fn(),
      getVoices: () => [{ voiceURI: 'v1', lang: 'en-US', localService: true, default: true }],
      addEventListener: jest.fn(),
    };
    window.SpeechSynthesisUtterance = function (txt) { this.text = txt; };
    let t = 0;
    global.requestAnimationFrame = (cb) => setTimeout(() => cb((t += 16)), 0);
    if (window.matchMedia == null) window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    const AnswerView = require('../../../../../renderer/components/agent/AnswerView');
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    return new AnswerView({ root });
  }

  afterEach(() => {
    delete window.speechSynthesis;
    delete window.SpeechSynthesisUtterance;
  });

  test('Listen button is visible+enabled once an answer exists and speaks on click', () => {
    const v = viewWithTts();
    v.renderStatic('Read this answer aloud please');
    const btn = document.querySelector('.agent-answer-listen');
    expect(btn.hidden).toBe(false);
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(speak).toHaveBeenCalled();
    expect(btn.textContent).toBe('Stop');
  });

  test('clicking Listen while speaking cancels playback', () => {
    const v = viewWithTts();
    v.renderStatic('Some spoken answer');
    const btn = document.querySelector('.agent-answer-listen');
    btn.click(); // start
    btn.click(); // stop
    expect(cancel).toHaveBeenCalled();
  });

  test('Listen disabled (no raw) but visible when supported with empty answer', () => {
    const v = viewWithTts();
    const btn = document.querySelector('.agent-answer-listen');
    expect(btn.hidden).toBe(false);
    expect(btn.disabled).toBe(true);
  });
});

describe('AnswerView keyboard citation activation', () => {
  test('Space key on a focused citation invokes onCite', () => {
    const { v } = freshView();
    const onCite = jest.fn();
    v.setCitationMap({ 3: 'pane-z' }, onCite);
    v.renderStatic('Fact [3].');
    const a = document.querySelector('.agent-cite');
    a.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(onCite).toHaveBeenCalledWith('pane-z');
  });

  test('non-citation click on the body is ignored', () => {
    const { v } = freshView();
    const onCite = jest.fn();
    v.setCitationMap({ 1: 'p' }, onCite);
    v.renderStatic('Plain text, no markers.');
    document.querySelector('.agent-answer-body').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCite).not.toHaveBeenCalled();
  });

  test('setCitationMap mid-stream re-renders static answers immediately', () => {
    const { v } = freshView();
    v.renderStatic('Claim [1] here.');
    expect(document.querySelectorAll('.agent-cite')).toHaveLength(0);
    v.setCitationMap({ 1: 'src-1' }, jest.fn());
    expect(document.querySelectorAll('.agent-cite')).toHaveLength(1);
  });

  test('setCitationMap with an empty/invalid map clears citation linking', () => {
    const { v } = freshView();
    v.setCitationMap({}, jest.fn());
    v.renderStatic('Ref [1].');
    expect(document.querySelectorAll('.agent-cite')).toHaveLength(0);
  });
});
