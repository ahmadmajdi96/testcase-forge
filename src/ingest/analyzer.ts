import { createHash } from 'node:crypto';
import type {
  CoverageItem,
  CoverageKind,
  SourceDocument,
  SpecModel,
} from '../domain/spec.js';
import {
  parseBullets,
  parseParagraphs,
  parseSections,
  parseTables,
  walkJson,
} from './parsers.js';

const NATIVE_ID = /^`?([A-Z][A-Z0-9]{1,14}(?:-[A-Z0-9]+)*-\d{1,4}|[A-Z]+-[A-Z]+-[A-Z]+)`?$/;
const ENDPOINT = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[\w\-/${}.:]*)/g;
const ROUTE_LIKE = /^\/[\w\-/${}.:]*$/;

const KIND_BY_JSON_KEY: Record<string, CoverageKind> = {
  endpoints: 'endpoint',
  routes: 'route',
  selectors: 'selector',
  personas: 'persona',
  fixtures: 'fixture',
  external_mocks: 'mock',
  environment_variables: 'env_var',
};

function norm(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function stripTicks(value: string): string {
  return value.replace(/^`|`$/g, '').trim();
}

function detectPriority(
  explicit: string | undefined,
  context: string,
): CoverageItem['priority'] {
  const fromColumn = explicit?.match(/\bP([0-3])\b/);
  if (fromColumn) return `P${fromColumn[1]}` as CoverageItem['priority'];
  const lower = context.toLowerCase();
  if (/(security|auth|jwt|secret|tenant|destructive|production|hmac)/.test(lower)) {
    return 'P0';
  }
  if (/(contract|endpoint|api|upload|webhook|integration)/.test(lower)) return 'P1';
  if (/(performance|load|stress|spike|soak|visual|a11y|accessib)/.test(lower)) {
    return 'P2';
  }
  return 'P2';
}

function inferKind(section: string, text: string): CoverageKind {
  const haystack = `${section} ${text}`.toLowerCase();
  if (/\b(get|post|put|patch|delete)\s+\//i.test(text)) return 'endpoint';
  if (ROUTE_LIKE.test(stripTicks(text))) return 'route';
  if (/persona|role/.test(haystack) && /admin|user|disabled/.test(haystack)) {
    return 'persona';
  }
  if (/mock/.test(haystack)) return 'mock';
  if (/fixture|seed data|factory/.test(haystack)) return 'fixture';
  if (/environment|base url/.test(haystack)) return 'environment';
  if (/risk|failure mode|flaky|edge/.test(haystack)) return 'risk';
  if (/gate|entry criteria|exit criteria/.test(haystack)) return 'gate';
  if (/workload|mix/.test(haystack)) return 'workload';
  if (/variable/.test(haystack)) return 'env_var';
  if (/selector|locator/.test(haystack)) return 'selector';
  return 'planned_case';
}

class ItemCollector {
  private readonly byKey = new Map<string, CoverageItem>();
  private sequence = 0;

  add(input: Omit<CoverageItem, 'id'> & { dedupeKey: string }): void {
    const { dedupeKey, ...rest } = input;
    const existing = this.byKey.get(dedupeKey);
    if (existing) {
      // Same fact restated in another section: merge provenance, keep one item.
      if (!existing.sourceSection.includes(rest.sourceSection)) {
        existing.sourceSection = `${existing.sourceSection} | ${rest.sourceSection}`;
      }
      if (!existing.sourceDocument.includes(rest.sourceDocument)) {
        existing.sourceDocument = `${existing.sourceDocument} | ${rest.sourceDocument}`;
      }
      for (const nativeId of rest.nativeIds) {
        if (!existing.nativeIds.includes(nativeId)) existing.nativeIds.push(nativeId);
      }
      if (rest.priority < existing.priority) existing.priority = rest.priority;
      return;
    }
    this.sequence += 1;
    const prefix = rest.kind.toUpperCase().replace(/_/g, '');
    this.byKey.set(dedupeKey, {
      ...rest,
      id: `CI-${prefix}-${String(this.sequence).padStart(4, '0')}`,
    });
  }

  list(): CoverageItem[] {
    return [...this.byKey.values()];
  }
}

function analyzeJsonDocument(doc: SourceDocument, collector: ItemCollector): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.text);
  } catch {
    return false;
  }

  if (parsed === null || typeof parsed !== 'object') return false;

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(value) && value.every((v) => v !== null && typeof v === 'object')) {
      const kind = KIND_BY_JSON_KEY[key] ?? 'requirement';
      for (const entry of value as Record<string, unknown>[]) {
        const record = entry;
        const nativeId =
          typeof record.id === 'string' ? record.id : undefined;
        const title =
          (typeof record.endpoint === 'string' && record.endpoint) ||
          (typeof record.route === 'string' && record.route) ||
          (typeof record.name === 'string' && record.name) ||
          (typeof record.selector_hint === 'string' && record.selector_hint) ||
          (typeof record.dependency === 'string' && record.dependency) ||
          (typeof record.factory === 'string' && record.factory) ||
          (typeof record.role === 'string' && record.role) ||
          nativeId ||
          key;
        if (nativeId && /\*/.test(nativeId)) continue; // ID convention rows, not facts
        const detail = JSON.stringify(record);
        const attributes: Record<string, string> = {};
        for (const [k, v] of Object.entries(record)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            attributes[k] = String(v);
          } else if (Array.isArray(v)) {
            attributes[k] = v.map((x) => String(x)).join(', ');
          }
        }
        collector.add({
          dedupeKey: `${kind}:${norm(String(title))}:${nativeId ?? hash(detail)}`,
          kind,
          title: String(title),
          detail,
          priority: detectPriority(undefined, `${key} ${title} ${detail}`),
          sourceDocument: doc.name,
          sourceSection: `$.${key}`,
          nativeIds: nativeId ? [nativeId] : [],
          attributes,
        });
      }
      continue;
    }

    // Scalars and nested objects still describe real configuration facts.
    for (const leaf of walkJson(value, [key])) {
      if (leaf.value === null || leaf.value === '') continue;
      const title = `${leaf.path} = ${String(leaf.value)}`;
      collector.add({
        dedupeKey: `requirement:${norm(title)}`,
        kind: 'requirement',
        title: leaf.path,
        detail: title,
        priority: 'P2',
        sourceDocument: doc.name,
        sourceSection: `$.${key}`,
        nativeIds: [],
        attributes: { value: String(leaf.value) },
      });
    }
  }
  return true;
}

function analyzeTextDocument(doc: SourceDocument, collector: ItemCollector): void {
  for (const section of parseSections(doc.text)) {
    const sectionPath = section.path.join(' > ');

    for (const table of parseTables(section)) {
      const idIndex = table.headers.findIndex((h) => /^id$/i.test(h));
      const priorityIndex = table.headers.findIndex((h) => /priority/i.test(h));

      for (const row of table.rows) {
        const cells = table.headers.map((h, i) => [h, row[i] ?? ''] as const);
        const attributes = Object.fromEntries(
          cells.filter(([, v]) => v.length > 0).map(([h, v]) => [h || 'col', v]),
        );
        const rawId = idIndex >= 0 ? stripTicks(row[idIndex] ?? '') : '';
        const nativeId = NATIVE_ID.test(rawId) ? rawId : '';
        const descriptive =
          cells.find(([h]) => /^(item|target|variable|risk type|workload|gate|environment|mock id|role)$/i.test(h))?.[1] ??
          cells.find(([h, v]) => !/^id$/i.test(h) && v.length > 0)?.[1] ??
          rawId;
        const title = stripTicks(descriptive || rawId || 'unnamed row');
        if (!title) continue;

        const detail = cells
          .filter(([, v]) => v.length > 0)
          .map(([h, v]) => `${h}: ${v}`)
          .join(' | ');
        const kind = inferKind(sectionPath, title);

        collector.add({
          dedupeKey: nativeId
            ? `${kind}:${nativeId}:${norm(title)}`
            : `${kind}:${norm(title)}:${hash(norm(detail))}`,
          kind,
          title,
          detail,
          priority: detectPriority(
            priorityIndex >= 0 ? row[priorityIndex] : undefined,
            `${sectionPath} ${detail}`,
          ),
          sourceDocument: doc.name,
          sourceSection: sectionPath,
          nativeIds: nativeId ? [nativeId] : [],
          attributes,
        });
      }
    }

    for (const bullet of parseBullets(section)) {
      // "Detected endpoints: POST /a, GET /b" style lines fan out into one item each.
      const endpointMatches = [...bullet.matchAll(ENDPOINT)];
      if (endpointMatches.length > 1) {
        for (const match of endpointMatches) {
          const endpoint = `${match[1]} ${match[2]}`;
          collector.add({
            dedupeKey: `endpoint:${norm(endpoint)}`,
            kind: 'endpoint',
            title: endpoint,
            detail: `Endpoint referenced in ${sectionPath}: ${endpoint}`,
            priority: 'P1',
            sourceDocument: doc.name,
            sourceSection: sectionPath,
            nativeIds: [],
            attributes: { method: match[1]!, path: match[2]! },
          });
        }
        continue;
      }

      if (bullet.length < 12) continue;
      collector.add({
        dedupeKey: `requirement:${norm(bullet)}`,
        kind: inferKind(sectionPath, bullet) === 'planned_case'
          ? 'requirement'
          : inferKind(sectionPath, bullet),
        title: bullet.slice(0, 140),
        detail: bullet,
        priority: detectPriority(undefined, `${sectionPath} ${bullet}`),
        sourceDocument: doc.name,
        sourceSection: sectionPath,
        nativeIds: [],
        attributes: {},
      });
    }

    for (const paragraph of parseParagraphs(section)) {
      collector.add({
        dedupeKey: `requirement:${norm(paragraph).slice(0, 200)}`,
        kind: 'requirement',
        title: `${sectionPath}: ${paragraph.slice(0, 110)}`,
        detail: paragraph.slice(0, 1200),
        priority: detectPriority(undefined, `${sectionPath} ${paragraph}`),
        sourceDocument: doc.name,
        sourceSection: sectionPath,
        nativeIds: [],
        attributes: {},
      });
    }
  }
}

export function analyzeDocuments(documents: SourceDocument[]): SpecModel {
  const collector = new ItemCollector();

  for (const doc of documents) {
    const looksJson =
      doc.mediaType.includes('json') ||
      doc.name.toLowerCase().endsWith('.json') ||
      doc.text.trimStart().startsWith('{') ||
      doc.text.trimStart().startsWith('[');

    if (!looksJson || !analyzeJsonDocument(doc, collector)) {
      analyzeTextDocument(doc, collector);
    }
  }

  const items = collector.list();
  const pick = (kind: CoverageKind, limit: number) =>
    items
      .filter((i) => i.kind === kind)
      .slice(0, limit)
      .map((i) => i.title);

  const itemsByKind: Record<string, number> = {};
  for (const item of items) {
    itemsByKind[item.kind] = (itemsByKind[item.kind] ?? 0) + 1;
  }

  return {
    documents,
    items,
    globalContext: {
      endpoints: pick('endpoint', 40),
      routes: pick('route', 60),
      personas: pick('persona', 15),
      fixtures: pick('fixture', 20),
      selectors: pick('selector', 45),
      environments: pick('environment', 10),
      components: pick('component', 20),
      sensitiveEnvVars: items
        .filter((i) => i.kind === 'env_var' && i.attributes.sensitive === 'true')
        .slice(0, 25)
        .map((i) => i.title),
    },
    stats: {
      documentCount: documents.length,
      totalBytes: documents.reduce((sum, d) => sum + d.bytes, 0),
      itemCount: items.length,
      itemsByKind,
    },
  };
}
