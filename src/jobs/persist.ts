import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError } from '../domain/errors.js';
import { toUiView } from '../domain/testcase.js';
import type { Job } from './types.js';
import { publicJobView } from './types.js';

/**
 * File-based artifact persistence: <ARTIFACTS_DIR>/<tenantId>/<jobId>/<file>.
 * Jobs live in memory while running; terminal results are flushed here so
 * generated test cases remain downloadable after a restart or redeploy.
 */

export const ARTIFACT_FILES = [
  'job.json',
  'coverage.json',
  'test-cases.full.json',
  'test-cases.ui.json',
] as const;
export type ArtifactFile = (typeof ARTIFACT_FILES)[number];

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function assertSafe(tenantId: string, jobId?: string): void {
  if (!TENANT_ID.test(tenantId)) {
    throw new AppError('bad_request', 'Invalid tenant id.');
  }
  if (jobId !== undefined && !JOB_ID.test(jobId)) {
    throw new AppError('bad_request', 'Invalid job id.');
  }
}

export class ArtifactRepository {
  private readonly root: string;

  constructor(artifactsDir: string) {
    this.root = resolve(artifactsDir);
  }

  private jobDir(tenantId: string, jobId: string): string {
    assertSafe(tenantId, jobId);
    return join(this.root, tenantId, jobId);
  }

  /** Flushes a terminal job's results to disk. */
  async persist(job: Job): Promise<void> {
    const dir = this.jobDir(job.tenantId, job.id);
    await mkdir(dir, { recursive: true });
    const files: Record<ArtifactFile, unknown> = {
      'job.json': publicJobView(job, true),
      'coverage.json': job.coverage,
      'test-cases.full.json': {
        jobId: job.id,
        status: job.status,
        coverage: job.coverage,
        count: job.cases.length,
        testCases: job.cases,
      },
      'test-cases.ui.json': {
        jobId: job.id,
        count: job.cases.length,
        testCases: job.cases.map(toUiView),
      },
    };
    await Promise.all(
      ARTIFACT_FILES.map((name) =>
        writeFile(join(dir, name), JSON.stringify(files[name], null, 2), 'utf8'),
      ),
    );
  }

  /** Lists persisted jobs for one tenant, newest first. */
  async listJobs(
    tenantId: string,
  ): Promise<{ jobId: string; modifiedAt: string; files: string[] }[]> {
    assertSafe(tenantId);
    const tenantDir = join(this.root, tenantId);
    let entries: string[];
    try {
      entries = await readdir(tenantDir);
    } catch {
      return []; // tenant has no persisted jobs yet
    }
    const jobs = await Promise.all(
      entries
        .filter((e) => JOB_ID.test(e))
        .map(async (jobId) => {
          const dir = join(tenantDir, jobId);
          const [info, files] = await Promise.all([stat(dir), readdir(dir)]);
          return {
            jobId,
            modifiedAt: info.mtime.toISOString(),
            files: files.filter((f) =>
              (ARTIFACT_FILES as readonly string[]).includes(f),
            ),
          };
        }),
    );
    return jobs.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /** Reads one artifact file; file names are allow-listed, never caller paths. */
  async read(tenantId: string, jobId: string, file: string): Promise<string> {
    if (!(ARTIFACT_FILES as readonly string[]).includes(file)) {
      throw new AppError(
        'bad_request',
        `Unknown artifact "${file}". Available: ${ARTIFACT_FILES.join(', ')}.`,
      );
    }
    const path = join(this.jobDir(tenantId, jobId), file);
    try {
      return await readFile(path, 'utf8');
    } catch {
      throw new AppError(
        'not_found',
        `Artifact "${file}" for job "${jobId}" was not found.`,
      );
    }
  }
}
