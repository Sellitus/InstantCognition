// domExtractor tests — exercises the IIFE source produced by buildExtractScript
// against jsdom (renderer suite uses the jsdom env) to verify the observation shape.

const { buildExtractScript } = require('../../../../main/agent/domExtractor');

function runScript(src) {
  // The script is an IIFE that returns a value. eval the source and capture.
  // eslint-disable-next-line no-eval
  return eval(src);
}

beforeEach(() => {
  document.body.innerHTML = `
    <h1>Test Page</h1>
    <p>Some intro text describing the page.</p>
    <a href="https://example.com/about">About us</a>
    <a href="https://example.com/contact">Contact</a>
    <button id="submit-btn">Submit</button>
    <input type="text" name="email" placeholder="Email address" />
    <textarea aria-label="comments"></textarea>
  `;
  document.title = 'Hello World';
  // jsdom returns 0 width/height by default; stub getBoundingClientRect to "visible"
  Element.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 20, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20 };
  };
});

describe('domExtractor.buildExtractScript', () => {
  test('returns a string containing an IIFE', () => {
    const src = buildExtractScript();
    expect(typeof src).toBe('string');
    expect(src).toContain('(function ()');
  });

  test('executed script returns observation with title, url, text fields', () => {
    const obs = runScript(buildExtractScript());
    expect(obs.title).toBe('Hello World');
    expect(typeof obs.url).toBe('string');
    // jsdom does not implement innerText so this is just a defined string
    expect(typeof obs.text).toBe('string');
  });

  test('observation includes interactive elements with selectors and labels', () => {
    const obs = runScript(buildExtractScript());
    expect(Array.isArray(obs.interactives)).toBe(true);
    expect(obs.interactives.length).toBeGreaterThan(0);
    const submit = obs.interactives.find((i) => i.tag === 'button');
    expect(submit).toBeDefined();
    expect(submit.label).toBe('Submit');
    expect(submit.selector).toContain('#submit-btn');
    const emailInput = obs.interactives.find((i) => i.tag === 'input' && i.name === 'email');
    expect(emailInput).toBeDefined();
    expect(emailInput.type).toBe('text');
    expect(emailInput.label).toBe('Email address');
  });

  test('observation includes links with text and href', () => {
    const obs = runScript(buildExtractScript());
    expect(Array.isArray(obs.links)).toBe(true);
    expect(obs.links.length).toBeGreaterThanOrEqual(2);
    const about = obs.links.find((l) => l.text === 'About us');
    expect(about).toBeDefined();
    expect(about.href).toContain('/about');
  });

  test('respects maxInteractives bound', () => {
    // Create many buttons
    for (let i = 0; i < 200; i++) {
      const b = document.createElement('button');
      b.textContent = 'btn' + i;
      document.body.appendChild(b);
    }
    const obs = runScript(buildExtractScript({ maxInteractives: 25 }));
    expect(obs.interactives.length).toBeLessThanOrEqual(25);
  });
});
