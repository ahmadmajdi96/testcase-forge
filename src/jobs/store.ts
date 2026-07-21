import { AppError } from '../domain/errors.js';
import { metrics } from '../observability/metrics.js';
import type { Job } from './types.js';

/**
 * In-memory job store with TTL eviction. It is deliberately behind a small
 * interface so it can be swapped for Redis/Postgres without touching callers
 * when the service is scaled horizontally.
 */
export class JobStore {
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly retentionMs: number,
    private readonly maxActiveJobs: number,
  ) {}

  create(job: Job): void {
    this.evictExpired();
    const active = [...this.jobs.values()].filter((j) =>
      ['queued', 'analyzing', 'generating'].includes(j.status),
    ).length;
    if (active >= this.maxActiveJobs) {
      throw new AppError(
        'rate_limited',
        'Too many active jobs. Retry once in-flight jobs complete.',
        { retryable: true },
      );
    }
    this.jobs.set(job.id, job);
    this.updateGauge();
  }

  /** Tenant-scoped lookup: another tenant's job id behaves as not-found. */
  get(id: string, tenantId: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId) {
      throw new AppError('not_found', `Job "${id}" was not found.`);
    }
    return job;
  }

  tryGet(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  touch(job: Job): void {
    job.updatedAt = new Date().toISOString();
    this.updateGauge();
  }

  list(tenantId: string, limit = 50): Job[] {
    return [...this.jobs.values()]
      .filter((j) => j.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  private updateGauge(): void {
    const active = [...this.jobs.values()].filter((j) =>
      ['queued', 'analyzing', 'generating'].includes(j.status),
    ).length;
    metrics.activeJobs.set(active);
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      const finished = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
      const terminal = ['completed', 'completed_with_gaps', 'failed', 'cancelled'].includes(
        job.status,
      );
      if (terminal && finished < cutoff) this.jobs.delete(id);
    }
  }
}
