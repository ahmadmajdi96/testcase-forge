import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, isAppError } from '../domain/errors.js';
import type { CodegenArtifactRepository } from '../codegen/persist.js';
import type { Logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import type { ExecutorFactory } from './executor.js';
import { RunArtifactRepository } from './persist.js';
import { RunStore } from './store.js';
import type { RunEvent, RunJob, RunTestResult } from './types.js';
import { cleanupWorkspace, collectArtifacts, materializeWorkspace } from './workspace.js';

export interface RunnerConfig {
  mode: 'docker' | 'subprocess';
  image: string;
  workspaceDir: string;
  hostWorkspaceDir: string;
  defaultTimeoutMs: number;
}

type Subscriber = (event: RunEvent) => void;

export class RunnerService {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(
    private readonly store: RunStore,
    private readonly codegenArtifacts: CodegenArtifactRepository,
    private readonly runArtifacts: RunArtifactRepository,
    private readonly executor: ExecutorFactory,
    private readonly logger: Logger,
    private readonly config: RunnerConfig,
  ) {}

  /** Client-triggered: a run starts only from this call. */
  submit(
    tenantId: string,
    codegenJobId: string,
    input: { baseUrl: string; env: Record<string, string>; timeoutMs?: number },
  ): RunJob {
    const now = new Date().toISOString();
    const job: RunJob = {
      id: randomUUID(),
      tenantId,
      codegenJobId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      options: {
        baseUrl: input.baseUrl,
        envNames: Object.keys(input.env).sort(),
        timeoutMs: input.timeoutMs ?? this.config.defaultTimeoutMs,
        mode: this.config.mode,
      },
      envValues: { ...input.env, BASE_URL: input.baseUrl },
      progress: { totalTests: 0, finishedTests: 0, passed: 0, failed: 0, skipped: 0 },
      tests: [],
      events: [],
      exitCode: null,
      workspace: null,
      artifactCount: 0,
      warnings: [],
      error: null,
      abort: new AbortController(),
    };
    this.emit(job, 'run_created', {
      codegenJobId,
      baseUrl: input.baseUrl,
      envNames: job.options.envNames,
      mode: job.options.mode,
    });
    this.store.create(job);
    void this.process(job).catch((error) => {
      this.logger.error({ runId: job.id, err: error }, 'unhandled run failure');
    });
    return job;
  }

  cancel(id: string, tenantId: string): RunJob {
    const job = this.store.get(id, tenantId);
    if (!['queued', 'preparing', 'running'].includes(job.status)) return job;
    job.abort.abort();
    this.emit(job, 'run_cancelled', {});
    return job;
  }

  /** SSE subscription: replays history, then streams; returns an unsubscribe. */
  subscribe(id: string, tenantId: string, onEvent: Subscriber): () => void {
    const job = this.store.get(id, tenantId);
    for (const event of job.events) onEvent(event);
    const set = this.subscribers.get(job.id) ?? new Set();
    set.add(onEvent);
    this.subscribers.set(job.id, set);
    return () => {
      set.delete(onEvent);
    };
  }

  private emit(job: RunJob, type: string, data: Record<string, unknown>): void {
    const event: RunEvent = {
      seq: job.events.length + 1,
      ts: new Date().toISOString(),
      type,
      data,
    };
    job.events.push(event);
    this.store.touch(job);
    for (const subscriber of this.subscribers.get(job.id) ?? []) {
      try {
        subscriber(event);
      } catch {
        /* a broken SSE socket must not affect the run */
      }
    }
  }

  /** Absorbs one reporter JSONL line into job state + the live stream. */
  private absorbReporterEvent(job: RunJob, raw: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const { type, ts, ...data } = parsed;
    void ts;
    if (typeof type !== 'string') return;

    if (type === 'run_started') {
      job.progress.totalTests = Number(data.totalTests ?? 0);
    }
    if (type === 'test_finished') {
      const result: RunTestResult = {
        title: String(data.title ?? ''),
        file: String(data.file ?? ''),
        status: String(data.status ?? 'unknown'),
        durationMs: Number(data.durationMs ?? 0),
        retry: Number(data.retry ?? 0),
        error: data.error == null ? null : String(data.error),
        attachments: Array.isArray(data.attachments)
          ? (data.attachments as RunTestResult['attachments'])
          : [],
      };
      // Retries replace the previous attempt of the same test.
      const existing = job.tests.findIndex(
        (t) => t.title === result.title && t.file === result.file,
      );
      if (existing >= 0) job.tests[existing] = result;
      else job.tests.push(result);

      job.progress.finishedTests = job.tests.length;
      job.progress.passed = job.tests.filter((t) => t.status === 'passed').length;
      job.progress.failed = job.tests.filter(
        (t) => t.status === 'failed' || t.status === 'timedOut',
      ).length;
      job.progress.skipped = job.tests.filter((t) => t.status === 'skipped').length;
    }
    this.emit(job, type, data);
  }

  private async process(job: RunJob): Promise<void> {
    let eventsOffset = 0;
    const eventsPath = () => join(job.workspace!, 'results', 'events.jsonl');

    const drainEvents = async (): Promise<void> => {
      try {
        const content = await readFile(eventsPath(), 'utf8');
        const fresh = content.slice(eventsOffset);
        if (!fresh) return;
        const lines = fresh.split('\n');
        // Keep a trailing partial line in the buffer for the next drain.
        const complete = fresh.endsWith('\n') ? lines : lines.slice(0, -1);
        eventsOffset += complete.join('\n').length + (complete.length > 0 ? 1 : 0);
        for (const line of complete) {
          if (line.trim()) this.absorbReporterEvent(job, line);
        }
      } catch {
        /* file not created yet */
      }
    };

    try {
      job.status = 'preparing';
      job.startedAt = new Date().toISOString();
      this.emit(job, 'preparing', { message: 'Loading generated suite.' });

      const bundle = await this.codegenArtifacts.readBundle(job.tenantId, job.codegenJobId);
      job.workspace = await materializeWorkspace(this.config.workspaceDir, job.id, bundle);
      this.emit(job, 'workspace_ready', { files: Object.keys(bundle).length });

      if (job.abort.signal.aborted) throw new AppError('conflict', 'Run was cancelled.');

      const handle = await this.executor({
        runId: job.id,
        workspace: job.workspace,
        hostWorkspace: this.config.hostWorkspaceDir || this.config.workspaceDir,
        envValues: job.envValues,
        mode: this.config.mode,
        image: this.config.image,
      });
      job.status = 'running';
      this.emit(job, 'executor_started', {
        mode: this.config.mode,
        message:
          this.config.mode === 'docker'
            ? 'Isolated container started; installing dependencies then running the suite.'
            : 'Runner process started.',
      });

      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        void handle.kill();
      }, job.options.timeoutMs);
      const onCancel = () => void handle.kill();
      job.abort.signal.addEventListener('abort', onCancel, { once: true });

      // Tail the reporter stream while the suite runs.
      const poller = setInterval(() => void drainEvents(), 400);
      const exitCode = await handle.done;
      clearInterval(poller);
      clearTimeout(timeout);
      job.abort.signal.removeEventListener('abort', onCancel);
      await drainEvents(); // final flush
      job.exitCode = exitCode;

      // Persist evidence regardless of outcome — failures need artifacts most.
      const artifacts = await collectArtifacts(job.workspace);
      job.artifactCount = artifacts.length;

      const finishedAt = new Date().toISOString();
      let finalStatus: RunJob['status'];
      if (job.abort.signal.aborted) finalStatus = 'cancelled';
      else if (timedOut) finalStatus = 'timed_out';
      else if (exitCode === 0 || (exitCode === 1 && job.tests.length > 0)) {
        finalStatus = 'completed';
      } else {
        finalStatus = 'failed';
        job.error = {
          code: 'runner_error',
          message: `Runner exited with code ${exitCode} before producing results. See results/npm-install.log and results/playwright.log.`,
        };
      }

      await this.runArtifacts.persist(
        { ...job, status: finalStatus, finishedAt, envValues: {} },
        artifacts,
      );
      this.emit(job, 'artifacts_persisted', { count: artifacts.length });

      job.status = finalStatus;
      job.finishedAt = finishedAt;
      this.emit(job, 'run_terminal', {
        status: finalStatus,
        exitCode,
        passed: job.progress.passed,
        failed: job.progress.failed,
        totalTests: job.progress.totalTests,
      });
      metrics.testRuns.inc({ status: finalStatus });
    } catch (error) {
      const appError = isAppError(error)
        ? error
        : new AppError('internal_error', `Run failed: ${(error as Error).message}`, {
            cause: error,
          });
      const finishedAt = new Date().toISOString();
      job.error = { code: appError.code, message: appError.message };
      const finalStatus = job.abort.signal.aborted ? 'cancelled' : 'failed';
      try {
        const artifacts = job.workspace ? await collectArtifacts(job.workspace) : [];
        job.artifactCount = artifacts.length;
        await this.runArtifacts.persist(
          { ...job, status: finalStatus, finishedAt, envValues: {} },
          artifacts,
        );
      } catch {
        /* keep the original failure */
      }
      job.status = finalStatus;
      job.finishedAt = finishedAt;
      this.emit(job, 'run_terminal', { status: finalStatus, error: appError.message });
      metrics.testRuns.inc({ status: finalStatus });
      this.logger.error({ runId: job.id, message: appError.message }, 'test run failed');
    } finally {
      // Secrets and workspace never outlive the run.
      job.envValues = {};
      if (job.workspace) {
        await cleanupWorkspace(job.workspace).catch(() => {});
      }
    }
  }
}
