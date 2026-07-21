import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { toUiView } from '../../domain/testcase.js';
import type { SourceDocument } from '../../domain/spec.js';
import {
  dedupeDocuments,
  toSourceDocument,
  type RawUpload,
} from '../../ingest/extractor.js';
import type { JobService } from '../../jobs/service.js';
import type { JobStore } from '../../jobs/store.js';
import { ARTIFACT_FILES, type ArtifactRepository } from '../../jobs/persist.js';
import { publicJobView } from '../../jobs/types.js';
import type { Env } from '../../config/env.js';

const OptionsSchema = z.object({
  maxItemsPerUnit: z.coerce.number().int().min(1).max(40).optional(),
  concurrency: z.coerce.number().int().min(1).max(16).optional(),
  maxRepairRounds: z.coerce.number().int().min(0).max(5).optional(),
  maxGlobalRepairRounds: z.coerce.number().int().min(0).max(5).optional(),
});

const JsonSubmitSchema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1),
        mediaType: z.string().optional(),
        content: z.string().min(1),
        encoding: z.enum(['utf8', 'base64']).default('utf8'),
      }),
    )
    .min(1),
  options: OptionsSchema.optional(),
});

async function collectMultipart(
  request: FastifyRequest,
  env: Env,
): Promise<{ uploads: RawUpload[]; options: Partial<z.infer<typeof OptionsSchema>> }> {
  const uploads: RawUpload[] = [];
  const fields: Record<string, string> = {};
  let total = 0;

  const parts = request.parts();
  for await (const part of parts) {
    if (part.type === 'file') {
      if (uploads.length >= env.MAX_FILES_PER_JOB) {
        throw new AppError(
          'bad_request',
          `Too many files; the maximum is ${env.MAX_FILES_PER_JOB}.`,
        );
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of part.file) {
        size += chunk.length;
        total += chunk.length;
        if (size > env.MAX_FILE_BYTES) {
          throw new AppError(
            'payload_too_large',
            `File "${part.filename}" exceeds the ${env.MAX_FILE_BYTES}-byte limit.`,
          );
        }
        if (total > env.MAX_TOTAL_BYTES) {
          throw new AppError(
            'payload_too_large',
            `Total upload exceeds the ${env.MAX_TOTAL_BYTES}-byte limit.`,
          );
        }
        chunks.push(chunk);
      }
      if (part.file.truncated) {
        throw new AppError('payload_too_large', `File "${part.filename}" was truncated.`);
      }
      uploads.push({
        filename: part.filename,
        mediaType: part.mimetype || 'text/plain',
        content: Buffer.concat(chunks),
      });
    } else if (typeof part.value === 'string') {
      fields[part.fieldname] = part.value;
    }
  }

  let options: Partial<z.infer<typeof OptionsSchema>> = {};
  if (fields.options) {
    try {
      options = OptionsSchema.parse(JSON.parse(fields.options));
    } catch {
      throw new AppError('bad_request', 'The "options" field must be valid JSON.');
    }
  }
  return { uploads, options };
}

export function registerJobRoutes(
  app: FastifyInstance,
  deps: {
    service: JobService;
    store: JobStore;
    artifacts: ArtifactRepository;
    env: Env;
  },
): void {
  const { service, store, artifacts, env } = deps;

  app.post('/v1/test-generations', async (request, reply) => {
    const contentType = request.headers['content-type'] ?? '';
    let documents: SourceDocument[];
    let options: Partial<z.infer<typeof OptionsSchema>> = {};

    if (contentType.includes('multipart/form-data')) {
      const { uploads, options: opts } = await collectMultipart(request, env);
      if (uploads.length === 0) {
        throw new AppError('bad_request', 'No files were provided in the multipart body.');
      }
      documents = uploads.map(toSourceDocument);
      options = opts;
    } else if (contentType.includes('application/json')) {
      const parsed = JsonSubmitSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AppError('bad_request', 'Invalid JSON body.', {
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        });
      }
      if (parsed.data.files.length > env.MAX_FILES_PER_JOB) {
        throw new AppError(
          'bad_request',
          `Too many files; the maximum is ${env.MAX_FILES_PER_JOB}.`,
        );
      }
      let total = 0;
      documents = parsed.data.files.map((f) => {
        const content = Buffer.from(f.content, f.encoding);
        total += content.byteLength;
        if (content.byteLength > env.MAX_FILE_BYTES) {
          throw new AppError(
            'payload_too_large',
            `File "${f.filename}" exceeds the ${env.MAX_FILE_BYTES}-byte limit.`,
          );
        }
        if (total > env.MAX_TOTAL_BYTES) {
          throw new AppError('payload_too_large', 'Total upload exceeds the size limit.');
        }
        return toSourceDocument({
          filename: f.filename,
          mediaType: f.mediaType ?? 'text/plain',
          content,
        });
      });
      options = parsed.data.options ?? {};
    } else {
      throw new AppError(
        'unsupported_media_type',
        'Use multipart/form-data (file uploads) or application/json.',
      );
    }

    const { documents: unique, duplicates } = dedupeDocuments(documents);
    const job = service.submit(request.tenantId, unique, duplicates, options);
    return reply.code(202).send(publicJobView(job, true));
  });

  app.get('/v1/test-generations', async (request) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .catch(50)
      .parse((request.query as Record<string, unknown>)?.limit);
    return { jobs: store.list(request.tenantId, limit).map((j) => publicJobView(j)) };
  });

  app.get('/v1/test-generations/:id', async (request) => {
    const { id } = request.params as { id: string };
    return publicJobView(store.get(id, request.tenantId), true);
  });

  // Full detail incl. hidden AI-only context — for the code generator, not the UI.
  app.get('/v1/test-generations/:id/test-cases', async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;
    const view = query.view === 'ui' ? 'ui' : 'full';
    const job = store.get(id, request.tenantId);
    if (view === 'ui') {
      return { jobId: job.id, count: job.cases.length, testCases: job.cases.map(toUiView) };
    }
    return {
      jobId: job.id,
      status: job.status,
      coverage: job.coverage,
      count: job.cases.length,
      testCases: job.cases,
    };
  });

  app.post('/v1/test-generations/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    return publicJobView(service.cancel(id, request.tenantId));
  });

  // ---- Persisted artifacts: survive restarts, always tenant-scoped ----

  app.get('/v1/artifacts', async (request) => {
    const jobs = await artifacts.listJobs(request.tenantId);
    return { tenantId: request.tenantId, jobs, availableFiles: ARTIFACT_FILES };
  });

  app.get('/v1/artifacts/:jobId/files', async (request) => {
    const { jobId } = request.params as { jobId: string };
    const jobs = await artifacts.listJobs(request.tenantId);
    const job = jobs.find((j) => j.jobId === jobId);
    if (!job) {
      throw new AppError('not_found', `No persisted artifacts for job "${jobId}".`);
    }
    return { jobId, files: job.files };
  });

  app.get('/v1/artifacts/:jobId/files/:file', async (request, reply) => {
    const { jobId, file } = request.params as { jobId: string; file: string };
    const content = await artifacts.read(request.tenantId, jobId, file);
    reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${jobId}-${file}"`);
    return reply.send(content);
  });
}
