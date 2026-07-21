import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from 'fastify';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { Env } from '../config/env.js';
import { AppError, isAppError } from '../domain/errors.js';
import { TestCaseGenerator } from '../llm/generator.js';
import { NovitaClient } from '../llm/novita.js';
import { SpecFileGenerator } from '../codegen/generator.js';
import { CodegenArtifactRepository } from '../codegen/persist.js';
import { CodegenService } from '../codegen/service.js';
import { CodegenStore } from '../codegen/store.js';
import { ArtifactRepository } from '../jobs/persist.js';
import { JobService } from '../jobs/service.js';
import { JobStore } from '../jobs/store.js';
import { defaultExecutor, type ExecutorFactory } from '../runner/executor.js';
import { RunArtifactRepository } from '../runner/persist.js';
import { RunnerService } from '../runner/service.js';
import { RunStore } from '../runner/store.js';
import { createLogger, type Logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import { makeAuthHook } from './auth.js';
import { registerCodegenRoutes } from './routes/codegen.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerRunRoutes } from './routes/runs.js';

export interface BuiltApp {
  app: FastifyInstance;
  logger: Logger;
  novita: NovitaClient;
}

export async function buildApp(
  env: Env,
  overrides: { fetchImpl?: typeof fetch; runnerExec?: ExecutorFactory } = {},
): Promise<BuiltApp> {
  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');

  const app: FastifyInstance = Fastify({
    // pino instance is runtime-compatible; cast keeps the default logger generic
    // so route registrars typed against FastifyInstance stay assignable.
    loggerInstance: logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: env.MAX_TOTAL_BYTES + 1024 * 1024,
    genReqId: () =>
      `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_FILE_BYTES,
      files: env.MAX_FILES_PER_JOB,
      fields: 20,
    },
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/healthz' || req.url === '/metrics',
  });

  const novita = new NovitaClient(
    {
      apiKey: env.NOVITA_API_KEY,
      baseUrl: env.NOVITA_BASE_URL,
      model: env.NOVITA_MODEL,
      maxTokens: env.NOVITA_MAX_TOKENS,
      temperature: env.NOVITA_TEMPERATURE,
      timeoutMs: env.NOVITA_TIMEOUT_MS,
      maxRetries: env.NOVITA_MAX_RETRIES,
      circuitFailureThreshold: env.NOVITA_CIRCUIT_FAILURE_THRESHOLD,
      circuitResetMs: env.NOVITA_CIRCUIT_RESET_MS,
    },
    logger,
    overrides.fetchImpl ?? fetch,
  );

  const generator = new TestCaseGenerator(novita, logger, env.MAX_REPAIR_ROUNDS);
  const store = new JobStore(env.JOB_RETENTION_MS, env.MAX_ACTIVE_JOBS);
  const artifacts = new ArtifactRepository(env.ARTIFACTS_DIR);
  const service = new JobService(store, generator, artifacts, logger, {
    maxItemsPerUnit: env.MAX_ITEMS_PER_UNIT,
    concurrency: env.GENERATION_CONCURRENCY,
    maxRepairRounds: env.MAX_REPAIR_ROUNDS,
    maxGlobalRepairRounds: env.MAX_GLOBAL_REPAIR_ROUNDS,
  });

  const codegenStore = new CodegenStore(
    env.JOB_RETENTION_MS,
    env.MAX_ACTIVE_JOBS,
    env.MAX_ACTIVE_CODEGEN_PER_TENANT,
  );
  const codegenArtifacts = new CodegenArtifactRepository(env.ARTIFACTS_DIR);
  const codegenService = new CodegenService(
    codegenStore,
    new SpecFileGenerator(novita),
    artifacts,
    codegenArtifacts,
    logger,
    {
      concurrency: env.CODEGEN_CONCURRENCY,
      maxCasesPerFile: env.CODEGEN_MAX_CASES_PER_FILE,
    },
  );

  const runStore = new RunStore(
    env.JOB_RETENTION_MS,
    env.MAX_ACTIVE_JOBS,
    env.MAX_ACTIVE_RUNS_PER_TENANT,
  );
  const runArtifacts = new RunArtifactRepository(env.ARTIFACTS_DIR);
  const runnerService = new RunnerService(
    runStore,
    codegenArtifacts,
    runArtifacts,
    overrides.runnerExec ?? defaultExecutor,
    logger,
    {
      mode: env.RUNNER_MODE,
      image: env.RUNNER_IMAGE,
      workspaceDir:
        env.RUNNER_WORKSPACE_DIR ||
        join(tmpdir(), 'tcf-run-workspaces'),
      hostWorkspaceDir: env.RUNNER_HOST_WORKSPACE_DIR,
      defaultTimeoutMs: env.RUN_TIMEOUT_MS,
    },
  );

  // Per-request metrics.
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unknown';
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
    metrics.httpRequests.inc({ route, method: request.method, status: statusClass });
    metrics.httpDuration.observe(reply.elapsedTime / 1000, { route });
  });

  // Error/404 handlers are set BEFORE route plugins register so encapsulated
  // contexts inherit them; registered later, children keep Fastify's defaults.
  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      request.log.warn({ code: error.code, msg: error.message }, 'request error');
      return reply.code(error.statusCode).send(error.toPayload());
    }
    // Fastify validation / multipart errors carry their own status codes.
    const statusCode = (error as { statusCode?: number }).statusCode;
    const message =
      error instanceof Error ? error.message : 'Request could not be processed.';
    if (statusCode && statusCode < 500) {
      const code = statusCode === 413 ? 'payload_too_large' : 'bad_request';
      return reply.code(statusCode).send(new AppError(code, message).toPayload());
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply
      .code(500)
      .send(new AppError('internal_error', 'Internal server error.').toPayload());
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(new AppError('not_found', `Route ${request.method} ${request.url} not found.`).toPayload());
  });

  app.decorateRequest('tenantId', 'default');
  const authHook = makeAuthHook(env.keyToTenant);

  registerHealthRoutes(app, novita);

  await app.register(async (secured) => {
    secured.addHook('preHandler', authHook);
    registerJobRoutes(secured, { service, store, artifacts, env });
    registerCodegenRoutes(secured, {
      codegen: codegenService,
      codegenStore,
      codegenArtifacts,
    });
    registerRunRoutes(secured, { runner: runnerService, runStore, runArtifacts });
  });

  return { app, logger, novita };
}
