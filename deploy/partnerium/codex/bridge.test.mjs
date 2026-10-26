import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CodexClient, prepareCompletion } from './codex-client.mjs';
import { createBridge, validateRequest } from './server.mjs';

const token = 'test-bridge-token-with-at-least-32-characters';
const client = new CodexClient({
  executable: process.execPath,
  args: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))],
  cwd: process.cwd(),
});
const server = createBridge({
  client,
  token,
  imageOrigin: 'https://crm.partnerium.app',
});
let endpoint;
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};
const request = (model = 'test-model', extra = {}) => ({
  model,
  messages: [{ role: 'user', content: 'Hello' }],
  ...extra,
});

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  client.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('requires bridge authentication and does not expose account identity', async () => {
  assert.equal((await fetch(`${endpoint}/v1/models`)).status, 401);
  const response = await fetch(`${endpoint}/v1/models`, { headers });
  const body = await response.json();

  assert.equal(body.data[0].id, 'test-model');
  assert.equal(JSON.stringify(body).includes('account'), false);
});

test('rejects unsupported content, malformed tools, and local image paths', () => {
  for (const body of [
    request('test-model', {
      tools: [{ type: 'function', function: { name: 'a', parameters: null } }],
    }),
    request('test-model', {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'file:///auth/auth.json' } },
          ],
        },
      ],
    }),
    request('test-model', {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'https://127.0.0.1/secret' },
            },
          ],
        },
      ],
    }),
    request('test-model', { messages: [{ role: 'tool', content: 'result' }] }),
  ])
    assert.throws(() => validateRequest(body, 'https://crm.partnerium.app'));
});

test('retains message roles, tool call ids, and full history between model steps', () => {
  const converted = prepareCompletion(
    request('test-model', {
      messages: [
        { role: 'system', content: 'Check CRM permissions' },
        { role: 'user', content: 'Find Alice' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'find_contact', arguments: '{"name":"Alice"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-1', content: '{"name":"Alice"}' },
      ],
    }),
  );

  assert.match(converted.instructions, /Check CRM permissions/);
  assert.deepEqual(
    converted.messages.map((message) => message.role),
    ['user', 'assistant', 'tool'],
  );
  assert.equal(converted.messages[2].tool_call_id, 'call-1');
});

test('supports non-streaming title generation with usage', async () => {
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request()),
  });
  const body = await response.json();

  assert.equal(body.choices[0].message.content, 'Hello');
  assert.equal(body.usage.total_tokens, 12);
});

test('streams text and emits a terminal finish reason', async () => {
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request('test-model', { stream: true })),
  });
  const text = await response.text();

  assert.match(text, /"content":"Hello"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]/);
});

test('delegates tool execution to CRM and rejects unoffered tools', async () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'find_contact',
        description: 'Find contacts',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request('tool-model', { tools })),
  });
  const body = await response.json();

  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(
    body.choices[0].message.tool_calls[0].function.name,
    'find_contact',
  );
  const schema = prepareCompletion(request('tool-model', { tools })).schema;

  assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, [
    'find_contact',
  ]);
});

test('a failed CLI turn never becomes a successful partial response', async () => {
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request('failed-model', { stream: true })),
  });

  assert.equal(response.status, 502);
  const body = await response.text();

  assert.match(body, /Codex could not complete/);
  assert.equal(body.includes('Private upstream details'), false);
});

test('cancelling a request frees the bridge for the next user', async () => {
  const controller = new AbortController();
  const pending = fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request('slow-model')),
    signal: controller.signal,
  });
  const rejection = assert.rejects(pending, { name: 'AbortError' });

  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();
  await rejection;
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request()),
  });

  assert.equal(response.status, 200);
});

test('subscription exhaustion returns a limit error without a different provider', async () => {
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request('limited-model')),
  });

  assert.equal(response.status, 429);
  assert.match(
    (await response.json()).error.message,
    /subscription usage limit/,
  );
});
