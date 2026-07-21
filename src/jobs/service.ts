import { randomUUID } from 'node:crypto';
import { AppError, isAppError } from '../domain/errors.js';
import type { SourceDocument } from '../domain/spec.js';
import { analyzeDocuments } from '../ingest/analyzer.js';
import { planGeneration, planUnitsFromItems } from '../ingest/planner.js';
import { buildCoverageReport } from '../coverage/report.js';
import { TestCaseGenerator } from '../llm/generator.js';
import type { Logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import { mapWithConcurrency } from './pool.js';
import { ArtifactRepository } from './persist.js';
import { JobStore } from './store.js';
import type { Job, JobOptions } from './types.js';

export class JobService {
  constructor(
    private readonly store: JobStore,
    private readonly generator: TestCaseGenerator,
    private readonly artifacts: ArtifactRepository,
    private readonly logger: Logger,
    private readonly defaults: JobOptions,
  ) {}

  /** Creates a tenant-scoped job and kicks off async processing; returns immediately. */
  submit(
    tenantId: string,
    documents: SourceDocument[],
    duplicateNotes: string[],
    overrides: Partial<JobOptions>,
  ): Job {
    if (documents.length === 0) {
      throw new AppError('bad_request', 'At least one readable document is required.');
    }
    const now = new Date().toISOString();
    const options: JobOptions = {
      maxItemsPerUnit: overrides.maxItemsPerUnit ?? this.defaults.maxItemsPerUnit,
      concurrency: overrides.concurrency ?? this.defaults.concurrency,
      maxRepairRounds: overrides.maxRepairRounds ?? this.defaults.maxRepairRounds,
      maxGlobalRepairRounds:
        overrides.maxGlobalRepairRounds ?? this.defaults.maxGlobalRepairRounds,
    };
    const job: Job = {
      id: randomUUID(),
      tenantId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      options,
      documentNames: documents.map((d) => d.name),
      duplicateNotes,
      progress: { totalUnits: 0, completedUnits: 0, totalItems: 0, generatedCases: 0 },
      spec: null,
      cases: [],
      coverage: null,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        novitaModel: this.generator['novita'].model,
      },
      warnings: [...duplicateNotes.map((n) => `Duplicate skipped: ${n}`)],
      error: null,
      abort: new AbortController(),
    };

    this.store.create(job);
    metrics.jobsStarted.inc();

    // Fire-and-forget: failures are captured on the job record, never thrown here.
    void this.process(job, documents).catch((error) => {
      this.logger.error({ jobId: job.id, err: error }, 'unhandled job failure');
    });

    return job;
  }

  cancel(id: string, tenantId: string): Job {
    const job = this.store.get(id, tenantId);
    if (['completed', 'completed_with_gaps', 'failed', 'cancelled'].includes(job.status)) {
      return job;
    }
    job.abort.abort();
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    job.error = { code: 'cancelled', message: 'Job cancelled by request.' };
    this.store.touch(job);
    metrics.jobsFinished.inc({ status: 'cancelled' });
    return job;
  }

  private async process(job: Job, documents: SourceDocument[]): Promise<void> {
    const startedMs = Date.now();
    try {
      job.status = 'analyzing';
      job.startedAt = new Date().toISOString();
      this.store.touch(job);

      const spec = analyzeDocuments(documents);
      if (spec.items.length === 0) {
        throw new AppError(
          'unprocessable_entity',
          'No testable details could be extracted from the uploaded documents.',
        );
      }
      job.spec = spec;

      const units = planGeneration(spec, job.options.maxItemsPerUnit);
      job.progress.totalUnits = units.length;
      job.progress.totalItems = spec.items.length;
      job.status = 'generating';
      this.store.touch(job);
      this.logger.info(
        { jobId: job.id, items: spec.items.length, units: units.length },
        'generation planned',
      );

      let sequence = 0;
      const seq = { next: () => (sequence += 1) };

      let failedUnits = 0;
      const results = await mapWithConcurrency(
        units,
        job.options.concurrency,
        async (unit) => {
          if (job.abort.signal.aborted) {
            throw new AppError('conflict', 'Job was cancelled.');
          }
          try {
            const result = await this.generator.generateUnit(
              spec,
              unit,
              job.id,
              job.abort.signal,
              seq,
            );
            // Stream partial progress so long jobs are observable while running.
            job.cases.push(...result.cases);
            job.usage.promptTokens += result.usage.promptTokens;
            job.usage.completionTokens += result.usage.completionTokens;
            job.usage.totalTokens += result.usage.totalTokens;
            job.warnings.push(...result.warnings);
            return result;
          } catch (error) {
            // A cancellation aborts the whole job; any other unit failure is
            // isolated so the remaining units still produce coverage.
            if (job.abort.signal.aborted || (isAppError(error) && error.code === 'conflict')) {
              throw error;
            }
            failedUnits += 1;
            const message = isAppError(error) ? error.message : (error as Error).message;
            job.warnings.push(
              `Unit ${unit.id} (${unit.suite}) failed and was skipped: ${message}`,
            );
            this.logger.warn(
              { jobId: job.id, unit: unit.id, message },
              'unit failed, continuing',
            );
            return null;
          } finally {
            job.progress.completedUnits += 1;
            job.progress.generatedCases = job.cases.length;
            this.store.touch(job);
          }
        },
      );

      // Job-level repair: items left uncovered because a unit was skipped (timeout,
      // upstream error) are re-planned into fresh units and generated again. This
      // is what makes "cover every detail" hold even when individual units fail.
      // Runs before the empty-result check so a fully-skipped first pass can recover.
      for (let round = 0; round < job.options.maxGlobalRepairRounds; round += 1) {
        if (job.abort.signal.aborted) break;
        const covered = new Set(
          job.cases.flatMap((c) => c.ai.traceability.coverageItemIds),
        );
        const uncovered = spec.items.filter((i) => !covered.has(i.id));
        if (uncovered.length === 0) break;

        this.logger.info(
          { jobId: job.id, round: round + 1, uncovered: uncovered.length },
          'job-level coverage repair',
        );
        const repairUnits = planUnitsFromItems(
          uncovered,
          job.options.maxItemsPerUnit,
          `R${round + 1}`,
        );
        job.progress.totalUnits += repairUnits.length;
        this.store.touch(job);

        await mapWithConcurrency(repairUnits, job.options.concurrency, async (unit) => {
          if (job.abort.signal.aborted) return null;
          try {
            const result = await this.generator.generateUnit(
              spec,
              unit,
              job.id,
              job.abort.signal,
              seq,
            );
            job.cases.push(...result.cases);
            job.usage.promptTokens += result.usage.promptTokens;
            job.usage.completionTokens += result.usage.completionTokens;
            job.usage.totalTokens += result.usage.totalTokens;
            job.warnings.push(...result.warnings);
            return result;
          } catch (error) {
            if (job.abort.signal.aborted) throw error;
            const message = isAppError(error) ? error.message : (error as Error).message;
            job.warnings.push(`Repair unit ${unit.id} failed: ${message}`);
            return null;
          } finally {
            job.progress.completedUnits += 1;
            job.progress.generatedCases = job.cases.length;
            this.store.touch(job);
          }
        });
      }

      if (job.cases.length === 0) {
        throw new AppError(
          'upstream_error',
          `Generation produced no test cases; all ${units.length} unit(s) failed across the initial and repair passes.`,
        );
      }

      job.cases.sort((a, b) => a.id.localeCompare(b.id));
      job.coverage = buildCoverageReport(spec, job.cases);
      metrics.coverageRatio.set(job.coverage.coverageRatio);

      const hasGaps =
        job.coverage.uncoveredItems > 0 || !job.coverage.p0FullyCovered;
      const finalStatus = hasGaps ? 'completed_with_gaps' : 'completed';
      const finishedAt = new Date().toISOString();

      // Persist BEFORE flipping the visible status: a client that sees
      // "completed" must always find the artifacts already on disk.
      await this.persistSafely({ ...job, status: finalStatus, finishedAt });

      job.status = finalStatus;
      job.finishedAt = finishedAt;
      this.store.touch(job);

      metrics.jobsFinished.inc({ status: job.status });
      metrics.jobDuration.observe((Date.now() - startedMs) / 1000);
      this.logger.info(
        {
          jobId: job.id,
          cases: job.cases.length,
          coverage: job.coverage.coverageRatio,
          status: job.status,
          units: results.length,
          failedUnits,
        },
        'job finished',
      );
    } catch (error) {
      if (job.status === 'cancelled') return;
      const appError = isAppError(error)
        ? error
        : new AppError('internal_error', `Job failed: ${(error as Error).message}`, {
            cause: error,
          });
      const finishedAt = new Date().toISOString();
      job.error = { code: appError.code, message: appError.message };
      // Preserve any cases produced before the failure and report their coverage.
      if (job.spec && job.cases.length > 0) {
        job.coverage = buildCoverageReport(job.spec, job.cases);
      }
      // Persist before the terminal status becomes visible (same rule as success).
      await this.persistSafely({ ...job, status: 'failed', finishedAt });
      job.status = 'failed';
      job.finishedAt = finishedAt;
      this.store.touch(job);
      metrics.jobsFinished.inc({ status: 'failed' });
      this.logger.error(
        { jobId: job.id, code: appError.code, message: appError.message },
        'job failed',
      );
    }
  }

  /** Artifact persistence must never take down a finished job. */
  private async persistSafely(job: Job): Promise<void> {
    try {
      await this.artifacts.persist(job);
    } catch (error) {
      const message = (error as Error).message;
      job.warnings.push(`Artifact persistence failed: ${message}`);
      this.logger.error({ jobId: job.id, message }, 'artifact persistence failed');
    }
  }
}
