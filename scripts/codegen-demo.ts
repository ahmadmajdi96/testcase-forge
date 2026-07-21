/**
 * Real-Novita codegen demo. Boots the service in-process, POSTs a codegen
 * request against a persisted test-generation job (exactly what a client app
 * would do), polls the trace, and prints one generated spec file.
 *
 * Usage: NOVITA_API_KEY=sk_... tsx scripts/codegen-demo.ts <sourceJobId> [limit]
 */
import { buildApp } from '../src/api/app.js';
import { loadEnv } from '../src/config/env.js';

const sourceJobId = process.argv[2];
const limit = Number(process.argv[3] ?? 8);
if (!sourceJobId) throw new Error('usage: codegen-demo.ts <sourceJobId> [limit]');

async function main() {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
  });
  const { app } = await buildApp(env);

  const start = await app.inject({
    method: 'POST',
    url: '/v1/codegen',
    headers: { 'content-type': 'application/json' },
    payload: {
      sourceJobId,
      options: {
        baseUrl: 'http://localhost:3000',
        envVars: ['TEST_USER_EMAIL', 'TEST_USER_PASSWORD', 'SUPABASE_URL', 'RAG_BASE_URL'],
        include: { testTypes: ['e2e'], limit },
        concurrency: 3,
      },
    },
  });
  if (start.statusCode !== 202) throw new Error(`submit failed: ${start.body}`);
  const jobId = start.json().id as string;
  console.log(`▶ Codegen job ${jobId} accepted (source ${sourceJobId}, limit ${limit} e2e cases)`);

  let final: Record<string, unknown> = {};
  for (let i = 0; i < 600; i += 1) {
    final = (await app.inject({ method: 'GET', url: `/v1/codegen/${jobId}` })).json();
    const p = final.progress as { completedFiles: number; totalFiles: number };
    process.stdout.write(`\r  ${final.status} files=${p.completedFiles}/${p.totalFiles}   `);
    if (['completed', 'completed_with_errors', 'failed'].includes(String(final.status))) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('\n');

  const trace = (await app.inject({ method: 'GET', url: `/v1/codegen/${jobId}/trace` })).json()
    .trace as { seq: number; ts: string; type: string; message: string }[];
  console.log('── Trace (full audit log) ──');
  for (const e of trace) console.log(`  ${e.seq}. [${e.ts.slice(11, 19)}] ${e.type}: ${e.message}`);

  const files = (await app.inject({ method: 'GET', url: `/v1/codegen/${jobId}/files` })).json()
    .files as string[];
  console.log('\n── Persisted files ──');
  for (const f of files) console.log(`  ${f}`);

  const spec = files.find((f) => f.startsWith('tests/') && f.endsWith('.spec.ts') && f !== 'tests/auth.setup.ts');
  if (spec) {
    const content = (
      await app.inject({ method: 'GET', url: `/v1/codegen/${jobId}/files/${spec}` })
    ).body;
    console.log(`\n── ${spec} (first 80 lines) ──`);
    console.log(content.split('\n').slice(0, 80).join('\n'));
  }

  const usage = final.usage as Record<string, number>;
  console.log(`\n▶ Status: ${final.status} | tokens prompt=${usage.promptTokens} completion=${usage.completionTokens}`);
  await app.close();
  process.exit(final.status === 'failed' ? 1 : 0);
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
