// externalLinks — links handed to the app by the OS (macOS open-url, a second
// instance's argv on Windows/Linux, the first launch's own argv). Pure module:
// nothing to mock, the sink is the boundary.

let externalLinks;
let errorSpy;

beforeEach(() => {
  jest.resetModules();
  externalLinks = require('../../../../main/services/externalLinks');
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('openWebUrl', () => {
  test('queues links that arrive before a sink exists, then delivers them in order on attach', () => {
    expect(externalLinks.openWebUrl('https://first.example/a', 'open-url')).toBe(true);
    expect(externalLinks.openWebUrl('http://second.example/b', 'open-url')).toBe(true);
    const sink = jest.fn();
    externalLinks.attach(sink);
    expect(sink.mock.calls).toEqual([['https://first.example/a'], ['http://second.example/b']]);
  });

  test('delivers immediately once attached and does not replay already-delivered links', () => {
    externalLinks.openWebUrl('https://queued.example/', 'open-url');
    const sink = jest.fn();
    externalLinks.attach(sink);
    externalLinks.openWebUrl('https://live.example/', 'open-url');
    const second = jest.fn();
    externalLinks.attach(second);
    expect(sink.mock.calls).toEqual([['https://queued.example/'], ['https://live.example/']]);
    expect(second).not.toHaveBeenCalled();
  });

  test('queues again after detach (window closed) until the next attach', () => {
    const sink = jest.fn();
    externalLinks.attach(sink);
    externalLinks.detach();
    externalLinks.openWebUrl('https://later.example/', 'open-url');
    expect(sink).not.toHaveBeenCalled();
    const next = jest.fn();
    externalLinks.attach(next);
    expect(next).toHaveBeenCalledWith('https://later.example/');
  });

  test.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'mailto:a@b.example',
    'data:text/html,<script>1</script>',
    'ms-msdt:/id',
    'https://',
    '',
  ])('refuses and logs the non-web link %p', (raw) => {
    const sink = jest.fn();
    externalLinks.attach(sink);
    expect(externalLinks.openWebUrl(raw, 'open-url')).toBe(false);
    expect(sink).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('refused'), expect.any(String));
  });

  test('refuses a non-string value', () => {
    const sink = jest.fn();
    externalLinks.attach(sink);
    expect(externalLinks.openWebUrl(/** @type {any} */ ({ href: 'https://x.example/' }), 'open-url')).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  test('a refused link is never queued for a later attach', () => {
    externalLinks.openWebUrl('javascript:alert(1)', 'open-url');
    const sink = jest.fn();
    externalLinks.attach(sink);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('webUrlsFromArgv', () => {
  test('keeps only http(s) arguments, in order', () => {
    const argv = [
      'C:\\Program Files\\InstantCognition\\InstantCognition.exe',
      '--allow-file-access-from-files',
      '--original-process-start-time=13350000000',
      'https://one.example/path?q=1',
      '.',
      '/home/u/page.html',
      'HTTP://two.example/',
    ];
    expect(externalLinks.webUrlsFromArgv(argv)).toEqual(['https://one.example/path?q=1', 'http://two.example/']);
  });

  test('ignores flags that embed a URL and plain file paths without logging them', () => {
    const argv = ['/usr/bin/instantcognition', '--url=https://x.example/', 'C:\\Users\\u\\a.html', './rel/page.html'];
    expect(externalLinks.webUrlsFromArgv(argv)).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('rejects and logs arguments that carry a non-web scheme', () => {
    const argv = ['app', 'javascript:alert(1)', 'file:///etc/passwd', 'https://ok.example/'];
    expect(externalLinks.webUrlsFromArgv(argv)).toEqual(['https://ok.example/']);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  test('a missing argv yields no links', () => {
    expect(externalLinks.webUrlsFromArgv(undefined)).toEqual([]);
  });
});

describe('openFromArgv', () => {
  test('routes every web URL in argv through the queue', () => {
    externalLinks.openFromArgv(['app', '--flag', 'https://a.example/', 'javascript:x', 'http://b.example/'], 'launch');
    const sink = jest.fn();
    externalLinks.attach(sink);
    expect(sink.mock.calls).toEqual([['https://a.example/'], ['http://b.example/']]);
  });
});
