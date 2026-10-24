const { runJudges, isPolicyTrigger } = require('../../../../main/agent/panelOfJudges');

function fakeLlm(verdicts) {
  // verdicts is a sequence of strings; each chatCompletion returns the next.
  let i = 0;
  return {
    chatCompletion: async () => {
      const v = verdicts[i % verdicts.length]; i++;
      return { content: v };
    },
  };
}

describe('panelOfJudges', () => {
  test('approves only when ALL judges approve', async () => {
    const llm = fakeLlm(['APPROVE', 'APPROVE', 'APPROVE']);
    const res = await runJudges({ llm, call: { name: 'browser.click_idx', args: { idx: 1 } }, task: 'x', url: 'https://a' });
    expect(res.approved).toBe(true);
    expect(res.verdicts).toHaveLength(3);
  });

  test('rejects when any judge rejects', async () => {
    const llm = fakeLlm(['APPROVE', 'REJECT: spends money', 'APPROVE']);
    const res = await runJudges({ llm, call: { name: 'browser.click_idx', args: {} }, task: 'x', url: 'https://a' });
    expect(res.approved).toBe(false);
    expect(res.verdicts[1].approve).toBe(false);
  });

  test('fail-open reason on a blank response is captured', async () => {
    const llm = fakeLlm(['', 'APPROVE', 'APPROVE']);
    const res = await runJudges({ llm, call: { name: 'x' }, task: 't' });
    expect(res.approved).toBe(false);
  });

  test('isPolicyTrigger honours mode judge policy', () => {
    expect(isPolicyTrigger('payment', 'payment_auth')).toBe(true);
    expect(isPolicyTrigger('click', 'payment_auth')).toBe(false);
    expect(isPolicyTrigger('click', 'destructive')).toBe(false);
    expect(isPolicyTrigger('destructive', 'destructive')).toBe(true);
    expect(isPolicyTrigger('click', 'all_mutating')).toBe(true);
    expect(isPolicyTrigger('read', 'all_mutating')).toBe(false);
    expect(isPolicyTrigger('meta', 'all_mutating')).toBe(false);
  });
});
