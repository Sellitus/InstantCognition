/**
 * @jest-environment jsdom
 */

// ProjectComposer — the Projects surface in AgentPanel. The pure helpers
// (stripMentionTokens, mention-token → file-id resolution) are exercised
// directly; electron + configBridge are stubbed at the external boundary.
// jsdom gives us a real textarea + DOM events for the mention-menu wiring.

jest.mock('electron', () => ({
  ipcRenderer: {
    invoke: jest.fn(async () => ({ ok: true })),
    send: jest.fn(),
    on: jest.fn(),
  },
}));

jest.mock('../../../../../renderer/core/configBridge', () => ({
  get: jest.fn(() => null),
  set: jest.fn(),
}));

jest.mock('../../../../../renderer/components/PromptDialog', () => ({ prompt: jest.fn(async () => null) }));

const { ipcRenderer } = require('electron');
const configBridge = require('../../../../../renderer/core/configBridge');
const { prompt } = require('../../../../../renderer/components/PromptDialog');
const ProjectComposer = require('../../../../../renderer/components/agent/ProjectComposer');

// jsdom has no layout, so the mention menu's scroll-into-view call has no
// implementation to hit.
Element.prototype.scrollIntoView = function scrollIntoView() {};

function makeHostAndInput() {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  const input = document.createElement('textarea');
  document.body.appendChild(host);
  document.body.appendChild(input);
  return { host, input };
}

describe('stripMentionTokens (static)', () => {
  test('removes a single [[file:Name]] token', () => {
    expect(ProjectComposer.stripMentionTokens('see [[file:notes.txt]] please')).toBe('see please');
  });

  test('removes multiple tokens', () => {
    expect(ProjectComposer.stripMentionTokens('[[file:a.txt]] and [[file:b.md]]')).toBe('and');
  });

  test('leaves text without tokens untouched', () => {
    expect(ProjectComposer.stripMentionTokens('no mentions here')).toBe('no mentions here');
  });

  test('returns empty string for empty input', () => {
    expect(ProjectComposer.stripMentionTokens('')).toBe('');
  });

  test('handles null/undefined input', () => {
    expect(ProjectComposer.stripMentionTokens(null)).toBe('');
    expect(ProjectComposer.stripMentionTokens(undefined)).toBe('');
  });

  test('collapses double spaces left behind', () => {
    expect(ProjectComposer.stripMentionTokens('a [[file:x.txt]] b')).toBe('a b');
  });
});

describe('ProjectComposer mention resolution', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('collectAttachments returns empty text when no mentions or images', async () => {
    const { host, input } = makeHostAndInput();
    const pc = new ProjectComposer({ host, input });
    await pc.mount();
    const r = await pc.collectAttachments();
    expect(r.text).toBe('');
    expect(r.images).toEqual([]);
  });

  test('_resolveMentionedFileIds maps tokens to active-project files', async () => {
    const { host, input } = makeHostAndInput();
    // Prime the files list without a full IPC round-trip.
    const pc = new ProjectComposer({ host, input });
    await pc.mount();
    pc._activeId = 'proj_1';
    pc._files = [
      { id: 'f1', name: 'notes.txt', isImage: false },
      { id: 'f2', name: 'pic.png', isImage: true },
    ];
    input.value = 'look at [[file:notes.txt]] and also [[file:pic.png]] and [[file:missing.txt]]';
    const ids = pc._resolveMentionedFileIds();
    expect(ids).toHaveLength(2);
    expect(ids.map((x) => x.fileId).sort()).toEqual(['f1', 'f2']);
    // The missing-file token yields no entry (no such file in the project).
    expect(ids.find((x) => x.name === 'missing.txt')).toBeUndefined();
  });

  test('clearPending empties staged images', async () => {
    const { host, input } = makeHostAndInput();
    const pc = new ProjectComposer({ host, input });
    await pc.mount();
    pc._pendingImages = [{ projectId: 'p', fileId: 'f', name: 'x.png' }];
    pc.clearPending();
    expect(pc._pendingImages).toEqual([]);
  });

  test('getActiveProjectId returns the active id', async () => {
    const { host, input } = makeHostAndInput();
    const pc = new ProjectComposer({ host, input });
    await pc.mount();
    pc._activeId = 'proj_42';
    expect(pc.getActiveProjectId()).toBe('proj_42');
  });
});

describe('ProjectComposer mount wiring', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('renders the project bar into the host', async () => {
    const { host, input } = makeHostAndInput();
    const pc = new ProjectComposer({ host, input });
    await pc.mount();
    expect(host.querySelector('.proj-bar-selector')).toBeTruthy();
    expect(host.querySelector('.proj-bar-attach')).toBeTruthy();
    expect(host.querySelector('.proj-bar-shot')).toBeTruthy();
  });

  test('a failed upload tells the user instead of only logging', async () => {
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, projects: [{ id: 'p1', name: 'First' }] });
    const pc = new ProjectComposer({ host, input });
    await pc.mount();

    ipcRenderer.invoke.mockRejectedValue(new Error('disk full'));
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    expect(await pc._uploadFile('p1', file)).toBeNull();
    expect(host.querySelector('.proj-bar-hint').textContent).toBe('Upload failed: notes.txt');
  });

  test('a rejected create surfaces the failure in the bar hint', async () => {
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, projects: [] });
    const pc = new ProjectComposer({ host, input });
    await pc.mount();

    ipcRenderer.invoke.mockRejectedValue(new Error('no space left'));
    expect(await pc._ensureProject()).toBeNull();
    expect(host.querySelector('.proj-bar-hint').textContent).toBe('Could not create project: no space left');
  });

  test('loads projects on mount via projects:list', async () => {
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, projects: [{ id: 'p1', name: 'First', fileCount: 2 }] });
    const pc = new ProjectComposer({ host, input });
    await pc.mount();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('projects:list');
    expect(pc.getActiveProjectId()).toBe('p1');
    expect(host.querySelector('.proj-bar-name').textContent).toBe('First');
  });

  test('a failed projects:list leaves the bar in its no-project state', async () => {
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockRejectedValue(new Error('ipc down'));
    const pc = new ProjectComposer({ host, input });
    await pc.mount();
    expect(pc.getActiveProjectId()).toBeNull();
    expect(host.querySelector('.proj-bar-name').textContent).toBe('No project');
    // Upload buttons are meaningless with no project to upload into.
    expect(host.querySelector('.proj-bar-attach').hidden).toBe(true);
    expect(host.querySelector('.proj-bar-shot').hidden).toBe(true);
  });

  test('the persisted lastActiveId wins over the first project', async () => {
    const { host, input } = makeHostAndInput();
    configBridge.get.mockReturnValue('p2');
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:list'
        ? { ok: true, projects: [{ id: 'p1', name: 'First' }, { id: 'p2', name: 'Second' }] }
        : { ok: true, files: [] }
    ));
    const pc = new ProjectComposer({ host, input });
    await pc.mount();
    expect(pc.getActiveProjectId()).toBe('p2');
  });

  test('a stale lastActiveId falls back to the first project', async () => {
    const { host, input } = makeHostAndInput();
    configBridge.get.mockReturnValue('deleted-project');
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:list'
        ? { ok: true, projects: [{ id: 'p1', name: 'First' }] }
        : { ok: true, files: [] }
    ));
    const pc = new ProjectComposer({ host, input });
    await pc.mount();
    expect(pc.getActiveProjectId()).toBe('p1');
  });
});

describe('ProjectComposer project menu', () => {
  beforeEach(() => { jest.clearAllMocks(); configBridge.get.mockReturnValue(null); });

  test('the selector lists every project and switching persists the choice', async () => {
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:list'
        ? { ok: true, projects: [{ id: 'p1', name: 'First' }, { id: 'p2', name: 'Second', fileCount: 3 }] }
        : { ok: true, files: [] }
    ));
    const pc = new ProjectComposer({ host, input });
    await pc.mount();

    host.querySelector('.proj-bar-selector').click();
    const items = Array.from(host.querySelectorAll('.proj-menu-item:not(.proj-menu-create)'));
    expect(items.map((i) => i.textContent)).toEqual(['First', 'Second  (3)']);

    items[1].click();
    await Promise.resolve();
    await Promise.resolve();

    expect(pc.getActiveProjectId()).toBe('p2');
    expect(configBridge.set).toHaveBeenCalledWith('settings.projects.lastActiveId', 'p2');
    expect(host.querySelector('.proj-menu')).toBeNull();
  });

  test('with no projects the menu says so instead of rendering an empty list', async () => {
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, projects: [] });
    const pc = new ProjectComposer({ host, input });
    await pc.mount();

    host.querySelector('.proj-bar-selector').click();
    expect(host.querySelector('.proj-menu-empty')).toBeTruthy();
    // "New project…" stays available — it is the way out of the empty state.
    expect(host.querySelector('.proj-menu-create')).toBeTruthy();
  });

  test('a second click on the selector closes the menu', async () => {
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, projects: [] });
    const pc = new ProjectComposer({ host, input });
    await pc.mount();

    const selector = host.querySelector('.proj-bar-selector');
    selector.click();
    expect(host.querySelector('.proj-menu')).toBeTruthy();
    selector.click();
    expect(host.querySelector('.proj-menu')).toBeNull();
  });

  test('creating a project from the menu activates it', async () => {
    prompt.mockResolvedValue('  Research  ');
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockImplementation(async (channel, arg) => {
      if (channel === 'projects:create') return { ok: true, project: { id: 'p9' } };
      if (channel === 'projects:list') {
        return { ok: true, projects: arg === undefined && ipcRenderer.invoke.mock.calls.some((c) => c[0] === 'projects:create')
          ? [{ id: 'p9', name: 'Research' }]
          : [] };
      }
      return { ok: true, files: [] };
    });
    const pc = new ProjectComposer({ host, input });
    await pc.mount();

    await pc._createProject();

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('projects:create', { name: 'Research' });
    expect(pc.getActiveProjectId()).toBe('p9');
  });

  test('a cancelled name prompt creates nothing', async () => {
    prompt.mockResolvedValue(null);
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, projects: [] });
    const pc = new ProjectComposer({ host, input });
    await pc.mount();

    await pc._createProject();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('projects:create', expect.anything());
  });

  test('a refused create surfaces the service error in the hint', async () => {
    prompt.mockResolvedValue('Research');
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:create' ? { ok: false, error: 'name_taken' } : { ok: true, projects: [] }
    ));
    const pc = new ProjectComposer({ host, input });
    await pc.mount();

    await pc._createProject();
    expect(host.querySelector('.proj-bar-hint').textContent).toBe('Could not create project: name_taken');
  });
});

describe('ProjectComposer @-mention autocomplete', () => {
  /** Mount with one project and two files already loaded. */
  async function mountWithFiles(files) {
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:list'
        ? { ok: true, projects: [{ id: 'p1', name: 'First' }] }
        : { ok: true, files }
    ));
    const pc = new ProjectComposer({ host, input });
    await pc.mount();
    return { pc, host, input };
  }

  const FILES = [
    { id: 'f1', name: 'notes.txt', isImage: false },
    { id: 'f2', name: 'diagram.png', isImage: true },
  ];

  beforeEach(() => { jest.clearAllMocks(); configBridge.get.mockReturnValue(null); });

  function type(input, value) {
    input.value = value;
    input.selectionStart = value.length;
    input.dispatchEvent(new Event('input'));
  }

  test('typing @ lists the project files', async () => {
    const { input } = await mountWithFiles(FILES);
    type(input, 'see @');
    const items = Array.from(document.querySelectorAll('.proj-mention-item'));
    expect(items.map((i) => i.dataset.fileName)).toEqual(['notes.txt', 'diagram.png']);
  });

  test('mention items carry a file/image icon and the bare file name', async () => {
    const { input } = await mountWithFiles(FILES);
    type(input, 'see @');
    const items = Array.from(document.querySelectorAll('.proj-mention-item'));
    expect(items.map((i) => i.querySelector('.proj-mention-name').textContent)).toEqual(['notes.txt', 'diagram.png']);
    expect(items.map((i) => i.textContent)).toEqual(['notes.txt', 'diagram.png']);
    items.forEach((i) => expect(i.querySelector('.proj-mention-icon svg')).not.toBeNull());
    // The project bar uses icon glyphs, not emoji.
    const bar = document.querySelector('.proj-bar');
    expect(bar.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(bar.querySelector('.proj-bar-shot svg')).not.toBeNull();
  });

  test('the query filters the list and an unmatched query closes it', async () => {
    const { input } = await mountWithFiles(FILES);
    type(input, 'see @diag');
    expect(document.querySelectorAll('.proj-mention-item')).toHaveLength(1);
    type(input, 'see @zzz');
    expect(document.querySelector('.proj-mention-menu')).toBeNull();
  });

  test('an @ inside an email address is not a mention', async () => {
    const { input } = await mountWithFiles(FILES);
    type(input, 'mail me at someone@');
    expect(document.querySelector('.proj-mention-menu')).toBeNull();
  });

  test('with no files there is nothing to mention', async () => {
    const { input } = await mountWithFiles([]);
    type(input, '@');
    expect(document.querySelector('.proj-mention-menu')).toBeNull();
  });

  test('picking a file replaces the @query with a [[file:…]] token', async () => {
    const { pc, input } = await mountWithFiles(FILES);
    type(input, 'summarise @not');
    const item = document.querySelector('.proj-mention-item');
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));

    expect(input.value).toBe('summarise [[file:notes.txt]] ');
    expect(document.querySelector('.proj-mention-menu')).toBeNull();
    // The token now resolves back to the file id the send path needs.
    expect(pc._resolveMentionedFileIds()).toEqual([{ projectId: 'p1', fileId: 'f1', name: 'notes.txt' }]);
  });

  test('arrows move the selection and Enter picks it', async () => {
    const { input } = await mountWithFiles(FILES);
    type(input, '@');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.querySelector('.proj-mention-item.is-selected').dataset.fileName).toBe('diagram.png');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.value).toBe('[[file:diagram.png]] ');
  });

  test('ArrowUp from the top wraps to the last file', async () => {
    const { input } = await mountWithFiles(FILES);
    type(input, '@');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.querySelector('.proj-mention-item.is-selected').dataset.fileName).toBe('diagram.png');
  });

  test('Escape closes the menu without inserting anything', async () => {
    const { input } = await mountWithFiles(FILES);
    type(input, 'hello @');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.proj-mention-menu')).toBeNull();
    expect(input.value).toBe('hello @');
  });
});

describe('ProjectComposer attachments and uploads', () => {
  beforeEach(() => { jest.clearAllMocks(); configBridge.get.mockReturnValue(null); });

  async function mountActive(files = []) {
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:list'
        ? { ok: true, projects: [{ id: 'p1', name: 'First' }] }
        : { ok: true, files }
    ));
    const pc = new ProjectComposer({ host, input });
    await pc.mount();
    return { pc, host, input };
  }

  test('collectAttachments inlines mentioned file text and image data URLs', async () => {
    const files = [
      { id: 'f1', name: 'notes.txt', isImage: false },
      { id: 'f2', name: 'diagram.png', isImage: true },
    ];
    const { pc, input } = await mountActive(files);
    input.value = '[[file:notes.txt]] and [[file:diagram.png]]';

    ipcRenderer.invoke.mockImplementation(async (channel, arg) => {
      if (channel !== 'projects:read') return { ok: true, files };
      return arg.fileId === 'f1'
        ? { ok: true, file: files[0], text: 'body text' }
        : { ok: true, file: files[1], dataUrl: 'data:image/png;base64,AAA' };
    });

    const r = await pc.collectAttachments();
    expect(r.text).toBe('--- File: notes.txt ---\nbody text');
    expect(r.images).toEqual([{ name: 'diagram.png', dataUrl: 'data:image/png;base64,AAA' }]);
  });

  test('a long file is truncated so one attachment cannot blow the context', async () => {
    const files = [{ id: 'f1', name: 'big.txt', isImage: false }];
    const { pc, input } = await mountActive(files);
    input.value = '[[file:big.txt]]';
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:read' ? { ok: true, file: files[0], text: 'x'.repeat(20000) } : { ok: true, files }
    ));

    const r = await pc.collectAttachments();
    expect(r.text).toContain('…[truncated]');
    expect(r.text.length).toBeLessThan(12100);
  });

  test('an image with no data URL degrades to a text note rather than vanishing', async () => {
    const files = [{ id: 'f2', name: 'diagram.png', isImage: true }];
    const { pc, input } = await mountActive(files);
    input.value = '[[file:diagram.png]]';
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:read' ? { ok: true, file: files[0], dataUrl: null } : { ok: true, files }
    ));

    const r = await pc.collectAttachments();
    expect(r.text).toBe('--- Image: diagram.png (in project) ---');
    expect(r.images).toEqual([]);
  });

  test('a failed read is skipped instead of blocking the send', async () => {
    const files = [
      { id: 'f1', name: 'notes.txt', isImage: false },
      { id: 'f3', name: 'gone.txt', isImage: false },
    ];
    const { pc, input } = await mountActive(files);
    input.value = '[[file:gone.txt]] [[file:notes.txt]]';
    ipcRenderer.invoke.mockImplementation(async (channel, arg) => {
      if (channel !== 'projects:read') return { ok: true, files };
      if (arg.fileId === 'f3') throw new Error('read failed');
      return { ok: true, file: files[0], text: 'body text' };
    });

    const r = await pc.collectAttachments();
    expect(r.text).toBe('--- File: notes.txt ---\nbody text');
  });

  test('a pasted image is staged once and not duplicated by its mention', async () => {
    const files = [{ id: 'f2', name: 'diagram.png', isImage: true }];
    const { pc, input } = await mountActive(files);
    input.value = '[[file:diagram.png]]';
    pc._pendingImages = [{ projectId: 'p1', fileId: 'f2', name: 'diagram.png' }];
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:read' ? { ok: true, file: files[0], dataUrl: 'data:image/png;base64,AAA' } : { ok: true, files }
    ));

    const r = await pc.collectAttachments();
    expect(r.images).toHaveLength(1);
  });

  test('screenshotting the page refreshes the file list and reports success', async () => {
    const { pc, host } = await mountActive([]);
    const calls = [];
    ipcRenderer.invoke.mockImplementation(async (channel, arg) => {
      calls.push(channel);
      if (channel === 'projects:screenshotActive') return { ok: true };
      return { ok: true, files: [{ id: 'f9', name: 'page.png', isImage: true }] };
    });

    await pc._capturePage();

    expect(calls).toContain('projects:screenshotActive');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('projects:screenshotActive', { id: 'p1' });
    expect(pc._files).toHaveLength(1);
    expect(host.querySelector('.proj-bar-hint').textContent).toBe('Page screenshot added');
  });

  test('screenshotting with no project asks for one instead of failing silently', async () => {
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, projects: [] });
    const pc = new ProjectComposer({ host, input });
    await pc.mount();

    await pc._capturePage();

    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('projects:screenshotActive', expect.anything());
    expect(host.querySelector('.proj-bar-hint').textContent).toBe('Select or create a project first');
  });

  test('a refused screenshot surfaces the reason', async () => {
    const { pc, host } = await mountActive([]);
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:screenshotActive' ? { ok: false, error: 'no_active_tab' } : { ok: true, files: [] }
    ));

    await pc._capturePage();
    expect(host.querySelector('.proj-bar-hint').textContent).toBe('Screenshot failed: no_active_tab');
  });

  test('an ok:false upload reply still reports failure', async () => {
    const { pc, host } = await mountActive([]);
    ipcRenderer.invoke.mockResolvedValue({ ok: false, error: 'too_big' });
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    expect(await pc._uploadFile('p1', file)).toBeNull();
    expect(host.querySelector('.proj-bar-hint').textContent).toBe('Upload failed: notes.txt');
  });

  test('an uploaded image is staged for the next message', async () => {
    const { pc } = await mountActive([]);
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:addImage' ? { ok: true, file: { id: 'f7', name: 'shot.png' } } : { ok: true, files: [] }
    ));
    const img = new File(['bytes'], 'shot.png', { type: 'image/png' });

    const added = await pc._uploadFile('p1', img);

    expect(added).toEqual({ id: 'f7', name: 'shot.png' });
    expect(pc._pendingImages).toEqual([{ projectId: 'p1', fileId: 'f7', name: 'shot.png' }]);
  });

  test('dropping files uploads them into the active project', async () => {
    const { pc, host, input } = await mountActive([]);
    const uploaded = [];
    ipcRenderer.invoke.mockImplementation(async (channel, arg) => {
      if (channel === 'projects:addFile') { uploaded.push(arg.name); return { ok: true, file: { id: 'f' + uploaded.length } }; }
      return { ok: true, files: [] };
    });

    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: [new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['b'], 'b.txt', { type: 'text/plain' })] },
    });
    input.dispatchEvent(event);
    await pc.whenSettled();

    expect(uploaded).toEqual(['a.txt', 'b.txt']);
    expect(host.querySelector('.proj-bar-hint').textContent).toBe('2 files added');
    expect(pc.getActiveProjectId()).toBe('p1');
  });

  test('a drop with no files is ignored', async () => {
    const { pc, input } = await mountActive([]);
    ipcRenderer.invoke.mockClear();

    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [] } });
    input.dispatchEvent(event);
    await pc.whenSettled();

    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  test('pasting an image uploads it; pasting text does not', async () => {
    const { pc, host, input } = await mountActive([]);
    ipcRenderer.invoke.mockImplementation(async (channel) => (
      channel === 'projects:addImage' ? { ok: true, file: { id: 'f5', name: 'clip.png' } } : { ok: true, files: [] }
    ));

    const imgFile = new File(['bytes'], 'clip.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/png', getAsFile: () => imgFile }] },
    });
    input.dispatchEvent(paste);
    await pc.whenSettled();

    expect(host.querySelector('.proj-bar-hint').textContent).toBe('1 image pasted');
    // Staged once by the upload path — the paste path must not double-add it.
    expect(pc._pendingImages).toEqual([{ projectId: 'p1', fileId: 'f5', name: 'clip.png' }]);

    ipcRenderer.invoke.mockClear();
    const textPaste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(textPaste, 'clipboardData', { value: { items: [{ kind: 'string', type: 'text/plain' }] } });
    input.dispatchEvent(textPaste);
    await pc.whenSettled();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  test('uploading with no project creates the Uploads project first', async () => {
    const { host, input } = makeHostAndInput();
    ipcRenderer.invoke.mockResolvedValue({ ok: true, projects: [] });
    const pc = new ProjectComposer({ host, input });
    await pc.mount();

    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'projects:create') return { ok: true, project: { id: 'up1' } };
      if (channel === 'projects:list') return { ok: true, projects: [{ id: 'up1', name: 'Uploads' }] };
      return { ok: true, files: [] };
    });

    expect(await pc._ensureProject()).toBe('up1');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('projects:create', { name: 'Uploads' });
  });
});
