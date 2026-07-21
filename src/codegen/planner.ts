import type { TestCase } from '../domain/testcase.js';
import type { CodegenInclude, FilePlan } from './types.js';

/**
 * Spec file paths come from model output (`ai.playwright.suggestedFile`), so
 * they are treated as untrusted: strip traversal, collapse to a safe charset,
 * force the `.spec.ts` extension and pin everything under `tests/`.
 */
export function sanitizeSpecPath(raw: string | undefined, suite: string): string {
  let path = (raw ?? '')
    .replace(/\\/g, '/')
    .replace(/\.\.+/g, '.')
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9_\-./]/g, '-');

  path = path
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.')
    .join('/');

  if (!path) path = `${suite}.spec.ts`;
  if (!path.endsWith('.spec.ts')) {
    path = `${path.replace(/\.(ts|js|tsx|mjs|cjs|spec)$/i, '')}.spec.ts`;
  }
  if (!path.startsWith('tests/')) path = `tests/${path}`;
  return path.slice(0, 180);
}

export function filterCases(cases: TestCase[], include: CodegenInclude): TestCase[] {
  let filtered = cases;
  if (include.suites?.length) {
    const set = new Set(include.suites.map((s) => s.toLowerCase()));
    filtered = filtered.filter((c) => set.has(c.ai.suite.toLowerCase()));
  }
  if (include.testTypes?.length) {
    const set = new Set(include.testTypes.map((t) => t.toLowerCase()));
    filtered = filtered.filter((c) => set.has(c.ai.testType.toLowerCase()));
  }
  if (include.priorities?.length) {
    const set = new Set(include.priorities.map((p) => p.toUpperCase()));
    filtered = filtered.filter((c) => set.has(c.ui.priority));
  }
  // Highest severity first so a capped run keeps the P0s.
  filtered = [...filtered].sort(
    (a, b) => a.ui.priority.localeCompare(b.ui.priority) || a.id.localeCompare(b.id),
  );
  if (include.limit && include.limit > 0) filtered = filtered.slice(0, include.limit);
  return filtered;
}

/** Groups cases into spec files, splitting oversized groups into -partN files. */
export function planFiles(cases: TestCase[], maxCasesPerFile: number): FilePlan[] {
  const groups = new Map<string, FilePlan>();

  for (const testCase of cases) {
    const path = sanitizeSpecPath(testCase.ai.playwright.suggestedFile, testCase.ai.suite);
    const group = groups.get(path) ?? {
      path,
      suite: testCase.ai.suite,
      testType: testCase.ai.testType,
      cases: [],
    };
    group.cases.push(testCase);
    groups.set(path, group);
  }

  const plans: FilePlan[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    if (group.cases.length <= maxCasesPerFile) {
      plans.push(group);
      continue;
    }
    for (let i = 0; i < group.cases.length; i += maxCasesPerFile) {
      const part = Math.floor(i / maxCasesPerFile) + 1;
      plans.push({
        ...group,
        path:
          part === 1
            ? group.path
            : group.path.replace(/\.spec\.ts$/, `.part${part}.spec.ts`),
        cases: group.cases.slice(i, i + maxCasesPerFile),
      });
    }
  }
  return plans;
}
