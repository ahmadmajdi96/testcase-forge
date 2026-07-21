type JsonSchema = Record<string, unknown>;

const str = (description: string): JsonSchema => ({ type: 'string', description });
const nullableStr = (description: string): JsonSchema => ({
  type: ['string', 'null'],
  description,
});
const strArray = (description: string): JsonSchema => ({
  type: 'array',
  description,
  items: { type: 'string' },
});
const enumOf = (values: string[], description: string): JsonSchema => ({
  type: 'string',
  enum: values,
  description,
});

/** `strict: true` requires every property to be listed in `required`. */
function object(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const stepSchema = object({
  action: str('Concrete operator action. Name the exact route, control, request or command.'),
  expectedResult: str('Observable outcome of this single step, stated as an assertion.'),
});

const selectorSchema = object({
  purpose: str('What this locator targets, e.g. "cases table heading".'),
  strategy: enumOf(
    ['role', 'label', 'text', 'testid', 'placeholder', 'css'],
    'Playwright locator strategy. Prefer role > label > text > testid; css last.',
  ),
  value: str('Locator value, e.g. "heading" for getByRole or the test id string.'),
  accessibleName: nullableStr('Accessible name for getByRole, else null.'),
  fallbackCss: nullableStr('CSS fallback selector, else null.'),
  verified: {
    type: 'boolean',
    description:
      'true only when the locator appears verbatim in the source documents; false when inferred.',
  },
  evidence: str('Which document/section the locator came from, or "inferred".'),
});

const networkMockSchema = object({
  id: str('Stable mock id, e.g. MOCK-NOVITA-TIMEOUT.'),
  urlPattern: str('Glob or regex string for page.route(), e.g. "**/api/rag/upload".'),
  method: str('HTTP method to intercept.'),
  status: { type: 'integer', minimum: 100, maximum: 599, description: 'Status to fulfil with.' },
  responseBody: str('JSON string body to return. Use "" for empty.'),
  failureMode: enumOf(
    ['none', 'timeout', 'malformed', 'rate_limited', 'server_error', 'abort'],
    'Failure the mock simulates.',
  ),
});

const assertionSchema = object({
  kind: enumOf(
    [
      'visible', 'hidden', 'text', 'url', 'status_code', 'json_field',
      'count', 'attribute', 'no_console_errors', 'a11y', 'snapshot', 'latency',
    ],
    'What is being asserted.',
  ),
  target: str('Locator, URL, JSON path or response field under assertion.'),
  matcher: enumOf(
    [
      'toBeVisible', 'toBeHidden', 'toHaveText', 'toContainText', 'toHaveURL',
      'toBe', 'toEqual', 'toHaveCount', 'toHaveAttribute', 'toBeLessThan',
      'toMatchSnapshot',
    ],
    'Playwright expect matcher.',
  ),
  expected: str('Expected value as a string. Use "" for matchers without an argument.'),
});

const playwrightSchema = object({
  suggestedFile: str('Spec path, e.g. "tests/e2e/cases.spec.ts".'),
  describeBlock: str('test.describe title.'),
  testTitle: str('test() title.'),
  tags: strArray('Playwright tags such as "@p0", "@security", "@smoke".'),
  requiresAuth: { type: 'boolean', description: 'Whether the test needs a signed-in session.' },
  storageStateKey: nullableStr('Storage state fixture key, e.g. "admin", else null.'),
  viewport: enumOf(['desktop', 'tablet', 'mobile'], 'Viewport preset.'),
  locale: str('BCP-47 locale, e.g. "en" or "ar".'),
  parallelSafe: { type: 'boolean', description: 'false when the test mutates shared state.' },
  timeoutMs: { type: 'integer', minimum: 1000, description: 'Per-test timeout.' },
  retries: { type: 'integer', minimum: 0, maximum: 5, description: 'Suggested retries.' },
  capturesVisualSnapshot: { type: 'boolean', description: 'Whether to take a screenshot snapshot.' },
  runsAccessibilityScan: { type: 'boolean', description: 'Whether to run an axe scan.' },
});

const evidenceGapSchema = object({
  field: str('Which field is unverified, e.g. "selectors[0].value".'),
  reason: str('Why it could not be confirmed from the documents.'),
  verificationAction: str('Exact action an engineer takes to confirm it.'),
  blocking: { type: 'boolean', description: 'true if code generation should not proceed.' },
});

const testCaseSchema = object({
  title: str('Imperative, specific test title under 120 characters.'),
  description: str('2-4 sentences: what is verified and why it matters.'),
  preconditions: str('System state, seeded data and auth required before step 1.'),
  expectedResult: str('Overall pass condition when every step succeeds.'),
  status: enumOf(['Draft', 'Ready', 'In Review', 'Approved', 'Deprecated'], 'Workflow status.'),
  priority: enumOf(['P0', 'P1', 'P2', 'P3'], 'Severity, inherited from the covered items.'),
  coverageTags: strArray('Short kebab-case tags shown in the UI, e.g. "auth", "rate-limit".'),
  steps: {
    type: 'array',
    minItems: 2,
    maxItems: 12,
    description: 'Ordered steps. Each is one concrete action with one observable result.',
    items: stepSchema,
  },
  testType: enumOf(
    ['e2e', 'api', 'contract', 'integration', 'component', 'unit', 'security',
     'performance', 'accessibility', 'visual', 'regression'],
    'Test discipline.',
  ),
  suite: str('Suite name this case belongs to.'),
  route: nullableStr('UI route under test, else null.'),
  httpMethod: nullableStr('HTTP method under test, else null.'),
  endpoint: nullableStr('API path under test, else null.'),
  personaId: nullableStr('Persona id such as DATA-AUTH-ADMIN, else null.'),
  authState: enumOf(['anonymous', 'authenticated', 'admin', 'disabled'], 'Session state.'),
  selectors: { type: 'array', description: 'Locators the generated code will need.', items: selectorSchema },
  networkMocks: { type: 'array', description: 'Routes to intercept.', items: networkMockSchema },
  fixtures: strArray('Fixture ids required, e.g. DATA-CASE-MINIMAL.'),
  seedData: strArray('Records to seed before the test.'),
  cleanup: strArray('Teardown steps in reverse dependency order.'),
  assertions: { type: 'array', minItems: 1, description: 'Machine-checkable assertions.', items: assertionSchema },
  dataInputs: object({
    valid: strArray('Valid inputs to exercise.'),
    invalid: strArray('Invalid inputs to exercise.'),
    boundary: strArray('Boundary inputs to exercise.'),
  }),
  edgeCaseClass: enumOf(
    ['happy_path', 'negative', 'boundary', 'dependency_failure', 'concurrency',
     'idempotency', 'authz', 'observability', 'cleanup'],
    'Which class of behaviour this case targets.',
  ),
  riskLevel: enumOf(['low', 'medium', 'high', 'critical'], 'Business risk if this fails.'),
  flakinessRisk: enumOf(['low', 'medium', 'high'], 'Likelihood of nondeterminism.'),
  estimatedDurationMs: { type: 'integer', minimum: 100, description: 'Expected runtime.' },
  playwright: playwrightSchema,
  coveredItemIds: strArray(
    'REQUIRED. Coverage item ids (CI-*) from the supplied list that this case fully verifies.',
  ),
  upstreamIds: strArray('Native ids from the source docs, e.g. CONTRACT-003, SEC-001.'),
  evidenceGaps: { type: 'array', description: 'Unverified assumptions.', items: evidenceGapSchema },
  generationNotes: str('Guidance for the Playwright code generator: pitfalls, ordering, waits.'),
});

export const TEST_CASE_BATCH_SCHEMA = {
  name: 'test_case_batch',
  strict: true,
  schema: object({
    testCases: {
      type: 'array',
      minItems: 1,
      description: 'Generated test cases. Collectively they must cover every supplied item.',
      items: testCaseSchema,
    },
  }),
};
