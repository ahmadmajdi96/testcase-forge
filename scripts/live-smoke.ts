/**
 * Real Novita end-to-end smoke test. No mocks.
 *
 * Boots the full service in-process, submits a subset of the actual uploaded
 * specification documents, polls until the job is terminal, and prints a
 * coverage summary plus one rendered UI test case and its hidden AI context.
 *
 * Usage:
 *   NOVITA_API_KEY=sk_... tsx scripts/live-smoke.ts [dir-with-md-and-json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../src/api/app.js';
import { loadEnv } from '../src/config/env.js';

const SOURCE_DIR =
  process.argv[2] ?? '/Users/ahmadsalameh/Downloads/jobsss/extracted';

function loadFiles(dir: string) {
  const names = readdirSync(dir).filter(
    (n) => n.endsWith('.md') || n.endsWith('.json'),
  );
  // Keep the smoke run cheap: two representative documents, one md + one json.
  const chosen = [
    names.find((n) => n.includes('02_api')) ?? names.find((n) => n.endsWith('.md')),
    names.find((n) => n.includes('test_generation_context')) ??
      names.find((n) => n.endsWith('.json')),
  ].filter(Boolean) as string[];

  return chosen.map((name) => ({
    filename: name,
    content: readFileSync(join(dir, name), 'utf8'),
  }));
}

async function main() {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
    MAX_ITEMS_PER_UNIT: process.env.MAX_ITEMS_PER_UNIT ?? '6',
    GENERATION_CONCURRENCY: process.env.GENERATION_CONCURRENCY ?? '3',
  });

  const { app, novita } = await buildApp(env);
  console.log(`\n▶ Novita model: ${env.NOVITA_MODEL}`);
  const reachable = await novita.ping();
  console.log(`▶ Novita reachable: ${reachable}`);
  if (!reachable) throw new Error('Novita is unreachable; check NOVITA_API_KEY.');

  const files = loadFiles(SOURCE_DIR);
  console.log(`▶ Submitting ${files.length} document(s): ${files.map((f) => f.filename).join(', ')}`);

  const submit = await app.inject({
    method: 'POST',
    url: '/v1/test-generations',
    headers: { 'content-type': 'application/json' },
    payload: { files, options: { maxItemsPerUnit: 6 } },
  });
  if (submit.statusCode !== 202) {
    throw new Error(`submit failed: ${submit.statusCode} ${submit.body}`);
  }
  const jobId = submit.json().id as string;
  const specStats = submit.json().specStats;
  console.log(`▶ Job ${jobId} accepted. Extracted ${specStats.itemCount} coverage items.`);
  console.log('  items by kind:', specStats.itemsByKind);

  const started = Date.now();
  let final: Record<string, unknown> = {};
  for (let i = 0; i < 600; i += 1) {
    const res = await app.inject({ method: 'GET', url: `/v1/test-generations/${jobId}` });
    final = res.json();
    const progress = final.progress as { completedUnits: number; totalUnits: number; generatedCases: number };
    process.stdout.write(
      `\r  status=${final.status} units=${progress.completedUnits}/${progress.totalUnits} cases=${progress.generatedCases}   `,
    );
    if (['completed', 'completed_with_gaps', 'failed', 'cancelled'].includes(String(final.status))) {
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('');

  const coverage = final.coverage as Record<string, unknown> | null;
  const usage = final.usage as Record<string, unknown>;
  console.log(`\n▶ Terminal status: ${final.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (final.error) console.log('  error:', final.error);
  if (coverage) {
    console.log(
      `▶ Coverage: ${coverage.coveredItems}/${coverage.totalItems} items (ratio ${coverage.coverageRatio}), ` +
        `${coverage.totalCases} cases, P0 fully covered: ${coverage.p0FullyCovered}`,
    );
    const uncovered = coverage.uncovered as { id: string; title: string }[];
    if (uncovered.length) {
      console.log(`  first uncovered: ${uncovered.slice(0, 5).map((u) => u.id).join(', ')}`);
    }
  }
  console.log(`▶ Tokens: prompt=${usage.promptTokens} completion=${usage.completionTokens}`);

  // Show one UI case (what the app renders) and its hidden AI context.
  const full = await app.inject({
    method: 'GET',
    url: `/v1/test-generations/${jobId}/test-cases`,
  });
  const cases = full.json().testCases as Record<string, unknown>[];
  if (cases.length > 0) {
    const sample = cases[0]!;
    const ui = sample.ui as Record<string, unknown>;
    const ai = sample.ai as Record<string, unknown>;
    console.log('\n── Sample test case (UI view — shown in the app) ──');
    console.log('Title:', ui.title);
    console.log('Priority:', ui.priorityLabel, '| Status:', ui.status);
    console.log('Preconditions:', ui.preconditions);
    console.log('Steps:');
    for (const step of ui.steps as { index: number; action: string; expectedResult: string }[]) {
      console.log(`  ${step.index}. ${step.action}\n     → ${step.expectedResult}`);
    }
    console.log('Coverage tags:', (ui.coverageTags as string[]).join(', '));
    console.log('\n── Hidden AI context (sent to the Playwright code model, NOT shown in UI) ──');
    console.log('testType:', ai.testType, '| authState:', ai.authState, '| suite:', ai.suite);
    console.log('selectors:', JSON.stringify(ai.selectors));
    console.log('assertions:', JSON.stringify(ai.assertions));
    console.log('playwright:', JSON.stringify(ai.playwright));
    console.log('traceability:', JSON.stringify(ai.traceability));
    console.log('evidenceGaps:', JSON.stringify(ai.evidenceGaps));
  }

  await app.close();
  const failed = final.status === 'failed';
  console.log(`\n✅ Smoke ${failed ? 'FAILED' : 'OK'}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n❌ Smoke crashed:', err);
  process.exit(1);
});
