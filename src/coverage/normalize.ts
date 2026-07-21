import { z } from 'zod';
import {
  PRIORITY_LABEL,
  Priority,
  type TestCase,
  type TestCaseAi,
  type TestCaseUi,
} from '../domain/testcase.js';
import type { CoverageItem, GenerationUnit } from '../domain/spec.js';

/**
 * Loose schema for the model output. Novita enforces the JSON schema, but we
 * re-validate defensively and then coerce into the strict internal model so a
 * slightly-off field never crashes a job.
 */
const RawStep = z.object({
  action: z.string().min(1),
  expectedResult: z.string().min(1),
});

const RawTestCase = z
  .object({
    title: z.string().min(1),
    description: z.string().default(''),
    preconditions: z.string().default(''),
    expectedResult: z.string().default(''),
    status: z.string().default('Draft'),
    priority: z.string().default('P2'),
    coverageTags: z.array(z.string()).default([]),
    steps: z.array(RawStep).default([]),
    testType: z.string().default('integration'),
    suite: z.string().default(''),
    route: z.string().nullish(),
    httpMethod: z.string().nullish(),
    endpoint: z.string().nullish(),
    personaId: z.string().nullish(),
    authState: z.string().default('anonymous'),
    selectors: z.array(z.any()).default([]),
    networkMocks: z.array(z.any()).default([]),
    fixtures: z.array(z.string()).default([]),
    seedData: z.array(z.string()).default([]),
    cleanup: z.array(z.string()).default([]),
    assertions: z.array(z.any()).default([]),
    dataInputs: z
      .object({
        valid: z.array(z.string()).default([]),
        invalid: z.array(z.string()).default([]),
        boundary: z.array(z.string()).default([]),
      })
      .default({ valid: [], invalid: [], boundary: [] }),
    edgeCaseClass: z.string().default('happy_path'),
    riskLevel: z.string().default('medium'),
    flakinessRisk: z.string().default('low'),
    estimatedDurationMs: z.number().default(15_000),
    playwright: z.any().default({}),
    coveredItemIds: z.array(z.string()).default([]),
    upstreamIds: z.array(z.string()).default([]),
    evidenceGaps: z.array(z.any()).default([]),
    generationNotes: z.string().default(''),
  })
  .passthrough();

export const RawBatch = z.object({
  testCases: z.array(RawTestCase).default([]),
});
export type RawTestCaseInput = z.infer<typeof RawTestCase>;

function coercePriority(value: unknown): Priority {
  const match = String(value ?? '').match(/P?([0-3])/i);
  const key = match ? (`P${match[1]}` as Priority) : 'P2';
  return Priority.options.includes(key) ? key : 'P2';
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const str = String(value ?? '').toLowerCase();
  const hit = allowed.find((a) => a.toLowerCase() === str);
  return hit ?? fallback;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// Internal coverage-item ids (CI-PERSONA-0101) and native ids (DATA-AUTH-ADMIN,
// CONTRACT-003) are machine references and must never surface as UI tags.
const INTERNAL_ID_TAG = /^(CI-[A-Z]+-\d+|[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\d+|[A-Z]{2,}(-[A-Z]{2,})+)$/;

/** Produces clean, human-readable, kebab-case tags for the Create Test Case UI. */
function cleanCoverageTags(
  raw: string[] | undefined,
  suite: string,
  edgeCaseClass: string | undefined,
): string[] {
  const tags = (raw ?? [])
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !INTERNAL_ID_TAG.test(t))
    .map((t) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, ''),
    )
    .filter((t) => t.length > 1 && t.length <= 40);

  const deduped = [...new Set(tags)];
  if (deduped.length > 0) return deduped.slice(0, 30);

  // Fall back to derived tags so the UI is never left with an empty tag list.
  return [...new Set([suite, edgeCaseClass].filter(Boolean).map((t) =>
    String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
  ))];
}

const VALID_ITEM_IDS = (unit: GenerationUnit) =>
  new Set(unit.items.map((i) => i.id));

/** Turns one raw model object into a validated, UI-safe TestCase. */
export function normalizeTestCase(
  raw: RawTestCaseInput,
  ctx: {
    jobId: string;
    unit: GenerationUnit;
    model: string;
    origin: TestCase['origin'];
    createdAt: string;
    sequence: number;
  },
): TestCase {
  const priority = coercePriority(raw.priority);

  const steps = (raw.steps ?? [])
    .filter((s) => s.action?.trim() && s.expectedResult?.trim())
    .map((s, i) => ({
      index: i + 1,
      action: s.action.trim(),
      expectedResult: s.expectedResult.trim(),
    }));

  // A case with no usable steps is unusable downstream; give it a minimal, honest one.
  if (steps.length === 0) {
    steps.push({
      index: 1,
      action: raw.title.trim(),
      expectedResult: raw.expectedResult?.trim() || 'Behaviour matches the specification.',
    });
  }

  const ui: TestCaseUi = {
    title: raw.title.trim().slice(0, 300),
    description: (raw.description || raw.title).trim(),
    preconditions:
      raw.preconditions?.trim() ||
      'Application is running with seeded canonical fixtures and healthy dependencies.',
    expectedResult:
      raw.expectedResult?.trim() ||
      'All steps pass and the specified behaviour is observed.',
    status: oneOf(
      raw.status,
      ['Draft', 'Ready', 'In Review', 'Approved', 'Deprecated'] as const,
      'Draft',
    ),
    priority,
    priorityLabel: PRIORITY_LABEL[priority],
    coverageTags: cleanCoverageTags(raw.coverageTags, raw.suite || ctx.unit.suite, raw.edgeCaseClass),
    steps,
  };

  const validIds = VALID_ITEM_IDS(ctx.unit);
  const coveredItemIds = [
    ...new Set((raw.coveredItemIds ?? []).filter((id) => validIds.has(id))),
  ];

  const ai: TestCaseAi = {
    testType: oneOf(
      raw.testType,
      ['e2e', 'api', 'contract', 'integration', 'component', 'unit', 'security',
       'performance', 'accessibility', 'visual', 'regression'] as const,
      (ctx.unit.testType as TestCaseAi['testType']) ?? 'integration',
    ),
    suite: raw.suite?.trim() || ctx.unit.suite,
    route: raw.route?.trim() || null,
    httpMethod: raw.httpMethod?.trim() || null,
    endpoint: raw.endpoint?.trim() || null,
    personaId: raw.personaId?.trim() || null,
    authState: oneOf(
      raw.authState,
      ['anonymous', 'authenticated', 'admin', 'disabled'] as const,
      'anonymous',
    ),
    selectors: (raw.selectors ?? [])
      .map((s: Record<string, unknown>) => ({
        purpose: String(s.purpose ?? 'unspecified'),
        strategy: oneOf(
          String(s.strategy ?? 'css'),
          ['role', 'label', 'text', 'testid', 'placeholder', 'css'] as const,
          'css',
        ),
        value: String(s.value ?? ''),
        accessibleName: s.accessibleName == null ? null : String(s.accessibleName),
        fallbackCss: s.fallbackCss == null ? null : String(s.fallbackCss),
        verified: Boolean(s.verified),
        evidence: String(s.evidence ?? 'inferred'),
      }))
      .filter((s) => s.value.length > 0),
    networkMocks: (raw.networkMocks ?? []).map((m: Record<string, unknown>, i: number) => ({
      id: String(m.id ?? `MOCK-${i + 1}`),
      urlPattern: String(m.urlPattern ?? '**/*'),
      method: String(m.method ?? 'GET').toUpperCase(),
      status: clampInt(Number(m.status ?? 200), 100, 599, 200),
      responseBody:
        typeof m.responseBody === 'string'
          ? m.responseBody
          : JSON.stringify(m.responseBody ?? ''),
      failureMode: oneOf(
        String(m.failureMode ?? 'none'),
        ['none', 'timeout', 'malformed', 'rate_limited', 'server_error', 'abort'] as const,
        'none',
      ),
    })),
    fixtures: [...new Set((raw.fixtures ?? []).map((f) => f.trim()).filter(Boolean))],
    seedData: (raw.seedData ?? []).map((s) => s.trim()).filter(Boolean),
    cleanup: (raw.cleanup ?? []).map((s) => s.trim()).filter(Boolean),
    assertions: (raw.assertions ?? [])
      .map((a: Record<string, unknown>) => ({
        kind: oneOf(
          String(a.kind ?? 'visible'),
          ['visible', 'hidden', 'text', 'url', 'status_code', 'json_field', 'count',
           'attribute', 'no_console_errors', 'a11y', 'snapshot', 'latency'] as const,
          'visible',
        ),
        target: String(a.target ?? ''),
        matcher: oneOf(
          String(a.matcher ?? 'toBeVisible'),
          ['toBeVisible', 'toBeHidden', 'toHaveText', 'toContainText', 'toHaveURL', 'toBe',
           'toEqual', 'toHaveCount', 'toHaveAttribute', 'toBeLessThan', 'toMatchSnapshot'] as const,
          'toBeVisible',
        ),
        expected: a.expected == null ? '' : String(a.expected),
      }))
      .filter((a) => a.target.length > 0),
    dataInputs: {
      valid: raw.dataInputs?.valid ?? [],
      invalid: raw.dataInputs?.invalid ?? [],
      boundary: raw.dataInputs?.boundary ?? [],
    },
    edgeCaseClass: oneOf(
      raw.edgeCaseClass,
      ['happy_path', 'negative', 'boundary', 'dependency_failure', 'concurrency',
       'idempotency', 'authz', 'observability', 'cleanup'] as const,
      'happy_path',
    ),
    riskLevel: oneOf(
      raw.riskLevel,
      ['low', 'medium', 'high', 'critical'] as const,
      'medium',
    ),
    flakinessRisk: oneOf(raw.flakinessRisk, ['low', 'medium', 'high'] as const, 'low'),
    estimatedDurationMs: clampInt(Number(raw.estimatedDurationMs), 100, 3_600_000, 15_000),
    playwright: normalizePlaywright(raw.playwright, ui, ctx.unit),
    traceability: {
      sourceDocuments: [
        ...new Set(
          ctx.unit.items
            .filter((i) => coveredItemIds.includes(i.id))
            .flatMap((i) => i.sourceDocument.split(' | ')),
        ),
      ],
      sourceSections: [
        ...new Set(
          ctx.unit.items
            .filter((i) => coveredItemIds.includes(i.id))
            .map((i) => i.sourceSection),
        ),
      ],
      coverageItemIds: coveredItemIds,
      upstreamIds: [
        ...new Set([
          ...(raw.upstreamIds ?? []),
          ...ctx.unit.items
            .filter((i) => coveredItemIds.includes(i.id))
            .flatMap((i) => i.nativeIds),
        ]),
      ],
    },
    evidenceGaps: (raw.evidenceGaps ?? []).map((g: Record<string, unknown>) => ({
      field: String(g.field ?? 'unknown'),
      reason: String(g.reason ?? 'unspecified'),
      verificationAction: String(g.verificationAction ?? 'Verify against the running system.'),
      blocking: Boolean(g.blocking),
    })),
    generationNotes: raw.generationNotes?.trim() ?? '',
  };

  return {
    id: `TC-${ctx.jobId.slice(0, 8)}-${String(ctx.sequence).padStart(4, '0')}`,
    jobId: ctx.jobId,
    origin: ctx.origin,
    model: ctx.model,
    createdAt: ctx.createdAt,
    ui,
    ai,
  };
}

function normalizePlaywright(
  raw: unknown,
  ui: TestCaseUi,
  unit: GenerationUnit,
): TestCaseAi['playwright'] {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    suggestedFile: String(p.suggestedFile ?? `tests/e2e/${unit.suite}.spec.ts`),
    describeBlock: String(p.describeBlock ?? unit.suite),
    testTitle: String(p.testTitle ?? ui.title),
    tags: Array.isArray(p.tags) ? p.tags.map((t) => String(t)) : [`@${ui.priority.toLowerCase()}`],
    requiresAuth: Boolean(p.requiresAuth),
    storageStateKey: p.storageStateKey == null ? null : String(p.storageStateKey),
    viewport: oneOf(String(p.viewport ?? 'desktop'), ['desktop', 'tablet', 'mobile'] as const, 'desktop'),
    locale: String(p.locale ?? 'en'),
    parallelSafe: p.parallelSafe === undefined ? true : Boolean(p.parallelSafe),
    timeoutMs: clampInt(Number(p.timeoutMs ?? 30_000), 1000, 600_000, 30_000),
    retries: clampInt(Number(p.retries ?? 0), 0, 5, 0),
    capturesVisualSnapshot: Boolean(p.capturesVisualSnapshot),
    runsAccessibilityScan: Boolean(p.runsAccessibilityScan),
  };
}

export function coveredIds(cases: TestCase[]): Set<string> {
  const ids = new Set<string>();
  for (const c of cases) for (const id of c.ai.traceability.coverageItemIds) ids.add(id);
  return ids;
}

export function missingItems(
  unit: GenerationUnit,
  cases: TestCase[],
): CoverageItem[] {
  const covered = coveredIds(cases);
  return unit.items.filter((i) => !covered.has(i.id));
}
