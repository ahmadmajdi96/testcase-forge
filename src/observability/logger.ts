import pino from 'pino';

const REDACT_PATTERNS: RegExp[] = [
  /\bsk_[A-Za-z0-9_\-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-]{8,}\b/gi,
  /\beyJ[A-Za-z0-9._\-]{20,}\b/g, // JWT-shaped
];

/**
 * Secrets can arrive inside uploaded documents, provider error bodies and model
 * output, so redaction is applied to free-form strings rather than fixed paths.
 */
export function redact(value: string): string {
  return REDACT_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, '[redacted]'),
    value,
  );
}

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    base: { service: 'testcase-forge' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'apiKey',
        'novitaApiKey',
      ],
      censor: '[redacted]',
    },
    hooks: {
      logMethod(args, method) {
        const sanitized = args.map((arg) =>
          typeof arg === 'string' ? redact(arg) : arg,
        );
        return method.apply(this, sanitized as typeof args);
      },
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
