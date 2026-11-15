import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

test('Anthropic tool images follow all tool results as native images', async () => {
  const s = await setup();
  try {
    await s.proxy.post('/v1/messages', {
      model: 'm', max_tokens: 100,
      messages: [
        { role: 'user', content: 'Look at the screenshot' },
        { role: 'assistant', content: ['a', 'b'].map(id => ({ type: 'tool_use', id, name: 'read', input: {} })) },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'a', content: [
            { type: 'text', text: 'Screenshot' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ] },
          { type: 'tool_result', tool_use_id: 'b', content: 'Done' },
        ] },
      ],
    }, { Authorization: 'Bearer user_test' });
    const messages = s.mock.lastGenerate().body.params.messages;
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool', 'tool', 'user']);
    assert.equal(messages[2].content[0].output.value, 'Screenshot');
    assert.equal(messages[4].content[0].image, 'data:image/png;base64,AAAA');
  } finally { await s.close(); }
});
