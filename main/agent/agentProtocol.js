// agentProtocol — pure-string helper used by AgentService:
//   buildInitialObservation(tabs, wc, buildReadableScript) — initial observation
//     text listing all open tabs + active-tab readable excerpt

const { errMsg } = require('../../shared/errMsg');

function summarizeTab(t) {
  const name = t.name || '';
  const title = (t.title || '').slice(0, 80);
  const url = t.url || '';
  const active = t.isActive ? ' [active]' : '';
  return `  - ${t.spaceId} · ${name}${active} · ${title} · ${url}`;
}

async function buildInitialObservation(tabs, activeWc, buildReadableScript) {
  const lines = ['Open tabs:'];
  if (tabs.length === 0) lines.push('  (no registered tabs yet)');
  else tabs.forEach((t) => lines.push(summarizeTab(t)));
  lines.push('');
  lines.push('Active tab excerpt:');
  try {
    const out = await activeWc.executeJavaScript(buildReadableScript({ maxMainText: 2000 }), true);
    if (out && out.title) lines.push(`  title: ${out.title}`);
    if (out && out.url) lines.push(`  url: ${out.url}`);
    if (out && out.excerpt) lines.push(`  excerpt: ${out.excerpt}`);
    if (out && out.mainText) {
      const snippet = out.mainText.length > 1200 ? out.mainText.slice(0, 1200) + '…' : out.mainText;
      lines.push(`  preview:\n${snippet}`);
    }
  } catch (err) {
    lines.push(`  (observation failed: ${errMsg(err)})`);
  }
  return lines.join('\n');
}

module.exports = {
  buildInitialObservation,
};
