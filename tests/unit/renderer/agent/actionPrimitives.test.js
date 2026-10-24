// actionPrimitives tests — exercise the IIFE source strings against jsdom.

const ap = require('../../../../main/agent/actionPrimitives');

function run(src) {
  // eslint-disable-next-line no-eval
  return eval(src);
}

beforeEach(() => {
  document.body.innerHTML = `
    <input id="search" name="q" type="text" />
    <button id="go">Go</button>
    <div id="answer">forty two</div>
    <div class="result"></div>
  `;
  Element.prototype.scrollIntoView = function () {};
});

describe('buildClickScript', () => {
  test('clicks element when present', (done) => {
    const btn = document.getElementById('go');
    btn.addEventListener('click', () => done());
    const result = run(ap.buildClickScript('#go'));
    expect(result.ok).toBe(true);
  });

  test('returns not_found when missing', () => {
    const result = run(ap.buildClickScript('#nope'));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_found');
  });
});

describe('buildTypeScript', () => {
  test('sets value on input and dispatches input event', () => {
    let inputFired = false;
    document.getElementById('search').addEventListener('input', () => { inputFired = true; });
    const result = run(ap.buildTypeScript('#search', 'hello world'));
    expect(result.ok).toBe(true);
    expect(document.getElementById('search').value).toBe('hello world');
    expect(inputFired).toBe(true);
  });

  test('returns not_found for missing element', () => {
    const result = run(ap.buildTypeScript('#missing', 'x'));
    expect(result.ok).toBe(false);
  });
});

describe('buildScrollScript', () => {
  test('returns ok and scrollY', () => {
    window.scrollBy = jest.fn();
    const result = run(ap.buildScrollScript('down', 300));
    expect(result.ok).toBe(true);
  });
});

describe('buildExtractTextScript', () => {
  test('returns text from matching elements', () => {
    const result = run(ap.buildExtractTextScript('#answer'));
    expect(result.ok).toBe(true);
    expect(result.text).toContain('forty two');
  });

  test('returns not_found when nothing matches', () => {
    const result = run(ap.buildExtractTextScript('.nonexistent'));
    expect(result.ok).toBe(false);
  });

  // A broad selector on a JSON or feed URL returns the whole document. Uncapped,
  // it lands in the agent conversation and is re-sent on every later step.
  test('caps a large match and flags the truncation', () => {
    document.body.innerHTML = `<pre id="big">${'x'.repeat(20000)}</pre>`;
    const result = run(ap.buildExtractTextScript('#big'));
    expect(result.ok).toBe(true);
    expect(result.text.length).toBe(6000);
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(20000); // the model is told how much it did not see
  });

  test('an explicit maxChars overrides the default and a short match is never flagged', () => {
    document.body.innerHTML = '<pre id="big">abcdefghij</pre>';
    expect(run(ap.buildExtractTextScript('#big', 4))).toMatchObject({ ok: true, text: 'abcd', truncated: true });
    expect(run(ap.buildExtractTextScript('#big', 500)).truncated).toBeUndefined();
  });
});

describe('buildWaitForScript', () => {
  test('returns immediately when element exists', async () => {
    const promise = run(ap.buildWaitForScript('#answer', 1000));
    const result = await promise;
    expect(result.ok).toBe(true);
  });

  test('times out when element missing', async () => {
    const promise = run(ap.buildWaitForScript('#never', 200));
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('timeout');
  });
});

describe('buildFillFormScript', () => {
  test('fills multiple fields, reports per-field results', () => {
    const result = run(ap.buildFillFormScript([
      { selector: '#search', value: 'foo' },
      { selector: '#missing', value: 'bar' },
    ]));
    expect(result.ok).toBe(true);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1].ok).toBe(false);
    expect(document.getElementById('search').value).toBe('foo');
  });
});
