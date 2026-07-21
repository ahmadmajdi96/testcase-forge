import { AppError } from '../domain/errors.js';

/**
 * Scans a `[ {...}, {...} ]` array and returns every top-level object that is
 * completely balanced, tolerating a truncated final element. This recovers the
 * usable cases from a response that hit the token limit mid-array instead of
 * discarding the whole batch.
 */
export function salvageObjects(arrayBody: string): unknown[] {
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < arrayBody.length; i += 1) {
    const ch = arrayBody[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(arrayBody.slice(start, i + 1)));
        } catch {
          /* skip an individually malformed object */
        }
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Parses model output into `{ testCases: [...] }`. Handles code fences,
 * leading/trailing prose and truncated arrays without discarding partial
 * results.
 */
export function parseBatch(content: string): { testCases: unknown[] } {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1]! : trimmed).trim();

  try {
    const whole = JSON.parse(candidate) as { testCases?: unknown[] };
    if (whole && Array.isArray(whole.testCases)) return { testCases: whole.testCases };
  } catch {
    /* fall through to salvage */
  }

  const key = candidate.indexOf('"testCases"');
  const arrayStart = candidate.indexOf('[', key >= 0 ? key : 0);
  if (arrayStart >= 0) {
    const salvaged = salvageObjects(candidate.slice(arrayStart));
    if (salvaged.length > 0) return { testCases: salvaged };
  }

  const salvaged = salvageObjects(candidate);
  if (salvaged.length > 0) return { testCases: salvaged };

  throw new AppError('upstream_error', 'Model output contained no recoverable test cases.');
}
