import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { loadEnv } from '../src/config/env.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  NOVITA_API_KEY: 'sk_test_key',
  SERVICE_API_KEYS: 'secret-key',
  MAX_FILE_BYTES: '2048',
  MAX_TOTAL_BYTES: '4096',
  NOVITA_MAX_RETRIES: '1',
  MAX_REPAIR_ROUNDS: '1',
} satisfies Record<string, string>;

function makeCase(coveredIds: string[]) {
  return {
    title: `Cover ${coveredIds.join(', ')}`,
    description: 'Generated test case for coverage.',
    preconditions: 'App running with seeded fixtures.',
    expectedResult: 'Endpoint behaves per the contract.',
    status: 'Ready',
    priority: 'P0',
    coverageTags: ['auth'],
    steps: [
      { action: 'Send request', expectedResult: 'Receives 200' },
      { action: 'Inspect body', expectedResult: 'Matches schema' },
    ],
    testType: 'contract',
    suite: 'api-contract',
    route: null,
    httpMethod: 'POST',
    endpoint: '/api/rag/upload',
    personaId: 'DATA-AUTH-ADMIN',
    authState: 'admin',
    selectors: [],
    networkMocks: [],
    fixtures: ['DATA-CASE-MINIMAL'],
    seedData: [],
    cleanup: [],
    assertions: [{ kind: 'status_code', target: 'response', matcher: 'toBe', expected: '200' }],
    dataInputs: { valid: ['ok'], invalid: ['bad'], boundary: ['empty'] },
    edgeCaseClass: 'happy_path',
    riskLevel: 'high',
    flakinessRisk: 'low',
    estimatedDurationMs: 5000,
    playwright: {
      suggestedFile: 'tests/e2e/rag.spec.ts',
      describeBlock: 'RAG',
      testTitle: 'uploads',
      tags: ['@p0'],
      requiresAuth: true,
      storageStateKey: 'admin',
      viewport: 'desktop',
      locale: 'en',
      parallelSafe: true,
      timeoutMs: 30000,
      retries: 0,
      capturesVisualSnapshot: false,
      runsAccessibilityScan: false,
    },
    coveredItemIds: coveredIds,
    upstreamIds: [],
    evidenceGaps: [],
    generationNotes: 'none',
  };
}

/** Fake Novita that covers every requested item id, so jobs complete cleanly. */
function coveringFetch(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    const userMsg: string = body.messages?.[1]?.content ?? '';
    const ids = [...userMsg.matchAll(/\bCI-[A-Z]+-\d{4}\b/g)].map((m) => m[0]);
    const unique = [...new Set(ids)];
    const payload = {
      model: 'mock-model',
      choices: [
        {
          message: { content: JSON.stringify({ testCases: [makeCase(unique)] }) },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
}

async function waitForTerminal(app: FastifyInstance, id: string, headers: Record<string, string>) {
  for (let i = 0; i < 60; i += 1) {
    const res = await app.inject({ method: 'GET', url: `/v1/test-generations/${id}`, headers });
    const body = res.json();
    if (['completed', 'completed_with_gaps', 'failed', 'cancelled'].includes(body.status)) {
      return body;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job did not finish in time');
}

const AUTH = { authorization: 'Bearer secret-key' };

let current: FastifyInstance | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
  vi.restoreAllMocks();
});

describe('POST /v1/test-generations (mocked Novita)', () => {
  it('generates and fully covers a spec, exposing UI and full views', async () => {
    const env = loadEnv({ ...process.env, ...BASE_ENV });
    const { app } = await buildApp(env, { fetchImpl: coveringFetch() });
    current = app;

    const submit = await app.inject({
      method: 'POST',
      url: '/v1/test-generations',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        files: [
          {
            filename: '02_api.md',
            content:
              '# API\n\n## Endpoints\n\n| ID | Item | Priority |\n|---|---|---|\n| CONTRACT-001 | POST /api/rag/upload | P0 |\n',
          },
        ],
      },
    });
    expect(submit.statusCode).toBe(202);
    const jobId = submit.json().id as string;

    const final = await waitForTerminal(app, jobId, AUTH);
    expect(['completed', 'completed_with_gaps']).toContain(final.status);
    expect(final.coverage.coverageRatio).toBe(1);
    expect(final.caseCount).toBeGreaterThan(0);

    const ui = await app.inject({
      method: 'GET',
      url: `/v1/test-generations/${jobId}/test-cases?view=ui`,
      headers: AUTH,
    });
    const uiCase = ui.json().testCases[0];
    // UI view is exactly the Create Test Case screen fields — no AI-only keys leak.
    expect(Object.keys(uiCase).sort()).toEqual(
      ['coverageTags', 'description', 'expectedResult', 'id', 'preconditions', 'priority', 'status', 'steps', 'title'].sort(),
    );
    expect(uiCase).not.toHaveProperty('selectors');
    expect(uiCase).not.toHaveProperty('playwright');

    const full = await app.inject({
      method: 'GET',
      url: `/v1/test-generations/${jobId}/test-cases`,
      headers: AUTH,
    });
    const fullCase = full.json().testCases[0];
    // Full view carries the hidden machine context for the code generator.
    expect(fullCase.ai).toHaveProperty('playwright');
    expect(fullCase.ai).toHaveProperty('assertions');
    expect(fullCase.ai.traceability.coverageItemIds.length).toBeGreaterThan(0);
  });

  it('rejects unauthenticated requests', async () => {
    const env = loadEnv({ ...process.env, ...BASE_ENV });
    const { app } = await buildApp(env, { fetchImpl: coveringFetch() });
    current = app;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/test-generations',
    });
    expect(res.statusCode).toBe(401);
    // Error contract: {error:{code,message}} — not Fastify's default shape.
    expect(res.json()).toEqual({
      error: { code: 'unauthorized', message: 'Missing API key.' },
    });
  });

  it('enforces per-file size limits', async () => {
    const env = loadEnv({ ...process.env, ...BASE_ENV });
    const { app } = await buildApp(env, { fetchImpl: coveringFetch() });
    current = app;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/test-generations',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: {
        files: [{ filename: 'big.md', content: 'x'.repeat(5000) }],
      },
    });
    expect(res.statusCode).toBe(413);
  });

  it('health endpoints need no auth', async () => {
    const env = loadEnv({ ...process.env, ...BASE_ENV });
    const { app } = await buildApp(env, { fetchImpl: coveringFetch() });
    current = app;
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('tcf_http_requests_total');
  });
});
