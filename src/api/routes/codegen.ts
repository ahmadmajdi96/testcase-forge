import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import type { CodegenArtifactRepository } from '../../codegen/persist.js';
import type { CodegenService } from '../../codegen/service.js';
import type { CodegenStore } from '../../codegen/store.js';
import { publicCodegenView } from '../../codegen/types.js';

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

const SubmitSchema = z.object({
  sourceJobId: z.string().uuid(),
  options: z
    .object({
      baseUrl: z.string().url().optional(),
      envVars: z
        .array(z.string().regex(ENV_NAME, 'Env vars must be UPPER_SNAKE_CASE names.'))
        .max(50)
        .optional(),
      concurrency: z.coerce.number().int().min(1).max(16).optional(),
      maxCasesPerFile: z.coerce.number().int().min(1).max(20).optional(),
      uiLocale: z.string().min(2).max(10).optional(),
      localeStorageKey: z.string().min(1).max(64).optional(),
      include: z
        .object({
          suites: z.array(z.string().min(1)).max(50).optional(),
          testTypes: z.array(z.string().min(1)).max(20).optional(),
          priorities: z.array(z.enum(['P0', 'P1', 'P2', 'P3'])).optional(),
          limit: z.coerce.number().int().min(1).max(2000).optional(),
        })
        .optional(),
    })
    .optional(),
});

export function registerCodegenRoutes(
  app: FastifyInstance,
  deps: {
    codegen: CodegenService;
    codegenStore: CodegenStore;
    codegenArtifacts: CodegenArtifactRepository;
  },
): void {
  const { codegen, codegenStore, codegenArtifacts } = deps;

  // Explicitly client-triggered: this is the only way a codegen job starts.
  app.post('/v1/codegen', async (request, reply) => {
    const parsed = SubmitSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('bad_request', 'Invalid codegen request.', {
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const job = codegen.submit(
      request.tenantId,
      parsed.data.sourceJobId,
      parsed.data.options ?? {},
    );
    return reply.code(202).send(publicCodegenView(job));
  });

  app.get('/v1/codegen', async (request) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .catch(50)
      .parse((request.query as Record<string, unknown>)?.limit);
    return {
      jobs: codegenStore.list(request.tenantId, limit).map((j) => publicCodegenView(j)),
    };
  });

  app.get('/v1/codegen/:id', async (request) => {
    const { id } = request.params as { id: string };
    return publicCodegenView(codegenStore.get(id, request.tenantId));
  });

  // Full append-only trace: every planning/generation/persistence event.
  app.get('/v1/codegen/:id/trace', async (request) => {
    const { id } = request.params as { id: string };
    const job = codegenStore.get(id, request.tenantId);
    return { jobId: job.id, status: job.status, trace: job.trace };
  });

  app.post('/v1/codegen/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    return publicCodegenView(codegen.cancel(id, request.tenantId));
  });

  // ---- Persisted output (survives restarts; served from disk) ----

  app.get('/v1/codegen/:id/files', async (request) => {
    const { id } = request.params as { id: string };
    const manifest = await codegenArtifacts.readManifest(request.tenantId, id);
    return {
      jobId: id,
      status: manifest.status,
      files: manifest.persistedFiles,
    };
  });

  app.get('/v1/codegen/:id/files/*', async (request, reply) => {
    const { id } = request.params as { id: string };
    const relPath = (request.params as Record<string, string>)['*'] ?? '';
    const content = await codegenArtifacts.readFile(request.tenantId, id, relPath);
    const type = relPath.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : 'text/plain; charset=utf-8';
    return reply.header('Content-Type', type).send(content);
  });

  /** Whole suite as one JSON map {path: content} — write-to-disk on the client. */
  app.get('/v1/codegen/:id/bundle', async (request) => {
    const { id } = request.params as { id: string };
    const files = await codegenArtifacts.readBundle(request.tenantId, id);
    return { jobId: id, fileCount: Object.keys(files).length, files };
  });

  /** Persisted codegen jobs for this tenant (post-restart discovery). */
  app.get('/v1/codegen-artifacts', async (request) => {
    return {
      tenantId: request.tenantId,
      jobs: await codegenArtifacts.listJobs(request.tenantId),
    };
  });
}
