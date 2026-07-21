import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import type { RunArtifactRepository } from '../../runner/persist.js';
import type { RunnerService } from '../../runner/service.js';
import type { RunStore } from '../../runner/store.js';
import { publicRunView } from '../../runner/types.js';

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

const SubmitSchema = z.object({
  codegenJobId: z.string().uuid(),
  options: z.object({
    baseUrl: z.string().url(),
    /** Runtime env values (credentials etc). Held in memory only, never persisted. */
    env: z
      .record(
        z.string().regex(ENV_NAME, 'Env keys must be UPPER_SNAKE_CASE.'),
        z.string().max(2000),
      )
      .refine((r) => Object.keys(r).length <= 50, 'Too many env entries.')
      .default({}),
    timeoutMs: z.coerce.number().int().min(30_000).max(3_600_000).optional(),
  }),
});

export function registerRunRoutes(
  app: FastifyInstance,
  deps: { runner: RunnerService; runStore: RunStore; runArtifacts: RunArtifactRepository },
): void {
  const { runner, runStore, runArtifacts } = deps;

  // Explicitly client-triggered.
  app.post('/v1/test-runs', async (request, reply) => {
    const parsed = SubmitSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('bad_request', 'Invalid test-run request.', {
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const job = runner.submit(request.tenantId, parsed.data.codegenJobId, {
      baseUrl: parsed.data.options.baseUrl,
      env: parsed.data.options.env,
      timeoutMs: parsed.data.options.timeoutMs,
    });
    return reply.code(202).send(publicRunView(job));
  });

  app.get('/v1/test-runs', async (request) => {
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .catch(50)
      .parse((request.query as Record<string, unknown>)?.limit);
    return { runs: runStore.list(request.tenantId, limit).map((j) => publicRunView(j)) };
  });

  app.get('/v1/test-runs/:id', async (request) => {
    const { id } = request.params as { id: string };
    return publicRunView(runStore.get(id, request.tenantId));
  });

  /**
   * Live view: Server-Sent Events. Replays the full history, then streams every
   * new event (test started/finished, steps, artifacts) until the run ends.
   */
  app.get('/v1/test-runs/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    // Tenant check BEFORE committing the stream: wrong tenant gets a JSON 404,
    // never an open event stream.
    runStore.get(id, request.tenantId);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const send = (event: { seq: number; type: string; ts: string; data: unknown }) => {
      reply.raw.write(
        `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ ts: event.ts, ...(event.data as object) })}\n\n`,
      );
      if (event.type === 'run_terminal') {
        clearInterval(heartbeat);
        reply.raw.end();
      }
    };

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    let unsubscribe: () => void;
    try {
      unsubscribe = runner.subscribe(id, request.tenantId, send);
    } catch (error) {
      clearInterval(heartbeat);
      reply.raw.end();
      throw error;
    }
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    // Response is streamed manually; tell Fastify not to serialize anything.
    return reply;
  });

  app.post('/v1/test-runs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    return publicRunView(runner.cancel(id, request.tenantId));
  });

  // ---- Persisted evidence: videos, traces, screenshots, logs ----

  app.get('/v1/test-runs/:id/artifacts', async (request) => {
    const { id } = request.params as { id: string };
    const manifest = await runArtifacts.readManifest(request.tenantId, id);
    return {
      runId: id,
      status: manifest.status,
      tests: manifest.tests,
      files: manifest.persistedFiles,
    };
  });

  app.get('/v1/test-runs/:id/artifacts/*', async (request, reply) => {
    const { id } = request.params as { id: string };
    const relPath = (request.params as Record<string, string>)['*'] ?? '';
    const { content, contentType } = await runArtifacts.readArtifact(
      request.tenantId,
      id,
      relPath,
    );
    return reply
      .header('Content-Type', contentType)
      .header('Content-Disposition', `inline; filename="${relPath.split('/').pop()}"`)
      .send(content);
  });

  app.get('/v1/run-artifacts', async (request) => {
    return { tenantId: request.tenantId, runs: await runArtifacts.listRuns(request.tenantId) };
  });
}
