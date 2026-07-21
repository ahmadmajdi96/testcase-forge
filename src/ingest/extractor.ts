import { createHash } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import type { SourceDocument } from '../domain/spec.js';

const TEXT_EXTENSIONS = new Set([
  'md',
  'markdown',
  'txt',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'csv',
  'tsv',
  'html',
  'htm',
  'xml',
  'ts',
  'js',
  'sql',
  'env',
  'log',
]);

const TEXT_MEDIA_PREFIXES = ['text/', 'application/json', 'application/xml'];

export interface RawUpload {
  filename: string;
  mediaType: string;
  content: Buffer;
}

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx + 1).toLowerCase();
}

/** Rejects anything that is not plausibly UTF-8 text before it reaches the model. */
function assertDecodable(filename: string, content: Buffer): string {
  const nulBytes = content.subarray(0, 4096).filter((b) => b === 0).length;
  if (nulBytes > 0) {
    throw new AppError(
      'unsupported_media_type',
      `File "${filename}" appears to be binary; only UTF-8 text documents are supported.`,
    );
  }
  const text = content.toString('utf8');
  if (text.includes('�')) {
    throw new AppError(
      'unsupported_media_type',
      `File "${filename}" is not valid UTF-8 text.`,
    );
  }
  return text;
}

export function toSourceDocument(upload: RawUpload): SourceDocument {
  const filename = upload.filename.trim();
  if (!filename) {
    throw new AppError('bad_request', 'Every uploaded file must have a filename.');
  }
  // Uploaded names are used in prompts and reports only; never as a filesystem path.
  const safeName = filename.replace(/[\\/]/g, '_').slice(0, 200);

  const ext = extensionOf(safeName);
  const mediaOk = TEXT_MEDIA_PREFIXES.some((p) => upload.mediaType.startsWith(p));
  if (ext && !TEXT_EXTENSIONS.has(ext) && !mediaOk) {
    throw new AppError(
      'unsupported_media_type',
      `Unsupported file type ".${ext}" for "${safeName}". Supported: ${[...TEXT_EXTENSIONS].join(', ')}.`,
    );
  }
  if (upload.content.byteLength === 0) {
    throw new AppError('unprocessable_entity', `File "${safeName}" is empty.`);
  }

  const text = assertDecodable(safeName, upload.content);
  if (text.trim().length === 0) {
    throw new AppError(
      'unprocessable_entity',
      `File "${safeName}" contains no readable content.`,
    );
  }

  return {
    name: safeName,
    mediaType: upload.mediaType || 'text/plain',
    bytes: upload.content.byteLength,
    sha256: createHash('sha256').update(upload.content).digest('hex'),
    text,
  };
}

/** Drops byte-identical re-uploads so duplicated files do not duplicate cost. */
export function dedupeDocuments(documents: SourceDocument[]): {
  documents: SourceDocument[];
  duplicates: string[];
} {
  const seen = new Map<string, string>();
  const kept: SourceDocument[] = [];
  const duplicates: string[] = [];
  for (const doc of documents) {
    const existing = seen.get(doc.sha256);
    if (existing) {
      duplicates.push(`${doc.name} (identical to ${existing})`);
      continue;
    }
    seen.set(doc.sha256, doc.name);
    kept.push(doc);
  }
  return { documents: kept, duplicates };
}
