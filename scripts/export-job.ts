/**
 * Runs a real Novita generation job and writes the results to disk so the
 * generated test cases are accessible after the process exits.
 *
 * Usage:
 *   NOVITA_API_KEY=sk_... tsx scripts/export-job.ts [sourceDir] [file1,file2,...]
 *
 * Output (under artifacts/<jobId>/):
 *   job.json                 status, progress, coverage report, usage
 *   coverage.json            coverage report only
 *   test-cases.full.json     every case incl. hidden AI context (for the code model)
 *   test-cases.ui.json       UI view only (exactly the Create Test Case fields)
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../src/api/app.js';
import { loadEnv } from '../src/config/env.js';

const SOURCE_DIR = process.argv[2] ?? '/Users/ahmadsalameh/Downloads/jobsss/extracted';
const FILE_FILTER = process.argv[3]?.split(',').map((s) => s.trim()).filter(Boolean);
const POLL_CAP = Number(process.env.POLL_CAP ?? 3600); // seconds

function loadFiles() {
  const names = readdirSync(SOURCE_DIR).filter((n) => n.endsWith('.md') || n.endsWith('.json'));
  const chosen = FILE_FILTER
    ? names.filter((n) => FILE_FILTER.some((f) => n.includes(f)))
    : names;
  if (chosen.length === 0) throw new Error(`No matching files in ${SOURCE_DIR}`);
  return chosen.map((name) => ({ filename: name, content: readFileSync(join(SOURCE_DIR, name), 'utf8') }));
}

async function main() {
  const env = loadEnv({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: process.env.LOG_LEVEL ?? 'error' });
  const { app, novita } = await buildApp(env);

  if (!(await novita.ping())) throw new Error('Novita unreachable; check NOVITA_API_KEY.');
  const files = loadFiles();
  console.log(`▶ Model ${env.NOVITA_MODEL} | ${files.length} file(s): ${files.map((f) => f.filename).join(', ')}`);

  const submit = await app.inject({
    method: 'POST',
    url: '/v1/test-generations',
    headers: { 'content-type': 'application/json' },
    payload: { files },
  });
  if (submit.statusCode !== 202) throw new Error(`submit failed: ${submit.statusCode} ${submit.body}`);
  const jobId = submit.json().id as string;
  console.log(`▶ Job ${jobId} accepted (${submit.json().specStats.itemCount} coverage items).`);

  let final: Record<string, unknown> = {};
  for (let i = 0; i < POLL_CAP; i += 1) {
    final = (await app.inject({ method: 'GET', url: `/v1/test-generations/${jobId}` })).json();
    const p = final.progress as { completedUnits: number; totalUnits: number; generatedCases: number };
    process.stdout.write(`\r  ${final.status} units=${p.completedUnits}/${p.totalUnits} cases=${p.generatedCases}    `);
    if (['completed', 'completed_with_gaps', 'failed', 'cancelled'].includes(String(final.status))) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('');

  const full = (await app.inject({ method: 'GET', url: `/v1/test-generations/${jobId}/test-cases` })).json();
  const ui = (await app.inject({ method: 'GET', url: `/v1/test-generations/${jobId}/test-cases?view=ui` })).json();

  const outDir = join(process.cwd(), 'artifacts', jobId);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'job.json'), JSON.stringify(final, null, 2));
  writeFileSync(join(outDir, 'coverage.json'), JSON.stringify(final.coverage, null, 2));
  writeFileSync(join(outDir, 'test-cases.full.json'), JSON.stringify(full, null, 2));
  writeFileSync(join(outDir, 'test-cases.ui.json'), JSON.stringify(ui, null, 2));

  const cov = final.coverage as Record<string, unknown> | null;
  console.log(`\n▶ Status: ${final.status}`);
  if (cov) {
    console.log(`▶ Coverage: ${cov.coveredItems}/${cov.totalItems} (ratio ${cov.coverageRatio}), ${cov.totalCases} cases, P0 complete: ${cov.p0FullyCovered}`);
  }
  console.log(`\n✅ Written to:\n  ${outDir}/`);
  console.log(`     job.json  coverage.json  test-cases.full.json  test-cases.ui.json`);
  await app.close();
  process.exit(final.status === 'failed' ? 1 : 0);
}

main().catch((err) => {
  console.error('\n❌ Export failed:', err);
  process.exit(1);
});
