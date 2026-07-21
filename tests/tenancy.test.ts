import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { loadEnv } from '../src/config/env.js';

const ACME = { authorization: 'Bearer sk_acme_test' };
const GLOBEX = { authorization: 'Bearer sk_globex_test' };

const SPEC_MD =
  '# API\n\n## Endpoints\n\n| ID | Item | Priority |\n|---|---|---|\n| CONTRACT-001 | POST /api/one | P0 |\n';

/** Mock Novita that covers every requested item. */
function coveringFetch(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    const userMsg: string = body.messages?.[1]?.content ?? '';
    const ids = [...new Set([...userMsg.matchAll(/\bCI-[A-Z]+-\d{4}\b/g)].map((m) => m[0]))];
    const testCases = [
      {
        title: 'Case', description: 'd', preconditions: 'p', expectedResult: 'e',
        status: 'Ready', priority: 'P0', coverageTags: ['api'],
        steps: [{ action: 'a', expectedResult: 'r' }, { action: 'b', expectedResult: 's' }],
        testType: 'contract', suite: 's', authState: 'anonymous',
        selectors: [], networkMocks: [], fixtures: [], seedData: [], cleanup: [],
        assertions: [{ kind: 'status_code', target: 'resp', matcher: 'toBe', expected: '200' }],
        dataInputs: { valid: [], invalid: [], boundary: [] },
        edgeCaseClass: 'happy_path', riskLevel: 'high', flakinessRisk: 'low',
        estimatedDurationMs: 1000,
        playwright: {
          suggestedFile: 'a.spec.ts', describeBlock: 'd', testTitle: 't', tags: [],
          requiresAuth: false, storageStateKey: null, viewport: 'desktop', locale: 'en',
          parallelSafe: true, timeoutMs: 30000, retries: 0,
          capturesVisualSnapshot: false, runsAccessibilityScan: false,
        },
        coveredItemIds: ids, upstreamIds: [], evidenceGaps: [], generationNotes: '',
      },
    ];
    return new Response(
      JSON.stringify({
        model: 'mock',
        choices: [{ message: { content: JSON.stringify({ testCases }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

async function submitAndFinish(app: FastifyInstance, headers: Record<string, string>) {
  const submit = await app.inject({
    method: 'POST',
    url: '/v1/test-generations',
    headers: { ...headers, 'content-type': 'application/json' },
    payload: { files: [{ filename: 'api.md', content: SPEC_MD }] },
  });
  expect(submit.statusCode).toBe(202);
  const jobId = submit.json().id as string;
  for (let i = 0; i < 100; i += 1) {
    const res = await app.inject({ method: 'GET', url: `/v1/test-generations/${jobId}`, headers });
    if (['completed', 'completed_with_gaps', 'failed'].includes(res.json().status)) return jobId;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not finish');
}

describe('multi-tenancy and artifact persistence', () => {
  let app: FastifyInstance;
  let artifactsDir: string;

  beforeEach(async () => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'tcf-artifacts-'));
    const env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      NOVITA_API_KEY: 'sk_x',
      SERVICE_API_KEYS: '',
      TENANT_API_KEYS: 'acme:sk_acme_test,globex:sk_globex_test',
      ARTIFACTS_DIR: artifactsDir,
    });
    ({ app } = await buildApp(env, { fetchImpl: coveringFetch() }));
  });

  afterEach(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it("a tenant cannot see another tenant's jobs", async () => {
    const acmeJob = await submitAndFinish(app, ACME);

    // Globex cannot read Acme's job by id (404, not 403 — no existence leak).
    const cross = await app.inject({
      method: 'GET',
      url: `/v1/test-generations/${acmeJob}`,
      headers: GLOBEX,
    });
    expect(cross.statusCode).toBe(404);

    // Globex's list is empty; Acme's list has the job.
    const globexList = await app.inject({ method: 'GET', url: '/v1/test-generations', headers: GLOBEX });
    expect(globexList.json().jobs).toHaveLength(0);
    const acmeList = await app.inject({ method: 'GET', url: '/v1/test-generations', headers: ACME });
    expect(acmeList.json().jobs).toHaveLength(1);

    // Globex cannot cancel Acme's job either.
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/test-generations/${acmeJob}/cancel`,
      headers: GLOBEX,
    });
    expect(cancel.statusCode).toBe(404);
  });

  it('persists artifacts per tenant and serves them via the API', async () => {
    const jobId = await submitAndFinish(app, ACME);

    const list = await app.inject({ method: 'GET', url: '/v1/artifacts', headers: ACME });
    expect(list.statusCode).toBe(200);
    expect(list.json().tenantId).toBe('acme');
    expect(list.json().jobs.map((j: { jobId: string }) => j.jobId)).toContain(jobId);

    const ui = await app.inject({
      method: 'GET',
      url: `/v1/artifacts/${jobId}/files/test-cases.ui.json`,
      headers: ACME,
    });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-disposition']).toContain(jobId);
    const parsed = JSON.parse(ui.body);
    expect(parsed.testCases.length).toBeGreaterThan(0);
    expect(parsed.testCases[0]).not.toHaveProperty('ai');

    // Cross-tenant artifact access is denied as not-found.
    const cross = await app.inject({
      method: 'GET',
      url: `/v1/artifacts/${jobId}/files/test-cases.ui.json`,
      headers: GLOBEX,
    });
    expect(cross.statusCode).toBe(404);

    // Non-allow-listed file names are rejected outright.
    const evil = await app.inject({
      method: 'GET',
      url: `/v1/artifacts/${jobId}/files/..%2F..%2Fetc%2Fpasswd`,
      headers: ACME,
    });
    expect([400, 404]).toContain(evil.statusCode);
  });

  it('rejects invalid TENANT_API_KEYS formats at startup', () => {
    expect(() =>
      loadEnv({ ...process.env, NOVITA_API_KEY: 'sk_x', TENANT_API_KEYS: 'no-colon-entry' }),
    ).toThrow(/tenant:key/);
    expect(() =>
      loadEnv({
        ...process.env,
        NOVITA_API_KEY: 'sk_x',
        TENANT_API_KEYS: 'a:dup,b:dup',
      }),
    ).toThrow(/unique/);
    expect(() =>
      loadEnv({
        ...process.env,
        NOVITA_API_KEY: 'sk_x',
        TENANT_API_KEYS: 'bad/tenant:key1',
      }),
    ).toThrow(/Invalid tenant id/);
  });
});
