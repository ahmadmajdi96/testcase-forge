import type { CoverageItem, GenerationUnit, SpecModel } from '../domain/spec.js';
import type { ChatMessage } from './novita.js';

const SYSTEM_PROMPT = `You are a senior QA architect that converts specification documents into exhaustive, execution-ready test cases.

The test cases you emit are consumed by a downstream code-generation model that produces Playwright TypeScript specs. Therefore every case must be concrete and machine-actionable, never generic.

Hard rules:
- Cover EVERY supplied coverage item. Each item id MUST appear in the "coveredItemIds" of at least one test case. Prefer one focused case per item; combine only tightly related items.
- For every non-trivial item, also produce negative, boundary and dependency-failure variants where they make sense. Security, auth, upload and webhook items MUST include an unauthorized/invalid-signature/oversized-input variant.
- Steps must be numbered actions with one observable expected result each. Reference real routes, endpoints, selectors, personas and fixtures from the provided context.
- Locators follow Playwright priority: getByRole > getByLabel > getByText > getByTestId > css. Mark any locator you infer (not present verbatim in the docs) with verified=false and add an evidenceGap describing how to confirm it.
- Assertions must be machine-checkable (matchers + expected values), never "looks correct".
- Never invent credentials or secrets. Reference sensitive values only by their variable name.
- The "ui" fields (title, description, preconditions, expectedResult, steps, status, priority, coverageTags) are shown to a human in a test-management UI; keep them clean and readable. The remaining fields are machine context for the code generator and are never shown to users, so pack them with precise detail.
- Return ONLY the JSON described by the schema.`;

function renderContext(spec: SpecModel): string {
  const c = spec.globalContext;
  const lines: string[] = ['## Shared system context (authoritative for all cases)'];
  if (c.endpoints.length) lines.push(`Endpoints: ${c.endpoints.join(', ')}`);
  if (c.routes.length) lines.push(`UI routes: ${c.routes.join(', ')}`);
  if (c.personas.length) lines.push(`Personas: ${c.personas.join(', ')}`);
  if (c.fixtures.length) lines.push(`Fixtures: ${c.fixtures.join(', ')}`);
  if (c.selectors.length) {
    lines.push(`Selector hints: ${c.selectors.slice(0, 25).join(' || ')}`);
  }
  if (c.environments.length) lines.push(`Environments: ${c.environments.join(', ')}`);
  if (c.sensitiveEnvVars.length) {
    lines.push(
      `Sensitive variables (reference by name only, never emit values): ${c.sensitiveEnvVars.join(', ')}`,
    );
  }
  return lines.join('\n');
}

function renderItem(item: CoverageItem): string {
  const native = item.nativeIds.length ? ` [native: ${item.nativeIds.join(', ')}]` : '';
  const attrs = Object.entries(item.attributes)
    .filter(([k]) => !/^col$/i.test(k))
    .slice(0, 12)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return [
    `- ${item.id}${native} (${item.kind}, ${item.priority})`,
    `  title: ${item.title}`,
    `  detail: ${item.detail.slice(0, 700)}`,
    `  source: ${item.sourceDocument} :: ${item.sourceSection}`,
    attrs ? `  attributes: ${attrs.slice(0, 700)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildGenerationMessages(
  spec: SpecModel,
  unit: GenerationUnit,
): ChatMessage[] {
  const itemIds = unit.items.map((i) => i.id).join(', ');
  const user = [
    renderContext(spec),
    '',
    `## Suite: ${unit.suite}  |  Test type: ${unit.testType}`,
    `Generate at least ${unit.minCases} test case(s). You may exceed this to add negative, boundary and failure-mode variants, but you must not skip any item.`,
    '',
    '## Coverage items to fully cover in this batch',
    unit.items.map(renderItem).join('\n\n'),
    '',
    `## Mandatory coverage checklist`,
    `Every one of these ids must appear in some test case's coveredItemIds: ${itemIds}.`,
    'Before returning, re-read each item and confirm it is covered.',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

export function buildRepairMessages(
  spec: SpecModel,
  unit: GenerationUnit,
  missing: CoverageItem[],
): ChatMessage[] {
  const user = [
    renderContext(spec),
    '',
    `## Suite: ${unit.suite}  |  Test type: ${unit.testType}`,
    'The previous response did NOT cover the following items. Generate additional test cases that fully cover ONLY these items. Reuse the same schema and quality rules.',
    '',
    missing.map(renderItem).join('\n\n'),
    '',
    `Each of these ids must appear in coveredItemIds: ${missing.map((i) => i.id).join(', ')}.`,
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}
