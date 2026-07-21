import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { loadEnv } from '../src/config/env.js';
import { planFiles, sanitizeSpecPath } from '../src/codegen/planner.js';
import { extractCode } from '../src/codegen/generator.js';
import { normalizeTestCase } from '../src/coverage/normalize.js';
import type { GenerationUnit } from '../src/domain/spec.js';

const ACME = { authorization: 'Bearer sk_acme_test' };
const GLOBEX = { authorization: 'Bearer sk_globex_test' };

// ---------- unit: path sanitization + planning ----------

describe('codegen planner', () => {
  it('sanitizes hostile spec paths', () => {
    expect(sanitizeSpecPath('../../etc/passwd', 's')).toBe('tests/etc/passwd.spec.ts');
    expect(sanitizeSpecPath('/abs/path.spec.ts', 's')).toBe('tests/abs/path.spec.ts');
    expect(sanitizeSpecPath('weird name!!.ts', 's')).toBe('tests/weird-name--.spec.ts');
    expect(sanitizeSpecPath(undefined, 'api-contract')).toBe('tests/api-contract.spec.ts');
    expect(sanitizeSpecPath('tests/e2e/cases.spec.ts', 's')).toBe('tests/e2e/cases.spec.ts');
  });

  it('splits oversized groups into part files', () => {
    const unit: GenerationUnit = {
      id: 'U-0001', suite: 's', testType: 'e2e',
      items: [], minCases: 0,
    };
    const mk = (n: number) =>
      normalizeTestCase(
        {
          title: `Case ${n}`,
          steps: [{ action: 'a', expectedResult: 'b' }],
          coveredItemIds: [],
          playwright: { suggestedFile: 'tests/big.spec.ts' },
        } as never,
        {
          jobId: '12345678-aaaa-bbbb-cccc-000000000000',
          unit, model: 'm', origin: 'model',
          createdAt: new Date().toISOString(), sequence: n,
        },
      );
    const cases = Array.from({ length: 7 }, (_, i) => mk(i + 1));
    const plans = planFiles(cases, 3);
    expect(plans.map((p) => p.path)).toEqual([
      'tests/big.spec.ts',
      'tests/big.part2.spec.ts',
      'tests/big.part3.spec.ts',
    ]);
    expect(plans.map((p) => p.cases.length)).toEqual([3, 3, 1]);
  });
});

describe('code extraction', () => {
  it('prefers fenced blocks and tolerates raw output', () => {
    expect(extractCode('Here you go:\n```ts\nconst a = 1;\n```\nDone.')).toBe('const a = 1;\n');
    expect(extractCode("import { test } from '@playwright/test';")).toBe(
      "import { test } from '@playwright/test';\n",
    );
  });
});

// ---------- integration: testgen -> codegen through the API ----------

const SPEC_MD =
  '# API\n\n## Endpoints\n\n| ID | Item | Priority |\n|---|---|---|\n| CONTRACT-001 | POST /api/one | P0 |\n| CONTRACT-002 | GET /api/two | P1 |\n';

const FAKE_SPEC = `import { test, expect } from '@playwright/test';
// traceability: {{IDS}}
test.describe('generated', () => {
  test('covers everything', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\\//);
  });
});
`;

function dualFetch(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    // Test-generation calls use structured output; codegen calls do not.
    if (body.response_format) {
      const userMsg: string = body.messages?.[1]?.content ?? '';
      const ids = [...new Set([...userMsg.matchAll(/\bCI-[A-Z]+-\d{4}\b/g)].map((m) => m[0]))];
      const testCases = [{
        title: 'Case one', description: 'd', preconditions: 'p', expectedResult: 'e',
        status: 'Ready', priority: 'P0', coverageTags: ['api'],
        steps: [{ action: 'open', expectedResult: 'ok' }, { action: 'check', expectedResult: 'ok' }],
        testType: 'e2e', suite: 'ui-e2e', authState: 'authenticated',
        selectors: [], networkMocks: [], fixtures: [], seedData: [], cleanup: [],
        assertions: [{ kind: 'visible', target: 'x', matcher: 'toBeVisible', expected: '' }],
        dataInputs: { valid: [], invalid: [], boundary: [] },
        edgeCaseClass: 'happy_path', riskLevel: 'high', flakinessRisk: 'low',
        estimatedDurationMs: 1000,
        playwright: {
          suggestedFile: 'tests/e2e/one.spec.ts', describeBlock: 'One', testTitle: 'one',
          tags: [], requiresAuth: true, storageStateKey: 'user', viewport: 'desktop',
          locale: 'en', parallelSafe: true, timeoutMs: 30000, retries: 0,
          capturesVisualSnapshot: false, runsAccessibilityScan: false,
        },
        coveredItemIds: ids, upstreamIds: [], evidenceGaps: [], generationNotes: '',
      }];
      return new Response(JSON.stringify({
        model: 'mock',
        choices: [{ message: { content: JSON.stringify({ testCases }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }), { status: 200 });
    }
    // Codegen: echo the case ids it was asked to implement.
    const userMsg: string = body.messages?.[1]?.content ?? '';
    const tcIds = [...new Set([...userMsg.matchAll(/\bTC-[0-9a-f]{8}-\d{4}\b/g)].map((m) => m[0]))];
    const code = FAKE_SPEC.replace('{{IDS}}', tcIds.join(', '));
    return new Response(JSON.stringify({
      model: 'mock',
      choices: [{ message: { content: '```ts\n' + code + '```' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function waitJson(
  app: FastifyInstance,
  url: string,
  headers: Record<string, string>,
  terminal: string[],
): Promise<Record<string, never>> {
  for (let i = 0; i < 150; i += 1) {
    const res = await app.inject({ method: 'GET', url, headers });
    const json = res.json();
    if (terminal.includes(json.status)) return json;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no terminal status at ${url}`);
}

describe('codegen API (mocked Novita)', () => {
  let app: FastifyInstance;
  let artifactsDir: string;
  let sourceJobId: string;

  beforeEach(async () => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'tcf-codegen-'));
    const env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      NOVITA_API_KEY: 'sk_x',
      SERVICE_API_KEYS: '',
      TENANT_API_KEYS: 'acme:sk_acme_test,globex:sk_globex_test',
      ARTIFACTS_DIR: artifactsDir,
    });
    ({ app } = await buildApp(env, { fetchImpl: dualFetch() }));

    const submit = await app.inject({
      method: 'POST',
      url: '/v1/test-generations',
      headers: { ...ACME, 'content-type': 'application/json' },
      payload: { files: [{ filename: 'api.md', content: SPEC_MD }] },
    });
    sourceJobId = submit.json().id;
    await waitJson(app, `/v1/test-generations/${sourceJobId}`, ACME, [
      'completed', 'completed_with_gaps',
    ]);
  });

  afterEach(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('generates a traceable suite from a completed source job', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/v1/codegen',
      headers: { ...ACME, 'content-type': 'application/json' },
      payload: {
        sourceJobId,
        options: { envVars: ['TEST_USER_EMAIL', 'TEST_USER_PASSWORD'], baseUrl: 'http://localhost:4000' },
      },
    });
    expect(start.statusCode).toBe(202);
    const jobId = start.json().id as string;

    const final = await waitJson(app, `/v1/codegen/${jobId}`, ACME, [
      'completed', 'completed_with_errors', 'failed',
    ]);
    expect(final.status).toBe('completed');
    expect(final.progress.completedFiles).toBeGreaterThan(0);
    expect(final.files[0].caseIds.length).toBeGreaterThan(0);

    // Full trace: every lifecycle event, in order.
    const trace = (
      await app.inject({ method: 'GET', url: `/v1/codegen/${jobId}/trace`, headers: ACME })
    ).json().trace as { type: string; seq: number }[];
    const types = trace.map((t) => t.type);
    for (const expected of ['job_created', 'source_loaded', 'plan_created', 'scaffold_written', 'file_started', 'file_completed', 'persisted', 'job_finished']) {
      expect(types).toContain(expected);
    }
    expect(trace.map((t) => t.seq)).toEqual(trace.map((_, i) => i + 1));

    // Files persisted and downloadable, spec references its case ids.
    const files = (
      await app.inject({ method: 'GET', url: `/v1/codegen/${jobId}/files`, headers: ACME })
    ).json().files as string[];
    expect(files).toContain('playwright.config.ts');
    expect(files).toContain('tests/e2e/one.spec.ts');
    const spec = (
      await app.inject({
        method: 'GET',
        url: `/v1/codegen/${jobId}/files/tests/e2e/one.spec.ts`,
        headers: ACME,
      })
    ).body;
    expect(spec).toContain('@playwright/test');
    expect(spec).toMatch(/TC-[0-9a-f]{8}-\d{4}/);

    // Env vars present by NAME in the scaffold, never with values.
    const envFile = (
      await app.inject({
        method: 'GET',
        url: `/v1/codegen/${jobId}/files/.env.example`,
        headers: ACME,
      })
    ).body;
    expect(envFile).toContain('TEST_USER_EMAIL=');
    expect(envFile).toContain('TEST_USER_PASSWORD=');

    // Bundle returns everything at once.
    const bundle = (
      await app.inject({ method: 'GET', url: `/v1/codegen/${jobId}/bundle`, headers: ACME })
    ).json();
    expect(bundle.fileCount).toBe(files.length);
  });

  it('is tenant-isolated end to end', async () => {
    // Globex cannot codegen from Acme's source job.
    const cross = await app.inject({
      method: 'POST',
      url: '/v1/codegen',
      headers: { ...GLOBEX, 'content-type': 'application/json' },
      payload: { sourceJobId },
    });
    expect(cross.statusCode).toBe(202); // accepted, then fails on source load
    const failed = await waitJson(app, `/v1/codegen/${cross.json().id}`, GLOBEX, ['failed']);
    expect(failed.error.code).toBe('not_found');

    // And cannot read Acme's codegen output.
    const start = await app.inject({
      method: 'POST',
      url: '/v1/codegen',
      headers: { ...ACME, 'content-type': 'application/json' },
      payload: { sourceJobId },
    });
    const jobId = start.json().id as string;
    await waitJson(app, `/v1/codegen/${jobId}`, ACME, ['completed']);
    const denied = await app.inject({
      method: 'GET',
      url: `/v1/codegen/${jobId}/files`,
      headers: GLOBEX,
    });
    expect(denied.statusCode).toBe(404);
  });

  it('rejects malformed requests', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/codegen',
      headers: { ...ACME, 'content-type': 'application/json' },
      payload: { sourceJobId: 'not-a-uuid' },
    });
    expect(bad.statusCode).toBe(400);

    const badEnv = await app.inject({
      method: 'POST',
      url: '/v1/codegen',
      headers: { ...ACME, 'content-type': 'application/json' },
      payload: { sourceJobId, options: { envVars: ['lower_case_bad'] } },
    });
    expect(badEnv.statusCode).toBe(400);
  });
});
