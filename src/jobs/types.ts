import type { CoverageReport } from '../coverage/report.js';
import type { SpecModel } from '../domain/spec.js';
import type { TestCase } from '../domain/testcase.js';

export type JobStatus =
  | 'queued'
  | 'analyzing'
  | 'generating'
  | 'completed'
  | 'completed_with_gaps'
  | 'failed'
  | 'cancelled';

export interface JobProgress {
  totalUnits: number;
  completedUnits: number;
  totalItems: number;
  generatedCases: number;
}

export interface JobOptions {
  maxItemsPerUnit: number;
  concurrency: number;
  maxRepairRounds: number;
  maxGlobalRepairRounds: number;
}

export interface JobUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  novitaModel: string;
}

export interface Job {
  id: string;
  tenantId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  options: JobOptions;
  documentNames: string[];
  duplicateNotes: string[];
  progress: JobProgress;
  spec: SpecModel | null;
  cases: TestCase[];
  coverage: CoverageReport | null;
  usage: JobUsage;
  warnings: string[];
  error: { code: string; message: string } | null;
  abort: AbortController;
}

export function publicJobView(job: Job, includeSpec = false): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    documentNames: job.documentNames,
    duplicateNotes: job.duplicateNotes,
    progress: job.progress,
    usage: job.usage,
    coverage: job.coverage,
    warnings: job.warnings,
    error: job.error,
    caseCount: job.cases.length,
    ...(includeSpec && job.spec
      ? { specStats: job.spec.stats, globalContext: job.spec.globalContext }
      : {}),
  };
}
