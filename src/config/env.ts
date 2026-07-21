import { z } from 'zod';

const bytes = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  SERVICE_API_KEYS: z.string().default(''),
  /** Tenant-scoped keys: "tenantA:key1,tenantA:key2,tenantB:key3". */
  TENANT_API_KEYS: z.string().default(''),
  ARTIFACTS_DIR: z.string().default('artifacts'),

  MAX_FILES_PER_JOB: z.coerce.number().int().positive().default(40),
  MAX_FILE_BYTES: bytes(10 * 1024 * 1024),
  MAX_TOTAL_BYTES: bytes(50 * 1024 * 1024),

  NOVITA_API_KEY: z.string().min(1, 'NOVITA_API_KEY is required'),
  NOVITA_BASE_URL: z.string().url().default('https://api.novita.ai/v3/openai'),
  NOVITA_MODEL: z.string().default('deepseek/deepseek-v3.2'),
  NOVITA_MAX_TOKENS: z.coerce.number().int().positive().default(8000),
  NOVITA_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  NOVITA_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  NOVITA_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(4),
  NOVITA_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(8),
  NOVITA_CIRCUIT_RESET_MS: z.coerce.number().int().positive().default(30_000),

  GENERATION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  MAX_ITEMS_PER_UNIT: z.coerce.number().int().min(1).max(40).default(8),
  MAX_REPAIR_ROUNDS: z.coerce.number().int().min(0).max(5).default(2),
  MAX_GLOBAL_REPAIR_ROUNDS: z.coerce.number().int().min(0).max(5).default(2),

  CODEGEN_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  CODEGEN_MAX_CASES_PER_FILE: z.coerce.number().int().min(1).max(20).default(6),
  MAX_ACTIVE_CODEGEN_PER_TENANT: z.coerce.number().int().min(1).max(50).default(3),

  /** docker = isolated container per run (production); subprocess = host process (dev). */
  RUNNER_MODE: z.enum(['docker', 'subprocess']).default('docker'),
  RUNNER_IMAGE: z.string().default('mcr.microsoft.com/playwright:v1.49.1-jammy'),
  RUNNER_WORKSPACE_DIR: z.string().default(''),
  /** Host-visible path of RUNNER_WORKSPACE_DIR when the service itself runs in a container. */
  RUNNER_HOST_WORKSPACE_DIR: z.string().default(''),
  RUN_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(900_000),
  MAX_ACTIVE_RUNS_PER_TENANT: z.coerce.number().int().min(1).max(20).default(2),
  JOB_RETENTION_MS: z.coerce.number().int().positive().default(86_400_000),
  MAX_ACTIVE_JOBS: z.coerce.number().int().positive().default(200),
});

export type Env = z.infer<typeof EnvSchema> & {
  apiKeys: string[];
  /** api key -> tenant id. Empty map means auth is disabled (non-production only). */
  keyToTenant: Map<string, string>;
};

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration -> ${detail}`);
  }
  const keyToTenant = new Map<string, string>();

  // Untenanted keys (SERVICE_API_KEYS) belong to the "default" tenant.
  for (const key of parsed.data.SERVICE_API_KEYS.split(',')) {
    const trimmed = key.trim();
    if (trimmed) keyToTenant.set(trimmed, 'default');
  }
  // TENANT_API_KEYS entries are "tenant:key". Tenant ids are path-safe slugs.
  for (const entry of parsed.data.TENANT_API_KEYS.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0 || sep === trimmed.length - 1) {
      throw new Error(
        `Invalid TENANT_API_KEYS entry "${trimmed}"; expected "tenant:key".`,
      );
    }
    const tenant = trimmed.slice(0, sep).trim();
    const key = trimmed.slice(sep + 1).trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(tenant)) {
      throw new Error(
        `Invalid tenant id "${tenant}"; use alphanumerics, "-" or "_" (max 64 chars).`,
      );
    }
    if (keyToTenant.has(key)) {
      throw new Error('Duplicate API key found across tenants; keys must be unique.');
    }
    keyToTenant.set(key, tenant);
  }

  const apiKeys = [...keyToTenant.keys()];

  if (parsed.data.MAX_FILE_BYTES > parsed.data.MAX_TOTAL_BYTES) {
    throw new Error('MAX_FILE_BYTES cannot exceed MAX_TOTAL_BYTES');
  }
  if (parsed.data.NODE_ENV === 'production' && apiKeys.length === 0) {
    throw new Error(
      'SERVICE_API_KEYS or TENANT_API_KEYS must be set when NODE_ENV=production',
    );
  }
  return { ...parsed.data, apiKeys, keyToTenant };
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
