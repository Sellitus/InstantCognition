// ArtifactFrame — sandbox, CSP-first document, script-escape safety, mermaid
// by URL, staging over IPC, trusted-source autosize and the navigation guard.

const ArtifactFrame = require('../../../../../renderer/components/assistant/ArtifactFrame');
const { FRAME_CSP, MERMAID_URL } = require('../../../../../shared/artifactFrame');

const { buildFrameDocument, MIN_HEIGHT, MAX_HEIGHT } = ArtifactFrame;
const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
const ESCAPE_ATTEMPT = '</script><script>window.pwned=1</script><img src=x onerror="window.pwned=2">';
const flush = () => new Promise((r) => setTimeout(r, 0));

// The main-process side of artifact-frame:stage / :release (the IPC boundary).
function fakeMain() {
  const staged = new Map();
  let n = 0;
  const ipc = {
    staged,
    released: [],
    failNextStage: null,
    invoke: jest.fn(async (channel, arg) => {
      if (channel === 'artifact-frame:stage') {
        if (ipc.failNextStage) { const err = ipc.failNextStage; ipc.failNextStage = null; throw err; }
        n += 1;
        const url = `ic-artifact://frame/${String(n).padStart(32, '0')}`;
        staged.set(url, arg);
        return url;
      }
      if (channel === 'artifact-frame:release') { ipc.released.push(arg); staged.delete(arg); return undefined; }
      throw new Error(`unexpected channel ${channel}`);
    }),
  };
  return ipc;
}

let frames = [];
const mount = (ipc = fakeMain()) => {
  const f = new ArtifactFrame({ ipc });
  document.body.appendChild(f.el);
  frames.push(f);
  return Object.assign(f, { main: ipc });
};
// The document the frame currently points at, as main would serve it.
const shown = (f) => f.main.staged.get(f.el.getAttribute('src'));
afterEach(() => {
  frames.forEach((f) => { f.destroy(); f.el.remove(); });
  frames = [];
});

describe('iframe isolation', () => {
  test('sandbox is allow-scripts only, never allow-same-origin', async () => {
    const f = mount();
    await f.render({ type: 'html', title: 'Page', content: '<p>x</p>' });
    expect(f.el.getAttribute('sandbox')).toBe('allow-scripts');
    expect(f.el.getAttribute('sandbox')).not.toMatch(/allow-same-origin/);
    expect(f.el.getAttribute('title')).toBe('Artifact: Page');
  });

  test.each(['html', 'markdown', 'code', 'svg', 'mermaid'])('CSP meta is the first child of head for %s', (type) => {
    const doc = parse(buildFrameDocument({ type, title: 't', content: 'graph TD; A-->B' }));
    const first = doc.head.firstElementChild;
    expect(first.tagName).toBe('META');
    expect(first.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(first.getAttribute('content')).toBe(FRAME_CSP);
    expect(FRAME_CSP).toBe("default-src 'none'; script-src 'unsafe-inline' ic-artifact://asset/mermaid.min.js; style-src 'unsafe-inline'; img-src data:");
  });

  test('an html artifact cannot put its own markup ahead of the CSP', () => {
    const doc = parse(buildFrameDocument({ type: 'html', title: 't', content: '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>x</body></html>' }));
    expect(doc.head.firstElementChild.getAttribute('content')).toBe(FRAME_CSP);
  });
});

describe('WebRTC egress prelude', () => {
  const vm = require('vm');
  const { WEBRTC_PRELUDE_JS } = ArtifactFrame;
  const RTC = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'];

  function mockFrameGlobal() {
    class MockNavigatorProto {}
    Object.defineProperty(MockNavigatorProto.prototype, 'mediaDevices', { configurable: true, get() { return { getUserMedia() {} }; } });
    const nav = new MockNavigatorProto();
    const g = { navigator: nav, Navigator: MockNavigatorProto };
    for (const n of RTC) g[n] = function MockCtor() {};
    g.window = g;
    g.self = g;
    return g;
  }

  test.each(['html', 'markdown', 'code', 'svg', 'mermaid'])('the prelude is the first script, right after the CSP meta, for %s', (type) => {
    const doc = parse(buildFrameDocument({ type, title: 't', content: '<script>window.first=1</script>graph TD; A' }));
    const second = doc.head.children[1];
    expect(second.tagName).toBe('SCRIPT');
    expect(second.textContent).toBe(WEBRTC_PRELUDE_JS);
    expect(doc.querySelector('script')).toBe(second);
  });

  test('an html artifact\'s own head markup still lands after the prelude', () => {
    const doc = parse(buildFrameDocument({ type: 'html', title: 't', content: '<html><head><script>window.early=1</script></head><body>x</body></html>' }));
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts[0].textContent).toBe(WEBRTC_PRELUDE_JS);
    expect(scripts.findIndex((sc) => /window\.early/.test(sc.textContent))).toBeGreaterThan(0);
  });

  test('running the prelude removes the peer-connection constructors and media devices for good', () => {
    const g = mockFrameGlobal();
    vm.runInNewContext(WEBRTC_PRELUDE_JS, g);
    for (const n of RTC) {
      expect(g[n]).toBeUndefined();
      expect(Reflect.set(g, n, function Restored() {})).toBe(false);
      expect(g[n]).toBeUndefined();
    }
    expect(g.navigator.mediaDevices).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(g.Navigator.prototype, 'mediaDevices')).toBeUndefined();
  });

  test('a nested frame reached through contentWindow is scrubbed too', () => {
    const g = mockFrameGlobal();
    const child = mockFrameGlobal();
    class MockIframe {}
    Object.defineProperty(MockIframe.prototype, 'contentWindow', { configurable: true, enumerable: true, get() { return child; } });
    g.HTMLIFrameElement = MockIframe;
    vm.runInNewContext(WEBRTC_PRELUDE_JS, g);
    expect(new MockIframe().contentWindow).toBe(child);
    for (const n of RTC) expect(child[n]).toBeUndefined();
    expect(child.navigator.mediaDevices).toBeUndefined();
  });

  test('without the prelude the mock frame keeps its constructors (the check above is meaningful)', () => {
    const g = mockFrameGlobal();
    expect(typeof g.RTCPeerConnection).toBe('function');
    expect(g.navigator.mediaDevices).toBeDefined();
  });

  test('the iframe denies powerful features through its permissions policy', () => {
    const f = mount();
    const allow = f.el.getAttribute('allow');
    for (const feature of ['camera', 'microphone', 'display-capture', 'geolocation']) {
      expect(allow).toContain(`${feature} 'none'`);
    }
  });
});

describe('</script> in artifact text cannot escape', () => {
  test.each(['markdown', 'code', 'svg'])('%s content adds no script and no handler', (type) => {
    const doc = parse(buildFrameDocument({ type, title: ESCAPE_ATTEMPT, content: ESCAPE_ATTEMPT }));
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts).toHaveLength(2); // the frame's own WebRTC prelude + autosize script
    expect(scripts.some((sc) => /pwned/.test(sc.textContent))).toBe(false);
    expect(doc.querySelector('[onerror]')).toBeNull();
    expect(doc.title).toBe(ESCAPE_ATTEMPT);
  });

  test('mermaid source stays text inside the pre', () => {
    const doc = parse(buildFrameDocument({ type: 'mermaid', title: 'd', content: `graph TD; A-->B\n${ESCAPE_ATTEMPT}` }));
    expect(doc.querySelectorAll('script')).toHaveLength(4);
    expect([...doc.querySelectorAll('script')].some((s) => /pwned/.test(s.textContent))).toBe(false);
    expect(doc.querySelector('pre.mermaid').textContent).toBe(`graph TD; A-->B\n${ESCAPE_ATTEMPT}`);
    expect(doc.querySelector('[onerror]')).toBeNull();
  });

  test('svg is embedded as a data: image, so its scripts never run', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>';
    const doc = parse(buildFrameDocument({ type: 'svg', title: 'Dot', content: svg }));
    const img = doc.querySelector('img.ic-svg');
    expect(img.getAttribute('src')).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    expect(doc.querySelector('svg')).toBeNull();
  });

  test('code fences cannot be closed early by backticks in the content', () => {
    const content = 'const a = `x`;\n```\n<b>not markup</b>';
    const doc = parse(buildFrameDocument({ type: 'code', language: 'javascript', title: 'c', content }));
    expect(doc.querySelectorAll('pre')).toHaveLength(1);
    expect(doc.querySelector('pre code').textContent).toBe(content);
    expect(doc.querySelector('b')).toBeNull();
  });

});

describe('mermaid', () => {
  test('the bundle loads by URL from the one asset the frame CSP allows, then runs strict', () => {
    const doc = parse(buildFrameDocument({ type: 'mermaid', title: 'Flow', content: 'graph TD; A-->B' }));
    const scripts = [...doc.querySelectorAll('script')];
    expect(scripts).toHaveLength(4);
    expect(scripts[2].getAttribute('src')).toBe(MERMAID_URL);
    expect(scripts[2].textContent).toBe('');
    expect(FRAME_CSP).toContain(MERMAID_URL);
    expect(scripts[3].textContent).toContain("securityLevel:'strict'");
    expect(scripts[3].textContent).toContain('theme:"dark"');
  });

  test('light host theme selects the default mermaid theme', () => {
    const doc = parse(buildFrameDocument({ type: 'mermaid', title: 'F', content: 'graph TD; A' }, { dark: false }));
    expect(doc.querySelectorAll('script')[3].textContent).toContain('theme:"default"');
  });
});

describe('theme tokens', () => {
  test('known tokens are copied; unknown names and unsafe values are dropped', () => {
    const doc = parse(buildFrameDocument({ type: 'markdown', title: 't', content: 'x' }, {
      tokens: { '--accent': ' #2FB9D6 ', '--evil': 'red', '--text-primary': 'red}</style><script>x()</script>' },
    }));
    const css = doc.querySelector('style').textContent;
    expect(css).toContain(':root{--accent:#2FB9D6}');
    expect(css).not.toContain('--evil');
    expect(doc.querySelectorAll('script')).toHaveLength(2);
  });
});

test('an unsupported type throws', () => {
  expect(() => buildFrameDocument({ type: 'pdf', title: 't', content: 'x' })).toThrow(/Unsupported artifact type: pdf/);
  expect(() => buildFrameDocument(null)).toThrow(TypeError);
});

describe('autosize via postMessage', () => {
  const post = (source, data) => window.dispatchEvent(new MessageEvent('message', { data, source }));

  test('a size message from the frame sets a clamped height', async () => {
    const f = mount();
    await f.render({ type: 'html', title: 't', content: '<p>x</p>' });
    post(f.el.contentWindow, { type: 'ic-artifact:size', height: 432.2 });
    expect(f.el.style.height).toBe('433px');
    post(f.el.contentWindow, { type: 'ic-artifact:size', height: 1e9 });
    expect(f.el.style.height).toBe(`${MAX_HEIGHT}px`);
    post(f.el.contentWindow, { type: 'ic-artifact:size', height: 3 });
    expect(f.el.style.height).toBe(`${MIN_HEIGHT}px`);
  });

  test('messages from any other source, or malformed, are ignored', async () => {
    const f = mount();
    const other = mount();
    await f.render({ type: 'html', title: 't', content: '<p>x</p>' });
    post(window, { type: 'ic-artifact:size', height: 900 });
    post(other.el.contentWindow, { type: 'ic-artifact:size', height: 900 });
    post(null, { type: 'ic-artifact:size', height: 900 });
    post(f.el.contentWindow, { type: 'other', height: 900 });
    post(f.el.contentWindow, { type: 'ic-artifact:size', height: 'NaN' });
    post(f.el.contentWindow, 'ic-artifact:size');
    expect(f.el.style.height).toBe(`${MIN_HEIGHT}px`);
  });

  test('destroy stops listening', async () => {
    const f = mount();
    await f.render({ type: 'html', title: 't', content: '<p>x</p>' });
    const win = f.el.contentWindow;
    f.destroy();
    post(win, { type: 'ic-artifact:size', height: 900 });
    expect(f.el.style.height).toBe(`${MIN_HEIGHT}px`);
  });
});

describe('staging over IPC', () => {
  test('render stages the built document in main and points the frame at its URL', async () => {
    const f = mount();
    await f.render({ type: 'markdown', title: 'Notes', content: 'hello **there**' });
    expect(f.main.invoke).toHaveBeenCalledWith('artifact-frame:stage', expect.any(String));
    expect(f.el.getAttribute('src')).toMatch(/^ic-artifact:\/\/frame\/[0-9a-f]{32}$/);
    expect(shown(f)).toContain('<strong>there</strong>');
    expect(f.el.hasAttribute('srcdoc')).toBe(false);
  });

  test('re-rendering releases the document it replaces', async () => {
    const f = mount();
    await f.render({ type: 'markdown', title: 'a', content: 'first' });
    const first = f.el.getAttribute('src');
    await f.render({ type: 'markdown', title: 'b', content: 'second' });
    expect(f.main.released).toEqual([first]);
    expect(f.main.staged.size).toBe(1);
    expect(shown(f)).toContain('second');
  });

  test('a render that finishes after a newer one never reaches the frame and is released', async () => {
    const ipc = fakeMain();
    const realInvoke = ipc.invoke.getMockImplementation();
    let releaseSlow;
    ipc.invoke.mockImplementationOnce((ch, arg) => new Promise((resolve) => { releaseSlow = () => resolve(realInvoke(ch, arg)); }));
    const f = mount(ipc);
    const slow = f.render({ type: 'markdown', title: 'old', content: 'stale' });
    await f.render({ type: 'markdown', title: 'new', content: 'fresh' });
    releaseSlow();
    await slow;
    expect(shown(f)).toContain('fresh');
    expect(ipc.staged.size).toBe(1);
    expect(ipc.released).toHaveLength(1);
  });

  test('a failed stage rejects the render and keeps the previous document', async () => {
    const f = mount();
    await f.render({ type: 'markdown', title: 'a', content: 'kept' });
    const before = f.el.getAttribute('src');
    f.main.failNextStage = new Error('main is gone');
    await expect(f.render({ type: 'markdown', title: 'b', content: 'lost' })).rejects.toThrow('main is gone');
    expect(f.el.getAttribute('src')).toBe(before);
    expect(shown(f)).toContain('kept');
  });

  test('destroy releases the shown document and drops a render still in flight', async () => {
    const ipc = fakeMain();
    const f = mount(ipc);
    await f.render({ type: 'markdown', title: 'a', content: 'one' });
    const pending = f.render({ type: 'markdown', title: 'b', content: 'two' });
    f.destroy();
    await pending;
    expect(f.el.hasAttribute('src')).toBe(false);
    expect(ipc.staged.size).toBe(0);
    expect(ipc.released).toHaveLength(2);
  });
});

describe('navigation guard', () => {
  test('a load after the rendered one replaces the frame with a notice', async () => {
    const f = mount();
    f.el.dispatchEvent(new Event('load')); // initial about:blank, before any render
    await f.render({ type: 'html', title: 't', content: '<a href="https://example.com">go</a>' });
    expect(shown(f)).toContain('href="https://example.com"');
    f.el.dispatchEvent(new Event('load'));
    expect(shown(f)).toContain('href="https://example.com"');
    f.el.dispatchEvent(new Event('load'));
    await flush();
    expect(shown(f)).toContain('The navigation was stopped.');
    expect(shown(f)).not.toContain('example.com');
  });

  test('when the notice cannot be staged the frame is blanked, never left on the foreign page', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const f = mount();
      await f.render({ type: 'html', title: 't', content: '<a href="https://example.com">go</a>' });
      f.el.dispatchEvent(new Event('load'));
      f.main.failNextStage = new Error('main is gone');
      f.el.dispatchEvent(new Event('load'));
      await flush();
      expect(f.el.getAttribute('src')).toBe('about:blank');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('could not show the navigation notice'), expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('re-rendering before the previous load fired is not a navigation', async () => {
    const f = mount();
    await f.render({ type: 'markdown', title: 'a', content: 'first' });
    await f.render({ type: 'markdown', title: 'b', content: 'second' });
    f.el.dispatchEvent(new Event('load'));
    await flush();
    expect(shown(f)).toContain('second');
  });
});
