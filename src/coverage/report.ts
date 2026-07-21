import type { SpecModel } from '../domain/spec.js';
import type { TestCase } from '../domain/testcase.js';
import { coveredIds } from './normalize.js';

export interface CoverageReport {
  totalItems: number;
  coveredItems: number;
  uncoveredItems: number;
  coverageRatio: number;
  totalCases: number;
  byKind: Record<string, { total: number; covered: number }>;
  byPriority: Record<string, { total: number; covered: number }>;
  uncovered: { id: string; kind: string; title: string; priority: string }[];
  blockingEvidenceGaps: number;
  p0FullyCovered: boolean;
}

/** The audit that makes "covers every detail" measurable rather than asserted. */
export function buildCoverageReport(
  spec: SpecModel,
  cases: TestCase[],
): CoverageReport {
  const covered = coveredIds(cases);
  const byKind: CoverageReport['byKind'] = {};
  const byPriority: CoverageReport['byPriority'] = {};
  const uncovered: CoverageReport['uncovered'] = [];

  for (const item of spec.items) {
    byKind[item.kind] ??= { total: 0, covered: 0 };
    byPriority[item.priority] ??= { total: 0, covered: 0 };
    byKind[item.kind]!.total += 1;
    byPriority[item.priority]!.total += 1;
    if (covered.has(item.id)) {
      byKind[item.kind]!.covered += 1;
      byPriority[item.priority]!.covered += 1;
    } else {
      uncovered.push({
        id: item.id,
        kind: item.kind,
        title: item.title.slice(0, 120),
        priority: item.priority,
      });
    }
  }

  const totalItems = spec.items.length;
  const coveredItems = totalItems - uncovered.length;
  const p0 = byPriority.P0;

  return {
    totalItems,
    coveredItems,
    uncoveredItems: uncovered.length,
    coverageRatio: totalItems === 0 ? 1 : Number((coveredItems / totalItems).toFixed(4)),
    totalCases: cases.length,
    byKind,
    byPriority,
    uncovered: uncovered
      .sort((a, b) => a.priority.localeCompare(b.priority))
      .slice(0, 200),
    blockingEvidenceGaps: cases.reduce(
      (sum, c) => sum + c.ai.evidenceGaps.filter((g) => g.blocking).length,
      0,
    ),
    p0FullyCovered: !p0 || p0.covered === p0.total,
  };
}
