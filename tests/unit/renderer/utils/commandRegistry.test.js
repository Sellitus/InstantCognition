const { getCommands, fuzzyScore, filterAndRank } = require('../../../../renderer/utils/commandRegistry');

describe('commandRegistry', () => {
  describe('fuzzyScore', () => {
    test('returns 0 for empty query', () => {
      expect(fuzzyScore('', 'anything')).toBe(0);
    });

    test('returns -1 for no haystack', () => {
      expect(fuzzyScore('foo', '')).toBe(-1);
      expect(fuzzyScore('foo', null)).toBe(-1);
    });

    test('prefix match scores highest', () => {
      const prefix = fuzzyScore('zoom', 'zoom in');
      const middle = fuzzyScore('zoom', 'reset zoom level');
      expect(prefix).toBeGreaterThan(middle);
    });

    test('returns -1 when characters are missing', () => {
      expect(fuzzyScore('xyz', 'reload page')).toBe(-1);
    });

    test('returns positive score when characters appear in order', () => {
      expect(fuzzyScore('rl', 'reload')).toBeGreaterThan(0);
    });

    test('is case-insensitive', () => {
      expect(fuzzyScore('ZOOM', 'zoom in')).toBeGreaterThan(0);
      expect(fuzzyScore('zoom', 'ZOOM IN')).toBeGreaterThan(0);
    });
  });

  describe('filterAndRank', () => {
    const cmds = [
      { id: 'a', title: 'Zoom In', keywords: 'zoom in larger' },
      { id: 'b', title: 'Zoom Out', keywords: 'zoom out smaller' },
      { id: 'c', title: 'Reload', keywords: 'reload refresh page' },
      { id: 'd', title: 'Find in Page', keywords: 'find search' },
    ];

    test('empty query returns all commands', () => {
      const out = filterAndRank(cmds, '');
      expect(out).toHaveLength(4);
    });

    test('filters out non-matching commands', () => {
      const out = filterAndRank(cmds, 'zoom');
      expect(out.map((c) => c.id).sort()).toEqual(['a', 'b']);
    });

    test('ranks prefix matches first', () => {
      const out = filterAndRank(cmds, 'reload');
      expect(out[0].id).toBe('c');
    });

    test('matches against keywords field', () => {
      const out = filterAndRank(cmds, 'search');
      expect(out[0].id).toBe('d');
    });

    test('returns empty array when nothing matches', () => {
      const out = filterAndRank(cmds, 'qqqqqq');
      expect(out).toHaveLength(0);
    });
  });

  describe('getCommands', () => {
    test('returns built-in action commands when context is empty', () => {
      const out = getCommands({});
      expect(out.length).toBeGreaterThan(0);
      expect(out.some((c) => c.type === 'action')).toBe(true);
    });

    test('returns space commands when spaces are provided', () => {
      const ctx = {
        spaces: {
          custom1: { name: 'ChatGPT', url: 'https://chat.openai.com', type: 'ai-service' },
          'llm-chat': { name: 'Local LLM', url: 'ic://llm-chat/', type: 'local-llm' },
        },
        spaceManager: { select: jest.fn() },
      };
      const out = getCommands(ctx);
      const spaceCmds = out.filter((c) => c.type === 'space');
      expect(spaceCmds).toHaveLength(2);
      expect(spaceCmds.map((c) => c.title)).toContain('ChatGPT');
      expect(spaceCmds.map((c) => c.title)).toContain('Local LLM');
    });

    test('space commands invoke spaceManager.select with correct id', () => {
      const select = jest.fn();
      const ctx = {
        spaces: { custom1: { name: 'GPT', url: 'https://x', type: 'ai-service' } },
        spaceManager: { select },
      };
      const out = getCommands(ctx);
      const cmd = out.find((c) => c.id === 'space:custom1');
      expect(cmd).toBeTruthy();
      cmd.action();
      expect(select).toHaveBeenCalledWith('custom1');
    });

    test('action commands have keywords for searching', () => {
      const out = getCommands({});
      out.filter((c) => c.type === 'action').forEach((c) => {
        expect(typeof c.keywords).toBe('string');
        expect(c.keywords.length).toBeGreaterThan(0);
      });
    });

    test('action commands do not throw when managers are undefined', () => {
      const out = getCommands({});
      out.filter((c) => c.type === 'action').forEach((c) => {
        expect(() => c.action()).not.toThrow();
      });
    });
  });

  describe('action command wiring (truthy arms)', () => {
    function run(ctx, id) {
      const cmd = getCommands(ctx).find((c) => c.id === id);
      expect(cmd).toBeTruthy();
      cmd.action();
      return cmd;
    }

    test.each([
      ['action:navigate.back', 'navigationManager', 'back'],
      ['action:navigate.forward', 'navigationManager', 'forward'],
      ['action:navigate.refresh', 'navigationManager', 'refresh'],
      ['action:navigate.home', 'navigationManager', 'home'],
      ['action:zoom.in', 'navigationManager', 'zoomIn'],
      ['action:zoom.out', 'navigationManager', 'zoomOut'],
      ['action:zoom.reset', 'navigationManager', 'zoomReset'],
      ['action:find.toggle', 'findBarManager', 'toggle'],
      ['action:view.multiSpace', 'spaceManager', 'toggleMulti'],
      ['action:view.browser', 'browserViewManager', 'toggle'],
      ['action:view.space', 'browserViewManager', 'toggleSpace'],
      ['action:view.flip', 'viewShell', 'flip'],
      ['action:panel.agent', 'agentPanel', 'toggle'],
      ['action:panel.library', 'libraryWindow', 'open'],
      ['action:panel.extensions', 'libraryWindow', 'open'],
      ['action:panel.notifications', 'libraryWindow', 'open'],
      ['action:notifications.clearAll', 'libraryWindow', 'clearAll'],
      ['action:notifications.markAllRead', 'libraryWindow', 'markAllRead'],
      ['action:council.convene', 'agentPanel', 'openChat'],
      ['action:research.report', 'agentPanel', 'openChat'],
      ['action:tab.new', 'newTabPicker', 'open'],
      ['action:tab.close', 'spaceManager', 'close'],
      ['action:tab.next', 'spaceManager', 'next'],
      ['action:tab.previous', 'spaceManager', 'previous'],
      ['action:reader.open', 'readerView', 'open'],
    ])('%s invokes %s.%s when present', (id, manager, method) => {
      const fn = jest.fn();
      run({ [manager]: { [method]: fn } }, id);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('layout commands pass the correct layout name', () => {
      const setLayout = jest.fn();
      run({ layoutManager: { setLayout } }, 'action:layout.sideBySide');
      expect(setLayout).toHaveBeenLastCalledWith('sideBySide');
      run({ layoutManager: { setLayout } }, 'action:layout.grid');
      expect(setLayout).toHaveBeenLastCalledWith('grid');
      run({ layoutManager: { setLayout } }, 'action:layout.stacked');
      expect(setLayout).toHaveBeenLastCalledWith('stacked');
    });

    test.each([
      ['action:settings.open', 'openSettings'],
      ['action:window.toggle', 'toggleWindow'],
      ['action:layout.cycle', 'cycleLayout'],
      ['action:links.external', 'toggleOpenLinkExternal'],
      ['action:bookmark.toggle', 'bookmarkPage'],
    ])('%s invokes the bare ctx fn %s', (id, fnName) => {
      const fn = jest.fn();
      run({ [fnName]: fn }, id);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('manager present but method missing does not throw (middle arm false)', () => {
      const out = getCommands({ navigationManager: {}, spaceManager: {}, layoutManager: {}, browserViewManager: {}, viewShell: {} });
      ['action:navigate.back', 'action:tab.close', 'action:layout.grid', 'action:view.space', 'action:view.flip',
        'action:layout.cycle', 'action:links.external', 'action:bookmark.toggle'].forEach((id) => {
        const cmd = out.find((c) => c.id === id);
        expect(() => cmd.action()).not.toThrow();
      });
    });
  });

  describe('_spaceCommands branch coverage', () => {
    test('returns [] when ctx is null', () => {
      expect(getCommands(null).filter((c) => c.type === 'space')).toHaveLength(0);
    });

    test('returns [] when ctx has no spaces', () => {
      expect(getCommands({}).filter((c) => c.type === 'space')).toHaveLength(0);
    });

    test('skips falsy space entries', () => {
      const out = getCommands({ spaces: { a: null, b: { name: 'B', url: 'u', type: 'ai-service' } } });
      const spaceCmds = out.filter((c) => c.type === 'space');
      expect(spaceCmds).toHaveLength(1);
      expect(spaceCmds[0].id).toBe('space:b');
    });

    test('falls back to id for title and empty subtitle when name/url absent', () => {
      const out = getCommands({ spaces: { onlyid: { type: 'ai-service' } } });
      const cmd = out.find((c) => c.id === 'space:onlyid');
      expect(cmd.title).toBe('onlyid');
      expect(cmd.subtitle).toBe('');
    });

    test('web-page type yields Web icon, ai-service yields AI icon', () => {
      const out = getCommands({
        spaces: {
          w: { name: 'W', url: 'u', type: 'web-page' },
          a: { name: 'A', url: 'u', type: 'ai-service' },
          l: { name: 'L', url: 'u', type: 'local-llm' },
        },
      });
      expect(out.find((c) => c.id === 'space:w').icon).toBe('Web');
      expect(out.find((c) => c.id === 'space:a').icon).toBe('AI');
      expect(out.find((c) => c.id === 'space:l').icon).toBe('Local');
    });

    test('space action no-ops when spaceManager absent', () => {
      const out = getCommands({ spaces: { x: { name: 'X', url: 'u', type: 'ai-service' } } });
      const cmd = out.find((c) => c.id === 'space:x');
      expect(() => cmd.action()).not.toThrow();
    });
  });

  describe('filterAndRank keyword fallback', () => {
    test('handles commands with missing keywords field', () => {
      const cmds = [
        { id: 'a', title: 'Zoom In' }, // no keywords -> exercises `cmd.keywords || ''`
        { id: 'b', title: 'Reload', keywords: 'refresh' },
      ];
      const out = filterAndRank(cmds, 'zoom');
      expect(out.map((c) => c.id)).toEqual(['a']);
    });

    test('keyword-only match still ranks below an absent title hit', () => {
      const cmds = [
        { id: 'a', title: 'Reload', keywords: 'refresh page' },
        { id: 'b', title: 'Zoom', keywords: '' },
      ];
      // 'refresh' only matches via keywords (titleScore -1), still surfaces.
      const out = filterAndRank(cmds, 'refresh');
      expect(out.map((c) => c.id)).toEqual(['a']);
    });
  });

  describe('Page Copilot + AI Council commands', () => {
    function find(ctx, id) {
      const cmd = getCommands(ctx).find((c) => c.id === id);
      expect(cmd).toBeTruthy();
      return cmd;
    }

    test('council.convene opens the unified chat seeded with /council', () => {
      const openChat = jest.fn();
      find({ agentPanel: { openChat } }, 'action:council.convene').action();
      expect(openChat).toHaveBeenCalledWith({ prefill: '/council ' });
    });

    test('research.report opens the unified chat seeded with /research', () => {
      const openChat = jest.fn();
      find({ agentPanel: { openChat } }, 'action:research.report').action();
      expect(openChat).toHaveBeenCalledWith({ prefill: '/research ' });
    });

    test('chat-routed commands no-op (no throw) when agentPanel is absent', () => {
      const ids = [
        'action:copilot.summarize', 'action:copilot.ask',
        'action:copilot.explain', 'action:copilot.compare',
        'action:council.convene', 'action:research.report',
      ];
      ids.forEach((id) => expect(() => find({}, id).action()).not.toThrow());
    });

    test('the council command is discoverable by broadcast, consolidation and synthesis language', () => {
      // One command now owns every phrasing the three duplicates used to split.
      for (const query of ['consolidate answers', 'ask all spaces', 'broadcast']) {
        expect(filterAndRank(getCommands({}), query)[0].id).toBe('action:council.convene');
      }
      const mergeOut = filterAndRank(getCommands({}), 'merge responses');
      expect(mergeOut.some((cmd) => cmd.id === 'action:council.convene')).toBe(true);
    });

    test.each([
      ['action:copilot.summarize', 'summarize'],
      ['action:copilot.explain', 'explain'],
      ['action:copilot.compare', 'compare'],
    ])('%s routes to the unified chat slash-action when agentPanel is present', (id, slash) => {
      const openChatAction = jest.fn();
      const pageOpen = jest.fn();
      find({ agentPanel: { openChatAction, openChat: jest.fn() }, pageCopilot: { open: pageOpen } }, id).action();
      expect(openChatAction).toHaveBeenCalledWith(slash);
      expect(pageOpen).not.toHaveBeenCalled();
    });

    test('action:copilot.ask opens the unified chat with the page attached', () => {
      const openChat = jest.fn();
      const pageOpen = jest.fn();
      find({ agentPanel: { openChat, openChatAction: jest.fn() }, pageCopilot: { open: pageOpen } }, 'action:copilot.ask').action();
      expect(openChat).toHaveBeenCalledWith({ context: 'page' });
      expect(pageOpen).not.toHaveBeenCalled();
    });
  });
});

describe('tab recovery commands', () => {
  function find(ctx, id) {
    return getCommands(ctx).find((c) => c.id === id);
  }

  test.each([
    ['action:tab.reopenClosed', 'Reopen Closed Tab', 'reopenClosedTab'],
    ['action:tab.newPrivate', 'New Private Tab', 'openPrivateTab'],
  ])('%s (%s) calls spaceManager.%s with no arguments', (id, title, method) => {
    const fn = jest.fn();
    const cmd = find({ spaceManager: { [method]: fn } }, id);
    expect(cmd.title).toBe(title);
    cmd.action();
    expect(fn).toHaveBeenCalledWith();
  });

  test('they are found by palette search and do nothing without a space manager', () => {
    const commands = getCommands({});
    expect(filterAndRank(commands, 'reopen')[0].id).toBe('action:tab.reopenClosed');
    expect(filterAndRank(commands, 'private')[0].id).toBe('action:tab.newPrivate');
    expect(() => find({}, 'action:tab.reopenClosed').action()).not.toThrow();
    expect(() => find({ spaceManager: {} }, 'action:tab.newPrivate').action()).not.toThrow();
  });
});
