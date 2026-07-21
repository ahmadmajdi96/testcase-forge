import { AppError } from '../domain/errors.js';
import type { RunJob } from './types.js';

const ACTIVE = new Set(['queued', 'preparing', 'running']);

/** In-memory run store; per-tenant caps keep one tenant from hogging runners. */
export class RunStore {
  private readonly runs = new Map<string, RunJob>();

  constructor(
    private readonly retentionMs: number,
    private readonly maxActiveGlobal: number,
    private readonly maxActivePerTenant: number,
  ) {}

  create(job: RunJob): void {
    this.evictExpired();
    const all = [...this.runs.values()];
    if (all.filter((j) => ACTIVE.has(j.status)).length >= this.maxActiveGlobal) {
      throw new AppError('rate_limited', 'Too many active test runs. Retry shortly.', {
        retryable: true,
      });
    }
    const tenantActive = all.filter(
      (j) => j.tenantId === job.tenantId && ACTIVE.has(j.status),
    ).length;
    if (tenantActive >= this.maxActivePerTenant) {
      throw new AppError(
        'rate_limited',
        `Tenant already has ${tenantActive} active run(s); the limit is ${this.maxActivePerTenant}.`,
        { retryable: true },
      );
    }
    this.runs.set(job.id, job);
  }

  get(id: string, tenantId: string): RunJob {
    const job = this.runs.get(id);
    if (!job || job.tenantId !== tenantId) {
      throw new AppError('not_found', `Test run "${id}" was not found.`);
    }
    return job;
  }

  touch(job: RunJob): void {
    job.updatedAt = new Date().toISOString();
  }

  list(tenantId: string, limit = 50): RunJob[] {
    return [...this.runs.values()]
      .filter((j) => j.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, job] of this.runs) {
      const finished = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
      if (!ACTIVE.has(job.status) && finished < cutoff) this.runs.delete(id);
    }
  }
}
