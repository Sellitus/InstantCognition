/**
 * @jest-environment jsdom
 */

// The in-page capture script, evaluated in jsdom exactly as CDP would inject
// it. jsdom cannot dispatch trusted events, so behavior tests build the
// source with trustedOnly=false; one test pins that the shipped source
// ignores untrusted (page-synthesized) events.
const { buildCaptureSource, CAPTURE_SOURCE, UNINSTALL_SOURCE, BINDING_NAME } = require('../../../../../main/agent/recorder/captureScript');
const { describeElement, isSensitiveField } = require('../../../../../main/agent/recorder/domDescribe');

const run = (src) => window.eval(src);
let emitted;

function sent() { return emitted.mock.calls.map(([json]) => JSON.parse(json)); }

function type(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  emitted = jest.fn();
  window[BINDING_NAME] = emitted;
});

afterEach(() => {
  run(UNINSTALL_SOURCE);
  delete window[BINDING_NAME];
});

describe('capture script', () => {
  beforeEach(() => run(buildCaptureSource({ trustedOnly: false })));

  test('a password never leaves the page in clear', () => {
    document.body.innerHTML = '<input id="pw" type="password">';
    type(document.getElementById('pw'), 'hunter2');
    expect(sent()).toEqual([expect.objectContaining({ type: 'input', value: '[redacted]', redacted: true })]);
    expect(emitted.mock.calls[0][0]).not.toContain('hunter2');
  });

  test('a password field switched to text by a show-password toggle stays redacted', () => {
    document.body.innerHTML = '<input id="pass" name="password" type="text" autocomplete="current-password">';
    type(document.getElementById('pass'), 'hunter2');
    expect(sent()[0].value).toBe('[redacted]');
  });

  test.each([
    ['<input id="n" autocomplete="cc-number">'],
    ['<input id="n" name="cardnumber">'],
    ['<input id="n" name="cvc">'],
  ])('card field %s is redacted', (html) => {
    document.body.innerHTML = html;
    type(document.getElementById('n'), '4111111111111111');
    expect(sent()[0].value).toBe('[redacted]');
  });

  test('a password field toggled to type=text before typing stays redacted', async () => {
    document.body.innerHTML = '<input id="field1" type="password">';
    const input = document.getElementById('field1');
    input.setAttribute('type', 'text');
    await Promise.resolve();
    type(input, 'hunter2');
    expect(sent()[0]).toMatchObject({ type: 'input', value: '[redacted]', redacted: true });
    expect(emitted.mock.calls[0][0]).not.toContain('hunter2');
  });

  test('a password field already in the page at install time is remembered after a toggle', async () => {
    run(UNINSTALL_SOURCE);
    document.body.innerHTML = '<input id="field2" type="password">';
    run(buildCaptureSource({ trustedOnly: false }));
    const input = document.getElementById('field2');
    input.type = 'text';
    await Promise.resolve();
    type(input, 'hunter2');
    expect(sent()[0].value).toBe('[redacted]');
  });

  test('a plain text field that never was a password keeps its value', async () => {
    document.body.innerHTML = '<input id="field3" type="text">';
    const input = document.getElementById('field3');
    input.setAttribute('type', 'search');
    await Promise.resolve();
    type(input, 'red shoes');
    expect(sent()[0].value).toBe('red shoes');
  });

  test.each([
    ['<input id="n" name="creditCardNumber">'],
    ['<input id="n" name="otp">'],
    ['<input id="n" name="pin">'],
    ['<input id="n" name="passcode">'],
  ])('field %s is redacted', (html) => {
    document.body.innerHTML = html;
    type(document.getElementById('n'), '123456');
    expect(sent()[0].value).toBe('[redacted]');
  });

  test('card expiry selects are redacted too', () => {
    document.body.innerHTML = '<select id="m" autocomplete="cc-exp-month"><option>01</option><option>02</option></select>';
    const sel = document.getElementById('m');
    sel.value = '02';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sent()[0]).toMatchObject({ type: 'change', value: '[redacted]' });
  });

  test('ordinary input keeps its value and carries field hints', () => {
    document.body.innerHTML = '<label for="q">Search</label><input id="q" name="q" type="search">';
    type(document.getElementById('q'), 'red shoes');
    expect(sent()[0]).toMatchObject({
      type: 'input', value: 'red shoes', field: { type: 'search', name: 'q', id: 'q' },
      target: { selector: '#q', strategy: 'id', role: 'textbox', name: 'Search' },
    });
  });

  test('clicks report the actionable ancestor; checkboxes report checked state; Enter and submit are captured', () => {
    document.body.innerHTML = '<form id="f"><button type="button" data-testid="buy"><span id="inner">Buy now</span></button>'
      + '<input type="checkbox" name="terms"></form>';
    document.getElementById('inner').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const box = document.querySelector('[name="terms"]');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    document.getElementById('f').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const events = sent();
    expect(events.map((e) => e.type)).toEqual(['click', 'change', 'key', 'submit']);
    expect(events[0].target).toMatchObject({ selector: '[data-testid="buy"]', strategy: 'testid', tag: 'button', text: 'Buy now' });
    expect(events[1]).toMatchObject({ checked: true, target: { selector: 'input[name="terms"]', strategy: 'name' } });
    expect(events[2].key).toBe('Enter');
  });

  test('uninstall removes every listener', () => {
    document.body.innerHTML = '<button id="b">x</button>';
    run(UNINSTALL_SOURCE);
    document.getElementById('b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(emitted).not.toHaveBeenCalled();
    expect(window.__icRecorderUninstall).toBeUndefined();
  });

  test('installing twice does not double-report', () => {
    run(buildCaptureSource({ trustedOnly: false }));
    document.body.innerHTML = '<button id="b">x</button>';
    document.getElementById('b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(emitted).toHaveBeenCalledTimes(1);
  });
});

test('the shipped source ignores events a page script synthesizes', () => {
  run(CAPTURE_SOURCE);
  document.body.innerHTML = '<button id="b">x</button>';
  document.getElementById('b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(emitted).not.toHaveBeenCalled();
});

test('nothing is installed when the binding is missing', () => {
  delete window[BINDING_NAME];
  run(buildCaptureSource({ trustedOnly: false }));
  expect(window.__icRecorderUninstall).toBeUndefined();
});

describe('describeElement', () => {
  test('prefers a stable id, skips generated ids, then aria-label', () => {
    document.body.innerHTML = '<button id=":r1:" aria-label="Close dialog">x</button>';
    expect(describeElement(document.querySelector('button'))).toMatchObject({
      selector: 'button[aria-label="Close dialog"]', strategy: 'aria-label', role: 'button', name: 'Close dialog',
    });
  });

  test('falls back to a structural path with role+name, and quotes are escaped', () => {
    document.body.innerHTML = '<ul><li><a href="/a">First</a></li><li><a href="/b">Say "hi"</a></li></ul>';
    const d = describeElement(document.querySelectorAll('a')[1]);
    expect(d.strategy).toBe('role');
    expect(d.name).toBe('Say "hi"');
    expect(document.querySelector(d.selector)).toBe(document.querySelectorAll('a')[1]);
  });

  test('a duplicated attribute is not treated as unique', () => {
    document.body.innerHTML = '<div><span data-testid="x">a</span></div><div><span data-testid="x">b</span></div>';
    const d = describeElement(document.querySelectorAll('span')[1]);
    expect(d.strategy).toBe('text');
    expect(document.querySelector(d.selector).textContent).toBe('b');
  });

  test('returns null for non-elements', () => {
    expect(describeElement(document.createTextNode('x'))).toBeNull();
    expect(describeElement(null)).toBeNull();
  });
});

describe('isSensitiveField', () => {
  test.each([
    [{ type: 'password' }, true],
    [{ autocomplete: 'cc-exp' }, true],
    [{ autocomplete: 'one-time-code' }, true],
    [{ name: 'card_number' }, true],
    [{ id: 'newPassword' }, true],
    [{ name: 'creditCardNumber' }, true],
    [{ name: 'cardHolder' }, true],
    [{ name: 'cc-num' }, true],
    [{ name: 'otp' }, true],
    [{ id: 'otpCode' }, true],
    [{ name: 'totp' }, true],
    [{ name: 'mfa_code' }, true],
    [{ name: 'oneTimeCode' }, true],
    [{ name: 'one-time-password' }, true],
    [{ name: 'pin' }, true],
    [{ id: 'pin_code' }, true],
    [{ name: 'pincode' }, true],
    [{ name: 'passcode' }, true],
    [{ name: 'passphrase' }, true],
    [{ name: 'ssn' }, true],
    [{ name: 'expiry' }, true],
    [{ name: 'cardExpirationDate' }, true],
    [{ name: 'cvv2' }, true],
    [{ name: 'csc' }, true],
    [{ id: 'securityCode' }, true],
    [{ name: 'security-code' }, true],
    [{ name: 'input[name="pin"]' }, true],
    [{ name: 'email', type: 'email' }, false],
    [{ name: 'accent' }, false],
    [{ id: 'spinner' }, false],
    [{ name: 'pinned' }, false],
    [{ name: 'opinion' }, false],
    [{ name: 'shipping' }, false],
    [{ name: 'phoneTime' }, false],
    [{ name: 'cc' }, false],
    [{ name: 'div.spinner > input:nth-of-type(2)' }, false],
    [null, false],
  ])('%j → %s', (hints, expected) => {
    expect(isSensitiveField(hints)).toBe(expected);
  });
});
