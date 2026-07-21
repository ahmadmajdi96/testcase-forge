import type { TestCase } from '../domain/testcase.js';
import type { ChatMessage } from '../llm/novita.js';
import type { FilePlan } from './types.js';

const SYSTEM_PROMPT = `You are a senior Playwright engineer. You convert structured test cases into ONE production-quality TypeScript spec file.

Hard rules:
- Output EXACTLY ONE fenced TypeScript code block and nothing else.
- Import from '@playwright/test'. Use the provided describeBlock and one test() per case, titled with the case's testTitle.
- Above each test(), emit a traceability header comment: case id, coverage item ids, upstream ids.
- Wrap each documented step in test.step('<n>. <action>', ...) and assert its expected result.
- Locators: use the provided selectors exactly — getByRole with accessibleName, getByLabel, getByTestId, getByText; CSS only as the given fallback. For selectors marked verified=false add a "// TODO(evidence gap):" comment with the verification action.
- Assertions: use the provided matcher/expected pairs with await expect(...).
- Network mocks: implement each networkMock with page.route(urlPattern, ...) — fulfil with the given status/body; failureMode timeout => route.abort('timedout'), abort => route.abort(), others => fulfil with the mock's status.
- Environment: import { env, requireEnv } from the support/env module (compute the correct relative path for this file's location, e.g. './support/env.js' for tests/x.spec.ts, '../support/env.js' for tests/e2e/x.spec.ts). Reference configuration ONLY by env variable name; NEVER invent or hardcode credentials or secrets.
- Auth: when a case has storageStateKey, use test.use({ storageState: 'results/.auth/<key>.json' }); authState 'anonymous' means no storage state.
- parallelSafe=false on any case => add test.describe.configure({ mode: 'serial' }).
- Respect timeoutMs via test.setTimeout and per-case retries only if all cases in the file agree.
- capturesVisualSnapshot => expect(page).toHaveScreenshot(); runsAccessibilityScan => leave a "// TODO: axe scan" comment (no external deps).
- Never use waitForTimeout; rely on web-first assertions.
- The file must compile under strict TypeScript with @playwright/test types only.`;

function compactCase(testCase: TestCase): Record<string, unknown> {
  const { ui, ai } = testCase;
  return {
    id: testCase.id,
    title: ui.title,
    priority: ui.priority,
    preconditions: ui.preconditions,
    expectedResult: ui.expectedResult,
    steps: ui.steps,
    testType: ai.testType,
    route: ai.route,
    endpoint: ai.endpoint,
    httpMethod: ai.httpMethod,
    authState: ai.authState,
    personaId: ai.personaId,
    selectors: ai.selectors,
    networkMocks: ai.networkMocks,
    fixtures: ai.fixtures,
    seedData: ai.seedData,
    cleanup: ai.cleanup,
    assertions: ai.assertions,
    dataInputs: ai.dataInputs,
    edgeCaseClass: ai.edgeCaseClass,
    playwright: ai.playwright,
    traceability: {
      coverageItemIds: ai.traceability.coverageItemIds,
      upstreamIds: ai.traceability.upstreamIds,
    },
    evidenceGaps: ai.evidenceGaps,
    generationNotes: ai.generationNotes.slice(0, 400),
  };
}

export function buildCodegenMessages(
  plan: FilePlan,
  envVars: string[],
  meta: { sourceJobId: string; codegenJobId: string },
): ChatMessage[] {
  const user = [
    `## Target file: ${plan.path}`,
    `Suite: ${plan.suite} | Test type: ${plan.testType}`,
    `File header comment must include: source job ${meta.sourceJobId}, codegen job ${meta.codegenJobId}.`,
    '',
    `## Available environment variable NAMES (reference only these, via the env module)`,
    ['BASE_URL', ...envVars].join(', '),
    '',
    `## Test cases to implement (${plan.cases.length})`,
    JSON.stringify(plan.cases.map(compactCase), null, 1),
    '',
    'Produce the complete spec file now.',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}
