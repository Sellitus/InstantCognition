// agentProtocol — pure string helper. No external boundary; the active
// webContents is a hand-rolled fake whose executeJavaScript we control.

const { buildInitialObservation } = require('../../../../main/agent/agentProtocol');

describe('buildInitialObservation', () => {
  function wc(out, throws) {
    return {
      executeJavaScript: jest.fn(async () => {
        if (throws) throw new Error('exec boom');
        return out;
      }),
    };
  }
  const script = jest.fn(() => 'READABLE_SCRIPT');

  test('lists a placeholder line when there are no tabs', async () => {
    const text = await buildInitialObservation([], wc({ title: 'T' }), script);
    expect(text).toContain('Open tabs:');
    expect(text).toContain('(no registered tabs yet)');
  });

  test('summarizes each tab including the active marker', async () => {
    const tabs = [
      { spaceId: 's1', name: 'One', title: 'Title One', url: 'https://1', isActive: true },
      { spaceId: 's2', name: 'Two', title: '', url: '', isActive: false },
    ];
    const text = await buildInitialObservation(tabs, wc({}), script);
    expect(text).toContain('s1 · One [active] · Title One · https://1');
    expect(text).toContain('s2 · Two');
    expect(text).not.toContain('s2 · Two [active]');
  });

  test('includes title/url/excerpt and a truncated preview from the active tab', async () => {
    const longText = 'A'.repeat(1500);
    const text = await buildInitialObservation([], wc({
      title: 'Page', url: 'https://p', excerpt: 'short excerpt', mainText: longText,
    }), script);
    expect(text).toContain('title: Page');
    expect(text).toContain('url: https://p');
    expect(text).toContain('excerpt: short excerpt');
    expect(text).toContain('preview:');
    // mainText > 1200 -> truncated with an ellipsis.
    expect(text).toContain('…');
    expect(text).not.toContain(longText);
  });

  test('keeps short mainText whole (no ellipsis)', async () => {
    const text = await buildInitialObservation([], wc({ mainText: 'tiny body' }), script);
    expect(text).toContain('preview:\ntiny body');
    expect(text).not.toContain('…');
  });

  test('reports the failure inline when executeJavaScript throws', async () => {
    const text = await buildInitialObservation([], wc(null, true), script);
    expect(text).toContain('observation failed: exec boom');
  });
});
