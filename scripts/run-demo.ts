/**
 * Full pipeline demo against a real target app:
 *   codegen (fresh, with functional auth setup) -> test run in an isolated
 *   Playwright container -> live progress -> videos/screenshots/traces.
 *
 * Usage:
 *   NOVITA_API_KEY=... TEST_USER_EMAIL=... TEST_USER_PASSWORD=... \
 *     tsx scripts/run-demo.ts <sourceTestGenJobId> <baseUrl> [limit]
 *
 * Credentials are read from the environment and passed only into the run's
 * container env; they are never printed or persisted.
 */
import { buildApp } from '../src/api/app.js';
import { loadEnv } from '../src/config/env.js';

const [sourceJobId, baseUrl, limitArg] = process.argv.slice(2);
const limit = Number(limitArg ?? 3);
if (!sourceJobId || !baseUrl) {
  throw new Error('usage: run-demo.ts <sourceTestGenJobId> <baseUrl> [limit]');
}
for (const name of ['TEST_USER_EMAIL', 'TEST_USER_PASSWORD']) {
  if (!process.env[name]) throw new Error(`Missing ${name} in environment`);
}

async function main() {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
  });
  const { app } = await buildApp(env);

  // 1. Fresh codegen (picks up the functional auth.setup scaffold).
  console.log(`▶ Codegen: ${limit} UI e2e case(s) from ${sourceJobId}`);
  const cg = await app.inject({
    method: 'POST',
    url: '/v1/codegen',
    headers: { 'content-type': 'application/json' },
    payload: {
      sourceJobId,
      options: {
        baseUrl,
        envVars: ['TEST_USER_EMAIL', 'TEST_USER_PASSWORD', 'AUTH_PATH'],
        include: { testTypes: ['e2e'], limit },
        concurrency: 3,
      },
    },
  });
  if (cg.statusCode !== 202) throw new Error(`codegen submit failed: ${cg.body}`);
  const codegenJobId = cg.json().id as string;
  let cgFinal: Record<string, unknown> = {};
  for (let i = 0; i < 300; i += 1) {
    cgFinal = (await app.inject({ method: 'GET', url: `/v1/codegen/${codegenJobId}` })).json();
    if (['completed', 'completed_with_errors', 'failed'].includes(String(cgFinal.status))) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`▶ Codegen ${cgFinal.status}: ${(cgFinal.progress as { completedFiles: number }).completedFiles} spec file(s)`);
  if (cgFinal.status === 'failed') throw new Error('codegen failed');

  // 2. Client-triggered run with env values (memory-only).
  const run = await app.inject({
    method: 'POST',
    url: '/v1/test-runs',
    headers: { 'content-type': 'application/json' },
    payload: {
      codegenJobId,
      options: {
        baseUrl,
        env: {
          TEST_USER_EMAIL: process.env.TEST_USER_EMAIL!,
          TEST_USER_PASSWORD: process.env.TEST_USER_PASSWORD!,
          AUTH_PATH: '/auth',
        },
        timeoutMs: 600_000,
      },
    },
  });
  if (run.statusCode !== 202) throw new Error(`run submit failed: ${run.body}`);
  const runId = run.json().id as string;
  console.log(`▶ Test run ${runId} started (mode: ${run.json().options.mode})`);

  // 3. Live progress (the SSE endpoint carries the same events; polled here for CLI display).
  let final: Record<string, unknown> = {};
  let lastEventCount = 0;
  for (let i = 0; i < 900; i += 1) {
    final = (await app.inject({ method: 'GET', url: `/v1/test-runs/${runId}?_=${i}` })).json();
    const p = final.progress as Record<string, number>;
    process.stdout.write(
      `\r  ${final.status} tests=${p.finishedTests}/${p.totalTests} passed=${p.passed} failed=${p.failed} events=${final.eventCount}   `,
    );
    lastEventCount = Number(final.eventCount ?? lastEventCount);
    if (['completed', 'failed', 'timed_out', 'cancelled'].includes(String(final.status))) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('\n');

  // 4. The SSE stream itself (replayed): prove the live-view payload.
  const sse = await app.inject({ method: 'GET', url: `/v1/test-runs/${runId}/events` });
  const frames = sse.body.split('\n\n').filter((f) => f.startsWith('id:'));
  console.log(`── SSE stream: ${frames.length} events ──`);
  for (const frame of frames) {
    const type = frame.match(/event: (.*)/)?.[1] ?? '?';
    const data = frame.match(/data: (.*)/)?.[1] ?? '';
    console.log(`  ${type.padEnd(20)} ${data.slice(0, 110)}`);
  }

  // 5. Evidence.
  console.log('\n── Test results ──');
  for (const t of final.tests as { title: string; status: string; durationMs: number; error: string | null }[]) {
    console.log(`  [${t.status.toUpperCase()}] ${t.title} (${Math.round(t.durationMs)}ms)${t.error ? ` — ${t.error.slice(0, 100)}` : ''}`);
  }
  const artifacts = (
    await app.inject({ method: 'GET', url: `/v1/test-runs/${runId}/artifacts` })
  ).json();
  console.log('\n── Persisted artifacts ──');
  for (const f of artifacts.files as { path: string; bytes: number; contentType: string }[]) {
    console.log(`  ${f.path} (${f.bytes} bytes, ${f.contentType})`);
  }

  await app.close();
  console.log(`\n✅ Run ${final.status}; artifacts at artifacts/default/runs/${runId}/`);
  process.exit(['completed'].includes(String(final.status)) ? 0 : 1);
}

main().catch((err) => {
  console.error('\n❌ demo failed:', err);
  process.exit(1);
});
