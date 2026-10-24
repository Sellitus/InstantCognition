const {
  stripThink,
  stripSpecialTokens,
  softenJson,
  extractToolCalls,
  looksLikeToolCall,
  parseHermesToolCalls,
  parseLlamaXmlToolCalls,
  parseLlamaPythonTagToolCalls,
  parseMistralToolCalls,
  parseClaudeInvokeToolCalls,
  parseDeepseekToolCalls,
  parseReActToolCalls,
  parseFencedJsonToolCalls,
  parseRawJsonToolCalls,
  parseCallSyntaxToolCalls,
  parseHarmonyToolCalls,
  parseFunctoolsToolCalls,
  parsePythonicToolCalls,
  normalizeName,
} = require('../../../../main/agent/responseParsers');

describe('stripThink', () => {
  test('removes <think>…</think>', () => {
    expect(stripThink('<think>inner</think>after')).toBe('after');
  });
  test('removes <thinking>…</thinking>', () => {
    expect(stripThink('<thinking>plan</thinking>{"x":1}')).toBe('{"x":1}');
  });
  test('removes <reasoning>…</reasoning>', () => {
    expect(stripThink('<reasoning>step</reasoning>hi')).toBe('hi');
  });
  test('removes <reflection>…</reflection>', () => {
    expect(stripThink('<reflection>r</reflection>hi')).toBe('hi');
  });
  test('removes <scratchpad>…</scratchpad>', () => {
    expect(stripThink('<scratchpad>s</scratchpad>hi')).toBe('hi');
  });
  test('removes [THINK]…[/THINK]', () => {
    expect(stripThink('[THINK]t[/THINK]hi')).toBe('hi');
  });
  test('removes Qwen <|im_start|>think … <|im_end|>', () => {
    expect(stripThink('<|im_start|>think\nreasoning\n<|im_end|>hi')).toBe('hi');
  });
  test('removes GPT-style analysis channel', () => {
    expect(stripThink('<|channel|>analysis<|message|>internal<|end|>hi')).toBe('hi');
  });
  test('removes multiple thinking blocks', () => {
    expect(stripThink('<think>a</think>mid<thinking>b</thinking>end')).toBe('midend');
  });
  test('empty string returns empty', () => {
    expect(stripThink('')).toBe('');
  });
  test('strips orphan </think> when no opening <think> was emitted', () => {
    const input = 'I have read 5 subreddits. I will now finish.</think>\n\n{"tool":"agent.done","args":{"summary":"hi"}}';
    expect(stripThink(input)).toBe('{"tool":"agent.done","args":{"summary":"hi"}}');
  });
  test('strips orphan </thinking> close tag', () => {
    expect(stripThink('reasoning prose</thinking>{"x":1}')).toBe('{"x":1}');
  });
  test('does not double-strip when both tags are present', () => {
    expect(stripThink('<think>plan</think>real content')).toBe('real content');
  });
});

describe('parseHermesToolCalls', () => {
  test('single <tool_call> JSON with name+arguments', () => {
    const r = parseHermesToolCalls('<tool_call>{"name":"browser.click","arguments":{"selector":"#x"}}</tool_call>');
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe('browser.click');
    expect(r[0].args).toEqual({ selector: '#x' });
  });
  test('multiple <tool_call> blocks dispatch in order', () => {
    const input = '<tool_call>{"name":"browser.read_tab","arguments":{"spaceId":"a"}}</tool_call>\n<tool_call>{"name":"browser.read_tab","arguments":{"spaceId":"b"}}</tool_call>';
    const r = parseHermesToolCalls(input);
    expect(r).toHaveLength(2);
    expect(r[0].args.spaceId).toBe('a');
    expect(r[1].args.spaceId).toBe('b');
  });
  test('<tool_calls>[array]</tool_calls> plural wrapper', () => {
    const r = parseHermesToolCalls('<tool_calls>[{"name":"browser.read_tab","arguments":{}},{"name":"agent.done","arguments":{"summary":"k"}}]</tool_calls>');
    expect(r).toHaveLength(2);
    expect(r[1].name).toBe('agent.done');
  });
  test('arguments as stringified JSON still parses', () => {
    const r = parseHermesToolCalls('<tool_call>{"name":"browser.click","arguments":"{\\"selector\\":\\"#x\\"}"}</tool_call>');
    expect(r[0].args).toEqual({ selector: '#x' });
  });
});

describe('parseLlamaXmlToolCalls', () => {
  test('<function=…><parameter=k>v</parameter></function>', () => {
    const r = parseLlamaXmlToolCalls('<function=browser.read_tab><parameter=spaceId>a</parameter></function>');
    expect(r[0]).toMatchObject({ name: 'browser.read_tab', args: { spaceId: 'a' } });
  });
  test('coerces numeric / boolean parameter values', () => {
    const input = '<function=browser.scroll><parameter=amount>400</parameter><parameter=spaceId>a</parameter></function>';
    const r = parseLlamaXmlToolCalls(input);
    expect(r[0].args).toEqual({ amount: 400, spaceId: 'a' });
  });
  test('<function=…>{json payload}</function> (Llama-3.1 JSON variant)', () => {
    const r = parseLlamaXmlToolCalls('<function=browser.click>{"selector":"#go","spaceId":"b"}</function>');
    expect(r[0]).toMatchObject({ name: 'browser.click', args: { selector: '#go', spaceId: 'b' } });
  });
});

describe('parseLlamaPythonTagToolCalls', () => {
  test('<|python_tag|>{json}<|eom_id|>', () => {
    const r = parseLlamaPythonTagToolCalls('<|python_tag|>{"name":"browser.read_tab","arguments":{"spaceId":"a"}}<|eom_id|>');
    expect(r[0].name).toBe('browser.read_tab');
  });
  test('<|python_tag|>{json} with no close tag', () => {
    const r = parseLlamaPythonTagToolCalls('<|python_tag|>{"name":"agent.done","arguments":{"summary":"k"}}');
    expect(r[0]).toMatchObject({ name: 'agent.done', args: { summary: 'k' } });
  });
});

describe('parseMistralToolCalls', () => {
  test('[TOOL_CALLS][{name,arguments}]', () => {
    const r = parseMistralToolCalls('[TOOL_CALLS][{"name":"browser.read_tab","arguments":{"spaceId":"a"}}]');
    expect(r[0].name).toBe('browser.read_tab');
    expect(r[0].args.spaceId).toBe('a');
  });
  test('multiple calls in one bracket', () => {
    const r = parseMistralToolCalls('[TOOL_CALLS][{"name":"browser.read_tab","arguments":{"spaceId":"a"}},{"name":"browser.read_tab","arguments":{"spaceId":"b"}}]');
    expect(r).toHaveLength(2);
  });
});

describe('parseClaudeInvokeToolCalls', () => {
  test('<invoke name="…"><parameter name="…">…</parameter></invoke>', () => {
    const r = parseClaudeInvokeToolCalls('<invoke name="browser.click"><parameter name="selector">#x</parameter></invoke>');
    expect(r[0]).toMatchObject({ name: 'browser.click', args: { selector: '#x' } });
  });
  test('wrapped in <function_calls>…</function_calls>', () => {
    const input = '<function_calls><invoke name="browser.read_tab"><parameter name="spaceId">a</parameter></invoke></function_calls>';
    const r = parseClaudeInvokeToolCalls(input);
    expect(r[0].name).toBe('browser.read_tab');
  });
});

describe('parseDeepseekToolCalls', () => {
  test('deepseek tool_call block (ASCII-normalized)', () => {
    const input = '<|tool_calls_begin|><|tool_call_begin|>function<|tool_sep|>browser.read_tab\n```json\n{"spaceId":"a"}\n```<|tool_call_end|><|tool_calls_end|>';
    const r = parseDeepseekToolCalls(input);
    expect(r[0]).toMatchObject({ name: 'browser.read_tab', args: { spaceId: 'a' } });
  });
  test('deepseek with unicode separators (｜ and ▁)', () => {
    const input = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>browser.read_tab\n```json\n{"spaceId":"a"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const r = parseDeepseekToolCalls(input);
    expect(r[0].name).toBe('browser.read_tab');
  });
});

describe('parseReActToolCalls', () => {
  test('Thought/Action/Action Input/Observation prose', () => {
    const input = 'Thought: I should read the tab.\nAction: browser.read_tab\nAction Input: {"spaceId":"a"}\nObservation: …';
    const r = parseReActToolCalls(input);
    expect(r[0]).toMatchObject({ name: 'browser.read_tab', args: { spaceId: 'a' } });
  });
  test('non-JSON Action Input preserved as _input', () => {
    const input = 'Action: browser.read_tab\nAction Input: hello world\nFinal Answer:';
    const r = parseReActToolCalls(input);
    expect(r[0].args._input).toBe('hello world');
  });
});

describe('parseFencedJsonToolCalls', () => {
  test('```json\\n[…]\\n```', () => {
    const input = 'Here:\n```json\n[{"tool":"browser.read_tab","args":{"spaceId":"a"}}]\n```\ndone';
    const r = parseFencedJsonToolCalls(input);
    expect(r[0].name).toBe('browser.read_tab');
  });
  test('plain ``` fenced block with object', () => {
    const input = '```\n{"tool":"agent.done","args":{"summary":"k"}}\n```';
    const r = parseFencedJsonToolCalls(input);
    expect(r[0].name).toBe('agent.done');
  });
});

describe('parseRawJsonToolCalls', () => {
  test('raw JSON object', () => {
    expect(parseRawJsonToolCalls('{"tool":"browser.click","args":{"selector":"#x"}}')[0].name).toBe('browser.click');
  });
  test('raw JSON array', () => {
    const r = parseRawJsonToolCalls('[{"tool":"browser.read_tab","args":{"spaceId":"a"}}]');
    expect(r).toHaveLength(1);
  });
  test('OpenAI function-shape object', () => {
    expect(parseRawJsonToolCalls('{"function":{"name":"browser.click","arguments":"{\\"selector\\":\\"#x\\"}"}}')[0].args.selector).toBe('#x');
  });
});

describe('normalizeName', () => {
  test('dotted name returned as-is', () => {
    expect(normalizeName('browser.click')).toBe('browser.click');
  });
  test('bare core verb gets agent.* prefix', () => {
    expect(normalizeName('done')).toBe('agent.done');
    expect(normalizeName('ask_user')).toBe('agent.ask_user');
  });
  test('bare non-core verb gets browser.* prefix', () => {
    expect(normalizeName('click')).toBe('browser.click');
  });
});

describe('extractToolCalls (dialect priority)', () => {
  test('strips <think> before parsing', () => {
    const r = extractToolCalls('<think>I will click.</think><tool_call>{"name":"browser.click","arguments":{"selector":"#x"}}</tool_call>');
    expect(r[0].name).toBe('browser.click');
  });
  test('Hermes wins over fenced-JSON when both present', () => {
    const input = '<tool_call>{"name":"browser.click","arguments":{"selector":"A"}}</tool_call>\n```json\n[{"tool":"browser.click","args":{"selector":"B"}}]\n```';
    const r = extractToolCalls(input);
    expect(r[0].args.selector).toBe('A');
  });
  test('returns [] for plain prose with no tool call markers', () => {
    expect(extractToolCalls('Just a prose answer without tools.')).toEqual([]);
  });
  test('Mistral [TOOL_CALLS] format end-to-end', () => {
    const r = extractToolCalls('[TOOL_CALLS][{"name":"browser.read_tab","arguments":{"spaceId":"a"}}]');
    expect(r[0].name).toBe('browser.read_tab');
  });
  test('Claude <invoke> format end-to-end', () => {
    const r = extractToolCalls('<function_calls><invoke name="browser.read_tab"><parameter name="spaceId">x</parameter></invoke></function_calls>');
    expect(r[0].args.spaceId).toBe('x');
  });
  test('DeepSeek unicode format end-to-end', () => {
    const input = '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>browser.read_tab\n```json\n{"spaceId":"a"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const r = extractToolCalls(input);
    expect(r[0].name).toBe('browser.read_tab');
  });
});

describe('looksLikeToolCall', () => {
  test.each([
    ['<tool_call>garbage</tool_call>', true],
    ['<function=x>…</function>', true],
    ['<invoke name="x">…</invoke>', true],
    ['<|python_tag|>{}<|eom_id|>', true],
    ['[TOOL_CALLS][]', true],
    ['<|tool_calls_begin|>…', true],
    ['Action: browser.read_tab\nAction Input: {}', true],
    ['{"tool":"x","args":{}}', true],
    ['{"name":"x"}', true],
    ['Just prose, no tools here.', false],
    ['<think>tool planning</think>prose only', false],
    // Hallucinated "call:" syntax should also flip the sentinel.
    ['call:browser.open_tab{url:"https://x"}', true],
    // Half-malformed special tokens around hallucinated syntax — should still
    // be detected after stripping.
    ['<|tool_response>call:agent.done{summary:"hi"}<tool_call|>', true],
  ])('%p → %p', (input, expected) => {
    expect(looksLikeToolCall(input)).toBe(expected);
  });
});

describe('stripSpecialTokens', () => {
  test('replaces <|"|> with literal quote', () => {
    expect(stripSpecialTokens('<|"|>hello<|"|>')).toBe('"hello"');
  });
  test('strips chat-template control tokens', () => {
    expect(stripSpecialTokens('a<|im_end|>b<|eot_id|>c')).toBe('abc');
  });
  test('strips <eos>/<bos> SentencePiece-style tokens', () => {
    expect(stripSpecialTokens('hi<eos>')).toBe('hi');
    expect(stripSpecialTokens('hi</eos>')).toBe('hi');
  });
  test('strips half-malformed <|name> (no closing pipe)', () => {
    expect(stripSpecialTokens('<|tool_response>x')).toBe('x');
  });
  test('strips half-malformed <name|> (no opening pipe)', () => {
    expect(stripSpecialTokens('x<tool_call|>')).toBe('x');
  });
  test('LEAVES well-formed dialect tokens intact', () => {
    expect(stripSpecialTokens('<|python_tag|>{}')).toBe('<|python_tag|>{}');
    expect(stripSpecialTokens('<tool_call>{}</tool_call>')).toBe('<tool_call>{}</tool_call>');
    expect(stripSpecialTokens('<function=x>{}</function>')).toBe('<function=x>{}</function>');
  });
  test('safe on empty / non-string input', () => {
    expect(stripSpecialTokens('')).toBe('');
    expect(stripSpecialTokens(null)).toBe('');
  });
});

describe('parseCallSyntaxToolCalls', () => {
  test('parses call:NAME{key:"value"} with unquoted keys', () => {
    const r = parseCallSyntaxToolCalls('call:browser.open_tab{url:"https://example.com/"}');
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe('browser.open_tab');
    expect(r[0].args).toEqual({ url: 'https://example.com/' });
  });
  test('parses multiple consecutive calls', () => {
    const r = parseCallSyntaxToolCalls('call:browser.open_tab{url:"https://a/"} call:browser.read_tab{}');
    expect(r).toHaveLength(2);
    expect(r[0].args.url).toBe('https://a/');
    expect(r[1].name).toBe('browser.read_tab');
  });
  test('parses agent.done with multi-word summary', () => {
    const r = parseCallSyntaxToolCalls('call:agent.done{summary:"All done with the task."}');
    expect(r[0]).toMatchObject({ name: 'agent.done', args: { summary: 'All done with the task.' } });
  });
  test('coerces numeric / boolean values', () => {
    const r = parseCallSyntaxToolCalls('call:browser.scroll{x:0,y:200,smooth:true}');
    expect(r[0].args).toEqual({ x: 0, y: 200, smooth: true });
  });
  test('handles nested objects in args', () => {
    const r = parseCallSyntaxToolCalls('call:browser.fill_form{fields:{name:"x",value:"y"}}');
    expect(r[0].name).toBe('browser.fill_form');
    expect(r[0].args.fields).toEqual({ name: 'x', value: 'y' });
  });
  test('namespaces bare names via normalizeName', () => {
    const r = parseCallSyntaxToolCalls('call:read_tab{}');
    expect(r[0].name).toBe('browser.read_tab');
  });
  test('returns [] when no call: pattern present', () => {
    expect(parseCallSyntaxToolCalls('plain prose')).toEqual([]);
  });
});

describe('extractToolCalls — end-to-end recovery from MLX-style hallucination', () => {
  // This is the exact garbled output we saw from the local MLX model: a
  // sequence of invented "call:" calls wrapped in malformed half-tokens, with
  // <|"|> as quote characters and <eos> at the end. Before this fix the
  // extractor returned [] and the agent gave up.
  test('recovers calls from <|tool_response>call:NAME{...}<tool_call|> wrappers', () => {
    const garbled = [
      '<|tool_response>call:browser.open_tab{url:<|"|>https://www.reddit.com/<|"|>}<tool_call|>',
      '<|tool_response>call:browser.wait_for_load{}<tool_call|>',
      '<|tool_response>call:agent.done{summary:<|"|>Done.<|"|>}<tool_call|>',
      '<eos>',
    ].join('');
    const calls = extractToolCalls(garbled);
    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.name)).toEqual([
      'browser.open_tab',
      'browser.wait_for_load',
      'agent.done',
    ]);
    expect(calls[0].args).toEqual({ url: 'https://www.reddit.com/' });
    expect(calls[2].args).toEqual({ summary: 'Done.' });
  });

  test('still prefers Hermes <tool_call> dialect when both are present', () => {
    // Sanity: a model that emits both must not have its real Hermes call
    // shadowed by a stray "call:" string elsewhere.
    const mixed = '<tool_call>{"name":"browser.read_tab","arguments":{}}</tool_call>\nirrelevant prose mentioning call:foo{x:1}';
    const calls = extractToolCalls(mixed);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('browser.read_tab');
  });

  // The Reddit-summary failure: the model emitted reasoning prose with NO
  // opening <think>, an orphan </think> close tag, then a JSON tool call
  // that got truncated mid-string by the maxTokens cap. Before this fix:
  //   - stripThink left the orphan </think> + prose in place
  //   - parseJsonBlock found the opening { but no matching } → returned null
  //   - extractToolCalls returned [] and the whole turn was lost
  test('recovers agent.done from orphan </think> + truncated JSON', () => {
    const truncated = [
      'The user wants me to finish the task. I have read 5 subreddits:',
      '1. r/cursor — pricing and limits.',
      '2. r/aiprogramming — RetinaNet object detection.',
      'I have enough information to summarize. I will construct the final JSON response.',
      '</think>',
      '',
      '{"tool":"agent.done","args":{"summary":"Here is what is currently trending in 5 different AI coding subreddits:\\n\\n**1. r/cursor**\\n*   Pricing & Limits: discussions about Opus 4.6 costs.\\n\\n**2. r/aiprogramming**\\n*   Object Detection Help: RetinaNet on Deep Fashion dataset.\\n\\n**3. r/AI_Agents**\\n*   Agent vs Scammers: a viral post about an agent fighting a romance scammer.\\n\\n**4. r/LLM**\\n*   Model Benchmarks: A detailed',
    ].join('\n');
    const calls = extractToolCalls(truncated);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('agent.done');
    // Summary survives — repair closes the unterminated string + braces.
    expect(typeof calls[0].args.summary).toBe('string');
    expect(calls[0].args.summary).toMatch(/r\/cursor/);
    expect(calls[0].args.summary).toMatch(/Model Benchmarks/);
  });
});

describe('parseJsonBlock container order', () => {
  test('object call whose args hold an array parses as the object', () => {
    const text = 'Plan: {"tool":"agent.todo_write","args":{"todos":[{"content":"a","status":"pending"}]}}';
    const calls = extractToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name || calls[0].tool).toBe('agent.todo_write');
    expect(calls[0].args.todos).toEqual([{ content: 'a', status: 'pending' }]);
  });

  test('top-level array of calls still parses as an array', () => {
    const text = '[{"tool":"browser.read_tab","args":{"spaceId":"a"}},{"tool":"browser.read_tab","args":{"spaceId":"b"}}]';
    const calls = extractToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls[1].args.spaceId).toBe('b');
  });
});

describe('parseJsonBlock truncation repair', () => {
  // Implementation detail: parseJsonBlock isn't exported, but the behavior
  // is observable via extractToolCalls + parseRawJsonToolCalls.
  test('repairs JSON cut off mid-string', () => {
    const truncated = '{"tool":"agent.done","args":{"summary":"Half a thought before';
    const calls = extractToolCalls(truncated);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.summary).toBe('Half a thought before');
  });

  test('repairs JSON cut off mid-array', () => {
    const truncated = '[{"tool":"browser.read_tab","args":{"spaceId":"a"}},{"tool":"browser.read_tab","args":{"spaceId":"b"';
    const calls = extractToolCalls(truncated);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].name).toBe('browser.read_tab');
  });

  test('does not "repair" valid JSON (returns parsed value verbatim)', () => {
    const calls = extractToolCalls('{"tool":"agent.done","args":{"summary":"complete"}}');
    expect(calls[0].args.summary).toBe('complete');
  });
});

// =============================================================================
// May-2026 dialects: Harmony, functools, pythonic
// =============================================================================

describe('parseHarmonyToolCalls (GPT-OSS / OpenAI open-weights)', () => {
  test('parses commentary channel with to=functions.NAMESPACE.NAME and <|call|> stop', () => {
    const input = '<|channel|>commentary to=functions.weather.get <|constrain|>json<|message|>{"location":"SF","units":"c"}<|call|>';
    const r = parseHarmonyToolCalls(input);
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe('weather.get');
    expect(r[0].args).toEqual({ location: 'SF', units: 'c' });
  });

  test('strips functions. namespace prefix', () => {
    const input = '<|channel|>commentary to=functions.browser.read_tab<|message|>{"spaceId":"a"}<|call|>';
    const r = parseHarmonyToolCalls(input);
    expect(r[0].name).toBe('browser.read_tab');
  });

  test('handles <|return|> stop token', () => {
    const input = '<|channel|>commentary to=agent.done<|message|>{"summary":"done"}<|return|>';
    const r = parseHarmonyToolCalls(input);
    expect(r[0]).toMatchObject({ name: 'agent.done', args: { summary: 'done' } });
  });

  test('handles multiple sequential calls', () => {
    const input = [
      '<|channel|>commentary to=functions.read<|message|>{"id":"a"}<|call|>',
      '<|channel|>commentary to=functions.read<|message|>{"id":"b"}<|call|>',
    ].join('');
    const r = parseHarmonyToolCalls(input);
    expect(r).toHaveLength(2);
    expect(r[1].args).toEqual({ id: 'b' });
  });

  test('returns [] when no commentary channel marker', () => {
    expect(parseHarmonyToolCalls('plain text')).toEqual([]);
    expect(parseHarmonyToolCalls('<|channel|>analysis<|message|>thinking<|end|>')).toEqual([]);
  });
});

describe('parseFunctoolsToolCalls (Phi-4-mini)', () => {
  test('parses functools[{name, arguments}]', () => {
    const r = parseFunctoolsToolCalls('functools[{"name":"browser.click","arguments":{"selector":"#x"}}]');
    expect(r[0]).toMatchObject({ name: 'browser.click', args: { selector: '#x' } });
  });

  test('parses parallel calls', () => {
    const r = parseFunctoolsToolCalls('functools[{"name":"a","arguments":{}},{"name":"b","arguments":{}}]');
    expect(r).toHaveLength(2);
  });

  test('returns [] when no functools marker', () => {
    expect(parseFunctoolsToolCalls('[{"name":"x"}]')).toEqual([]);
  });
});

describe('parsePythonicToolCalls (Llama 3.2 / 3.3 / 4)', () => {
  test('single call with single-quoted string args (namespaced name kept as-is)', () => {
    const r = parsePythonicToolCalls("[weather.get(city='San Francisco', units='celsius')]");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      name: 'weather.get',
      args: { city: 'San Francisco', units: 'celsius' },
    });
  });

  test('parallel calls', () => {
    const r = parsePythonicToolCalls("[browser.read_tab(spaceId='a'), browser.read_tab(spaceId='b')]");
    expect(r).toHaveLength(2);
    expect(r[0].args.spaceId).toBe('a');
    expect(r[1].args.spaceId).toBe('b');
  });

  test('coerces bool / None / number', () => {
    const r = parsePythonicToolCalls('[browser.scroll(x=0, y=200, smooth=True, focus=None)]');
    expect(r[0].args).toEqual({ x: 0, y: 200, smooth: true, focus: null });
  });

  test('handles double-quoted strings with embedded commas', () => {
    const r = parsePythonicToolCalls('[browser.search(q="hello, world", n=5)]');
    expect(r[0].args).toEqual({ q: 'hello, world', n: 5 });
  });

  test('namespaced names pass through (no fallback rewrite)', () => {
    const r = parsePythonicToolCalls("[browser.read_tab(spaceId='a')]");
    expect(r[0].name).toBe('browser.read_tab');
  });

  test('returns [] for plain JSON arrays (no name(...) at start)', () => {
    expect(parsePythonicToolCalls('[1, 2, 3]')).toEqual([]);
    expect(parsePythonicToolCalls('[{"name":"x"}]')).toEqual([]);
  });
});

// =============================================================================
// JSON auto-heal (softenJson)
// =============================================================================

describe('softenJson', () => {
  test('strips trailing commas before } and ]', () => {
    expect(JSON.parse(softenJson('{"a":1,"b":2,}'))).toEqual({ a: 1, b: 2 });
    expect(JSON.parse(softenJson('[1,2,3,]'))).toEqual([1, 2, 3]);
  });

  test('converts Python literals: True/False/None', () => {
    expect(JSON.parse(softenJson('{"a":True,"b":False,"c":None}'))).toEqual({ a: true, b: false, c: null });
  });

  test('quotes unquoted keys (top-level + nested)', () => {
    expect(JSON.parse(softenJson('{a:1, nested:{b:2}}'))).toEqual({ a: 1, nested: { b: 2 } });
  });

  test('strips // line comments and /* block */ comments', () => {
    const input = '{"a":1, // a is the count\n  "b":/* block */ 2}';
    expect(JSON.parse(softenJson(input))).toEqual({ a: 1, b: 2 });
  });

  test('replaces smart quotes', () => {
    // U+201C, U+201D for double; U+2018, U+2019 for single.
    const input = '{“name”:“click”}';
    expect(JSON.parse(softenJson(input))).toEqual({ name: 'click' });
  });

  test('strips BOM at start', () => {
    expect(JSON.parse(softenJson('﻿{"a":1}'))).toEqual({ a: 1 });
  });

  test('does NOT modify strings containing reserved keywords or commas', () => {
    // True inside a string MUST stay a string.
    const out = softenJson('{"msg":"True is not False"}');
    expect(JSON.parse(out)).toEqual({ msg: 'True is not False' });
  });

  test('does NOT touch trailing commas inside string contents', () => {
    const out = softenJson('{"x":"a,b,"}');
    expect(JSON.parse(out)).toEqual({ x: 'a,b,' });
  });

  test('idempotent on valid JSON', () => {
    const valid = '{"a":1,"b":[2,3],"c":"hi"}';
    expect(softenJson(valid)).toBe(valid);
  });
});

// =============================================================================
// End-to-end: each new format flows through extractToolCalls
// =============================================================================

describe('extractToolCalls — May 2026 dialects end-to-end', () => {
  test('Harmony tool call goes through orchestrator', () => {
    const calls = extractToolCalls('<|channel|>commentary to=functions.agent.done<|message|>{"summary":"hi"}<|call|>');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('agent.done');
  });

  test('functools tool call goes through orchestrator', () => {
    const calls = extractToolCalls('functools[{"name":"browser.read_tab","arguments":{"spaceId":"a"}}]');
    expect(calls[0].name).toBe('browser.read_tab');
  });

  test('pythonic tool call goes through orchestrator', () => {
    const calls = extractToolCalls("[browser.read_tab(spaceId='custom1')]");
    expect(calls[0]).toMatchObject({ name: 'browser.read_tab', args: { spaceId: 'custom1' } });
  });

  test('Hermes tool call with trailing-comma JSON still parses (auto-heal)', () => {
    const calls = extractToolCalls('<tool_call>{"name":"browser.click","arguments":{"selector":"#x",}}</tool_call>');
    expect(calls[0].args).toEqual({ selector: '#x' });
  });

  test('raw JSON with Python literals + unquoted keys still parses', () => {
    const calls = extractToolCalls('{tool:"agent.done", args:{summary:"k", urgent:True}}');
    expect(calls[0]).toMatchObject({ name: 'agent.done', args: { summary: 'k', urgent: true } });
  });
});

describe('looksLikeToolCall — sentinel covers May 2026 dialects', () => {
  test.each([
    ['<|channel|>commentary to=functions.X<|message|>{}<|call|>', true],
    ['functools[{"name":"x","arguments":{}}]', true],
    ["[get_weather(city='SF')]", true],
    ['plain prose with no tools', false],
  ])('%p → %p', (input, expected) => {
    expect(looksLikeToolCall(input)).toBe(expected);
  });

  test('null / empty content returns false (early-return arm)', () => {
    expect(looksLikeToolCall(null)).toBe(false);
    expect(looksLikeToolCall('')).toBe(false);
    expect(looksLikeToolCall(undefined)).toBe(false);
  });
});

describe('normalizeName — branch arms', () => {
  test('non-string / empty input returns empty string', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(42)).toBe('');
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('browser.'); // trimmed empty → fallbackNamespace.''
  });

  test('core verbs done/ask_user/set_plan get the agent. prefix', () => {
    expect(normalizeName('done')).toBe('agent.done');
    expect(normalizeName('ask_user')).toBe('agent.ask_user');
    expect(normalizeName('set_plan')).toBe('agent.set_plan');
  });

  test('honors an explicit fallbackNamespace for bare names', () => {
    expect(normalizeName('open_tab', 'browser')).toBe('browser.open_tab');
    expect(normalizeName('foo', 'custom')).toBe('custom.foo');
  });

  test('already-dotted names pass through untouched', () => {
    expect(normalizeName('agent.done')).toBe('agent.done');
    expect(normalizeName('x.y.z')).toBe('x.y.z');
  });
});

describe('stripThink — non-string and orphan-tag arms', () => {
  test('non-string input returns empty string', () => {
    expect(stripThink(null)).toBe('');
    expect(stripThink(42)).toBe('');
    expect(stripThink(undefined)).toBe('');
  });

  test('no thinking tags → trimmed input unchanged', () => {
    expect(stripThink('  just text  ')).toBe('just text');
  });

  test('orphan [/THINK] close tag is stripped', () => {
    expect(stripThink('reasoning[/THINK]{"x":1}')).toBe('{"x":1}');
  });
});

describe('stripSpecialTokens — additional arms', () => {
  test('non-string returns empty string / passthrough', () => {
    expect(stripSpecialTokens(null)).toBe('');
    expect(stripSpecialTokens(undefined)).toBe('');
    expect(stripSpecialTokens(0)).toBe('');
  });

  test('replaces <|"|> rendered-quote leakage', () => {
    expect(stripSpecialTokens('a<|"|>b')).toBe('a"b');
  });
});

describe('softenJson — guard arms', () => {
  test('non-string / empty returns empty string', () => {
    expect(softenJson(null)).toBe('');
    expect(softenJson(undefined)).toBe('');
    expect(softenJson(0)).toBe('');
  });

  test('idempotent on already-strict JSON with no BOM', () => {
    expect(softenJson('{"a":1,"b":[2,3]}')).toBe('{"a":1,"b":[2,3]}');
  });
});

describe('parseRawJsonToolCalls / parseJsonBlock helper arms', () => {
  test('returns [] for content with no JSON at all', () => {
    expect(parseRawJsonToolCalls('totally plain prose, no braces')).toEqual([]);
  });

  test('object without a tool/name/action key yields no calls', () => {
    // flattenJsonCalls: item is an object but `name` resolves empty → skipped.
    expect(parseRawJsonToolCalls('{"foo":1,"bar":2}')).toEqual([]);
  });

  test('array with a non-object element skips that element', () => {
    const calls = parseRawJsonToolCalls('[42, {"tool":"browser.read_tab","args":{"spaceId":"a"}}]');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('browser.read_tab');
  });

  test('string arguments are JSON-parsed via parseMaybeJson', () => {
    const calls = parseRawJsonToolCalls('{"name":"browser.read_tab","arguments":"{\\"spaceId\\":\\"z\\"}"}');
    expect(calls[0].args).toEqual({ spaceId: 'z' });
  });

  test('unparseable string arguments degrade to {} (parseMaybeJson catch)', () => {
    const calls = parseRawJsonToolCalls('{"name":"browser.read_tab","arguments":"not json at all"}');
    expect(calls[0].args).toEqual({});
  });

  test('args absent → remaining keys become the args (omit path)', () => {
    const calls = parseRawJsonToolCalls('{"tool":"browser.navigate","url":"https://x","extra":1}');
    expect(calls[0].args).toEqual({ url: 'https://x', extra: 1 });
  });

  test('repairs JSON truncated mid-object (brace stack closer)', () => {
    const calls = parseRawJsonToolCalls('{"tool":"agent.done","args":{"summary":"partial');
    expect(calls[0].name).toBe('agent.done');
    expect(calls[0].args.summary).toBe('partial');
  });

  test('softened-JSON fallback path: trailing commas + Python literals', () => {
    const calls = parseRawJsonToolCalls('{"tool":"agent.done","args":{"ok":True,},}');
    expect(calls[0].args).toEqual({ ok: true });
  });
});

describe('dialect parsers — empty / no-match early returns', () => {
  test('parseHermesToolCalls returns [] when no <tool_call> markers', () => {
    expect(parseHermesToolCalls('plain text')).toEqual([]);
  });

  test('parseHermesToolCalls plural wrapper with array of calls', () => {
    const calls = parseHermesToolCalls('<tool_calls>[{"name":"browser.read_tab","arguments":{"spaceId":"a"}}]</tool_calls>');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('browser.read_tab');
  });

  test('parseHermesToolCalls falls back to Llama-XML inside <tool_call> when not JSON', () => {
    const calls = parseHermesToolCalls('<tool_call><function=browser.click><parameter=selector>#go</parameter></function></tool_call>');
    expect(calls[0]).toMatchObject({ name: 'browser.click', args: { selector: '#go' } });
  });

  test('parseLlamaXmlToolCalls JSON body (no <parameter> tags) parsed as args', () => {
    const calls = parseLlamaXmlToolCalls('<function=browser.read_tab>{"spaceId":"q"}</function>');
    expect(calls[0]).toMatchObject({ name: 'browser.read_tab', args: { spaceId: 'q' } });
  });

  test('parseLlamaXmlToolCalls non-object JSON body falls through to params scan', () => {
    // body is JSON array (not a plain object) → not used as args; no <parameter>
    // tags → empty args object.
    const calls = parseLlamaXmlToolCalls('<function=browser.read_tab>[1,2,3]</function>');
    expect(calls[0]).toMatchObject({ name: 'browser.read_tab', args: {} });
  });

  test('parseLlamaPythonTagToolCalls skips empty bodies, parses the next', () => {
    const calls = parseLlamaPythonTagToolCalls('<|python_tag|><|eom_id|><|python_tag|>{"tool":"agent.done","args":{"summary":"s"}}<|eom_id|>');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('agent.done');
  });

  test('parseLlamaPythonTagToolCalls returns [] when no python tag', () => {
    expect(parseLlamaPythonTagToolCalls('no tag here')).toEqual([]);
  });

  test('parseMistralToolCalls returns [] when no [TOOL_CALLS] marker', () => {
    expect(parseMistralToolCalls('nope')).toEqual([]);
  });

  test('parseMistralToolCalls returns [] when payload is unparseable', () => {
    expect(parseMistralToolCalls('[TOOL_CALLS] not-json-here')).toEqual([]);
  });

  test('parseClaudeInvokeToolCalls returns [] with no <invoke>', () => {
    expect(parseClaudeInvokeToolCalls('text only')).toEqual([]);
  });

  test('parseDeepseekToolCalls returns [] when no begin marker', () => {
    expect(parseDeepseekToolCalls('no deepseek here')).toEqual([]);
  });

  test('parseDeepseekToolCalls skips a block with an empty name', () => {
    // Marker present (passes the cheap test) but the tool_sep name is blank.
    const txt = '<|tool_calls_begin|><|tool_call_begin|>function<|tool_sep|> ```json\n{"a":1}\n```<|tool_call_end|><|tool_calls_end|>';
    expect(parseDeepseekToolCalls(txt)).toEqual([]);
  });

  test('parseReActToolCalls returns [] when no Action: present', () => {
    expect(parseReActToolCalls('Thought: hmm')).toEqual([]);
  });

  test('parseFencedJsonToolCalls skips empty fences, returns [] when none', () => {
    expect(parseFencedJsonToolCalls('```\n\n```')).toEqual([]);
    expect(parseFencedJsonToolCalls('no fences')).toEqual([]);
  });

  test('parseHarmonyToolCalls returns [] when no commentary channel', () => {
    expect(parseHarmonyToolCalls('<|channel|>analysis<|message|>x<|end|>')).toEqual([]);
  });

  test('parseHarmonyToolCalls non-object payload yields empty args', () => {
    const calls = parseHarmonyToolCalls('<|channel|>commentary to=functions.do<|message|>[1,2]<|call|>');
    expect(calls[0]).toMatchObject({ name: 'agent.do'.replace('agent.', 'browser.'), args: {} });
  });

  test('parseFunctoolsToolCalls returns [] with no functools marker / bad payload', () => {
    expect(parseFunctoolsToolCalls('no marker')).toEqual([]);
    expect(parseFunctoolsToolCalls('functools[not json]')).toEqual([]);
  });

  test('parsePythonicToolCalls returns [] when no name(...) block', () => {
    expect(parsePythonicToolCalls('just [1, 2, 3] array')).toEqual([]);
  });

  test('parsePythonicToolCalls coerces None/number/bool and double-quoted commas', () => {
    const calls = parsePythonicToolCalls('[do(n=None, k=3.5, on=True, off=False, s="a, b")]');
    expect(calls[0].args).toEqual({ n: null, k: 3.5, on: true, off: false, s: 'a, b' });
  });

  test('parsePythonicToolCalls JSON-dict value parses to an object', () => {
    const calls = parsePythonicToolCalls('[do(cfg={"a":1,"b":2})]');
    expect(calls[0].args).toEqual({ cfg: { a: 1, b: 2 } });
  });

  test('parseCallSyntaxToolCalls returns [] when no call: pattern', () => {
    expect(parseCallSyntaxToolCalls('no calls here')).toEqual([]);
  });

  test('parseCallSyntaxToolCalls relaxed-kv regex fallback when JSON.parse fails', () => {
    // Unquoted keys + a value the auto-quoter cannot fully fix forces the
    // tolerant kv-regex branch.
    const calls = parseCallSyntaxToolCalls('call:agent.done{summary:"hi", n:5, ok:true}');
    expect(calls[0]).toMatchObject({ name: 'agent.done', args: { summary: 'hi', n: 5, ok: true } });
  });

  test('extractToolCalls returns [] for empty post-strip content', () => {
    expect(extractToolCalls('<think>only thinking</think>')).toEqual([]);
    expect(extractToolCalls('')).toEqual([]);
    expect(extractToolCalls(null)).toEqual([]);
  });

  test('Llama-XML coerceValue: malformed bracket value stays a string (JSON.parse catch)', () => {
    // <parameter> value looks like an array but is invalid JSON → coerceValue
    // JSON.parse throws → falls through → original string preserved.
    const calls = parseLlamaXmlToolCalls('<function=browser.x><parameter=v>[1, 2,</parameter></function>');
    expect(calls[0].args.v).toBe('[1, 2,');
  });

  test('Llama-XML coerceValue: valid JSON array/object value is parsed', () => {
    const calls = parseLlamaXmlToolCalls('<function=browser.x><parameter=v>[1,2,3]</parameter><parameter=o>{"a":1}</parameter></function>');
    expect(calls[0].args).toEqual({ v: [1, 2, 3], o: { a: 1 } });
  });

  test('pythonic _coercePythonValue: softened-JSON list fallback (single quotes → still string)', () => {
    // Single-quoted dict is not strict JSON and softenJson does not touch
    // single quotes inside → value stays the raw string.
    const calls = parsePythonicToolCalls("[do(d={'k':'v'})]");
    expect(typeof calls[0].args.d).toBe('string');
  });

  test('pythonic _coercePythonValue: trailing-comma list repaired via softenJson', () => {
    const calls = parsePythonicToolCalls('[do(items={"a":1,})]');
    expect(calls[0].args.items).toEqual({ a: 1 });
  });

  test('pythonic single-quoted string with an embedded escaped quote', () => {
    const calls = parsePythonicToolCalls("[say(msg='it\\'s fine')]");
    expect(calls[0].args.msg).toBe("it's fine");
  });

  test('call-syntax: unbalanced braces in body → call skipped (sliceBalancedBraces null)', () => {
    // Opening brace with no matching close → sliceBalancedBraces returns null
    // → that call is skipped (continue arm), no calls produced.
    expect(parseCallSyntaxToolCalls('call:agent.done{summary:"x"')).toEqual([]);
  });

  test('call-syntax: string-literal braces inside the body do not break balancing', () => {
    const calls = parseCallSyntaxToolCalls('call:agent.done{summary:"a } b { c"}');
    expect(calls[0].args.summary).toBe('a } b { c');
  });

  test('call-syntax: empty body yields empty args', () => {
    const calls = parseCallSyntaxToolCalls('call:agent.done{}');
    expect(calls[0]).toMatchObject({ name: 'agent.done', args: {} });
  });

  test('call-syntax: nested-object value via the strict JSON path', () => {
    const calls = parseCallSyntaxToolCalls('call:browser.x{opts:{a:1,b:2}}');
    expect(calls[0].args).toEqual({ opts: { a: 1, b: 2 } });
  });

  test('call-syntax tolerant kv fallback parses string/array values', () => {
    // A body the auto-quoter + JSON.parse cannot fully recover (stray text)
    // forces the regex kv fallback, which extracts the well-formed pairs.
    const calls = parseCallSyntaxToolCalls('call:agent.done{summary:"hi" garbage tags:[1,2]}');
    expect(calls[0].args.summary).toBe('hi');
    expect(calls[0].args.tags).toEqual([1, 2]);
  });
});
