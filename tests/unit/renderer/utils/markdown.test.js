/** @jest-environment jsdom */
const { mdToHtml, bindCodeCopy } = require('../../../../renderer/utils/markdown');

function parseHtml(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('markdown.mdToHtml', () => {
  test('headings', () => {
    expect(mdToHtml('# hi')).toContain('<h1 class="md-h md-h1">hi</h1>');
    expect(mdToHtml('### three')).toContain('<h3');
  });

  test('bold and italic', () => {
    const html = mdToHtml('this is **bold** and *italic*');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  test('inline code', () => {
    expect(mdToHtml('run `npm test`')).toContain('<code class="md-inline-code">npm test</code>');
  });

  test('fenced code block with language hint', () => {
    const html = mdToHtml('```js\nconst x = 1;\n```');
    expect(html).toContain('md-code');
    expect(html).toContain('md-code-lang');
    expect(parseHtml(html).querySelector('pre code').textContent).toBe('const x = 1;');
    expect(html).not.toContain('md-code-unclosed');
  });

  test('unclosed fence renders as an unclosed block (streaming-safe)', () => {
    const html = mdToHtml('```\nhalfway');
    expect(html).toContain('md-code-unclosed');
  });

  test('bullet list', () => {
    const html = mdToHtml('- a\n- b');
    expect(html).toContain('<ul class="md-list">');
    expect(html).toMatch(/<li>a<\/li>/);
    expect(html).toMatch(/<li>b<\/li>/);
  });

  test('numbered list', () => {
    const html = mdToHtml('1. first\n2. second');
    expect(html).toContain('<ol class="md-list">');
    expect(html).toMatch(/<li>first<\/li>/);
    expect(mdToHtml('3. third\n4. fourth')).toContain('<ol class="md-list" start="3">');
  });

  test('blockquote', () => {
    expect(mdToHtml('> quoted line')).toContain('<blockquote class="md-quote"><p class="md-p">quoted line</p></blockquote>');
  });

  test('http link is rendered', () => {
    const html = mdToHtml('[home](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test('javascript: link is rejected (XSS guard)', () => {
    const html = mdToHtml('[click](javascript:alert(1))');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('[click]');
  });

  test('HTML input is escaped, not passed through', () => {
    const html = mdToHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  test('paragraphs are blank-line separated', () => {
    const html = mdToHtml('one\ntwo\n\nthree');
    expect(html).toMatch(/<p[^>]*>one\ntwo<\/p>/);
    expect(html).not.toContain('<br');
    expect(html).toMatch(/<p[^>]*>three<\/p>/);
  });

  test('horizontal rule', () => {
    expect(mdToHtml('---')).toContain('<hr');
  });

  test('fenced code carries data-lang, hljs classes and a copy button', () => {
    const pre = parseHtml(mdToHtml('```js\nconst x = 1;\n```')).querySelector('pre');
    expect(pre.getAttribute('data-lang')).toBe('js');
    expect(pre.querySelector('code').className).toBe('hljs language-js');
    expect(pre.querySelector('code .hljs-keyword').textContent).toBe('const');
    const btn = pre.querySelector('button.md-copy');
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('aria-label')).toBe('Copy code');
  });

  test('unknown language fence is escaped plain text without highlighting', () => {
    const html = mdToHtml('```brainfuck\n<b>x</b> ++\n```');
    const code = parseHtml(html).querySelector('pre code');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; ++');
    expect(code.className).toBe('language-brainfuck');
    expect(code.querySelector('span')).toBeNull();
    expect(code.querySelector('b')).toBeNull();
  });

  test('fence language cannot inject attributes', () => {
    const html = mdToHtml('```js"onmouseover="alert(1)\nx\n```');
    expect(html).not.toContain('onmouseover');
    expect(parseHtml(html).querySelector('pre').hasAttribute('data-lang')).toBe(false);
  });

  test('<img onerror> inside a code fence is escaped text', () => {
    for (const src of ['```\n<img src=x onerror=alert(1)>\n```', '```html\n<img src=x onerror=alert(1)>\n```']) {
      const dom = parseHtml(mdToHtml(src));
      expect(dom.querySelector('img')).toBeNull();
      expect(dom.querySelector('[onerror]')).toBeNull();
      expect(dom.querySelector('pre code').textContent).toBe('<img src=x onerror=alert(1)>');
    }
  });

  test('unclosed fence mid-stream never throws and stays one code block', () => {
    const doc = 'Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\ndef f():\n    return 1\n```\n\nDone.';
    for (let i = 1; i <= doc.length; i += 1) {
      expect(() => mdToHtml(doc.slice(0, i))).not.toThrow();
    }
    const mid = mdToHtml(doc.slice(0, doc.indexOf('return')));
    expect(mid).toContain('md-code-unclosed');
    expect(parseHtml(mid).querySelectorAll('pre')).toHaveLength(1);
    expect(mdToHtml(doc)).not.toContain('md-code-unclosed');
  });

  test('table renders thead/tbody with alignment', () => {
    const dom = parseHtml(mdToHtml('| name | n |\n|:-----|--:|\n| a | 1 |\n| b | 2 |'));
    const table = dom.querySelector('.md-table-wrap > table.md-table');
    expect(table).not.toBeNull();
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['name', 'n']);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table.querySelector('tbody td:last-child').getAttribute('align')).toBe('right');
  });

  test('escaped pipes inside inline code stay in one table cell', () => {
    const dom = parseHtml(mdToHtml('| expr | v |\n|---|---|\n| `a \\| b` | 1 |'));
    const cells = dom.querySelectorAll('tbody td');
    expect(cells).toHaveLength(2);
    expect(cells[0].querySelector('code').textContent).toBe('a | b');
  });

  test('unescaped pipes inside inline code are not split into cells', () => {
    const dom = parseHtml(mdToHtml('| expr | v |\n|---|---|\n| `a | b` | 1 |\n| ``x || y`` | 2 |'));
    const rows = dom.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll('td')).toHaveLength(2);
    expect(rows[0].querySelector('code').textContent).toBe('a | b');
    expect(rows[1].querySelector('code').textContent).toBe('x || y');
  });

  test('pipe escaping is limited to table rows outside code fences', () => {
    expect(parseHtml(mdToHtml('use `a | b` here')).querySelector('code').textContent).toBe('a | b');
    const fenced = parseHtml(mdToHtml('```\n| `a | b` |\n|---|\n```')).querySelector('pre code');
    expect(fenced.textContent).toBe('| `a | b` |\n|---|');
  });

  test('half-typed table renders as a paragraph, not a table', () => {
    const html = mdToHtml('| a | b |\n|--');
    expect(html).not.toContain('<table');
    expect(html).toContain('md-p');
  });

  test('task list checkboxes are rendered disabled', () => {
    const dom = parseHtml(mdToHtml('- [ ] pending\n- [x] done'));
    const boxes = dom.querySelectorAll('input');
    expect(boxes).toHaveLength(2);
    boxes.forEach((b) => {
      expect(b.getAttribute('type')).toBe('checkbox');
      expect(b.disabled).toBe(true);
    });
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(true);
  });

  test('strikethrough renders as <del>', () => {
    expect(mdToHtml('~~gone~~')).toContain('<del>gone</del>');
  });

  test('javascript: link inside a table cell is neutralized', () => {
    const dom = parseHtml(mdToHtml('| a |\n|---|\n| [x](javascript:alert(1)) |'));
    expect(dom.querySelector('a')).toBeNull();
    expect(dom.innerHTML).not.toContain('href="javascript');
    expect(dom.querySelector('td').textContent).toBe('[x](javascript:alert(1))');
  });

  test('data: and relative links are not rendered as anchors', () => {
    const dom = parseHtml(mdToHtml('[a](data:text/html,<script>alert(1)</script>) [b](/etc/passwd)'));
    expect(dom.querySelector('a')).toBeNull();
    expect(dom.querySelector('script')).toBeNull();
  });

  test('images render as a link, never an <img> that loads by itself', () => {
    const dom = parseHtml(mdToHtml('![chart](https://example.com/c.png) ![bad](javascript:alert(1))'));
    expect(dom.querySelector('img')).toBeNull();
    const links = dom.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.com/c.png');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('inline raw HTML and event attributes are escaped', () => {
    const html = mdToHtml('hi <span onclick="x()">t</span> <script>alert(1)</script>');
    const dom = parseHtml(html);
    expect(dom.querySelector('script')).toBeNull();
    expect(dom.querySelector('[onclick]')).toBeNull();
    expect(html).toContain('&lt;script&gt;');
  });

  test('citation markers survive as plain text for AnswerView to linkify', () => {
    expect(mdToHtml('Fact [1] and [2].')).toContain('Fact [1] and [2].');
  });

  test('null input renders empty', () => {
    expect(mdToHtml(null)).toBe('');
    expect(mdToHtml(undefined)).toBe('');
  });
});

describe('markdown.bindCodeCopy', () => {
  let mockWriteText;
  let originalClipboard;

  beforeEach(() => {
    jest.useFakeTimers();
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    mockWriteText = jest.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mockWriteText } });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete navigator.clipboard;
  });

  function mount(md) {
    const root = document.createElement('div');
    root.innerHTML = mdToHtml(md);
    document.body.appendChild(root);
    bindCodeCopy(root);
    return root;
  }

  async function flush() {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }

  test('click copies the code text and shows a done state', async () => {
    mockWriteText.mockResolvedValue(undefined);
    const root = mount('```js\nconst a = 1;\n```');
    const btn = root.querySelector('button.md-copy');
    btn.click();
    await flush();
    expect(mockWriteText).toHaveBeenCalledTimes(1);
    expect(mockWriteText).toHaveBeenCalledWith('const a = 1;');
    expect(btn.classList.contains('md-copy--done')).toBe(true);
    expect(btn.textContent).toBe('Copied');
    jest.advanceTimersByTime(2000);
    expect(btn.textContent).toBe('Copy');
    expect(btn.classList.contains('md-copy--done')).toBe(false);
    root.remove();
  });

  test('clipboard rejection shows a visible error state and logs it', async () => {
    mockWriteText.mockRejectedValue(new Error('denied'));
    const root = mount('```\nx\n```');
    const btn = root.querySelector('button.md-copy');
    btn.click();
    await flush();
    expect(btn.classList.contains('md-copy--error')).toBe(true);
    expect(btn.textContent).toBe('Copy failed');
    expect(btn.title).toContain('denied');
    expect(console.error).toHaveBeenCalledWith('[markdown] code copy failed:', 'denied');
    root.remove();
  });

  test('missing clipboard API shows the error state instead of throwing', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const root = mount('```\nx\n```');
    const btn = root.querySelector('button.md-copy');
    expect(() => btn.click()).not.toThrow();
    await flush();
    expect(btn.classList.contains('md-copy--error')).toBe(true);
    root.remove();
  });

  test('copy survives innerHTML re-render and binding twice copies once', async () => {
    mockWriteText.mockResolvedValue(undefined);
    const root = mount('```\nold\n```');
    bindCodeCopy(root);
    root.innerHTML = mdToHtml('```\nnew\n```');
    root.querySelector('button.md-copy').click();
    await flush();
    expect(mockWriteText).toHaveBeenCalledTimes(1);
    expect(mockWriteText).toHaveBeenCalledWith('new');
    root.remove();
  });

  test('clicks outside copy buttons do nothing', async () => {
    const root = mount('text\n\n```\ncode\n```');
    root.querySelector('p').click();
    root.querySelector('pre code').click();
    await flush();
    expect(mockWriteText).not.toHaveBeenCalled();
    root.remove();
  });

  test('rejects a non-element root', () => {
    expect(() => bindCodeCopy(null)).toThrow(TypeError);
    expect(() => bindCodeCopy({})).toThrow(TypeError);
  });
});
