// An Anthropic Messages stream, written the way the API writes one, for a
// message a check makes up: message_start (the model and the input usage),
// each content block opened, filled by its deltas and closed, then
// message_delta (the stop reason and the output usage, with every attempt in
// usage.iterations when a fallback ran) and message_stop.
//
// The real SDK reads it as it would read Anthropic, which is the point: the
// briefing route (worker/briefing.js) passes Anthropic's bytes through
// untouched, so a check that feeds it these bytes is checking the same path.

export function sseEvents(message) {
  const {
    id = 'msg_test', model = 'claude-opus-5-5', content = [], stop_reason = 'end_turn',
    usage = { input_tokens: 10, output_tokens: 10 },
  } = message;
  const startUsage = {
    input_tokens: usage.input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    output_tokens: 1,
  };
  if (usage.cache_creation) startUsage.cache_creation = usage.cache_creation;
  const out = [['message_start', { type: 'message_start', message: {
    id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: startUsage } }]];
  content.forEach((b, index) => {
    if (b.type === 'text') {
      out.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      if (b.text) out.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }]);
    } else if (b.type === 'thinking') {
      out.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }]);
      if (b.thinking) out.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } }]);
      out.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature || 'c2lnbmVk' } }]);
    } else if (b.type === 'tool_use') {
      out.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }]);
      out.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input || {}) } }]);
    } else {
      out.push(['content_block_start', { type: 'content_block_start', index, content_block: b }]);
    }
    out.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  const deltaUsage = { output_tokens: usage.output_tokens || 0 };
  if (usage.iterations) deltaUsage.iterations = usage.iterations;
  out.push(['message_delta', { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: deltaUsage }]);
  out.push(['message_stop', { type: 'message_stop' }]);
  return out;
}

export function sseText(message) {
  return sseEvents(message).map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
