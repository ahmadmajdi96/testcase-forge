export type CoverageKind =
  | 'endpoint'
  | 'route'
  | 'selector'
  | 'component'
  | 'env_var'
  | 'persona'
  | 'fixture'
  | 'mock'
  | 'planned_case'
  | 'risk'
  | 'gate'
  | 'workload'
  | 'environment'
  | 'requirement';

/**
 * One atomic, addressable fact extracted from the uploaded documents. Every
 * item must be referenced by at least one generated test case, which is what
 * makes "covers every detail" a checkable property rather than a claim.
 */
export interface CoverageItem {
  id: string;
  kind: CoverageKind;
  title: string;
  detail: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  sourceDocument: string;
  sourceSection: string;
  /** IDs printed in the source docs (UNIT-001, CONTRACT-003, ...), if any. */
  nativeIds: string[];
  attributes: Record<string, string>;
}

export interface ParsedSection {
  heading: string;
  path: string[];
  body: string;
}

export interface SourceDocument {
  name: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  text: string;
}

export interface SpecModel {
  documents: SourceDocument[];
  items: CoverageItem[];
  /** Compact facts injected into every prompt so cases stay mutually consistent. */
  globalContext: {
    endpoints: string[];
    routes: string[];
    personas: string[];
    fixtures: string[];
    selectors: string[];
    environments: string[];
    components: string[];
    sensitiveEnvVars: string[];
  };
  stats: {
    documentCount: number;
    totalBytes: number;
    itemCount: number;
    itemsByKind: Record<string, number>;
  };
}

export interface GenerationUnit {
  id: string;
  suite: string;
  testType: string;
  items: CoverageItem[];
  /** Minimum number of cases the model must return for this unit. */
  minCases: number;
}
