const { alternateRoles, NO_REPLY_NOTE } = require('../../../../../main/services/llm/roleAlternation');

const roles = (msgs) => msgs.map((m) => m.role);
const toolCall = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs.list', arguments: '{}' } }] };

describe('alternateRoles', () => {
  test('an unanswered user turn followed by a new one gets a no-reply assistant note between them', () => {
    const out = alternateRoles([
      { role: 'system', content: 's' },
      { role: 'user', content: 'first, which failed' },
      { role: 'user', content: 'second' },
    ]);
    expect(roles(out)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(out[2].content).toBe(NO_REPLY_NOTE);
    expect(out[1].content).toBe('first, which failed');
    expect(out[3].content).toBe('second');
  });

  test('a user turn right after tool results (a run stopped before answering) gets the note too', () => {
    const out = alternateRoles([
      { role: 'user', content: 'go' }, toolCall, { role: 'tool', tool_call_id: 'c1', content: '{}' }, { role: 'user', content: 'next' },
    ]);
    expect(roles(out)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(out[1]).toBe(toolCall);
    expect(out[3].content).toBe(NO_REPLY_NOTE);
  });

  test('two plain assistant turns in a row merge into one', () => {
    const out = alternateRoles([
      { role: 'user', content: 'q' }, { role: 'assistant', content: 'part one' }, { role: 'assistant', content: 'part two' },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'part one\n\npart two' }]);
  });

  test('a canonical tool exchange and an alternating thread pass through untouched', () => {
    const input = [
      { role: 'system', content: 's' }, { role: 'user', content: 'go' }, toolCall,
      { role: 'tool', tool_call_id: 'c1', content: '{}' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'thanks' },
    ];
    const out = alternateRoles(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  test('assistant turns carrying non-string content are not merged', () => {
    const parts = [{ type: 'text', text: 'b' }];
    const out = alternateRoles([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'assistant', content: parts }]);
    expect(roles(out)).toEqual(['user', 'assistant', 'assistant']);
  });

  test('the caller array is never mutated', () => {
    const input = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }];
    alternateRoles(input);
    expect(input).toHaveLength(2);
  });

  test('a non-array is rejected loudly', () => {
    expect(() => alternateRoles(null)).toThrow(/array/);
  });
});
