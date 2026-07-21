export type RunStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'completed'          // suite ran; may include failing tests
  | 'failed'             // infrastructure failure (no results produced)
  | 'timed_out'
  | 'cancelled';

/** One SSE/live-view event. Reporter events pass through with their own types. */
export interface RunEvent {
  seq: number;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

export interface RunTestResult {
  title: string;
  file: string;
  status: string; // passed | failed | timedOut | skipped | interrupted
  durationMs: number;
  retry: number;
  error: string | null;
  attachments: { name: string; path: string; contentType: string }[];
}

export interface RunOptions {
  baseUrl: string;
  /** Env variable NAMES supplied for this run; values live only in memory. */
  envNames: string[];
  timeoutMs: number;
  mode: 'docker' | 'subprocess';
}

export interface RunJob {
  id: string;
  tenantId: string;
  codegenJobId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  options: RunOptions;
  /** Secret values: memory-only, excluded from views, manifests and logs. */
  envValues: Record<string, string>;
  progress: {
    totalTests: number;
    finishedTests: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  tests: RunTestResult[];
  events: RunEvent[];
  exitCode: number | null;
  workspace: string | null;
  artifactCount: number;
  warnings: string[];
  error: { code: string; message: string } | null;
  abort: AbortController;
}

export function publicRunView(job: RunJob, includeEvents = false): Record<string, unknown> {
  return {
    id: job.id,
    codegenJobId: job.codegenJobId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    options: job.options,
    progress: job.progress,
    tests: job.tests,
    exitCode: job.exitCode,
    artifactCount: job.artifactCount,
    warnings: job.warnings,
    error: job.error,
    eventCount: job.events.length,
    ...(includeEvents ? { events: job.events } : {}),
  };
}
