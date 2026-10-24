// artifactFrames — the ic-artifact: scheme behind artifact previews: staging,
// the CSP header on every served document, eviction, release and the mermaid
// asset. Electron's protocol/session objects are the boundary.

const { ArtifactFrames, MAX_STAGED } = require('../../../../main/services/artifactFrames');
const { FRAME_CSP, MERMAID_URL, SCHEME } = require('../../../../shared/artifactFrame');

const TOKEN_URL = /^ic-artifact:\/\/frame\/[0-9a-f]{32}$/;

describe('artifactFrames', () => {
  let frames;
  beforeEach(() => { frames = new ArtifactFrames(); });

  test('a staged document is served once per URL with the frame CSP as a header', async () => {
    const url = frames.stage('<p>hi</p>');
    expect(url).toMatch(TOKEN_URL);
    const res = frames.respond(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBe(FRAME_CSP);
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toBe('<p>hi</p>');
  });

  test('every stage gets its own unguessable URL', () => {
    const a = frames.stage('x');
    const b = frames.stage('x');
    expect(a).not.toBe(b);
  });

  test.each([
    'ic-artifact://frame/' + '0'.repeat(32),
    'ic-artifact://frame/not-a-token',
    'ic-artifact://frame/',
    'ic-artifact://elsewhere/x',
    'https://example.com/',
  ])('an unknown or malformed URL is a 404: %s', async (url) => {
    frames.stage('<p>secret</p>');
    const res = frames.respond(url);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('secret');
  });

  test('a released document is no longer served', () => {
    const url = frames.stage('<p>gone</p>');
    frames.release(url);
    expect(frames.respond(url).status).toBe(404);
    expect(frames.stagedCount()).toBe(0);
  });

  test('releasing an unknown URL leaves staged documents alone', () => {
    const url = frames.stage('<p>kept</p>');
    frames.release('ic-artifact://frame/' + 'f'.repeat(32));
    frames.release('garbage');
    expect(frames.respond(url).status).toBe(200);
  });

  test('the oldest documents are evicted past the cap', () => {
    const first = frames.stage('first');
    for (let i = 0; i < MAX_STAGED; i += 1) frames.stage(`doc ${i}`);
    expect(frames.stagedCount()).toBe(MAX_STAGED);
    expect(frames.respond(first).status).toBe(404);
  });

  test('stage rejects a non-string or oversized document', () => {
    expect(() => frames.stage(/** @type {any} */ ({ html: 'x' }))).toThrow(TypeError);
    expect(() => frames.stage('x'.repeat(16 * 1024 * 1024 + 1))).toThrow(RangeError);
    expect(frames.stagedCount()).toBe(0);
  });

  test('the mermaid asset is the vendored bundle, read once', async () => {
    const res = frames.respond(MERMAID_URL);
    expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    const body = await res.text();
    expect(body.length).toBeGreaterThan(1000000);
    expect(body).toContain('mermaid');
    const read = jest.spyOn(frames, '_readFile');
    frames.respond(MERMAID_URL);
    expect(read).not.toHaveBeenCalled();
  });

  test('install serves the scheme on the given session only', async () => {
    const session = { protocol: { handle: jest.fn() } };
    frames.install(/** @type {any} */ (session));
    expect(session.protocol.handle).toHaveBeenCalledWith(SCHEME, expect.any(Function));
    const url = frames.stage('<b>x</b>');
    const handler = session.protocol.handle.mock.calls[0][1];
    expect(await handler({ url }).text()).toBe('<b>x</b>');
  });

  test('registerScheme makes ic-artifact a standard, secure scheme', () => {
    const protocol = { registerSchemesAsPrivileged: jest.fn() };
    frames.registerScheme(protocol);
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: 'ic-artifact', privileges: { standard: true, secure: true } },
    ]);
  });
});
