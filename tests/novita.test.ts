import { describe, expect, it, vi } from 'vitest';
import { NovitaClient } from '../src/llm/novita.js';
import { createLogger } from '../src/observability/logger.js';

const logger = createLogger('silent', false);

function client(fetchImpl: typeof fetch, overrides = {}) {
  return new NovitaClient(
    {
      apiKey: 'sk_test',
      baseUrl: 'https://api.novita.ai/v3/openai',
      model: 'test-model',
      maxTokens: 1000,
      temperature: 0.2,
      timeoutMs: 500,
      maxRetries: 3,
      circuitFailureThreshold: 3,
      circuitResetMs: 10_000,
      ...overrides,
    },
    logger,
    fetchImpl,
  );
}

function ok(content: string): Response {
  return new Response(
    JSON.stringify({
      model: 'test-model',
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
    { status: 200 },
  );
}

describe('NovitaClient retry and resilience', () => {
  it('retries retryable 5xx then succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response('upstream boom', { status: 503 });
      return ok('{"ok":true}');
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.content).toBe('{"ok":true}');
    expect(calls).toBe(3);
  });

  it('does not retry non-retryable 400', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response('bad request', { status: 400 });
    }) as unknown as typeof fetch;

    await expect(
      client(fetchImpl).complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'upstream_error' });
    expect(calls).toBe(1);
  });

  it('times out slow requests', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        const timer = setTimeout(() => resolve(ok('{}')), 5000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    await expect(
      client(fetchImpl, { maxRetries: 0 }).complete({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ code: 'upstream_timeout' });
  });

  it('opens the circuit breaker after repeated failures', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('down', { status: 503 }),
    ) as unknown as typeof fetch;
    const c = client(fetchImpl, { maxRetries: 0, circuitFailureThreshold: 2 });

    await expect(c.complete({ messages: [{ role: 'user', content: 'a' }] })).rejects.toBeTruthy();
    await expect(c.complete({ messages: [{ role: 'user', content: 'b' }] })).rejects.toBeTruthy();
    // Third call should short-circuit without hitting fetch again.
    const before = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await expect(
      c.complete({ messages: [{ role: 'user', content: 'c' }] }),
    ).rejects.toMatchObject({ code: 'circuit_open' });
    const after = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(after).toBe(before);
  });
});
