import { describe, expect, it } from 'vitest';
import { normalizeTestCase, missingItems } from '../src/coverage/normalize.js';
import { buildCoverageReport } from '../src/coverage/report.js';
import type { CoverageItem, GenerationUnit, SpecModel } from '../src/domain/spec.js';

const items: CoverageItem[] = [
  {
    id: 'CI-ENDPOINT-0001',
    kind: 'endpoint',
    title: 'POST /api/rag/upload',
    detail: 'upload endpoint',
    priority: 'P0',
    sourceDocument: '02_api.md',
    sourceSection: 'Endpoint Catalog',
    nativeIds: ['CONTRACT-008'],
    attributes: {},
  },
  {
    id: 'CI-ROUTE-0002',
    kind: 'route',
    title: '/app/dashboard',
    detail: 'dashboard route',
    priority: 'P1',
    sourceDocument: '03_ui.md',
    sourceSection: 'Route Map',
    nativeIds: [],
    attributes: {},
  },
];

const unit: GenerationUnit = {
  id: 'U-0001',
  suite: 'api-contract',
  testType: 'contract',
  items,
  minCases: 2,
};

const ctx = {
  jobId: '12345678-aaaa-bbbb-cccc-000000000000',
  unit,
  model: 'test-model',
  origin: 'model' as const,
  createdAt: new Date().toISOString(),
  sequence: 1,
};

describe('normalizeTestCase', () => {
  it('coerces messy model output into a valid UI + AI test case', () => {
    const tc = normalizeTestCase(
      {
        title: '  Upload a valid PDF via RAG endpoint ',
        description: '',
        preconditions: '',
        expectedResult: 'Document is stored and a 200 is returned.',
        status: 'ready',
        priority: 'p0 - blocker',
        coverageTags: ['upload', 'upload', ' rag '],
        steps: [
          { action: 'POST multipart file to /api/rag/upload', expectedResult: '200 OK' },
          { action: '', expectedResult: '' },
        ],
        testType: 'contract',
        suite: 'api-contract',
        authState: 'ADMIN',
        selectors: [{ strategy: 'role', value: 'button', verified: true, evidence: 'docs' }],
        networkMocks: [{ id: 'M1', urlPattern: '**/api/rag/upload', method: 'post', status: '200', responseBody: { ok: true } }],
        assertions: [{ kind: 'status_code', target: 'response', matcher: 'toBe', expected: 200 }],
        coveredItemIds: ['CI-ENDPOINT-0001', 'CI-DOES-NOT-EXIST'],
        upstreamIds: [],
        estimatedDurationMs: 4000,
        playwright: { suggestedFile: 'tests/e2e/rag.spec.ts' },
      } as never,
      ctx,
    );

    expect(tc.ui.title).toBe('Upload a valid PDF via RAG endpoint');
    expect(tc.ui.priority).toBe('P0');
    expect(tc.ui.priorityLabel).toBe('P0 - Blocker');
    expect(tc.ui.coverageTags).toEqual(['upload', 'rag']); // deduped + kebab-cased
    expect(tc.ui.steps).toHaveLength(1); // empty step dropped
    expect(tc.ui.steps[0]!.index).toBe(1);
    expect(tc.ai.authState).toBe('admin');
    expect(tc.ai.networkMocks[0]!.status).toBe(200);
    expect(tc.ai.networkMocks[0]!.method).toBe('POST');
    // Unknown coverage id is discarded; only real ids survive.
    expect(tc.ai.traceability.coverageItemIds).toEqual(['CI-ENDPOINT-0001']);
    expect(tc.ai.traceability.upstreamIds).toContain('CONTRACT-008');
  });

  it('strips internal/native ids leaked into UI coverage tags', () => {
    const tc = normalizeTestCase(
      {
        title: 'Admin login',
        steps: [],
        suite: 'authorization',
        edgeCaseClass: 'authz',
        coverageTags: ['CI-PERSONA-0101', 'DATA-AUTH-ADMIN', 'CONTRACT-003', 'Admin Login'],
        coveredItemIds: [],
      } as never,
      ctx,
    );
    // Machine ids removed; only the readable tag survives (kebab-cased).
    expect(tc.ui.coverageTags).toEqual(['admin-login']);
  });

  it('derives fallback tags when none are usable', () => {
    const tc = normalizeTestCase(
      {
        title: 'X',
        steps: [],
        suite: 'authorization',
        edgeCaseClass: 'authz',
        coverageTags: ['CI-PERSONA-0101'],
        coveredItemIds: [],
      } as never,
      ctx,
    );
    expect(tc.ui.coverageTags).toEqual(['authorization', 'authz']);
  });

  it('synthesizes a step when the model returns none', () => {
    const tc = normalizeTestCase(
      { title: 'Bare case', steps: [], coveredItemIds: [] } as never,
      ctx,
    );
    expect(tc.ui.steps).toHaveLength(1);
    expect(tc.ui.steps[0]!.action).toContain('Bare case');
  });
});

describe('coverage reporting', () => {
  const spec = {
    items,
    documents: [],
    globalContext: {} as never,
    stats: {} as never,
  } as unknown as SpecModel;

  it('detects fully covered specs', () => {
    const cases = [
      normalizeTestCase(
        { title: 'A', steps: [], coveredItemIds: ['CI-ENDPOINT-0001'] } as never,
        ctx,
      ),
      normalizeTestCase(
        { title: 'B', steps: [], coveredItemIds: ['CI-ROUTE-0002'] } as never,
        ctx,
      ),
    ];
    const report = buildCoverageReport(spec, cases);
    expect(report.coverageRatio).toBe(1);
    expect(report.uncoveredItems).toBe(0);
    expect(report.p0FullyCovered).toBe(true);
  });

  it('flags uncovered P0 items', () => {
    const cases = [
      normalizeTestCase(
        { title: 'B', steps: [], coveredItemIds: ['CI-ROUTE-0002'] } as never,
        ctx,
      ),
    ];
    const report = buildCoverageReport(spec, cases);
    expect(report.uncoveredItems).toBe(1);
    expect(report.p0FullyCovered).toBe(false);
    expect(missingItems(unit, cases).map((i) => i.id)).toEqual(['CI-ENDPOINT-0001']);
  });
});
