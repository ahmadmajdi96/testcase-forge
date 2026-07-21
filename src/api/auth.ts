import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../domain/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved from the presented API key; "default" when auth is disabled. */
    tenantId: string;
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Bearer or x-api-key auth. Each key belongs to exactly one tenant; the
 * resolved tenant id scopes every job and artifact the request can touch.
 * When no keys are configured the service is open under the "default" tenant,
 * which is only permitted outside production (enforced in env loading).
 */
export function makeAuthHook(keyToTenant: Map<string, string>) {
  return async function authHook(request: FastifyRequest): Promise<void> {
    if (keyToTenant.size === 0) {
      request.tenantId = 'default';
      return;
    }

    const header = request.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const apiKeyHeader = request.headers['x-api-key'];
    const provided =
      bearer ??
      (typeof apiKeyHeader === 'string' ? apiKeyHeader.trim() : undefined);

    if (!provided) {
      throw new AppError('unauthorized', 'Missing API key.');
    }
    // Constant-time compare against every key; resolve the matching tenant.
    let tenant: string | null = null;
    for (const [key, tenantId] of keyToTenant) {
      if (safeEqual(key, provided)) tenant = tenantId;
    }
    if (tenant === null) {
      throw new AppError('unauthorized', 'Invalid API key.');
    }
    request.tenantId = tenant;
  };
}
