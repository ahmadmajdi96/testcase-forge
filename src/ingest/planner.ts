import type { CoverageItem, GenerationUnit, SpecModel } from '../domain/spec.js';

/** Maps an extracted fact onto the test discipline that should exercise it. */
const SUITE_BY_KIND: Record<string, { suite: string; testType: string }> = {
  endpoint: { suite: 'api-contract', testType: 'contract' },
  route: { suite: 'ui-e2e', testType: 'e2e' },
  selector: { suite: 'ui-e2e', testType: 'e2e' },
  component: { suite: 'component', testType: 'component' },
  env_var: { suite: 'configuration', testType: 'integration' },
  persona: { suite: 'authorization', testType: 'security' },
  fixture: { suite: 'test-data', testType: 'integration' },
  mock: { suite: 'dependency-failure', testType: 'integration' },
  planned_case: { suite: 'functional', testType: 'integration' },
  risk: { suite: 'risk-regression', testType: 'regression' },
  gate: { suite: 'release-gate', testType: 'regression' },
  workload: { suite: 'performance', testType: 'performance' },
  environment: { suite: 'environment', testType: 'integration' },
  requirement: { suite: 'requirements', testType: 'e2e' },
};

const SECURITY_HINT =
  /(security|auth|jwt|secret|redact|hmac|tenant|isolation|destructive|production|rate limit|upload)/i;
const PERF_HINT = /(performance|latency|load|stress|spike|soak|throughput|p95|p99)/i;
const A11Y_HINT = /(accessib|a11y|aria|screen reader|keyboard)/i;

/**
 * These documents repeat a source-evidence boilerplate that lists filenames like
 * `05_selector_and_accessibility_inventory.md` and `07_security_..._guide.md`.
 * Classifying on the item body would let those filenames hijack the suite, so we
 * only inspect the section heading and title, and strip the ".md/.json" tokens.
 */
function classify(item: CoverageItem): { suite: string; testType: string } {
  // A concrete endpoint/route/selector is defined by its kind, not prose keywords.
  const structuralKinds = new Set(['endpoint', 'route', 'selector', 'persona', 'mock', 'fixture']);
  if (structuralKinds.has(item.kind)) {
    return SUITE_BY_KIND[item.kind] ?? { suite: 'functional', testType: 'integration' };
  }

  const haystack = `${item.sourceSection} ${item.title}`.replace(
    /\b[\w-]+\.(md|json|ts|js)\b/gi,
    ' ',
  );
  if (A11Y_HINT.test(haystack)) return { suite: 'accessibility', testType: 'accessibility' };
  if (PERF_HINT.test(haystack)) return { suite: 'performance', testType: 'performance' };
  if (SECURITY_HINT.test(haystack)) return { suite: 'security', testType: 'security' };
  return SUITE_BY_KIND[item.kind] ?? { suite: 'functional', testType: 'integration' };
}

/**
 * Partitions every coverage item into small, homogeneous units. Small units keep
 * each prompt focused (better output quality) and bound the blast radius of a
 * single failed model call.
 */
export function planGeneration(
  spec: SpecModel,
  maxItemsPerUnit: number,
): GenerationUnit[] {
  return planUnitsFromItems(spec.items, maxItemsPerUnit, 'U');
}

/**
 * Partitions an arbitrary set of coverage items into ordered generation units.
 * Reused by the job-level repair pass to re-plan only the items left uncovered
 * (e.g. because a unit timed out and was skipped).
 */
export function planUnitsFromItems(
  items: CoverageItem[],
  maxItemsPerUnit: number,
  idPrefix = 'U',
): GenerationUnit[] {
  const groups = new Map<string, { suite: string; testType: string; items: CoverageItem[] }>();

  for (const item of items) {
    const { suite, testType } = classify(item);
    // Grouping by source section keeps semantically related facts together.
    const key = `${suite}::${testType}::${item.sourceDocument.split(' | ')[0]}::${item.sourceSection}`;
    const group = groups.get(key) ?? { suite, testType, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  const units: GenerationUnit[] = [];
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [, group] of ordered) {
    const sorted = [...group.items].sort((a, b) =>
      a.priority === b.priority
        ? a.id.localeCompare(b.id)
        : a.priority.localeCompare(b.priority),
    );
    for (let offset = 0; offset < sorted.length; offset += maxItemsPerUnit) {
      const slice = sorted.slice(offset, offset + maxItemsPerUnit);
      units.push({
        id: `${idPrefix}-${String(units.length + 1).padStart(4, '0')}`,
        suite: group.suite,
        testType: group.testType,
        items: slice,
        minCases: slice.length,
      });
    }
  }

  // Highest-severity work first: a partially completed job still covers the P0s.
  return units.sort((a, b) => {
    const severity = (u: GenerationUnit) =>
      Math.min(...u.items.map((i) => Number(i.priority.slice(1))));
    return severity(a) - severity(b) || a.id.localeCompare(b.id);
  });
}
