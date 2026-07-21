import { AppError } from '../domain/errors.js';
import type { CodegenJob } from './types.js';

const ACTIVE = new Set(['queued', 'planning', 'generating']);

/**
 * In-memory codegen job store with TTL eviction and per-tenant fairness caps —
 * one heavy tenant cannot exhaust the shared LLM throughput. Same swap path as
 * JobStore (Redis/Postgres) for multi-replica deployments.
 */
export class CodegenStore {
  private readonly jobs = new Map<string, CodegenJob>();

  constructor(
    private readonly retentionMs: number,
    private readonly maxActiveGlobal: number,
    private readonly maxActivePerTenant: number,
  ) {}

  create(job: CodegenJob): void {
    this.evictExpired();
    const all = [...this.jobs.values()];
    if (all.filter((j) => ACTIVE.has(j.status)).length >= this.maxActiveGlobal) {
      throw new AppError('rate_limited', 'Too many active codegen jobs. Retry shortly.', {
        retryable: true,
      });
    }
    const tenantActive = all.filter(
      (j) => j.tenantId === job.tenantId && ACTIVE.has(j.status),
    ).length;
    if (tenantActive >= this.maxActivePerTenant) {
      throw new AppError(
        'rate_limited',
        `Tenant already has ${tenantActive} active codegen job(s); the limit is ${this.maxActivePerTenant}.`,
        { retryable: true },
      );
    }
    this.jobs.set(job.id, job);
  }

  get(id: string, tenantId: string): CodegenJob {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId) {
      throw new AppError('not_found', `Codegen job "${id}" was not found.`);
    }
    return job;
  }

  touch(job: CodegenJob): void {
    job.updatedAt = new Date().toISOString();
  }

  list(tenantId: string, limit = 50): CodegenJob[] {
    return [...this.jobs.values()]
      .filter((j) => j.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      const finished = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
      if (!ACTIVE.has(job.status) && finished < cutoff) this.jobs.delete(id);
    }
  }
}
