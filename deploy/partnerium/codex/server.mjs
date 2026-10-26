import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { BridgeError, CodexClient } from './codex-client.mjs';

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = () => {
  throw new BridgeError('Invalid chat completion request.', 400);
};
const validName = (name) =>
  typeof name === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(name);

export const validateRequest = (body, imageOrigin) => {
  if (
    !isRecord(body) ||
    typeof body.model !== 'string' ||
    body.model.length > 200 ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > 1000 ||
    (body.stream !== undefined && typeof body.stream !== 'boolean')
  )
    invalid();

  for (const message of body.messages) {
    if (
      !isRecord(message) ||
      !['system', 'developer', 'user', 'assistant', 'tool'].includes(
        message.role,
      )
    )
      invalid();
    if (typeof message.content !== 'string') {
      if (message.role === 'assistant' && message.content === null) {
        if (!message.tool_calls?.length) invalid();
      } else if (
        message.role !== 'user' ||
        !Array.isArray(message.content) ||
        !message.content.length
      ) {
        invalid();
      } else {
        for (const part of message.content) {
          if (part?.type === 'text' && typeof part.text === 'string') continue;
          if (
            part?.type !== 'image_url' ||
            typeof part.image_url?.url !== 'string'
          )
            invalid();
          const url = part.image_url.url;

          if (
            !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(
              url,
            )
          ) {
            try {
              const parsed = new URL(url);

              if (
                parsed.protocol !== 'https:' ||
                parsed.origin !== imageOrigin ||
                parsed.username ||
                parsed.password
              )
                invalid();
            } catch {
              invalid();
            }
          }
        }
      }
    }
    if (
      message.role === 'tool' &&
      (typeof message.tool_call_id !== 'string' || !message.tool_call_id)
    )
      invalid();
    if (message.tool_calls !== undefined) {
      if (
        message.role !== 'assistant' ||
        !Array.isArray(message.tool_calls) ||
        message.tool_calls.length > 128
      )
        invalid();
      for (const call of message.tool_calls) {
        if (
          call?.type !== 'function' ||
          !validName(call.function?.name) ||
          typeof call.id !== 'string' ||
          typeof call.function.arguments !== 'string'
        )
          invalid();
      }
    }
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 128) invalid();
    const names = new Set();

    for (const tool of body.tools) {
      if (
        tool?.type !== 'function' ||
        !validName(tool.function?.name) ||
        !isRecord(tool.function.parameters) ||
        names.has(tool.function.name) ||
        (tool.function.description !== undefined &&
          typeof tool.function.description !== 'string')
      )
        invalid();
      names.add(tool.function.name);
    }
  }
  if (
    body.tool_choice !== undefined &&
    !['auto', 'none', 'required'].includes(body.tool_choice)
  ) {
    if (
      body.tool_choice?.type !== 'function' ||
      !validName(body.tool_choice.function?.name) ||
      !body.tools?.some(
        (tool) => tool.function.name === body.tool_choice.function.name,
      )
    )
      invalid();
  }
  if (body.tool_choice === 'required' && !body.tools?.length) invalid();
  if (
    body.response_format !== undefined &&
    (body.response_format?.type !== 'json_schema' ||
      !isRecord(body.response_format.json_schema?.schema))
  )
    invalid();

  return body;
};

const readBody = async (request) => {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024)
      throw new BridgeError('Chat request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeError('Invalid JSON request.', 400);
  }
};

const usageFor = (usage) => ({
  prompt_tokens: usage?.inputTokens ?? 0,
  completion_tokens: usage?.outputTokens ?? 0,
  total_tokens: usage?.totalTokens ?? 0,
  prompt_tokens_details: { cached_tokens: usage?.cachedInputTokens ?? 0 },
  completion_tokens_details: {
    reasoning_tokens: usage?.reasoningOutputTokens ?? 0,
  },
});

export const createBridge = ({ client, token, imageOrigin }) => {
  if (typeof token !== 'string' || token.length < 32)
    throw new Error('A bridge token of at least 32 characters is required.');
  const expected = Buffer.from(`Bearer ${token}`);
  let tail = Promise.resolve();
  let queued = 0;

  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    const ping = setInterval(() => {
      if (
        response.headersSent &&
        !response.writableEnded &&
        response.getHeader('Content-Type') === 'text/event-stream'
      )
        response.write(': keepalive\n\n');
    }, 15000);
    request.once('aborted', () => controller.abort());
    response.once('close', () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        await client.listModels();
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end('{"status":"ok"}');
        return;
      }
      const supplied = Buffer.from(request.headers.authorization ?? '');

      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        throw new BridgeError('Unauthorized.', 401);
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        const models = await client.listModels();

        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            object: 'list',
            data: models.map((model) => ({
              id: model.model,
              object: 'model',
              owned_by: 'codex',
              name: model.displayName,
              description: model.description,
              is_default: model.isDefault,
              input_modalities: model.inputModalities ?? ['text'],
            })),
          }),
        );
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions')
        throw new BridgeError('Not found.', 404);
      if (!request.headers['content-type']?.startsWith('application/json'))
        throw new BridgeError('JSON content type is required.', 415);
      const body = validateRequest(await readBody(request), imageOrigin);
      const models = await client.listModels();

      if (!models.some((model) => model.model === body.model))
        throw new BridgeError('This model is not available in Codex.', 400);
      if (queued >= 16)
        throw new BridgeError('Codex is busy. Please try again shortly.', 429);
      queued++;
      const previous = tail;
      let release;

      tail = new Promise((resolve) => {
        release = resolve;
      });
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const sendChunk = (delta, finishReason = null, usage) => {
        if (!body.stream || response.destroyed || response.writableEnded)
          return;
        if (!response.headersSent)
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          });
        response.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...(usage ? { usage: usageFor(usage) } : {}),
          })}\n\n`,
        );
      };

      try {
        await previous;
        if (controller.signal.aborted)
          throw new BridgeError('Codex request cancelled.', 499);
        const result = await client.complete({
          request: body,
          signal: controller.signal,
          onText: (text) => sendChunk({ content: text }),
        });
        const finishReason = result.toolCalls.length ? 'tool_calls' : 'stop';

        if (body.stream) {
          if (result.toolCalls.length)
            sendChunk({
              tool_calls: result.toolCalls.map((call, index) => ({
                index,
                ...call,
              })),
            });
          sendChunk({}, finishReason, result.usage ?? {});
          if (!response.destroyed) response.end('data: [DONE]\n\n');
        } else {
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              id,
              object: 'chat.completion',
              created,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: result.text || null,
                    ...(result.toolCalls.length
                      ? { tool_calls: result.toolCalls }
                      : {}),
                  },
                  finish_reason: finishReason,
                },
              ],
              usage: usageFor(result.usage),
            }),
          );
        }
      } finally {
        queued--;
        release();
      }
    } catch (error) {
      const message =
        error instanceof BridgeError
          ? error.message
          : 'Codex bridge is temporarily unavailable.';

      if (!response.destroyed && !response.writableEnded) {
        if (response.headersSent) {
          // An interrupted SSE response must fail in the SDK, never become a successful partial answer.
          response.destroy();
        } else {
          response
            .writeHead(error instanceof BridgeError ? error.status : 502, {
              'Content-Type': 'application/json',
            })
            .end(
              JSON.stringify({
                error: { message, type: 'codex_bridge_error' },
              }),
            );
        }
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(ping);
    }
  });

  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxConnections = 32;
  return server;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const client = new CodexClient();
  const token = (await readFile('/run/secrets/bridge-token', 'utf8')).trim();
  const server = createBridge({
    client,
    token,
    imageOrigin: process.env.CRM_ORIGIN,
  });

  server.listen(3001, '0.0.0.0');
  const stop = () => {
    server.close();
    server.closeAllConnections();
    client.stop();
  };

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
