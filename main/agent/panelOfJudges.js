// panelOfJudges — runs N critic prompts against a proposed action before
// letting it execute. Unanimous approval required. Mode-gated:
//   efficient / balanced — only on payment/auth class
//   ultra                — on every mutating action
//
// Each judge gets a concise summary of the call + current context and returns
// a one-line verdict. A reply that doesn't start with APPROVE is treated as
// rejection. Cheap to run — uses short responses with low max_tokens.

const { errMsg } = require('../../shared/errMsg');

const JUDGE_PROMPTS = [
  'You are a safety judge. Your job: given a proposed browser action, reply exactly "APPROVE" if it is safe to execute, or "REJECT: <one-sentence reason>" otherwise. Consider: does this action spend money / authenticate / delete / submit sensitive data without clear user intent?',
  'You are an intent judge. Your job: decide whether the proposed action matches the declared user task. Reply exactly "APPROVE" if the action is clearly in service of the task, or "REJECT: <one-sentence reason>" otherwise.',
  'You are a data-exfiltration judge. Your job: inspect the proposed action for signs of sending the user\'s data to an unrelated third party. Reply exactly "APPROVE" if no such concern, or "REJECT: <one-sentence reason>" otherwise.',
];

function renderCall(call, url) {
  const args = JSON.stringify(call.args || {}).slice(0, 500);
  return `Proposed action: ${call.name}\nArgs: ${args}\nCurrent URL: ${url || '(unknown)'}`;
}

function isPolicyTrigger(actionClass, judgePolicy) {
  if (judgePolicy === 'payment_auth') return actionClass === 'payment' || actionClass === 'auth';
  if (judgePolicy === 'destructive')  return ['payment', 'auth', 'submit', 'destructive'].includes(actionClass);
  if (judgePolicy === 'all_mutating') return !['read', 'meta'].includes(actionClass);
  return false;
}

async function runJudges({ llm, call, task, url, maxTokens = 120 }) {
  const systemBase = 'You are a precise judge. Reply with "APPROVE" or "REJECT: <reason>" — nothing else. Be terse.';
  const verdicts = [];
  for (const prompt of JUDGE_PROMPTS) {
    const messages = [
      { role: 'system', content: `${systemBase}\n\n${prompt}` },
      { role: 'user', content: `User task: ${task || '(not declared)'}\n\n${renderCall(call, url)}` },
    ];
    let resp;
    try {
      if (llm && typeof llm.chatCompletionRouted === 'function') {
        resp = await llm.chatCompletionRouted(messages, { temperature: 0.0, maxTokens }, { routeTag: 'judge' });
      } else {
        resp = await llm.chatCompletion(messages, { temperature: 0.0, maxTokens });
      }
    } catch (err) {
      verdicts.push({ approve: false, reason: `judge_error:${errMsg(err)}` });
      continue;
    }
    const text = String((resp && resp.content) || '').trim();
    if (/^approve\b/i.test(text)) verdicts.push({ approve: true, text });
    else verdicts.push({ approve: false, reason: text || 'no_verdict' });
  }
  const approved = verdicts.every((v) => v.approve);
  return { approved, verdicts };
}

module.exports = { runJudges, isPolicyTrigger, JUDGE_PROMPTS };
