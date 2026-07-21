import { randomUUID } from 'node:crypto';
import { AppError, isAppError } from '../domain/errors.js';
import { TestCase } from '../domain/testcase.js';
import type { ArtifactRepository } from '../jobs/persist.js';
import { mapWithConcurrency } from '../jobs/pool.js';
import type { Logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import { SpecFileGenerator } from './generator.js';
import { CodegenArtifactRepository } from './persist.js';
import { filterCases, planFiles } from './planner.js';
import { buildScaffold } from './scaffold.js';
import { CodegenStore } from './store.js';
import type { CodegenJob, CodegenOptions, TraceEvent } from './types.js';

export interface CodegenDefaults {
  concurrency: number;
  maxCasesPerFile: number;
}

export class CodegenService {
  constructor(
    private readonly store: CodegenStore,
    private readonly generator: SpecFileGenerator,
    private readonly sourceArtifacts: ArtifactRepository,
    private readonly codegenArtifacts: CodegenArtifactRepository,
    private readonly logger: Logger,
    private readonly defaults: CodegenDefaults,
  ) {}

  /** Client-triggered: nothing generates until this is called. */
  submit(
    tenantId: string,
    sourceJobId: string,
    overrides: Partial<CodegenOptions>,
  ): CodegenJob {
    const now = new Date().toISOString();
    const options: CodegenOptions = {
      baseUrl: overrides.baseUrl ?? 'http://localhost:3000',
      envVars: overrides.envVars ?? [],
      concurrency: overrides.concurrency ?? this.defaults.concurrency,
      maxCasesPerFile: overrides.maxCasesPerFile ?? this.defaults.maxCasesPerFile,
      include: overrides.include ?? {},
      uiLocale: overrides.uiLocale ?? 'en',
      localeStorageKey: overrides.localeStorageKey ?? 'locale',
    };

    const job: CodegenJob = {
      id: randomUUID(),
      tenantId,
      sourceJobId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      options,
      files: [],
      scaffoldPaths: [],
      progress: { totalFiles: 0, completedFiles: 0, failedFiles: 0, totalCases: 0 },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      trace: [],
      warnings: [],
      error: null,
      abort: new AbortController(),
    };
    this.trace(job, 'job_created', `Codegen requested for source job ${sourceJobId}.`, {
      options: { ...options },
    });

    this.store.create(job);

    void this.process(job).catch((error) => {
      this.logger.error({ codegenJobId: job.id, err: error }, 'unhandled codegen failure');
    });
    return job;
  }

  cancel(id: string, tenantId: string): CodegenJob {
    const job = this.store.get(id, tenantId);
    if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(job.status)) {
      return job;
    }
    job.abort.abort();
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    this.trace(job, 'job_cancelled', 'Cancelled by client request.');
    this.store.touch(job);
    metrics.codegenJobs.inc({ status: 'cancelled' });
    return job;
  }

  private trace(
    job: CodegenJob,
    type: TraceEvent['type'],
    message: string,
    data?: Record<string, unknown>,
  ): void {
    job.trace.push({
      seq: job.trace.length + 1,
      ts: new Date().toISOString(),
      type,
      message,
      ...(data ? { data } : {}),
    });
    this.store.touch(job);
  }

  private async loadSourceCases(job: CodegenJob): Promise<TestCase[]> {
    let raw: string;
    try {
      raw = await this.sourceArtifacts.read(
        job.tenantId,
        job.sourceJobId,
        'test-cases.full.json',
      );
    } catch {
      throw new AppError(
        'not_found',
        `Source job "${job.sourceJobId}" has no persisted test cases; it must be a completed test-generation job of this tenant.`,
      );
    }
    const parsed = JSON.parse(raw) as { testCases?: unknown[] };
    const cases = (parsed.testCases ?? [])
      .map((c) => TestCase.safeParse(c))
      .filter((r) => r.success)
      .map((r) => r.data);
    if (cases.length === 0) {
      throw new AppError('unprocessable_entity', 'Source job contains no valid test cases.');
    }
    return cases;
  }

  private async process(job: CodegenJob): Promise<void> {
    const startedMs = Date.now();
    try {
      job.status = 'planning';
      job.startedAt = new Date().toISOString();
      this.store.touch(job);

      const allCases = await this.loadSourceCases(job);
      const cases = filterCases(allCases, job.options.include);
      if (cases.length === 0) {
        throw new AppError(
          'unprocessable_entity',
          'The include filter matched no test cases.',
        );
      }
      this.trace(job, 'source_loaded', `Loaded ${allCases.length} case(s); ${cases.length} selected.`, {
        total: allCases.length,
        selected: cases.length,
      });

      const plans = planFiles(cases, job.options.maxCasesPerFile);
      job.files = plans.map((plan, i) => ({
        id: `F-${String(i + 1).padStart(4, '0')}`,
        path: plan.path,
        suite: plan.suite,
        testType: plan.testType,
        caseIds: plan.cases.map((c) => c.id),
        caseTitles: plan.cases.map((c) => c.ui.title),
        status: 'pending',
        attempts: 0,
        bytes: 0,
        durationMs: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        warnings: [],
        error: null,
      }));
      job.progress.totalFiles = plans.length;
      job.progress.totalCases = cases.length;
      this.trace(job, 'plan_created', `Planned ${plans.length} spec file(s) for ${cases.length} case(s).`, {
        files: plans.map((p) => ({ path: p.path, cases: p.cases.length })),
      });

      const generatedAt = new Date().toISOString();
      const scaffold = buildScaffold(job.options, {
        sourceJobId: job.sourceJobId,
        codegenJobId: job.id,
        generatedAt,
      });
      job.scaffoldPaths = Object.keys(scaffold).sort();
      this.trace(job, 'scaffold_written', `Deterministic scaffold prepared (${job.scaffoldPaths.length} files).`);

      job.status = 'generating';
      this.store.touch(job);

      const generatedFiles: Record<string, string> = { ...scaffold };
      await mapWithConcurrency(plans, job.options.concurrency, async (plan, index) => {
        const task = job.files[index]!;
        if (job.abort.signal.aborted) return;
        task.status = 'generating';
        this.trace(job, 'file_started', `Generating ${task.path} (${task.caseIds.length} cases).`, {
          fileId: task.id,
        });
        try {
          const result = await this.generator.generate(
            plan,
            job.options.envVars,
            { sourceJobId: job.sourceJobId, codegenJobId: job.id },
            job.abort.signal,
          );
          generatedFiles[task.path] = result.code;
          task.status = 'completed';
          task.attempts = result.attempts;
          task.bytes = Buffer.byteLength(result.code);
          task.durationMs = result.durationMs;
          task.usage = result.usage;
          task.warnings = result.warnings;
          job.usage.promptTokens += result.usage.promptTokens;
          job.usage.completionTokens += result.usage.completionTokens;
          job.usage.totalTokens += result.usage.totalTokens;
          job.warnings.push(...result.warnings.map((w) => `${task.path}: ${w}`));
          job.progress.completedFiles += 1;
          metrics.codegenFiles.inc({ outcome: 'completed' });
          this.trace(job, 'file_completed', `${task.path} generated (${task.bytes} bytes).`, {
            fileId: task.id,
            attempts: result.attempts,
            durationMs: result.durationMs,
            tokens: result.usage.totalTokens,
          });
        } catch (error) {
          if (job.abort.signal.aborted) throw error;
          const message = isAppError(error) ? error.message : (error as Error).message;
          task.status = 'failed';
          task.error = message;
          job.progress.failedFiles += 1;
          job.warnings.push(`File ${task.path} failed: ${message}`);
          metrics.codegenFiles.inc({ outcome: 'failed' });
          this.trace(job, 'file_failed', `${task.path} failed: ${message}`, { fileId: task.id });
        }
      });

      if (job.progress.completedFiles === 0) {
        throw new AppError('upstream_error', 'Every spec file failed to generate.');
      }

      const finalStatus =
        job.progress.failedFiles > 0 ? 'completed_with_errors' : 'completed';
      const finishedAt = new Date().toISOString();

      // Persist before the terminal status becomes visible to pollers.
      await this.codegenArtifacts.persist(
        { ...job, status: finalStatus, finishedAt },
        generatedFiles,
      );
      this.trace(job, 'persisted', `Persisted ${Object.keys(generatedFiles).length} file(s).`);

      job.status = finalStatus;
      job.finishedAt = finishedAt;
      this.trace(job, 'job_finished', `Codegen ${finalStatus} in ${Math.round((Date.now() - startedMs) / 1000)}s.`, {
        completedFiles: job.progress.completedFiles,
        failedFiles: job.progress.failedFiles,
        totalTokens: job.usage.totalTokens,
      });
      this.store.touch(job);
      metrics.codegenJobs.inc({ status: finalStatus });
    } catch (error) {
      if (job.status === 'cancelled') return;
      const appError = isAppError(error)
        ? error
        : new AppError('internal_error', `Codegen failed: ${(error as Error).message}`, {
            cause: error,
          });
      job.error = { code: appError.code, message: appError.message };
      const finishedAt = new Date().toISOString();
      this.trace(job, 'job_failed', appError.message);
      try {
        // Persist the manifest (trace + partial files state) even on failure.
        await this.codegenArtifacts.persist({ ...job, status: 'failed', finishedAt }, {});
      } catch {
        /* persistence failure on a failed job is already the worst case */
      }
      job.status = 'failed';
      job.finishedAt = finishedAt;
      this.store.touch(job);
      metrics.codegenJobs.inc({ status: 'failed' });
      this.logger.error(
        { codegenJobId: job.id, code: appError.code, message: appError.message },
        'codegen job failed',
      );
    }
  }
}
