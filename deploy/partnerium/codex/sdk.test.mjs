import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText, tool, jsonSchema, isStepCount } from 'ai';

import { CodexClient } from './codex-client.mjs';
import { createBridge } from './server.mjs';

const token = 'sdk-test-bridge-token-with-at-least-32-characters';
const client = new CodexClient({
  executable: process.execPath,
  args: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))],
  cwd: process.cwd(),
});
const server = createBridge({ client, token });
let provider;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  provider = createOpenAICompatible({
    name: 'codex',
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: token,
  });
});
after(async () => {
  client.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('the installed CRM SDK handles both streaming chat and non-streaming titles', async () => {
  const chat = streamText({
    model: provider('test-model'),
    prompt: 'Hello',
    maxRetries: 0,
  });

  assert.equal(await chat.text, 'Hello');
  assert.equal((await chat.usage).inputTokens, 10);
  const title = await generateText({
    model: provider('test-model'),
    prompt: 'Generate a title',
    maxRetries: 0,
  });

  assert.equal(title.text, 'Hello');
});

test('the CRM SDK executes tools in its own permission context and continues with their result', async () => {
  let executions = 0;
  const chat = streamText({
    model: provider('tool-model'),
    prompt: 'Find Alice',
    tools: {
      find_contact: tool({
        inputSchema: jsonSchema({
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        }),
        execute: async ({ name }) => {
          executions++;
          assert.equal(name, 'Alice');
          return { name, visibleTo: 'current-crm-user' };
        },
      }),
    },
    stopWhen: isStepCount(3),
    maxRetries: 0,
  });

  assert.equal(await chat.text, 'Hello');
  assert.equal(executions, 1);
  assert.equal((await chat.steps).length, 2);
});

test('the CRM SDK rejects a partial stream that ends without success', async () => {
  const chat = streamText({
    model: provider('failed-model'),
    prompt: 'Hello',
    maxRetries: 0,
    onError: () => {},
  });

  await assert.rejects(chat.text);
});
