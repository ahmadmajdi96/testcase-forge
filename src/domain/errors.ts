export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'unprocessable_entity'
  | 'rate_limited'
  | 'upstream_error'
  | 'upstream_timeout'
  | 'circuit_open'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  unprocessable_entity: 422,
  rate_limited: 429,
  upstream_error: 502,
  upstream_timeout: 504,
  circuit_open: 503,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = options.details;
    this.retryable =
      options.retryable ??
      ['upstream_error', 'upstream_timeout', 'rate_limited', 'circuit_open'].includes(
        code,
      );
  }

  toPayload(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
