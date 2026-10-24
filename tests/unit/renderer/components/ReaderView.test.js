/**
 * @jest-environment jsdom
 */

// ReaderView extracts the page in view (readableExtractor, run via the
// webview's executeJavaScript — the only external boundary, stubbed here)
// and renders it in the unified dropdown shell, with an optional local-TTS
// "Listen" button. configBridge + speechSynthesis are stubbed per test.

jest.mock('electron', () => ({ ipcRenderer: { on: jest.fn(), send: jest.fn(), sendSync: jest.fn(() => ({ config: null })), invoke: jest.fn() } }));

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeWv(id, pageObj, throws) {
  const el = document.createElement('div');
  el.id = id;
  document.body.appendChild(el);
  el.getURL = () => (pageObj && pageObj.url) || 'https://ex.com';
  el.getTitle = () => (pageObj && pageObj.title) || 'Example';
  el.executeJavaScript = jest.fn(async () => {
    if (throws) throw new Error('exec blew up');
    return pageObj;
  });
  return el;
}

function installSynth(present) {
  if (!present) {
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    return null;
  }
  const synth = {
    spoken: [],
    cancel: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    getVoices: jest.fn(() => []),
    addEventListener: jest.fn(),
    speak: jest.fn(function (u) { synth.spoken.push(u); }),
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  global.SpeechSynthesisUtterance = function (t) { this.text = t; this.onend = null; this.onerror = null; };
  return synth;
}

describe('ReaderView.renderArticle (pure)', () => {
  const { renderArticle } = require('../../../../renderer/components/ReaderView');

  test('converts headings, bullets, quotes and paragraphs to escaped HTML', () => {
    const html = renderArticle([
      '# Big Heading',
      '### Sub <script>',
      'A normal paragraph with <b>tags</b> & ampersand.',
      '• first item',
      '• second item',
      '> a pulled quote',
    ].join('\n'));
    expect(html).toContain('<h1 class="reader-h reader-h1">Big Heading</h1>');
    expect(html).toContain('<h3 class="reader-h reader-h3">Sub &lt;script&gt;</h3>');
    expect(html).toContain('&lt;b&gt;tags&lt;/b&gt; &amp; ampersand');
    expect(html).toContain('<ul class="reader-list"><li>first item</li><li>second item</li></ul>');
    expect(html).toContain('<blockquote class="reader-quote">a pulled quote</blockquote>');
    expect(html).not.toContain('<script>');
  });

  test('empty / nullish input yields empty string', () => {
    expect(renderArticle('')).toBe('');
    expect(renderArticle(null)).toBe('');
  });
});

describe('ReaderView', () => {
  let rv;
  let nav;

  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = '';
    document.body.classList.add('no-animations');
    installSynth(true);
    rv = require('../../../../renderer/components/ReaderView');
    nav = { getActiveWebview: jest.fn(() => null) };
    rv.initialize(() => ({ navigationManager: nav }));
  });

  afterEach(() => { try { rv.close(); } catch (_) { /* ignore */ } });

  test('initialize builds content; dropdown not in DOM until open()', () => {
    expect(rv.content).toBeTruthy();
    expect(document.querySelector('.app-dropdown')).toBeNull();
  });

  test('open() extracts the page and renders title + article body', async () => {
    const wv = makeWv('tabA', {
      title: 'Rustaceans',
      url: 'https://rust-lang.org/learn',
      byline: 'By The Team',
      wordCount: 440,
      mainText: '# Intro\nFutures are lazy.\n• point one\n> a quote',
    });
    nav.getActiveWebview.mockReturnValue(wv);
    rv.open();
    await flush();
    expect(document.querySelector('.app-dropdown')).toBeTruthy();
    expect(rv._metaEl.querySelector('.reader-title').textContent).toBe('Rustaceans');
    expect(rv._metaEl.textContent).toContain('By The Team');
    expect(rv._metaEl.textContent).toContain('rust-lang.org');
    expect(rv._metaEl.textContent).toMatch(/2 min read/);
    expect(rv._bodyEl.querySelector('.reader-h1').textContent).toBe('Intro');
    expect(rv._bodyEl.textContent).toContain('Futures are lazy.');
    expect(rv._bodyEl.querySelector('.reader-list li').textContent).toBe('point one');
  });

  test('open() with a specific spaceId reads that pane', async () => {
    makeWv('paneZ', { title: 'Z', url: 'u', mainText: 'zebra body' });
    rv.open({ spaceId: 'paneZ' });
    await flush();
    expect(rv._bodyEl.textContent).toContain('zebra body');
    expect(nav.getActiveWebview).not.toHaveBeenCalled();
  });

  test('no page in view surfaces an error', async () => {
    rv.open();
    await flush();
    expect(rv._bodyEl.querySelector('.reader-status--error').textContent).toMatch(/no page in view/i);
  });

  test('extraction failure surfaces the error message', async () => {
    const wv = makeWv('tabErr', null, true);
    nav.getActiveWebview.mockReturnValue(wv);
    rv.open();
    await flush();
    expect(rv._bodyEl.querySelector('.reader-status--error').textContent).toContain('exec blew up');
  });

  test('empty extraction result surfaces "no readable content"', async () => {
    const wv = makeWv('tabEmpty', { title: '', mainText: '' });
    nav.getActiveWebview.mockReturnValue(wv);
    rv.open();
    await flush();
    expect(rv._bodyEl.querySelector('.reader-status--error').textContent).toMatch(/no readable content/i);
  });

  test('Listen button speaks the article, then stops on a second click', async () => {
    const synth = window.speechSynthesis;
    makeWv('tabL', { title: 'Doc', url: 'u', mainText: 'Body to read.' });
    rv.open({ spaceId: 'tabL' });
    await flush();
    expect(rv._listenBtn.hidden).toBe(false);
    expect(rv._listenBtn.disabled).toBe(false);
    rv._listenBtn.click();
    expect(synth.speak).toHaveBeenCalled();
    expect(synth.spoken[0].text).toContain('Doc');
    expect(synth.spoken[0].text).toContain('Body to read.');
    expect(rv._listenBtn.textContent).toContain('Stop');
    rv._listenBtn.click();
    expect(synth.cancel).toHaveBeenCalled();
  });

  test('closing the panel cancels in-flight speech', async () => {
    const synth = window.speechSynthesis;
    makeWv('tabC', { title: 'C', url: 'u', mainText: 'words words' });
    rv.open({ spaceId: 'tabC' });
    await flush();
    rv._listenBtn.click();
    rv.close();
    expect(synth.cancel).toHaveBeenCalled();
  });

  test('Listen button is hidden when text-to-speech is unsupported', async () => {
    jest.resetModules();
    document.body.innerHTML = '';
    installSynth(false);
    const rv2 = require('../../../../renderer/components/ReaderView');
    rv2.initialize(() => ({ navigationManager: { getActiveWebview: () => null } }));
    makeWv('tabU', { title: 'U', url: 'u', mainText: 'x' });
    rv2.open({ spaceId: 'tabU' });
    await flush();
    expect(rv2._listenBtn.hidden).toBe(true);
    rv2.close();
  });

  test('Listen button is hidden when settings.tts.enabled is false', async () => {
    jest.resetModules();
    document.body.innerHTML = '';
    installSynth(true);
    const cfg = require('../../../../renderer/core/configBridge');
    cfg.initialize({ settings: { tts: { enabled: false, rate: 1, voiceURI: '' } } });
    const rv2 = require('../../../../renderer/components/ReaderView');
    rv2.initialize(() => ({ navigationManager: { getActiveWebview: () => null } }));
    makeWv('tabD', { title: 'D', url: 'u', mainText: 'x' });
    rv2.open({ spaceId: 'tabD' });
    await flush();
    expect(rv2._listenBtn.hidden).toBe(true);
    rv2.close();
  });
});
