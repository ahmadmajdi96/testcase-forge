import type { TestCase } from '../domain/testcase.js';

export type CodegenStatus =
  | 'queued'
  | 'planning'
  | 'generating'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type FileTaskStatus = 'pending' | 'generating' | 'completed' | 'failed';

/** One generated spec file: the unit of work, tracing and fault isolation. */
export interface FileTask {
  id: string; // F-0001
  path: string; // tests/e2e/cases.spec.ts (sanitized, always under tests/)
  suite: string;
  testType: string;
  caseIds: string[];
  caseTitles: string[];
  status: FileTaskStatus;
  attempts: number;
  bytes: number;
  durationMs: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  warnings: string[];
  error: string | null;
}

/** Append-only progress log: the traceability backbone of a codegen job. */
export interface TraceEvent {
  seq: number;
  ts: string;
  type:
    | 'job_created'
    | 'source_loaded'
    | 'plan_created'
    | 'scaffold_written'
    | 'file_started'
    | 'file_completed'
    | 'file_failed'
    | 'persisted'
    | 'job_finished'
    | 'job_failed'
    | 'job_cancelled';
  message: string;
  data?: Record<string, unknown>;
}

export interface CodegenInclude {
  suites?: string[];
  testTypes?: string[];
  priorities?: string[];
  /** Hard cap on cases (highest priority first). Cost-control for large jobs. */
  limit?: number;
}

export interface CodegenOptions {
  baseUrl: string;
  envVars: string[];
  concurrency: number;
  maxCasesPerFile: number;
  include: CodegenInclude;
  /** UI language forced into localStorage before hydration (default "en"). */
  uiLocale: string;
  /** localStorage key the app reads its locale from (default "locale"). */
  localeStorageKey: string;
}

export interface CodegenJob {
  id: string;
  tenantId: string;
  /** The completed test-generation job whose cases are being turned into code. */
  sourceJobId: string;
  status: CodegenStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  options: CodegenOptions;
  files: FileTask[];
  scaffoldPaths: string[];
  progress: {
    totalFiles: number;
    completedFiles: number;
    failedFiles: number;
    totalCases: number;
  };
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  trace: TraceEvent[];
  warnings: string[];
  error: { code: string; message: string } | null;
  abort: AbortController;
}

export interface FilePlan {
  path: string;
  suite: string;
  testType: string;
  cases: TestCase[];
}

export function publicCodegenView(
  job: CodegenJob,
  includeTrace = false,
): Record<string, unknown> {
  return {
    id: job.id,
    sourceJobId: job.sourceJobId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    options: job.options,
    progress: job.progress,
    usage: job.usage,
    scaffoldPaths: job.scaffoldPaths,
    files: job.files.map((f) => ({
      id: f.id,
      path: f.path,
      suite: f.suite,
      testType: f.testType,
      status: f.status,
      caseCount: f.caseIds.length,
      caseIds: f.caseIds,
      attempts: f.attempts,
      bytes: f.bytes,
      durationMs: f.durationMs,
      warnings: f.warnings,
      error: f.error,
    })),
    warnings: job.warnings,
    error: job.error,
    traceCount: job.trace.length,
    ...(includeTrace ? { trace: job.trace } : {}),
  };
}
