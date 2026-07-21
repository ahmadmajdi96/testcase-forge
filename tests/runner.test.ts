import { mkdtempSync, rmSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { loadEnv } from '../src/config/env.js';
import type { ExecutorFactory } from '../src/runner/executor.js';

const ACME = { authorization: 'Bearer sk_acme_test' };
const GLOBEX = { authorization: 'Bearer sk_globex_test' };

const SPEC_MD =
  '# API\n\n## Endpoints\n\n| ID | Item | Priority |\n|---|---|---|\n| CONTRACT-001 | POST /api/one | P0 |\n';

const FAKE_SPEC = `import { test, expect } from '@playwright/test';
// traceability: generated from testcase-forge; used by runner pipeline tests.
test.describe('generated suite', () => {
  test('generated test', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\\//);
  });
});
`;

/** Mocked Novita: covering testgen batches + a codegen spec file. */
function dualFetch(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.response_format) {
      const userMsg: string = body.messages?.[1]?.content ?? '';
      const ids = [...new Set([...userMsg.matchAll(/\bCI-[A-Z]+-\d{4}\b/g)].map((m) => m[0]))];
      const testCases = [{
        title: 'Case', description: 'd', preconditions: 'p', expectedResult: 'e',
        status: 'Ready', priority: 'P0', coverageTags: ['api'],
        steps: [{ action: 'a', expectedResult: 'b' }, { action: 'c', expectedResult: 'd' }],
        testType: 'e2e', suite: 'ui-e2e', authState: 'authenticated',
        selectors: [], networkMocks: [], fixtures: [], seedData: [], cleanup: [],
        assertions: [{ kind: 'visible', target: 'x', matcher: 'toBeVisible', expected: '' }],
        dataInputs: { valid: [], invalid: [], boundary: [] },
        edgeCaseClass: 'happy_path', riskLevel: 'high', flakinessRisk: 'low',
        estimatedDurationMs: 1000,
        playwright: {
          suggestedFile: 'tests/one.spec.ts', describeBlock: 'One', testTitle: 'one',
          tags: [], requiresAuth: true, storageStateKey: 'user', viewport: 'desktop',
          locale: 'en', parallelSafe: true, timeoutMs: 30000, retries: 0,
          capturesVisualSnapshot: false, runsAccessibilityScan: false,
        },
        coveredItemIds: ids, upstreamIds: [], evidenceGaps: [], generationNotes: '',
      }];
      return new Response(JSON.stringify({
        model: 'mock',
        choices: [{ message: { content: JSON.stringify({ testCases }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      model: 'mock',
      choices: [{ message: { content: '```ts\n' + FAKE_SPEC + '```' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** Simulates a Playwright run: streams reporter events, drops a video, exits 0. */
const fakeExecutor: ExecutorFactory = async (opts) => {
  let killed = false;
  const done = (async () => {
    const results = join(opts.workspace, 'results');
    const events = join(results, 'events.jsonl');
    await mkdir(results, { recursive: true });
    const emit = (e: Record<string, unknown>) =>
      appendFile(events, `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`);

    await emit({ type: 'run_started', totalTests: 2, workers: 1 });
    await new Promise((r) => setTimeout(r, 60));
    if (killed) return 137;
    await emit({ type: 'test_started', title: 'login works', file: 'tests/one.spec.ts', line: 3 });
    await new Promise((r) => setTimeout(r, 60));
    const videoDir = join(opts.workspace, 'test-results', 'one');
    await mkdir(videoDir, { recursive: true });
    await writeFile(join(videoDir, 'video.webm'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    await emit({
      type: 'test_finished', title: 'login works', file: 'tests/one.spec.ts',
      status: 'passed', durationMs: 1200, retry: 0, error: null,
      attachments: [{ name: 'video', path: 'test-results/one/video.webm', contentType: 'video/webm' }],
    });
    await emit({
      type: 'test_finished', title: 'broken thing', file: 'tests/one.spec.ts',
      status: 'failed', durationMs: 800, retry: 0, error: 'expected visible', attachments: [],
    });
    await emit({ type: 'run_finished', status: 'failed' });
    // Secrets must have been passed through as env values.
    if (opts.envValues.TEST_USER_EMAIL !== 'qa@example.com') return 99;
    return 1; // playwright exits 1 when tests failed
  })();
  return { done, kill: async () => { killed = true; } };
};

async function waitJson(app: FastifyInstance, url: string, headers: Record<string, string>, terminal: string[]) {
  for (let i = 0; i < 200; i += 1) {
    const json = (await app.inject({ method: 'GET', url, headers })).json();
    if (terminal.includes(json.status)) return json;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no terminal status at ${url}`);
}

describe('test runner (fake executor)', () => {
  let app: FastifyInstance;
  let artifactsDir: string;
  let workspaceDir: string;
  let codegenJobId: string;

  beforeEach(async () => {
    artifactsDir = mkdtempSync(join(tmpdir(), 'tcf-run-art-'));
    workspaceDir = mkdtempSync(join(tmpdir(), 'tcf-run-ws-'));
    const env = loadEnv({
      ...process.env,
      NODE_ENV: 'test',
      NOVITA_API_KEY: 'sk_x',
      SERVICE_API_KEYS: '',
      TENANT_API_KEYS: 'acme:sk_acme_test,globex:sk_globex_test',
      ARTIFACTS_DIR: artifactsDir,
      RUNNER_MODE: 'subprocess',
      RUNNER_WORKSPACE_DIR: workspaceDir,
    });
    ({ app } = await buildApp(env, { fetchImpl: dualFetch(), runnerExec: fakeExecutor }));

    const gen = await app.inject({
      method: 'POST', url: '/v1/test-generations',
      headers: { ...ACME, 'content-type': 'application/json' },
      payload: { files: [{ filename: 'api.md', content: SPEC_MD }] },
    });
    await waitJson(app, `/v1/test-generations/${gen.json().id}`, ACME, ['completed', 'completed_with_gaps']);
    const cg = await app.inject({
      method: 'POST', url: '/v1/codegen',
      headers: { ...ACME, 'content-type': 'application/json' },
      payload: { sourceJobId: gen.json().id, options: { envVars: ['TEST_USER_EMAIL'] } },
    });
    codegenJobId = cg.json().id;
    await waitJson(app, `/v1/codegen/${codegenJobId}`, ACME, ['completed']);
  });

  afterEach(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function startRun() {
    return app.inject({
      method: 'POST', url: '/v1/test-runs',
      headers: { ...ACME, 'content-type': 'application/json' },
      payload: {
        codegenJobId,
        options: {
          baseUrl: 'https://app.example.com',
          env: { TEST_USER_EMAIL: 'qa@example.com', TEST_USER_PASSWORD: 'hunter2secret' },
        },
      },
    });
  }

  it('runs a suite with live results, artifacts and no secret leakage', async () => {
    const start = await startRun();
    expect(start.statusCode).toBe(202);
    const runId = start.json().id as string;
    // Env NAMES are visible; values are not.
    expect(start.json().options.envNames).toEqual(['TEST_USER_EMAIL', 'TEST_USER_PASSWORD']);
    expect(JSON.stringify(start.json())).not.toContain('hunter2secret');

    const final = await waitJson(app, `/v1/test-runs/${runId}`, ACME, [
      'completed', 'failed', 'timed_out',
    ]);
    expect(final.status).toBe('completed'); // exit 1 with results = completed run
    expect(final.exitCode).toBe(1);
    expect(final.progress).toMatchObject({ totalTests: 2, finishedTests: 2, passed: 1, failed: 1 });
    expect(final.tests.find((t: { title: string }) => t.title === 'login works').status).toBe('passed');
    expect(JSON.stringify(final)).not.toContain('hunter2secret');

    // SSE: full replay ends with run_terminal.
    const sse = await app.inject({
      method: 'GET', url: `/v1/test-runs/${runId}/events`, headers: ACME,
    });
    expect(sse.headers['content-type']).toContain('text/event-stream');
    expect(sse.body).toContain('event: run_created');
    expect(sse.body).toContain('event: test_finished');
    expect(sse.body).toContain('event: run_terminal');
    expect(sse.body).not.toContain('hunter2secret');

    // Artifacts: video persisted and binary-downloadable; manifest has no secrets.
    const artifacts = await app.inject({
      method: 'GET', url: `/v1/test-runs/${runId}/artifacts`, headers: ACME,
    });
    const files = artifacts.json().files as { path: string }[];
    expect(files.some((f) => f.path === 'test-results/one/video.webm')).toBe(true);
    expect(JSON.stringify(artifacts.json())).not.toContain('hunter2secret');

    const video = await app.inject({
      method: 'GET',
      url: `/v1/test-runs/${runId}/artifacts/test-results/one/video.webm`,
      headers: ACME,
    });
    expect(video.statusCode).toBe(200);
    expect(video.headers['content-type']).toBe('video/webm');

    // Cross-tenant: everything is 404 for globex.
    for (const url of [
      `/v1/test-runs/${runId}`,
      `/v1/test-runs/${runId}/artifacts`,
      `/v1/test-runs/${runId}/events`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: GLOBEX });
      expect(res.statusCode).toBe(404);
    }
  });

  it('enforces per-tenant active run caps', async () => {
    // Default cap is 2; a third concurrent run is rejected.
    const a = await startRun();
    const b = await startRun();
    const c = await startRun();
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(c.statusCode).toBe(429);
    await waitJson(app, `/v1/test-runs/${a.json().id}`, ACME, ['completed', 'failed']);
    await waitJson(app, `/v1/test-runs/${b.json().id}`, ACME, ['completed', 'failed']);
  });

  it('rejects invalid env keys and missing baseUrl', async () => {
    const bad = await app.inject({
      method: 'POST', url: '/v1/test-runs',
      headers: { ...ACME, 'content-type': 'application/json' },
      payload: { codegenJobId, options: { baseUrl: 'not-a-url', env: {} } },
    });
    expect(bad.statusCode).toBe(400);
    const badEnv = await app.inject({
      method: 'POST', url: '/v1/test-runs',
      headers: { ...ACME, 'content-type': 'application/json' },
      payload: {
        codegenJobId,
        options: { baseUrl: 'https://x.example.com', env: { 'bad-key': 'v' } },
      },
    });
    expect(badEnv.statusCode).toBe(400);
  });
});
