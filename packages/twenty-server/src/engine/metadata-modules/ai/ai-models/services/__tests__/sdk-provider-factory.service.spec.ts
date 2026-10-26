import { generateText, Output } from 'ai';
import { z } from 'zod';

import { SdkProviderFactoryService } from 'src/engine/metadata-modules/ai/ai-models/services/sdk-provider-factory.service';

describe('OpenAI-compatible structured responses', () => {
  it('passes the output schema to providers that explicitly support it', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'test-completion',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"title":"Test"}' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    try {
      const provider = new SdkProviderFactoryService().createProvider('codex', {
        npm: '@ai-sdk/openai-compatible',
        baseUrl: 'https://provider.example/v1',
        apiKey: 'test-key',
        supportsStructuredOutputs: true,
      });

      if (!provider.createModel)
        throw new Error('Language model factory missing');
      const result = await generateText({
        model: provider.createModel('test-model'),
        prompt: 'Generate a title',
        output: Output.object({ schema: z.object({ title: z.string() }) }),
      });

      expect(result.output).toEqual({ title: 'Test' });
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

      expect(body.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: { schema: { properties: { title: { type: 'string' } } } },
      });
    } finally {
      fetchMock.mockRestore();
    }
  });
});
