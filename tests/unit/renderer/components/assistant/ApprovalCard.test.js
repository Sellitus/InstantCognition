// ApprovalCard — the approval queue against a mocked IPC boundary: FIFO
// order, stale/unknown requestIds, per-kind bodies, the Always-allow rule
// button, and focus vs. announcement on arrival.

const { createTwoFilesPatch } = require('diff');
const ApprovalCard = require('../../../../../renderer/components/assistant/ApprovalCard');

let root, container, composer, ipc, card, drained;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('section');
  container = document.createElement('div');
  container.className = 'agent-panel-approval';
  container.setAttribute('aria-live', 'assertive');
  container.hidden = true;
  composer = document.createElement('textarea');
  root.append(container, composer);
  document.body.appendChild(root);
  ipc = { send: jest.fn() };
  drained = jest.fn();
  card = new ApprovalCard({ container, ipc, focusRoot: () => root, onDrained: drained });
});

const shell = (requestId, extra) => ({
  requestId, call: { name: 'shell.run', args: { argv: ['git', 'status'] } }, class: 'exec', origin: null,
  sessionId: null, kind: 'shell', toolName: 'shell.run', argsPreview: '{"argv":["git","status"]}',
  suggestedRule: 'shell.run:git status', argv: ['git', 'status'], cwd: '/work/repo', ...extra,
});
const head = () => container.querySelector('.approval-card');
const btn = (decision) => container.querySelector(`button[data-decision="${decision}"]`);

test('requests queue in arrival order and each answer reveals the next', () => {
  card.enqueue(shell('r1'));
  card.enqueue(shell('r2', { argv: ['ls'] }));
  expect(container.hidden).toBe(false);
  expect(head().dataset.requestId).toBe('r1');
  expect(container.querySelector('.approval-card__counter').textContent).toBe('1 of 2');
  btn('approve').click();
  expect(ipc.send).toHaveBeenLastCalledWith('agent:approval-response', { requestId: 'r1', decision: 'approve' });
  expect(head().dataset.requestId).toBe('r2');
  expect(container.querySelector('.approval-card__counter').hidden).toBe(true);
  btn('reject').click();
  expect(ipc.send).toHaveBeenLastCalledWith('agent:approval-response', { requestId: 'r2', decision: 'reject' });
  expect(container.hidden).toBe(true);
  expect(head()).toBeNull();
  expect(drained).toHaveBeenCalledTimes(1);
});

test('an unknown or already-answered requestId sends nothing', () => {
  card.enqueue(shell('r1'));
  expect(card.respond('nope', 'approve')).toBe(false);
  expect(ipc.send).not.toHaveBeenCalled();
  const stale = btn('approve');
  stale.click();
  stale.click();
  expect(ipc.send).toHaveBeenCalledTimes(1);
  expect(card.respond('r1', 'approve')).toBe(false);
});

test('malformed and duplicate requests are ignored', () => {
  expect(card.enqueue(null)).toBe(false);
  expect(card.enqueue({ call: { name: 'x' } })).toBe(false);
  expect(card.enqueue({ requestId: '' })).toBe(false);
  expect(container.hidden).toBe(true);
  expect(card.enqueue(shell('r1'))).toBe(true);
  expect(card.enqueue(shell('r1', { argv: ['rm'] }))).toBe(false);
  expect(card.size).toBe(1);
});

test('fs_edit shows the file and a DiffView; large diffs start collapsed', () => {
  const patch = createTwoFilesPatch('notes.md', 'notes.md', 'a\n', 'b\n');
  card.enqueue({ requestId: 'f1', kind: 'fs_edit', toolName: 'fs.edit', call: { name: 'fs.edit', args: {} }, class: 'edit', path: 'notes.md', diff: patch, suggestedRule: null });
  expect(head().classList.contains('approval-card--fs_edit')).toBe(true);
  expect(container.querySelector('.approval-card__value').textContent).toBe('notes.md');
  expect(container.querySelector('.diff-view .diff-view__row--add .diff-view__code').textContent).toBe('b');

  const big = createTwoFilesPatch('big', 'big', 'x\n'.repeat(250), 'y\n'.repeat(250));
  card.respond('f1', 'approve');
  card.enqueue({ requestId: 'f2', kind: 'fs_edit', toolName: 'fs.write', call: { name: 'fs.write', args: {} }, class: 'edit', path: 'big', diff: big });
  expect(container.querySelector('.diff-view').classList.contains('diff-view--collapsed')).toBe(true);
  expect(container.querySelector('.diff-view__expand')).not.toBeNull();
});

test('fs_edit with a preview error shows it instead of a diff', () => {
  card.enqueue({ requestId: 'f3', kind: 'fs_edit', toolName: 'fs.edit', call: { name: 'fs.edit', args: {} }, class: 'edit', path: 'a.txt', diff: undefined, previewError: 'old_string not found' });
  expect(container.querySelector('.approval-card__error').textContent).toBe('Preview unavailable: old_string not found');
  expect(container.querySelector('.diff-view')).toBeNull();
});

test('shell shows each argv element as its own chip, the cwd and the sandbox note', () => {
  card.enqueue(shell('s1', { argv: ['echo', '$(whoami)', '<b>x</b>'] }));
  const chips = [...container.querySelectorAll('.approval-card__chip')].map((c) => c.textContent);
  expect(chips).toEqual(['echo', '$(whoami)', '<b>x</b>']);
  expect(container.querySelector('b')).toBeNull();
  expect(container.textContent).toContain('/work/repo');
  expect(container.querySelector('.approval-card__note').textContent).toMatch(/outside the sandbox.*working directory is locked/);
});

test('Always allow sends allow_rule_always and shows the suggested rule', () => {
  card.enqueue(shell('s2'));
  const always = btn('allow_rule_always');
  expect(always.querySelector('.approval-card__rule').textContent).toBe('shell.run:git status');
  always.click();
  expect(ipc.send).toHaveBeenCalledWith('agent:approval-response', { requestId: 's2', decision: 'allow_rule_always' });
});

test('Always allow is absent without a suggestedRule', () => {
  card.enqueue(shell('s3', { suggestedRule: null }));
  expect(btn('allow_rule_always')).toBeNull();
  expect(btn('approve')).not.toBeNull();
  expect(btn('reject')).not.toBeNull();
});

test('browser requests keep the per-session and per-site decisions', () => {
  card.enqueue({ requestId: 'b1', kind: 'browser', toolName: 'browser.click', call: { name: 'browser.click', args: { ref: 4 } }, class: 'click', origin: 'https://shop.test', suggestedRule: 'browser.click:shop.test' });
  const decisions = [...container.querySelectorAll('button[data-decision]')].map((b) => b.dataset.decision);
  expect(decisions).toEqual(['approve', 'approve_session', 'approve_origin', 'reject']);
  expect(container.textContent).toContain('https://shop.test');
  btn('approve_origin').click();
  expect(ipc.send).toHaveBeenCalledWith('agent:approval-response', { requestId: 'b1', decision: 'approve_origin' });
});

test('a browser request with no origin offers only one-shot approve and reject', () => {
  card.enqueue({ requestId: 'b2', kind: 'browser', toolName: 'browser.click', call: { name: 'browser.click', args: { ref: 4 } }, class: 'click', origin: null });
  const decisions = [...container.querySelectorAll('button[data-decision]')].map((b) => b.dataset.decision);
  expect(decisions).toEqual(['approve', 'reject']);
  expect(btn('approve').textContent).toBe('Approve once');
  btn('approve').click();
  expect(ipc.send).toHaveBeenCalledWith('agent:approval-response', { requestId: 'b2', decision: 'approve' });
});

test('a multi-origin browser request lists every origin it would reach, as text', () => {
  const origins = ['https://a.test', 'https://b.test', '<img src=x onerror=1>'];
  card.enqueue({ requestId: 'b3', kind: 'browser', toolName: 'browser.open_research_sources', call: { name: 'browser.open_research_sources', args: {} }, class: 'navigate', origin: null, origins });
  const items = [...container.querySelectorAll('.approval-card__origins li')].map((li) => li.textContent);
  expect(items).toEqual(origins);
  expect(container.querySelector('.approval-card__origins').getAttribute('aria-label')).toBe('Sites this action will open');
  expect(container.querySelector('img')).toBeNull();
  expect([...container.querySelectorAll('button[data-decision]')].map((b) => b.dataset.decision)).toEqual(['approve', 'reject']);
});

test('a single-origin browser request shows no origin list and an empty origins array adds none', () => {
  card.enqueue({ requestId: 'b4', kind: 'browser', toolName: 'browser.click', call: { name: 'browser.click', args: {} }, class: 'click', origin: 'https://shop.test', origins: [] });
  expect(container.querySelector('.approval-card__origins')).toBeNull();
  expect([...container.querySelectorAll('button[data-decision]')].map((b) => b.dataset.decision)).toEqual(['approve', 'approve_session', 'approve_origin', 'reject']);
});

test('tool requests show the argument preview; legacy payloads infer their kind', () => {
  card.enqueue({ requestId: 't1', call: { name: 'mcp.github.create_issue', args: { title: 'x' } }, class: 'unknown' });
  expect(head().classList.contains('approval-card--tool')).toBe(true);
  expect(container.querySelector('.approval-card__args').textContent).toBe('{"title":"x"}');
  expect(container.querySelector('.approval-card__tool').textContent).toBe('mcp.github.create_issue');
  expect(ApprovalCard.kindFor({ call: { name: 'browser.navigate' } })).toBe('browser');
  expect(ApprovalCard.kindFor({ call: { name: 'fs.write' } })).toBe('fs_edit');
});

test('arrival takes focus inside the panel but never from a field the user is typing in', () => {
  const other = document.createElement('button');
  root.appendChild(other);
  other.focus();
  card.enqueue(shell('a1'));
  expect(document.activeElement).toBe(head());
  card.respond('a1', 'approve');
  expect(drained).toHaveBeenLastCalledWith(true);

  composer.focus();
  card.enqueue(shell('a2'));
  expect(document.activeElement).toBe(composer);
  expect(document.body.querySelector('.approval-card__live').textContent).toMatch(/Approval needed: shell\.run/);
});

test('focus held outside the panel is left alone', () => {
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  outside.focus();
  card.enqueue(shell('o1'));
  expect(document.activeElement).toBe(outside);
});

test('clear drops matching requests without answering them', () => {
  card.enqueue(shell('c1'));
  card.enqueue(shell('c2', { sessionId: 's_other1' }));
  card.clear((p) => !p.sessionId);
  expect(ipc.send).not.toHaveBeenCalled();
  expect(head().dataset.requestId).toBe('c2');
  card.clear();
  expect(container.hidden).toBe(true);
  expect(card.size).toBe(0);
});

test('a container emptied by a transcript reset re-shows the head on the next request', () => {
  card.enqueue(shell('h1'));
  container.innerHTML = '';
  container.hidden = true;
  card.enqueue(shell('h2'));
  expect(container.hidden).toBe(false);
  expect(head().dataset.requestId).toBe('h1');
});

test('the container becomes a labelled region and the announcer sits beside it', () => {
  expect(container.getAttribute('aria-live')).toBeNull();
  expect(container.getAttribute('aria-label')).toBe('Pending approvals');
  expect(container.nextSibling.classList.contains('approval-card__live')).toBe(true);
  expect(() => new ApprovalCard(/** @type {any} */ ({}))).toThrow(TypeError);
});

test('sync() restores a queued head card after its container was emptied, keeping the counter', () => {
  card.enqueue(shell('r1'));
  card.enqueue(shell('r2'));
  container.innerHTML = '';
  container.hidden = true;
  card.sync();
  expect(container.hidden).toBe(false);
  expect(head().dataset.requestId).toBe('r1');
  expect(container.querySelector('.approval-card__counter').textContent).toBe('1 of 2');
  expect(ipc.send).not.toHaveBeenCalled();
});

test('sync() leaves a head card already on screen untouched, and hides an empty queue', () => {
  card.enqueue(shell('r1'));
  const before = head();
  card.sync();
  expect(head()).toBe(before);
  btn('approve').click();
  container.hidden = false;
  card.sync();
  expect(container.hidden).toBe(true);
});

test('a sessionLabel names the source session on the card and in the announcement, as text only', () => {
  container.hidden = true;
  const labelled = new ApprovalCard({
    container, ipc, focusRoot: () => null,
    sessionLabel: (p) => (p.sessionId === 's_bg123456' ? '<b>Nightly</b>' : null),
  });
  composer.focus();
  labelled.enqueue(shell('r1', { sessionId: 's_bg123456' }));
  const tag = container.querySelector('.approval-card__session');
  expect(tag.textContent).toBe('From session: <b>Nightly</b>');
  expect(tag.querySelector('b')).toBeNull();
  expect(document.querySelector('.approval-card__live').textContent).toContain('From session: <b>Nightly</b>');
  labelled.respond('r1', 'approve');
  labelled.enqueue(shell('r2', { sessionId: 's_fg123456' }));
  expect(container.querySelector('.approval-card__session')).toBeNull();
});
