import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { AppError } from '../domain/errors.js';
import type { CodegenJob } from './types.js';
import { publicCodegenView } from './types.js';

/**
 * Codegen artifacts live beside test-generation artifacts but in their own
 * namespace: <ARTIFACTS_DIR>/<tenant>/codegen/<jobId>/. The manifest carries
 * the full trace so progress stays inspectable after restarts.
 */

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export class CodegenArtifactRepository {
  private readonly root: string;

  constructor(artifactsDir: string) {
    this.root = resolve(artifactsDir);
  }

  private jobDir(tenantId: string, jobId: string): string {
    if (!TENANT_ID.test(tenantId)) throw new AppError('bad_request', 'Invalid tenant id.');
    if (!JOB_ID.test(jobId)) throw new AppError('bad_request', 'Invalid job id.');
    return join(this.root, tenantId, 'codegen', jobId);
  }

  /** Resolves a manifest-relative path, refusing anything escaping the job dir. */
  private safePath(dir: string, relPath: string): string {
    if (relPath.includes('..')) throw new AppError('bad_request', 'Invalid file path.');
    const full = resolve(dir, relPath);
    if (full !== dir && !full.startsWith(dir + sep)) {
      throw new AppError('bad_request', 'Invalid file path.');
    }
    return full;
  }

  async persist(job: CodegenJob, files: Record<string, string>): Promise<void> {
    const dir = this.jobDir(job.tenantId, job.id);
    await mkdir(dir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const full = this.safePath(dir, relPath);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ ...publicCodegenView(job, true), persistedFiles: Object.keys(files).sort() }, null, 2),
      'utf8',
    );
  }

  async listJobs(
    tenantId: string,
  ): Promise<{ jobId: string; modifiedAt: string }[]> {
    if (!TENANT_ID.test(tenantId)) throw new AppError('bad_request', 'Invalid tenant id.');
    const base = join(this.root, tenantId, 'codegen');
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      return [];
    }
    const jobs = await Promise.all(
      entries
        .filter((e) => JOB_ID.test(e))
        .map(async (jobId) => ({
          jobId,
          modifiedAt: (await stat(join(base, jobId))).mtime.toISOString(),
        })),
    );
    return jobs.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async readManifest(tenantId: string, jobId: string): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(join(this.jobDir(tenantId, jobId), 'manifest.json'), 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new AppError('not_found', `No persisted codegen artifacts for job "${jobId}".`);
    }
  }

  /** Reads one generated file; the path must be listed in the manifest. */
  async readFile(tenantId: string, jobId: string, relPath: string): Promise<string> {
    const manifest = await this.readManifest(tenantId, jobId);
    const persisted = (manifest.persistedFiles as string[] | undefined) ?? [];
    if (!persisted.includes(relPath)) {
      throw new AppError('not_found', `File "${relPath}" is not part of job "${jobId}".`);
    }
    const dir = this.jobDir(tenantId, jobId);
    return readFile(this.safePath(dir, relPath), 'utf8');
  }

  /** Returns every persisted file as {path: content} for one-shot download. */
  async readBundle(tenantId: string, jobId: string): Promise<Record<string, string>> {
    const manifest = await this.readManifest(tenantId, jobId);
    const persisted = (manifest.persistedFiles as string[] | undefined) ?? [];
    const dir = this.jobDir(tenantId, jobId);
    const bundle: Record<string, string> = {};
    for (const relPath of persisted) {
      bundle[relPath] = await readFile(this.safePath(dir, relPath), 'utf8');
    }
    return bundle;
  }
}
