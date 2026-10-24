// The app's own windows run without Node behind a strict CSP. These checks
// pin the parts of that contract that live outside JavaScript: the pages'
// CSP and script tags, and a renderer bundle that builds with no Node builtin.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildRenderer } = require('../../scripts/build-renderer');

const REPO_ROOT = path.join(__dirname, '../..');

function pageCsp(page) {
  const html = fs.readFileSync(path.join(REPO_ROOT, page), 'utf8');
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  const directives = new Map();
  for (const part of (meta ? meta[1] : '').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name, values);
  }
  return { html, directives };
}

describe.each(['index.html', 'launcher.html'])('%s', (page) => {
  const { html, directives } = pageCsp(page);

  test('declares a CSP before any stylesheet or script', () => {
    const cspAt = html.indexOf('Content-Security-Policy');
    expect(cspAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(html.indexOf('<link'));
    expect(cspAt).toBeLessThan(html.indexOf('<script'));
  });

  test('scripts run only from the packaged bundle: no inline, no eval', () => {
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('default-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/src="[a-z]+\.bundle\.js"/);
      expect(body.trim()).toBe('');
    }
  });
});

test('the shell may frame only staged artifact documents', () => {
  expect(pageCsp('index.html').directives.get('frame-src')).toEqual(['ic-artifact:']);
});

test('no webview in the shell markup names its own preload', () => {
  expect(pageCsp('index.html').html).not.toMatch(/\spreload=/);
});

test('the shell and launcher bundles build with no Node builtin', async () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-bundle-'));
  try {
    await buildRenderer({ outdir });
    for (const name of ['renderer.bundle.js', 'launcher.bundle.js']) {
      const code = fs.readFileSync(path.join(outdir, name), 'utf8');
      expect(code.length).toBeGreaterThan(10000);
      expect(code).not.toMatch(/\brequire\(["'](fs|path|os|child_process|crypto)["']\)/);
    }
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}, 120000);
