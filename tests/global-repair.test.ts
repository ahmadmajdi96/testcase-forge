import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { loadEnv } from '../src/config/env.js';

/**
 * Simulates a flaky Novita where the FIRST call for each unit times out, but
 * retries/repair succeed. Without job-level repair the timed-out units would
 * leave their items permanently uncovered; with it, coverage still closes.
 */
function flakyFetch(): typeof fetch {
  const failedOnce = new Set<string>();
  return (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    const userMsg: string = body.messages?.[1]?.content ?? '';
    const ids = [...new Set([...userMsg.matchAll(/\bCI-[A-Z]+-\d{4}\b/g)].map((m) => m[0]))];
    const key = ids.join(',');

    // Fail the first attempt for each distinct unit to force a skip/repair path.
    if (ids.length > 0 && !failedOnce.has(key)) {
      failedOnce.add(key);
      return new Response('upstream timeout', { status: 503 });
    }

    const testCases = ids.map((id) => ({
      title: `Cover ${id}`,
      description: 'covers item',
      preconditions: 'ready',
      expectedResult: 'ok',
      status: 'Ready',
      priority: 'P0',
      coverageTags: ['tag'],
      steps: [
        { action: 'do', expectedResult: 'done' },
        { action: 'check', expectedResult: 'passes' },
      ],
      testType: 'integration',
      suite: 's',
      authState: 'anonymous',
      selectors: [],
      networkMocks: [],
      fixtures: [],
      seedData: [],
      cleanup: [],
      assertions: [{ kind: 'visible', target: 'x', matcher: 'toBeVisible', expected: '' }],
      dataInputs: { valid: [], invalid: [], boundary: [] },
      edgeCaseClass: 'happy_path',
      riskLevel: 'medium',
      flakinessRisk: 'low',
      estimatedDurationMs: 1000,
      playwright: {
        suggestedFile: 'a.spec.ts', describeBlock: 'd', testTitle: 't', tags: [],
        requiresAuth: false, storageStateKey: null, viewport: 'desktop', locale: 'en',
        parallelSafe: true, timeoutMs: 30000, retries: 0,
        capturesVisualSnapshot: false, runsAccessibilityScan: false,
      },
      coveredItemIds: ids,
      upstreamIds: [],
      evidenceGaps: [],
      generationNotes: '',
    }));

    return new Response(
      JSON.stringify({
        model: 'mock',
        choices: [{ message: { content: JSON.stringify({ testCases }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

async function waitForTerminal(app: FastifyInstance, id: string) {
  for (let i = 0; i < 100; i += 1) {
    const body = (await app.inject({ method: 'GET', url: `/v1/test-generations/${id}` })).json();
    if (['completed', 'completed_with_gaps', 'failed', 'cancelled'].includes(body.status)) return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
}

let current: FastifyInstance | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

describe('job-level global repair', () => {
  it('recovers coverage even when units fail on first attempt', async () => {
    const env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      NOVITA_API_KEY: 'sk_x',
      SERVICE_API_KEYS: '',
      NOVITA_MAX_RETRIES: '0', // no in-client retry, so first-attempt failures skip the unit
      MAX_REPAIR_ROUNDS: '0',
      MAX_GLOBAL_REPAIR_ROUNDS: '3',
      MAX_ITEMS_PER_UNIT: '3',
    });
    const { app } = await buildApp(env, { fetchImpl: flakyFetch() });
    current = app;

    const md = `# API

## Endpoint Catalog

| ID | Item | Priority |
|---|---|---|
| CONTRACT-001 | POST /api/a | P0 |
| CONTRACT-002 | POST /api/b | P0 |
| CONTRACT-003 | POST /api/c | P1 |
| CONTRACT-004 | GET /api/d | P1 |
| CONTRACT-005 | GET /api/e | P1 |
`;
    const submit = await app.inject({
      method: 'POST',
      url: '/v1/test-generations',
      headers: { 'content-type': 'application/json' },
      payload: { files: [{ filename: 'api.md', content: md }] },
    });
    const jobId = submit.json().id as string;
    const final = await waitForTerminal(app, jobId);

    // First attempt skipped every unit; global repair regenerated them.
    expect(final.status).toBe('completed');
    expect(final.coverage.coverageRatio).toBe(1);
    expect(final.coverage.p0FullyCovered).toBe(true);
  });
});
