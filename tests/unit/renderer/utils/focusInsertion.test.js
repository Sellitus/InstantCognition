/**
 * @jest-environment jsdom
 */

jest.mock('../../../../renderer/components/AgentPanel', () => ({
  open: jest.fn(),
  input: null,
}));

const agentPanelMock = require('../../../../renderer/components/AgentPanel');
const { insertTranscript, insertIntoElement, isEditableElement } = require('../../../../renderer/utils/focusInsertion');

describe('focusInsertion.isEditableElement', () => {
  test('rejects buttons / non-editable elements', () => {
    const div = document.createElement('div');
    expect(isEditableElement(div)).toBe(false);
    const btn = document.createElement('button');
    expect(isEditableElement(btn)).toBe(false);
    const submit = document.createElement('input'); submit.type = 'submit';
    expect(isEditableElement(submit)).toBe(false);
  });
  test('accepts text input, textarea, contenteditable', () => {
    const inp = document.createElement('input'); inp.type = 'text';
    expect(isEditableElement(inp)).toBe(true);
    const ta = document.createElement('textarea');
    expect(isEditableElement(ta)).toBe(true);
    const ce = document.createElement('div'); ce.setAttribute('contenteditable', 'true');
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    expect(isEditableElement(ce)).toBe(true);
  });

  test('returns false for null / no-tagName inputs', () => {
    expect(isEditableElement(null)).toBe(false);
    expect(isEditableElement(undefined)).toBe(false);
    expect(isEditableElement({})).toBe(false);
  });

  test.each(['button', 'checkbox', 'radio'])('rejects input[type=%s]', (t) => {
    const el = document.createElement('input'); el.type = t;
    expect(isEditableElement(el)).toBe(false);
  });

  test('plain div without contentEditable is not editable', () => {
    const div = document.createElement('div');
    expect(isEditableElement(div)).toBe(false);
  });
});

describe('focusInsertion.insertIntoElement', () => {
  test('inserts at end of empty input', () => {
    const inp = document.createElement('input'); inp.type = 'text';
    insertIntoElement(inp, 'hello world');
    expect(inp.value).toBe('hello world');
  });

  test('appends with leading space when input has content', () => {
    const inp = document.createElement('input'); inp.type = 'text';
    inp.value = 'first';
    inp.selectionStart = 5; inp.selectionEnd = 5;
    insertIntoElement(inp, 'second');
    expect(inp.value).toBe('first second');
  });

  test('respects mode=replace', () => {
    const ta = document.createElement('textarea');
    ta.value = 'original';
    insertIntoElement(ta, 'fresh', { mode: 'replace' });
    expect(ta.value).toBe('fresh');
  });

  test('fires input event for framework listeners', () => {
    const ta = document.createElement('textarea');
    let fired = false;
    ta.addEventListener('input', () => { fired = true; });
    insertIntoElement(ta, 'x');
    expect(fired).toBe(true);
  });

  test('returns false for non-editable element', () => {
    const div = document.createElement('div');
    expect(insertIntoElement(div, 'no')).toBe(false);
  });

  test('inserts mid-string respecting selection range', () => {
    const inp = document.createElement('input'); inp.type = 'text';
    inp.value = 'abcdef';
    inp.selectionStart = 2; inp.selectionEnd = 4;
    insertIntoElement(inp, 'X');
    // before='ab' (no trailing ws -> sep ' '), after='ef'
    expect(inp.value).toBe('ab Xef');
  });

  test('no leading space when caret directly after whitespace', () => {
    const inp = document.createElement('input'); inp.type = 'text';
    inp.value = 'word ';
    inp.selectionStart = 5; inp.selectionEnd = 5;
    insertIntoElement(inp, 'next');
    expect(inp.value).toBe('word next');
  });

  test('falls back to value.length when selectionStart not numeric', () => {
    const inp = document.createElement('input'); inp.type = 'text';
    inp.value = 'tail';
    Object.defineProperty(inp, 'selectionStart', { value: null, configurable: true });
    Object.defineProperty(inp, 'selectionEnd', { value: null, configurable: true });
    insertIntoElement(inp, 'end');
    expect(inp.value).toBe('tail end');
  });

  test('contentEditable replace mode sets textContent', () => {
    const ce = document.createElement('div');
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    ce.textContent = 'old';
    expect(insertIntoElement(ce, 'new', { mode: 'replace' })).toBe(true);
    expect(ce.textContent).toBe('new');
  });

  test('contentEditable append uses execCommand when available', () => {
    const ce = document.createElement('div');
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    ce.textContent = 'hello';
    const exec = jest.fn().mockReturnValue(true);
    document.execCommand = exec;
    let fired = false;
    ce.addEventListener('input', () => { fired = true; });
    expect(insertIntoElement(ce, 'there')).toBe(true);
    expect(exec).toHaveBeenCalledWith('insertText', false, ' there');
    expect(fired).toBe(true);
  });

  test('contentEditable append falls back to textContent when execCommand throws', () => {
    const ce = document.createElement('div');
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    ce.textContent = 'base';
    document.execCommand = jest.fn(() => { throw new Error('unsupported'); });
    expect(insertIntoElement(ce, 'tail')).toBe(true);
    expect(ce.textContent).toBe('base tail');
  });

  test('contentEditable append from empty content uses no leading space via execCommand', () => {
    const ce = document.createElement('div');
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    ce.textContent = '';
    const exec = jest.fn().mockReturnValue(true);
    document.execCommand = exec;
    insertIntoElement(ce, 'first');
    expect(exec).toHaveBeenCalledWith('insertText', false, 'first');
  });
});

describe('focusInsertion.insertTranscript', () => {
  beforeEach(() => {
    agentPanelMock.open.mockClear();
    agentPanelMock.input = null;
  });

  test('returns {ok:false, where:none} for empty / non-string text', () => {
    expect(insertTranscript('')).toEqual({ ok: false, where: 'none' });
    expect(insertTranscript(null)).toEqual({ ok: false, where: 'none' });
    expect(insertTranscript(42)).toEqual({ ok: false, where: 'none' });
  });

  test('inserts into the focused editable element', () => {
    const inp = document.createElement('input'); inp.type = 'text';
    document.body.appendChild(inp);
    inp.focus();
    const res = insertTranscript('typed text');
    expect(res).toEqual({ ok: true, where: 'focused' });
    expect(inp.value).toBe('typed text');
    document.body.removeChild(inp);
  });

  test('falls back to AgentPanel composer when nothing focused', () => {
    const input = document.createElement('textarea');
    input.value = 'prior';
    agentPanelMock.input = input;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const res = insertTranscript('appended');
    expect(agentPanelMock.open).toHaveBeenCalledWith({ scope: 'global' });
    expect(res).toEqual({ ok: true, where: 'agent' });
    expect(input.value).toBe('prior appended');
  });

  test('AgentPanel fallback honors replace mode', () => {
    const input = document.createElement('textarea');
    input.value = 'prior';
    agentPanelMock.input = input;
    const res = insertTranscript('fresh', { mode: 'replace' });
    expect(res.where).toBe('agent');
    expect(input.value).toBe('fresh');
  });

  test('returns {ok:false, where:none} when AgentPanel has no input', () => {
    agentPanelMock.input = null;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const res = insertTranscript('nowhere');
    expect(agentPanelMock.open).toHaveBeenCalled();
    expect(res).toEqual({ ok: false, where: 'none' });
  });
});
