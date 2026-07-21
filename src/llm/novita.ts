import { AppError } from '../domain/errors.js';
import { metrics } from '../observability/metrics.js';
import type { Logger } from '../observability/logger.js';

export interface NovitaConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  maxRetries: number;
  circuitFailureThreshold: number;
  circuitResetMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  responseFormat?: JsonSchemaFormat;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export interface CompletionResult {
  content: string;
  model: string;
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
  attempts: number;
}

interface NovitaResponse {
  model?: string;
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string } | string;
  message?: string;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('conflict', 'Job was cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError('conflict', 'Job was cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Trips after repeated upstream failures so a Novita outage fails jobs fast
 * instead of holding every worker slot for the full retry ladder.
 */
class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  get isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.openedAt >= this.resetMs) {
      // Half-open: allow one probe through and let the result decide.
      this.failures = this.threshold - 1;
      metrics.circuitOpen.set(0);
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    metrics.circuitOpen.set(0);
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openedAt = Date.now();
      metrics.circuitOpen.set(1);
    }
  }
}

export class NovitaClient {
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly config: NovitaConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.breaker = new CircuitBreaker(
      config.circuitFailureThreshold,
      config.circuitResetMs,
    );
  }

  get model(): string {
    return this.config.model;
  }

  async complete(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    if (this.breaker.isOpen) {
      metrics.llmCalls.inc({ outcome: 'circuit_open' });
      throw new AppError(
        'circuit_open',
        'Novita is unavailable (circuit breaker open). Retry shortly.',
      );
    }

    const model = request.model ?? this.config.model;

    // Some Novita models only accept response_format=json_object, not json_schema.
    // Start strict; downgrade automatically if the model rejects the schema.
    let responseMode: 'schema' | 'object' | 'none' = request.responseFormat
      ? 'schema'
      : 'none';

    const buildBody = () => {
      const messages =
        responseMode === 'object' && request.responseFormat
          ? [
              ...request.messages.slice(0, -1),
              {
                role: request.messages[request.messages.length - 1]!.role,
                content: `${request.messages[request.messages.length - 1]!.content}\n\nRespond with a single JSON object that conforms to this JSON Schema (no prose, no code fences):\n${JSON.stringify(request.responseFormat.schema)}`,
              },
            ]
          : request.messages;
      return {
        model,
        messages,
        max_tokens: request.maxTokens ?? this.config.maxTokens,
        temperature: request.temperature ?? this.config.temperature,
        ...(responseMode === 'schema' && request.responseFormat
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: request.responseFormat.name,
                  strict: request.responseFormat.strict ?? true,
                  schema: request.responseFormat.schema,
                },
              },
            }
          : {}),
        ...(responseMode === 'object' ? { response_format: { type: 'json_object' } } : {}),
      };
    };

    const started = Date.now();
    let lastError: AppError | null = null;

    for (let attempt = 1; attempt <= this.config.maxRetries + 1; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      const onCancel = () => controller.abort();
      signal?.addEventListener('abort', onCancel, { once: true });

      try {
        const response = await this.fetchImpl(
          `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(buildBody()),
            signal: controller.signal,
          },
        );

        const rawText = await response.text();

        if (!response.ok) {
          // Model advertises structured output but rejects json_schema: downgrade
          // to json_object (schema is moved into the prompt) and retry for free.
          if (
            response.status === 400 &&
            responseMode === 'schema' &&
            /json_schema/i.test(rawText) &&
            /json_object|not support|unsupported/i.test(rawText)
          ) {
            this.logger.warn(
              { model },
              'model rejected json_schema; downgrading to json_object',
            );
            responseMode = 'object';
            attempt -= 1; // this exchange does not consume a retry
            continue; // finally clears the timeout and abort listener
          }
          const retryable = RETRYABLE_STATUS.has(response.status);
          const err = new AppError(
            response.status === 429
              ? 'rate_limited'
              : retryable
                ? 'upstream_error'
                : 'upstream_error',
            `Novita returned ${response.status}: ${rawText.slice(0, 400)}`,
            { retryable },
          );
          if (!retryable) {
            this.breaker.recordFailure();
            metrics.llmCalls.inc({ outcome: `http_${response.status}` });
            throw err;
          }
          lastError = err;
          throw err;
        }

        let parsed: NovitaResponse;
        try {
          parsed = JSON.parse(rawText) as NovitaResponse;
        } catch {
          lastError = new AppError(
            'upstream_error',
            `Novita returned a non-JSON body: ${rawText.slice(0, 300)}`,
          );
          throw lastError;
        }

        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim() === '') {
          lastError = new AppError(
            'upstream_error',
            `Novita returned an empty completion (finish_reason=${parsed.choices?.[0]?.finish_reason ?? 'unknown'}).`,
          );
          throw lastError;
        }

        const latencyMs = Date.now() - started;
        const usage = {
          promptTokens: parsed.usage?.prompt_tokens ?? 0,
          completionTokens: parsed.usage?.completion_tokens ?? 0,
          totalTokens: parsed.usage?.total_tokens ?? 0,
        };

        this.breaker.recordSuccess();
        metrics.llmCalls.inc({ outcome: 'success' });
        metrics.llmDuration.observe(latencyMs / 1000);
        metrics.llmTokens.inc({ direction: 'prompt' }, usage.promptTokens);
        metrics.llmTokens.inc({ direction: 'completion' }, usage.completionTokens);

        return {
          content,
          model: parsed.model ?? model,
          finishReason: parsed.choices?.[0]?.finish_reason ?? 'stop',
          usage,
          latencyMs,
          attempts: attempt,
        };
      } catch (error) {
        if (signal?.aborted) {
          throw new AppError('conflict', 'Job was cancelled.');
        }
        const isTimeout =
          error instanceof Error &&
          (error.name === 'AbortError' || error.name === 'TimeoutError');
        const appError = isTimeout
          ? new AppError(
              'upstream_timeout',
              `Novita call timed out after ${this.config.timeoutMs}ms.`,
            )
          : error instanceof AppError
            ? error
            : new AppError(
                'upstream_error',
                `Novita call failed: ${(error as Error).message}`,
                { cause: error },
              );

        lastError = appError;
        this.breaker.recordFailure();

        const canRetry = appError.retryable && attempt <= this.config.maxRetries;
        metrics.llmCalls.inc({
          outcome: canRetry ? 'retry' : appError.code,
        });
        this.logger.warn(
          {
            attempt,
            code: appError.code,
            willRetry: canRetry,
            message: appError.message.slice(0, 300),
          },
          'novita call failed',
        );
        if (!canRetry) throw appError;

        // Exponential backoff with full jitter, capped so a job cannot stall forever.
        const base = Math.min(1000 * 2 ** (attempt - 1), 20_000);
        await sleep(Math.random() * base + 250, signal);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onCancel);
      }
    }

    throw lastError ?? new AppError('upstream_error', 'Novita call failed.');
  }

  /** Cheap liveness probe used by /readyz. */
  async ping(timeoutMs = 8000): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/$/, '')}/models`,
        {
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
          signal: controller.signal,
        },
      );
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
