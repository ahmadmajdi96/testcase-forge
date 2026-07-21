import { AppError } from '../domain/errors.js';
import type { GenerationUnit, SpecModel } from '../domain/spec.js';
import type { TestCase } from '../domain/testcase.js';
import type { Logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import type { NovitaClient } from './novita.js';
import { buildGenerationMessages, buildRepairMessages } from './prompt.js';
import { TEST_CASE_BATCH_SCHEMA } from './schema.js';
import { RawBatch, missingItems, normalizeTestCase } from '../coverage/normalize.js';
import { parseBatch } from './parse.js';

export interface UnitResult {
  unitId: string;
  suite: string;
  cases: TestCase[];
  coveredCount: number;
  requestedCount: number;
  repairRounds: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  warnings: string[];
}

export class TestCaseGenerator {
  constructor(
    private readonly novita: NovitaClient,
    private readonly logger: Logger,
    private readonly maxRepairRounds: number,
  ) {}

  async generateUnit(
    spec: SpecModel,
    unit: GenerationUnit,
    jobId: string,
    signal: AbortSignal,
    seq: { next(): number },
  ): Promise<UnitResult> {
    const warnings: string[] = [];
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const cases: TestCase[] = [];

    const runOnce = async (
      messages: ReturnType<typeof buildGenerationMessages>,
      origin: TestCase['origin'],
    ): Promise<TestCase[]> => {
      const result = await this.novita.complete(
        {
          messages,
          responseFormat: TEST_CASE_BATCH_SCHEMA,
          // Give large units more room so the batch is never truncated mid-array.
          maxTokens: Math.min(16_000, 2500 + unit.items.length * 900),
        },
        signal,
      );
      usage.promptTokens += result.usage.promptTokens;
      usage.completionTokens += result.usage.completionTokens;
      usage.totalTokens += result.usage.totalTokens;

      const parsed = RawBatch.safeParse(parseBatch(result.content));
      if (result.finishReason === 'length') {
        warnings.push(
          `Unit ${unit.id} response hit the token limit; recovered ${parsed.success ? parsed.data.testCases.length : 0} complete case(s), some variants may be missing.`,
        );
      }
      if (!parsed.success || parsed.data.testCases.length === 0) {
        throw new AppError(
          'upstream_error',
          `Model output failed validation: ${parsed.success ? 'no test cases' : parsed.error.issues[0]?.message ?? 'unknown'}`,
        );
      }

      const createdAt = new Date().toISOString();
      return parsed.data.testCases.map((raw) =>
        normalizeTestCase(raw, {
          jobId,
          unit,
          model: result.model,
          origin,
          createdAt,
          sequence: seq.next(),
        }),
      );
    };

    cases.push(...(await runOnce(buildGenerationMessages(spec, unit), 'model')));

    // Coverage-repair loop: re-ask only for items no case claimed to cover.
    let repairRounds = 0;
    for (let round = 0; round < this.maxRepairRounds; round += 1) {
      const missing = missingItems(unit, cases);
      if (missing.length === 0) break;
      repairRounds += 1;
      this.logger.info(
        { unit: unit.id, round: round + 1, missing: missing.length },
        'repairing coverage gap',
      );
      try {
        const repaired = await runOnce(
          buildRepairMessages(spec, unit, missing),
          'model-repair',
        );
        cases.push(...repaired);
      } catch (error) {
        warnings.push(
          `Repair round ${round + 1} for unit ${unit.id} failed: ${(error as Error).message}`,
        );
        break;
      }
    }

    const stillMissing = missingItems(unit, cases);
    if (stillMissing.length > 0) {
      warnings.push(
        `Unit ${unit.id} left ${stillMissing.length} item(s) uncovered after ${repairRounds} repair round(s): ${stillMissing
          .map((i) => i.id)
          .join(', ')}.`,
      );
    }

    for (const c of cases) {
      metrics.testCases.inc({ origin: c.origin, suite: unit.suite });
    }

    return {
      unitId: unit.id,
      suite: unit.suite,
      cases,
      coveredCount: unit.items.length - stillMissing.length,
      requestedCount: unit.items.length,
      repairRounds,
      usage,
      warnings,
    };
  }
}
