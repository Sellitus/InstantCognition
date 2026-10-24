// AnswerView — Research Report citation linkification + click delegation.
//
// Locks in the contract: once setCitationMap({index→spaceId}) is set, [N]
// markers whose N is in the map render as clickable .agent-cite links that
// invoke onCite(spaceId); unknown [N] stay literal; markdown link attributes
// are never rewritten by the citation pass.

jest.mock('electron', () => ({}), { virtual: true });

const AnswerView = require('../../../../../renderer/components/agent/AnswerView');

function setup() {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.appendChild(root);
  return new AnswerView({ root });
}

describe('AnswerView citations', () => {
  test('without a citation map, [N] stays literal text', () => {
    const v = setup();
    v.renderStatic('See [1] for details.');
    const body = document.querySelector('.agent-answer-body');
    expect(body.querySelectorAll('.agent-cite')).toHaveLength(0);
    expect(body.textContent).toContain('[1]');
  });

  test('mapped [N] become clickable links; unmapped [N] stay literal', () => {
    const v = setup();
    v.setCitationMap({ 1: 'agent-tab-a', 2: 'agent-tab-b' }, () => {});
    v.renderStatic('Claim one [1], claim two [2], claim three [3].');
    const cites = document.querySelectorAll('.agent-answer-body .agent-cite');
    expect(cites).toHaveLength(2);
    expect(cites[0].getAttribute('data-cite-pane')).toBe('agent-tab-a');
    expect(cites[0].textContent).toBe('[1]');
    expect(cites[1].getAttribute('data-cite-pane')).toBe('agent-tab-b');
    expect(document.querySelector('.agent-answer-body').textContent).toContain('[3]');
  });

  test('clicking a citation invokes onCite with its spaceId', () => {
    const v = setup();
    const onCite = jest.fn();
    v.setCitationMap({ 1: 'agent-tab-x' }, onCite);
    v.renderStatic('Fact [1].');
    const a = document.querySelector('.agent-cite');
    a.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCite).toHaveBeenCalledWith('agent-tab-x');
  });

  test('Enter key on a focused citation also invokes onCite', () => {
    const v = setup();
    const onCite = jest.fn();
    v.setCitationMap({ 2: 'agent-tab-y' }, onCite);
    v.renderStatic('Another fact [2].');
    const a = document.querySelector('.agent-cite');
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCite).toHaveBeenCalledWith('agent-tab-y');
  });

  test('citation pass does not corrupt markdown link attributes', () => {
    const v = setup();
    v.setCitationMap({ 1: 'agent-tab-a' }, () => {});
    v.renderStatic('See [the docs](https://example.com/page) for context [1].');
    const link = document.querySelector('.agent-answer-body a[href="https://example.com/page"]');
    expect(link).toBeTruthy();
    expect(link.textContent).toBe('the docs');
    const cite = document.querySelector('.agent-cite');
    expect(cite.getAttribute('data-cite-pane')).toBe('agent-tab-a');
  });

  test('clear() drops the citation map so later renders are literal again', () => {
    const v = setup();
    v.setCitationMap({ 1: 'agent-tab-a' }, jest.fn());
    v.renderStatic('Fact [1].');
    expect(document.querySelectorAll('.agent-cite')).toHaveLength(1);
    v.clear();
    v.renderStatic('Fact [1] again.');
    expect(document.querySelectorAll('.agent-cite')).toHaveLength(0);
    expect(document.querySelector('.agent-answer-body').textContent).toContain('[1]');
  });
});

describe('AnswerView code blocks', () => {
  let originalClipboard;
  let mockWriteText;

  beforeEach(() => {
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    mockWriteText = jest.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mockWriteText } });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete navigator.clipboard;
  });

  async function flush() {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }

  test('copy button on a streamed code block copies that block, not the whole answer', async () => {
    mockWriteText.mockResolvedValue(undefined);
    const v = setup();
    v.appendChunk('Intro\n\n```js\nconst a = 1;\n');
    v.appendChunk('```\n\nOutro');
    document.querySelector('.agent-answer-body button.md-copy').click();
    await flush();
    expect(mockWriteText).toHaveBeenCalledWith('const a = 1;');
  });

  test('a rejected clipboard write marks the code copy button as failed', async () => {
    mockWriteText.mockRejectedValue(new Error('not focused'));
    const v = setup();
    v.renderStatic('```\nx\n```');
    const btn = document.querySelector('.agent-answer-body button.md-copy');
    btn.click();
    await flush();
    expect(btn.classList.contains('md-copy--error')).toBe(true);
  });

  test('citations inside table cells are linkified without breaking the table', () => {
    const v = setup();
    v.setCitationMap({ 1: 'agent-tab-a' }, jest.fn());
    v.renderStatic('| claim | src |\n|---|---|\n| sky is blue | [1] |');
    const cite = document.querySelector('.agent-answer-body td .agent-cite');
    expect(cite).not.toBeNull();
    expect(cite.getAttribute('data-cite-pane')).toBe('agent-tab-a');
  });
});

