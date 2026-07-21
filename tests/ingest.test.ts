import { describe, expect, it } from 'vitest';
import { analyzeDocuments } from '../src/ingest/analyzer.js';
import { planGeneration } from '../src/ingest/planner.js';
import { toSourceDocument, dedupeDocuments } from '../src/ingest/extractor.js';
import type { SourceDocument } from '../src/domain/spec.js';

function doc(name: string, text: string, mediaType = 'text/markdown'): SourceDocument {
  return toSourceDocument({
    filename: name,
    mediaType,
    content: Buffer.from(text, 'utf8'),
  });
}

const CONTRACT_MD = `# API Plan

## Endpoint Catalog

| ID | Item | Priority |
|---|---|---|
| CONTRACT-001 | POST /api/public/elevenlabs/scribe-token | P0 |
| CONTRACT-002 | POST /api/rag/upload | P1 |

- Detected endpoints: POST /api/a, GET /api/b, DELETE /api/c
`;

const CONTEXT_JSON = JSON.stringify({
  endpoints: [
    { endpoint: 'POST /api/public/hooks/twilio-inbound', id: 'CONTRACT-004' },
  ],
  personas: [{ id: 'DATA-AUTH-ADMIN', role: 'admin', purpose: 'admin flows' }],
  environment_variables: [
    { name: 'ELEVENLABS_API_KEY', required: true, sensitive: true },
    { name: 'MODEL', required: true, sensitive: false },
  ],
});

describe('document analysis', () => {
  it('extracts endpoints, personas and native ids from markdown tables', () => {
    const spec = analyzeDocuments([doc('02_api.md', CONTRACT_MD)]);
    const endpoints = spec.items.filter((i) => i.kind === 'endpoint');
    expect(endpoints.length).toBeGreaterThanOrEqual(2);
    const scribe = spec.items.find((i) =>
      i.title.includes('/api/public/elevenlabs/scribe-token'),
    );
    expect(scribe?.nativeIds).toContain('CONTRACT-001');
    expect(scribe?.priority).toBe('P0');
  });

  it('fans out "Detected endpoints" bullet lists into individual items', () => {
    const spec = analyzeDocuments([doc('02_api.md', CONTRACT_MD)]);
    const titles = spec.items.map((i) => i.title);
    expect(titles).toContain('POST /api/a');
    expect(titles).toContain('GET /api/b');
    expect(titles).toContain('DELETE /api/c');
  });

  it('parses JSON context and flags sensitive env vars', () => {
    const spec = analyzeDocuments([doc('context.json', CONTEXT_JSON, 'application/json')]);
    expect(spec.globalContext.sensitiveEnvVars).toContain('ELEVENLABS_API_KEY');
    expect(spec.globalContext.sensitiveEnvVars).not.toContain('MODEL');
    expect(spec.globalContext.personas).toContain('admin');
  });

  it('deduplicates identical facts across documents by native id', () => {
    const spec = analyzeDocuments([
      doc('a.md', CONTRACT_MD),
      doc('b.md', CONTRACT_MD.replace('# API Plan', '# API Plan Copy')),
    ]);
    const scribe = spec.items.filter((i) =>
      i.title.includes('/api/public/elevenlabs/scribe-token'),
    );
    expect(scribe).toHaveLength(1);
    expect(scribe[0]!.sourceDocument).toContain('|'); // merged provenance
  });
});

describe('generation planning', () => {
  it('splits items into units that never exceed the size cap', () => {
    const spec = analyzeDocuments([doc('02_api.md', CONTRACT_MD)]);
    const units = planGeneration(spec, 2);
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) expect(unit.items.length).toBeLessThanOrEqual(2);
    const planned = units.flatMap((u) => u.items.map((i) => i.id));
    // Every extracted item lands in exactly one unit.
    expect(new Set(planned).size).toBe(spec.items.length);
  });

  it('does not let source-evidence filenames hijack the suite', () => {
    // The auth requirement paragraph embeds "..._accessibility_inventory.md";
    // it must classify as security, never accessibility.
    const md = `# API Plan

## Global API Rules > Authentication

This section is fully populated using source evidence from 05_selector_and_accessibility_inventory.md and 07_security_and_external_dependency_guide.md for authentication and jwt handling behavior across the API surface which must be enforced.
`;
    const spec = analyzeDocuments([doc('02_api.md', md)]);
    const units = planGeneration(spec, 10);
    const suites = units.map((u) => u.suite);
    expect(suites).not.toContain('accessibility');
    expect(suites).toContain('security');
  });

  it('classifies structural kinds by kind, not prose', () => {
    const spec = analyzeDocuments([doc('02_api.md', CONTRACT_MD)]);
    const units = planGeneration(spec, 20);
    const endpointUnit = units.find((u) =>
      u.items.some((i) => i.kind === 'endpoint'),
    );
    expect(endpointUnit?.testType).toBe('contract');
  });

  it('orders units so P0 work runs first', () => {
    const spec = analyzeDocuments([doc('02_api.md', CONTRACT_MD)]);
    const units = planGeneration(spec, 5);
    const firstSeverity = Math.min(
      ...units[0]!.items.map((i) => Number(i.priority.slice(1))),
    );
    expect(firstSeverity).toBe(0);
  });
});

describe('upload extraction guards', () => {
  it('rejects binary content', () => {
    expect(() =>
      toSourceDocument({
        filename: 'x.md',
        mediaType: 'text/markdown',
        content: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      }),
    ).toThrow(/binary|UTF-8/i);
  });

  it('rejects empty files', () => {
    expect(() =>
      toSourceDocument({ filename: 'x.md', mediaType: 'text/markdown', content: Buffer.from('') }),
    ).toThrow(/empty/i);
  });

  it('strips path separators from filenames', () => {
    const d = toSourceDocument({
      filename: '../../etc/passwd.md',
      mediaType: 'text/markdown',
      content: Buffer.from('# hi\n\nsome content here that is long enough'),
    });
    expect(d.name).not.toContain('/');
  });

  it('detects byte-identical duplicates', () => {
    const a = doc('a.md', CONTRACT_MD);
    const b = doc('b.md', CONTRACT_MD);
    const { documents, duplicates } = dedupeDocuments([a, b]);
    expect(documents).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
  });
});
