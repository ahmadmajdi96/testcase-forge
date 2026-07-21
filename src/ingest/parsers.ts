import type { ParsedSection } from '../domain/spec.js';

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
  section: ParsedSection;
}

const HEADING = /^(#{1,6})\s+(.*)$/;

/** Splits markdown into sections keyed by their full heading path. */
export function parseSections(text: string): ParsedSection[] {
  const lines = text.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  const stack: { level: number; title: string }[] = [];
  let buffer: string[] = [];
  let current: { level: number; title: string } | null = null;

  const flush = () => {
    const body = buffer.join('\n').trim();
    const path = stack.map((s) => s.title);
    if (current || body) {
      sections.push({
        heading: current?.title ?? '(preamble)',
        path: path.length > 0 ? path : ['(preamble)'],
        body,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match) {
      flush();
      const level = match[1]!.length;
      const title = match[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      current = { level, title };
      stack.push(current);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections.filter((s) => s.body.length > 0 || s.heading !== '(preamble)');
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Extracts GitHub-flavoured pipe tables from a section body. */
export function parseTables(section: ParsedSection): MarkdownTable[] {
  const lines = section.body.split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && SEPARATOR.test(next)) {
      const headers = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        const cells = splitRow(lines[i]!);
        if (cells.some((c) => c.length > 0)) rows.push(cells);
        i += 1;
      }
      if (rows.length > 0) tables.push({ headers, rows, section });
      continue;
    }
    i += 1;
  }
  return tables;
}

/** Bullet lines carry most of the prose requirements in these documents. */
export function parseBullets(section: ParsedSection): string[] {
  return section.body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[-*+]\s+/.test(l))
    .map((l) => l.replace(/^[-*+]\s+/, '').trim())
    .filter((l) => l.length > 0);
}

/** Prose paragraphs that are not bullets, tables or fenced code. */
export function parseParagraphs(section: ParsedSection): string[] {
  const withoutFences = section.body.replace(/```[\s\S]*?```/g, '');
  return withoutFences
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(
      (p) =>
        p.length > 40 && !p.includes('|') && !/^[-*+]\s+/.test(p) && !SEPARATOR.test(p),
    );
}

export type JsonLeaf = { path: string; value: unknown };

/** Depth-limited walk so a hostile or huge JSON file cannot blow up ingest. */
export function walkJson(
  value: unknown,
  path: string[] = [],
  out: JsonLeaf[] = [],
  depth = 0,
): JsonLeaf[] {
  if (depth > 12 || out.length > 20_000) return out;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      walkJson(entry, [...path, String(index)], out, depth + 1),
    );
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      walkJson(entry, [...path, key], out, depth + 1);
    }
    return out;
  }
  out.push({ path: path.join('.'), value });
  return out;
}
