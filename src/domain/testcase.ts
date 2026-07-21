import { z } from 'zod';

/**
 * The test case model is split in two halves on purpose:
 *
 *  - `ui`      mirrors the Create Test Case screen exactly (Title, Description,
 *              Preconditions, Expected Result, numbered Test Steps, Status,
 *              Priority, Coverage Tags). Nothing else is rendered.
 *  - `ai`      is never rendered. It carries the machine context a downstream
 *              model needs to emit runnable Playwright specs: routes, locators,
 *              network mocks, fixtures, assertions, traceability, evidence gaps.
 */

export const TestStatus = z.enum([
  'Draft',
  'Ready',
  'In Review',
  'Approved',
  'Deprecated',
]);
export type TestStatus = z.infer<typeof TestStatus>;

export const Priority = z.enum(['P0', 'P1', 'P2', 'P3']);
export type Priority = z.infer<typeof Priority>;

export const PRIORITY_LABEL: Record<Priority, string> = {
  P0: 'P0 - Blocker',
  P1: 'P1 - Critical',
  P2: 'P2 - High',
  P3: 'P3 - Medium',
};

export const TestStep = z.object({
  index: z.number().int().positive(),
  action: z.string().min(1),
  expectedResult: z.string().min(1),
});
export type TestStep = z.infer<typeof TestStep>;

export const TestCaseUi = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1),
  preconditions: z.string().min(1),
  expectedResult: z.string().min(1),
  status: TestStatus,
  priority: Priority,
  priorityLabel: z.string(),
  coverageTags: z.array(z.string().min(1)).max(30),
  steps: z.array(TestStep).min(1).max(40),
});
export type TestCaseUi = z.infer<typeof TestCaseUi>;

export const TestType = z.enum([
  'e2e',
  'api',
  'contract',
  'integration',
  'component',
  'unit',
  'security',
  'performance',
  'accessibility',
  'visual',
  'regression',
]);
export type TestType = z.infer<typeof TestType>;

export const SelectorHint = z.object({
  purpose: z.string().min(1),
  strategy: z.enum(['role', 'label', 'text', 'testid', 'placeholder', 'css']),
  value: z.string().min(1),
  accessibleName: z.string().nullable(),
  fallbackCss: z.string().nullable(),
  /** false means the locator was inferred and must be confirmed at runtime. */
  verified: z.boolean(),
  evidence: z.string(),
});

export const NetworkMock = z.object({
  id: z.string().min(1),
  urlPattern: z.string().min(1),
  method: z.string().min(1),
  status: z.number().int().min(100).max(599),
  responseBody: z.string(),
  failureMode: z
    .enum(['none', 'timeout', 'malformed', 'rate_limited', 'server_error', 'abort'])
    .default('none'),
});

export const Assertion = z.object({
  kind: z.enum([
    'visible',
    'hidden',
    'text',
    'url',
    'status_code',
    'json_field',
    'count',
    'attribute',
    'no_console_errors',
    'a11y',
    'snapshot',
    'latency',
  ]),
  target: z.string().min(1),
  matcher: z.enum([
    'toBeVisible',
    'toBeHidden',
    'toHaveText',
    'toContainText',
    'toHaveURL',
    'toBe',
    'toEqual',
    'toHaveCount',
    'toHaveAttribute',
    'toBeLessThan',
    'toMatchSnapshot',
  ]),
  expected: z.string(),
});

export const PlaywrightHints = z.object({
  suggestedFile: z.string().min(1),
  describeBlock: z.string().min(1),
  testTitle: z.string().min(1),
  tags: z.array(z.string()),
  requiresAuth: z.boolean(),
  storageStateKey: z.string().nullable(),
  viewport: z.enum(['desktop', 'tablet', 'mobile']),
  locale: z.string(),
  parallelSafe: z.boolean(),
  timeoutMs: z.number().int().positive(),
  retries: z.number().int().min(0).max(5),
  capturesVisualSnapshot: z.boolean(),
  runsAccessibilityScan: z.boolean(),
});

export const Traceability = z.object({
  sourceDocuments: z.array(z.string()),
  sourceSections: z.array(z.string()),
  coverageItemIds: z.array(z.string()),
  upstreamIds: z.array(z.string()),
});

export const EvidenceGap = z.object({
  field: z.string().min(1),
  reason: z.string().min(1),
  verificationAction: z.string().min(1),
  blocking: z.boolean(),
});

export const DataInputs = z.object({
  valid: z.array(z.string()),
  invalid: z.array(z.string()),
  boundary: z.array(z.string()),
});

export const TestCaseAi = z.object({
  testType: TestType,
  suite: z.string().min(1),
  route: z.string().nullable(),
  httpMethod: z.string().nullable(),
  endpoint: z.string().nullable(),
  personaId: z.string().nullable(),
  authState: z.enum(['anonymous', 'authenticated', 'admin', 'disabled']),
  selectors: z.array(SelectorHint),
  networkMocks: z.array(NetworkMock),
  fixtures: z.array(z.string()),
  seedData: z.array(z.string()),
  cleanup: z.array(z.string()),
  assertions: z.array(Assertion).min(1),
  dataInputs: DataInputs,
  edgeCaseClass: z
    .enum([
      'happy_path',
      'negative',
      'boundary',
      'dependency_failure',
      'concurrency',
      'idempotency',
      'authz',
      'observability',
      'cleanup',
    ])
    .default('happy_path'),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  flakinessRisk: z.enum(['low', 'medium', 'high']),
  estimatedDurationMs: z.number().int().positive(),
  playwright: PlaywrightHints,
  traceability: Traceability,
  evidenceGaps: z.array(EvidenceGap),
  generationNotes: z.string(),
});
export type TestCaseAi = z.infer<typeof TestCaseAi>;

export const TestCase = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  origin: z.enum(['model', 'model-repair']),
  model: z.string(),
  createdAt: z.string(),
  ui: TestCaseUi,
  ai: TestCaseAi,
});
export type TestCase = z.infer<typeof TestCase>;

/** Exactly the fields the Create Test Case screen renders. */
export function toUiView(testCase: TestCase): Record<string, unknown> {
  return {
    id: testCase.id,
    title: testCase.ui.title,
    description: testCase.ui.description,
    preconditions: testCase.ui.preconditions,
    expectedResult: testCase.ui.expectedResult,
    status: testCase.ui.status,
    priority: testCase.ui.priorityLabel,
    coverageTags: testCase.ui.coverageTags,
    steps: testCase.ui.steps.map((s) => ({
      index: s.index,
      action: s.action,
      expectedResult: s.expectedResult,
    })),
  };
}
