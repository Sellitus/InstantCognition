// promote — ```artifact:<type> fenced blocks in a chat answer become
// artifact candidates for the chat lane.

const { extractArtifactBlocks } = require('../../../../../main/agent/artifacts/promote');

test('extracts typed blocks with title and code language', () => {
  const text = [
    'Here is the page:',
    '```artifact:html Landing page',
    '<h1>Hello</h1>',
    '<p>World</p>',
    '```',
    'And the script:',
    '~~~~artifact:code:python  Fetch helper ',
    'print("hi")',
    '~~~~',
  ].join('\n');
  expect(extractArtifactBlocks(text)).toEqual([
    { type: 'html', title: 'Landing page', content: '<h1>Hello</h1>\n<p>World</p>' },
    { type: 'code', language: 'python', title: 'Fetch helper', content: 'print("hi")' },
  ]);
});

test('title is optional and capped at 200 chars', () => {
  const [a] = extractArtifactBlocks('```artifact:mermaid\ngraph TD; A-->B\n```');
  expect(a).toEqual({ type: 'mermaid', content: 'graph TD; A-->B' });
  const [b] = extractArtifactBlocks(`\`\`\`artifact:svg ${'t'.repeat(300)}\n<svg/>\n\`\`\``);
  expect(b.title).toHaveLength(200);
});

test('unknown types, plain fences and empty bodies are not promoted', () => {
  const text = [
    '```artifact:pdf Report', 'data', '```',
    '```js', 'const a = 1;', '```',
    '```artifact:HTML Upper', '<p/>', '```',
    '```artifact:markdown Empty', '   ', '```',
    '```artifact:markdown Real', '# Kept', '```',
  ].join('\n');
  expect(extractArtifactBlocks(text)).toEqual([{ type: 'markdown', title: 'Real', content: '# Kept' }]);
});

test('an unclosed block (mid-stream) is not promoted until it closes', () => {
  const partial = '```artifact:html Page\n<h1>Hel';
  expect(extractArtifactBlocks(partial)).toEqual([]);
  expect(extractArtifactBlocks(`${partial}lo</h1>\n\`\`\``)).toEqual([{ type: 'html', title: 'Page', content: '<h1>Hello</h1>' }]);
});

test('an artifact fence shown inside another fence is example text', () => {
  const text = ['````markdown', '```artifact:html Example', '<p>x</p>', '```', '````'].join('\n');
  expect(extractArtifactBlocks(text)).toEqual([]);
});

test('closing fence must match the opener character and be at least as long', () => {
  const text = ['````artifact:markdown Doc', '```python', 'x = 1', '```', '~~~~', 'still inside', '````'].join('\n');
  expect(extractArtifactBlocks(text)).toEqual([
    { type: 'markdown', title: 'Doc', content: '```python\nx = 1\n```\n~~~~\nstill inside' },
  ]);
});

test('CRLF input and non-string input', () => {
  expect(extractArtifactBlocks('```artifact:svg Dot\r\n<svg/>\r\n```\r\n')).toEqual([{ type: 'svg', title: 'Dot', content: '<svg/>' }]);
  expect(extractArtifactBlocks(null)).toEqual([]);
  expect(extractArtifactBlocks(42)).toEqual([]);
});
