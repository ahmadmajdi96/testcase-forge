import type { FastifyInstance } from 'fastify';
import type { NovitaClient } from '../../llm/novita.js';
import { renderMetrics } from '../../observability/metrics.js';

export function registerHealthRoutes(
  app: FastifyInstance,
  novita: NovitaClient,
): void {
  app.get('/healthz', async () => ({ status: 'ok', uptimeSec: process.uptime() }));

  app.get('/readyz', async (_req, reply) => {
    const upstreamOk = await novita.ping();
    if (!upstreamOk) {
      return reply
        .code(503)
        .send({ status: 'degraded', novita: 'unreachable' });
    }
    return { status: 'ready', novita: 'reachable' };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return renderMetrics();
  });
}
