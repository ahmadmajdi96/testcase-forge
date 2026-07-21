import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { AppError } from '../domain/errors.js';
import type { RunJob } from './types.js';
import { publicRunView } from './types.js';
import type { CollectedArtifact } from './workspace.js';

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const CONTENT_TYPES: Record<string, string> = {
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.zip': 'application/zip',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Run evidence (videos, traces, screenshots, logs, event stream) persisted at
 * <ARTIFACTS_DIR>/<tenant>/runs/<runId>/. Env VALUES are never written here.
 */
export class RunArtifactRepository {
  private readonly root: string;

  constructor(artifactsDir: string) {
    this.root = resolve(artifactsDir);
  }

  private runDir(tenantId: string, runId: string): string {
    if (!TENANT_ID.test(tenantId)) throw new AppError('bad_request', 'Invalid tenant id.');
    if (!JOB_ID.test(runId)) throw new AppError('bad_request', 'Invalid run id.');
    return join(this.root, tenantId, 'runs', runId);
  }

  private safePath(dir: string, relPath: string): string {
    if (relPath.includes('..')) throw new AppError('bad_request', 'Invalid file path.');
    const full = resolve(dir, relPath);
    if (full !== dir && !full.startsWith(dir + sep)) {
      throw new AppError('bad_request', 'Invalid file path.');
    }
    return full;
  }

  async persist(job: RunJob, artifacts: CollectedArtifact[]): Promise<void> {
    const dir = this.runDir(job.tenantId, job.id);
    await mkdir(dir, { recursive: true });
    for (const artifact of artifacts) {
      const target = this.safePath(dir, artifact.relPath);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(artifact.absPath, target);
    }
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify(
        {
          ...publicRunView(job, true),
          persistedFiles: artifacts
            .map((a) => ({ path: a.relPath, bytes: a.bytes, contentType: contentTypeFor(a.relPath) }))
            .sort((a, b) => a.path.localeCompare(b.path)),
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  async listRuns(tenantId: string): Promise<{ runId: string; modifiedAt: string }[]> {
    if (!TENANT_ID.test(tenantId)) throw new AppError('bad_request', 'Invalid tenant id.');
    const base = join(this.root, tenantId, 'runs');
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      return [];
    }
    const runs = await Promise.all(
      entries
        .filter((e) => JOB_ID.test(e))
        .map(async (runId) => ({
          runId,
          modifiedAt: (await stat(join(base, runId))).mtime.toISOString(),
        })),
    );
    return runs.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async readManifest(tenantId: string, runId: string): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(join(this.runDir(tenantId, runId), 'manifest.json'), 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new AppError('not_found', `No persisted artifacts for run "${runId}".`);
    }
  }

  /** Binary-safe read; the path must be listed in the manifest. */
  async readArtifact(
    tenantId: string,
    runId: string,
    relPath: string,
  ): Promise<{ content: Buffer; contentType: string }> {
    const manifest = await this.readManifest(tenantId, runId);
    const files = (manifest.persistedFiles as { path: string }[] | undefined) ?? [];
    if (!files.some((f) => f.path === relPath)) {
      throw new AppError('not_found', `File "${relPath}" is not part of run "${runId}".`);
    }
    const dir = this.runDir(tenantId, runId);
    const content = await readFile(this.safePath(dir, relPath));
    return { content, contentType: contentTypeFor(relPath) };
  }
}
