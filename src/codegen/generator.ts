import { AppError } from '../domain/errors.js';
import type { NovitaClient } from '../llm/novita.js';
import type { FilePlan } from './types.js';
import { buildCodegenMessages } from './prompt.js';

export interface GeneratedFile {
  code: string;
  warnings: string[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  attempts: number;
  durationMs: number;
  model: string;
}

/** Pulls the TypeScript out of the model reply (fenced block preferred). */
export function extractCode(content: string): string {
  const fenced = content.match(/```(?:ts|typescript)?\s*\n([\s\S]*?)```/);
  const code = (fenced ? fenced[1]! : content).trim();
  return code.endsWith('\n') ? code : `${code}\n`;
}

/** Cheap structural checks: catches empty/prose replies before they persist. */
export function validateSpec(code: string, plan: FilePlan): string[] {
  const warnings: string[] = [];
  if (!code.includes('@playwright/test')) {
    throw new AppError('upstream_error', 'Generated file does not import @playwright/test.');
  }
  if (!/\btest(\.describe)?\s*\(/.test(code)) {
    throw new AppError('upstream_error', 'Generated file contains no test() blocks.');
  }
  if (code.length < 200) {
    throw new AppError('upstream_error', 'Generated file is implausibly short.');
  }
  for (const testCase of plan.cases) {
    if (!code.includes(testCase.id)) {
      warnings.push(`Case ${testCase.id} is not referenced in ${plan.path}.`);
    }
  }
  const secretish = code.match(/\b(password|apiKey|token)\s*[:=]\s*['"][^'"]{8,}['"]/i);
  if (secretish) {
    warnings.push(
      `Possible hardcoded credential in ${plan.path} ("${secretish[0].slice(0, 40)}…") — review before running.`,
    );
  }
  return warnings;
}

export class SpecFileGenerator {
  constructor(private readonly novita: NovitaClient) {}

  async generate(
    plan: FilePlan,
    envVars: string[],
    meta: { sourceJobId: string; codegenJobId: string },
    signal: AbortSignal,
  ): Promise<GeneratedFile> {
    const started = Date.now();
    const result = await this.novita.complete(
      {
        messages: buildCodegenMessages(plan, envVars, meta),
        maxTokens: Math.min(16_000, 3000 + plan.cases.length * 1500),
        temperature: 0.1,
      },
      signal,
    );

    const code = extractCode(result.content);
    const warnings = validateSpec(code, plan);
    if (result.finishReason === 'length') {
      warnings.push(`${plan.path} hit the token limit; the file tail may be truncated.`);
    }

    return {
      code,
      warnings,
      usage: result.usage,
      attempts: result.attempts,
      durationMs: Date.now() - started,
      model: result.model,
    };
  }
}
