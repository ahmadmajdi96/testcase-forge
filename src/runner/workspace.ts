import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { AppError } from '../domain/errors.js';
import { REPORTER_FILENAME, REPORTER_SOURCE } from './reporter.js';

/** Directories whose contents become downloadable run artifacts. */
const ARTIFACT_DIRS = ['results', 'test-results'];
/** Session tokens live here — never persisted or served. */
const EXCLUDED = new Set(['results/.auth']);
const MAX_ARTIFACT_TOTAL_BYTES = 500 * 1024 * 1024;

function safeJoin(root: string, relPath: string): string {
  if (relPath.includes('..')) throw new AppError('bad_request', 'Invalid path in bundle.');
  const full = resolve(root, relPath);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new AppError('bad_request', 'Invalid path in bundle.');
  }
  return full;
}

/** Writes a codegen bundle plus the streaming reporter into a fresh run dir. */
export async function materializeWorkspace(
  rootDir: string,
  runId: string,
  bundle: Record<string, string>,
): Promise<string> {
  const workspace = join(resolve(rootDir), runId);
  await mkdir(workspace, { recursive: true });
  for (const [relPath, content] of Object.entries(bundle)) {
    if (relPath === 'manifest.json') continue; // codegen metadata, not suite code
    const full = safeJoin(workspace, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  await writeFile(join(workspace, REPORTER_FILENAME), REPORTER_SOURCE, 'utf8');
  await mkdir(join(workspace, 'results'), { recursive: true });
  return workspace;
}

export interface CollectedArtifact {
  relPath: string;
  absPath: string;
  bytes: number;
}

/** Result files worth keeping: events, JSON results, videos, traces, screenshots. */
export async function collectArtifacts(workspace: string): Promise<CollectedArtifact[]> {
  const collected: CollectedArtifact[] = [];
  let total = 0;

  async function walk(dir: string, rel: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (EXCLUDED.has(relPath)) continue;
      const info = await stat(abs);
      if (info.isDirectory()) {
        await walk(abs, relPath);
      } else {
        total += info.size;
        if (total > MAX_ARTIFACT_TOTAL_BYTES) return;
        collected.push({ relPath, absPath: abs, bytes: info.size });
      }
    }
  }

  for (const dir of ARTIFACT_DIRS) {
    await walk(join(workspace, dir), dir);
  }
  return collected;
}

export async function cleanupWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
}
