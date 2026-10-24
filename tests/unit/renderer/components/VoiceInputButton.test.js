/**
 * @jest-environment jsdom
 */

const listeners = new Set();
const mockOverlay = {
  bindConfig: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  cancel: jest.fn(),
  isActive: jest.fn(() => false),
  getState: jest.fn(() => ({ mode: 'idle', isActive: false, targetEl: null })),
  onStateChange: jest.fn((fn) => {
    listeners.add(fn);
    fn(mockOverlay.getState());
    return () => listeners.delete(fn);
  }),
};

jest.mock('../../../../renderer/components/VoiceCaptureOverlay', () => mockOverlay);
jest.mock('../../../../renderer/core/configBridge', () => ({ get: jest.fn(() => ({ lang: 'fallback' })) }));

const { createVoiceInputButton } = require('../../../../renderer/components/VoiceInputButton');

function emit(state) {
  mockOverlay.getState.mockReturnValue(state);
  listeners.forEach((fn) => fn(state));
}

describe('VoiceInputButton', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    listeners.clear();
    jest.clearAllMocks();
    mockOverlay.isActive.mockReturnValue(false);
    mockOverlay.getState.mockReturnValue({ mode: 'idle', isActive: false, targetEl: null });
  });

  test('starts voice capture with the explicit target and voice config', () => {
    const target = document.createElement('textarea');
    document.body.appendChild(target);
    const button = createVoiceInputButton({
      target,
      label: 'Dictate task',
      getConfig: () => ({ lang: 'en' }),
    });
    document.body.appendChild(button);

    button.click();

    expect(mockOverlay.bindConfig).toHaveBeenCalledWith({ lang: 'en' });
    expect(mockOverlay.start).toHaveBeenCalledWith({ pressToTalk: false, targetEl: target });
    expect(document.activeElement).toBe(target);
  });

  test('mousedown prevents focus from leaving the text field', () => {
    const target = document.createElement('input');
    document.body.appendChild(target);
    target.focus();
    const button = createVoiceInputButton({ target, label: 'Dictate' });
    document.body.appendChild(button);

    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(target);
  });

  test('state changes mark the owning button and disable other mic buttons', () => {
    const first = document.createElement('textarea');
    const second = document.createElement('textarea');
    document.body.append(first, second);
    const firstButton = createVoiceInputButton({ target: first, label: 'First mic' });
    const secondButton = createVoiceInputButton({ target: second, label: 'Second mic' });
    document.body.append(firstButton, secondButton);

    emit({ mode: 'recording', isActive: true, targetEl: first });

    expect(firstButton.classList.contains('is-listening')).toBe(true);
    expect(firstButton.getAttribute('aria-pressed')).toBe('true');
    expect(firstButton.disabled).toBe(false);
    expect(secondButton.disabled).toBe(true);

    emit({ mode: 'transcribing', isActive: true, targetEl: first });

    expect(firstButton.classList.contains('is-listening')).toBe(false);
    expect(firstButton.classList.contains('is-transcribing')).toBe(true);
    expect(firstButton.title).toBe('Cancel transcription');
  });

  test('clicking the owning active button stops recording or cancels transcription', () => {
    const target = document.createElement('textarea');
    document.body.appendChild(target);
    const button = createVoiceInputButton({ target, label: 'Dictate' });
    document.body.appendChild(button);

    emit({ mode: 'recording', isActive: true, targetEl: target });
    button.click();
    expect(mockOverlay.stop).toHaveBeenCalledTimes(1);

    emit({ mode: 'transcribing', isActive: true, targetEl: target });
    button.click();
    expect(mockOverlay.cancel).toHaveBeenCalledTimes(1);
  });
});
