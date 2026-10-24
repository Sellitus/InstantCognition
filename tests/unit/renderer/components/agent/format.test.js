/** @jest-environment jsdom */

// format — shared formatters for agent tool calls + results. Every
// formatDecision action branch, every formatResult branch (error
// shapes + per-action success), escapeHtml, shortName, formatCall/
// formatCallResult wiring, relTime + formatDuration thresholds.

const fmt = require('../../../../../renderer/components/agent/format');
const {
  escapeHtml, shortName, formatCall, formatCallResult,
  formatDecision, formatResult, relTime, formatDuration,
} = fmt;

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'</a>`))
      .toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
  test('null/undefined become empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
  test('numbers are stringified', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('shortName', () => {
  test('strips the prefix before the first dot', () => {
    expect(shortName('browser.click')).toBe('click');
    expect(shortName('a.b.c')).toBe('b.c');
  });
  test('returns the name unchanged when there is no dot', () => {
    expect(shortName('done')).toBe('done');
  });
  test('empty / falsy returns empty string', () => {
    expect(shortName('')).toBe('');
    expect(shortName(undefined)).toBe('');
  });
});

describe('formatDecision', () => {
  test('returns empty for missing decision or action', () => {
    expect(formatDecision(null)).toBe('');
    expect(formatDecision({})).toBe('');
  });

  test('list_tabs', () => {
    expect(formatDecision({ action: 'list_tabs' })).toBe('Listing open tabs');
  });

  test('read_tab with and without a spaceId target', () => {
    expect(formatDecision({ action: 'read_tab' })).toBe('Reading tab (active)');
    expect(formatDecision({ action: 'read_tab', spaceId: 's1' })).toBe('Reading tab (s1)');
  });

  test('screenshot_tabs lists ids or "(none)"', () => {
    expect(formatDecision({ action: 'screenshot_tabs', spaceIds: ['a', 'b'] }))
      .toBe('Viewing tabs: a, b');
    expect(formatDecision({ action: 'screenshot_tabs' })).toBe('Viewing tabs: (none)');
  });

  test('click with selector and target', () => {
    expect(formatDecision({ action: 'click', selector: '#go', spaceId: 's2' }))
      .toBe('Click #go (s2)');
    expect(formatDecision({ action: 'click' })).toBe('Click ?');
  });

  test('type truncates preview to 40 chars', () => {
    const long = 'x'.repeat(60);
    const out = formatDecision({ action: 'type', text: long, selector: '#in' });
    expect(out).toBe(`Type "${'x'.repeat(40)}" → #in`);
    expect(formatDecision({ action: 'type' })).toBe('Type "" → ?');
  });

  test('scroll defaults direction/amount', () => {
    expect(formatDecision({ action: 'scroll' })).toBe('Scroll down 400px');
    expect(formatDecision({ action: 'scroll', direction: 'up', amount: 100 }))
      .toBe('Scroll up 100px');
  });

  test('wait / navigate / extract / get_selection / press_key', () => {
    expect(formatDecision({ action: 'wait', selector: '.x' })).toBe('Wait for .x');
    expect(formatDecision({ action: 'navigate', url: 'u' })).toBe('Navigate to u');
    expect(formatDecision({ action: 'navigate' })).toBe('Navigate to ?');
    expect(formatDecision({ action: 'extract', selector: 'p' })).toBe('Extract p');
    expect(formatDecision({ action: 'get_selection' })).toBe('Get selection');
    expect(formatDecision({ action: 'press_key', key: 'Enter' })).toBe('Press Enter');
    expect(formatDecision({ action: 'press_key' })).toBe('Press ?');
  });

  test('open_tab / close_tab / focus_tab', () => {
    expect(formatDecision({ action: 'open_tab', url: 'http://x' })).toBe('Open tab: http://x');
    expect(formatDecision({ action: 'open_tab' })).toBe('Open tab: ?');
    expect(formatDecision({ action: 'close_tab', spaceId: 's' })).toBe('Close tab (s)');
    expect(formatDecision({ action: 'focus_tab' })).toBe('Focus tab');
  });

  test('done uses summary then a default', () => {
    expect(formatDecision({ action: 'done', summary: 'All set' })).toBe('All set');
    expect(formatDecision({ action: 'done' })).toBe('Done');
  });

  test('ask_user and set_plan', () => {
    expect(formatDecision({ action: 'ask_user', question: 'Why?' })).toBe('Ask user: Why?');
    expect(formatDecision({ action: 'ask_user' })).toBe('Ask user: ');
    expect(formatDecision({ action: 'set_plan', steps: ['a', 'b'] })).toBe('Plan: a → b');
    expect(formatDecision({ action: 'set_plan' })).toBe('Plan: ');
  });

  test('unknown action falls through to the raw action name', () => {
    expect(formatDecision({ action: 'mystery' })).toBe('mystery');
  });
});

describe('formatResult', () => {
  test('empty for missing decision or result', () => {
    expect(formatResult(null, {})).toBe('');
    expect(formatResult({}, null)).toBe('');
  });

  test('intra_tab_conflict and tool_timeout error shapes', () => {
    expect(formatResult({ action: 'click' }, { error: 'intra_tab_conflict' }))
      .toBe('→ rejected: intra-tab conflict (retry next turn)');
    expect(formatResult({ action: 'click' }, { error: 'tool_timeout', timeoutMs: 5000 }))
      .toBe('→ timed out after 5000ms');
  });

  test('generic failure with and without details', () => {
    expect(formatResult({ action: 'x' }, { ok: false, error: 'boom' }))
      .toBe('→ failed: boom');
    expect(formatResult({ action: 'x' }, { ok: false }))
      .toBe('→ failed: unknown');
    expect(formatResult({ action: 'x' }, { ok: false, error: 'boom', details: ['a', 'b'] }))
      .toBe('→ failed: boom (a,b)');
  });

  test('list_tabs pluralizes', () => {
    expect(formatResult({ action: 'list_tabs' }, { ok: true, tabs: ['a'] }))
      .toBe('→ 1 open tab');
    expect(formatResult({ action: 'list_tabs' }, { ok: true, tabs: ['a', 'b'] }))
      .toBe('→ 2 open tabs');
    expect(formatResult({ action: 'list_tabs' }, { ok: true }))
      .toBe('→ 0 open tabs');
  });

  test('read_tab with title and word count', () => {
    expect(formatResult({ action: 'read_tab' }, { ok: true, title: 'Doc', wordCount: 12 }))
      .toBe('→ read Doc · 12 words');
    expect(formatResult({ action: 'read_tab' }, { ok: true }))
      .toBe('→ read (untitled)');
  });

  test('screenshot_tabs pluralizes images', () => {
    expect(formatResult({ action: 'screenshot_tabs' }, { ok: true, images: [1] }))
      .toBe('→ captured 1 image');
    expect(formatResult({ action: 'screenshot_tabs' }, { ok: true, images: [1, 2] }))
      .toBe('→ captured 2 images');
    expect(formatResult({ action: 'screenshot_tabs' }, { ok: true }))
      .toBe('→ captured 0 images');
  });

  test('extract / get_selection truncate text', () => {
    const long = 'a'.repeat(200);
    expect(formatResult({ action: 'extract' }, { ok: true, text: long }))
      .toBe(`→ ${'a'.repeat(120)}`);
    expect(formatResult({ action: 'get_selection' }, { ok: true, text: long }))
      .toBe(`→ "${'a'.repeat(100)}"`);
    expect(formatResult({ action: 'extract' }, { ok: true })).toBe('→ ');
  });

  test('scroll and default action', () => {
    expect(formatResult({ action: 'scroll' }, { ok: true })).toBe('→ scrolled');
    expect(formatResult({ action: 'anything' }, { ok: true })).toBe('→ ok');
  });
});

describe('formatCall / formatCallResult', () => {
  test('formatCall maps a tool call into a decision string', () => {
    expect(formatCall({ name: 'browser.click', args: { selector: '#a' } }))
      .toBe('Click #a');
    expect(formatCall(null)).toBe('');
  });

  test('formatCallResult combines a call + result', () => {
    expect(formatCallResult(
      { name: 'browser.list_tabs', args: {} },
      { ok: true, tabs: ['x', 'y'] },
    )).toBe('→ 2 open tabs');
    expect(formatCallResult(null, {})).toBe('');
    expect(formatCallResult({ name: 'x' }, null)).toBe('');
  });
});

describe('relTime', () => {
  test('falsy / future / non-finite → empty', () => {
    expect(relTime(0)).toBe('');
    expect(relTime(Date.now() + 100000)).toBe('');
    expect(relTime('not a number')).toBe('');
  });
  test('threshold buckets: just now / m / h / d', () => {
    const now = Date.now();
    expect(relTime(now - 1000)).toBe('just now');
    expect(relTime(now - 5 * 60_000)).toBe('5m ago');
    expect(relTime(now - 3 * 3_600_000)).toBe('3h ago');
    expect(relTime(now - 2 * 86_400_000)).toBe('2d ago');
  });
  test('older than a week → a locale date string', () => {
    const old = Date.now() - 30 * 86_400_000;
    const out = relTime(old);
    expect(out).toBe(new Date(old).toLocaleDateString());
  });
});

describe('formatDuration', () => {
  test('non-finite / non-positive → empty', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(-5)).toBe('');
    expect(formatDuration(NaN)).toBe('');
  });
  test('sub-second in ms', () => {
    expect(formatDuration(450)).toBe('450ms');
  });
  test('seconds with one decimal', () => {
    expect(formatDuration(2500)).toBe('2.5s');
  });
  test('minutes + seconds', () => {
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});
