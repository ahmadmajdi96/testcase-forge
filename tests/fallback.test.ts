import { describe, expect, it, vi } from 'vitest';
import { NovitaClient } from '../src/llm/novita.js';
import { createLogger } from '../src/observability/logger.js';
import { TEST_CASE_BATCH_SCHEMA } from '../src/llm/schema.js';

const logger = createLogger('silent', false);

function client(fetchImpl: typeof fetch) {
  return new NovitaClient(
    {
      apiKey: 'sk_test',
      baseUrl: 'https://api.novita.ai/v3/openai',
      model: 'glm-like-model',
      maxTokens: 1000,
      temperature: 0.2,
      timeoutMs: 2000,
      maxRetries: 2,
      circuitFailureThreshold: 5,
      circuitResetMs: 10_000,
    },
    logger,
    fetchImpl,
  );
}

describe('json_schema -> json_object fallback', () => {
  it('downgrades to json_object when the model rejects json_schema', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      bodies.push(body);
      const req = JSON.parse(body);
      if (req.response_format?.type === 'json_schema') {
        return new Response(
          JSON.stringify({
            code: 400,
            message: "Model does not support 'json_schema' response format. Supported formats: json_object.",
          }),
          { status: 400 },
        );
      }
      // json_object mode succeeds.
      expect(req.response_format?.type).toBe('json_object');
      return new Response(
        JSON.stringify({
          model: 'glm-like-model',
          choices: [{ message: { content: '{"testCases":[{"title":"ok"}]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).complete({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'generate cases' },
      ],
      responseFormat: TEST_CASE_BATCH_SCHEMA,
    });

    expect(result.content).toContain('testCases');
    // First attempt used json_schema, second used json_object with schema in prompt.
    expect(bodies).toHaveLength(2);
    const second = JSON.parse(bodies[1]!);
    expect(second.response_format.type).toBe('json_object');
    expect(second.messages[1].content).toContain('JSON Schema');
  });
});
