import type { LongMemoryArchive, LongMemoryKind, LongMemoryRecord, LongMemoryScope, LongMemorySource, MemoryImportDataset } from '@graycode/contracts';
import { importHash, type SourceFile } from './files';

export function splitImportText(text: string, maximum = 600): Array<{ text: string; start: number; end: number }> {
  const parts: Array<{ text: string; start: number; end: number }> = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + maximum);
    // 不截断 UTF-16 代理对，也不删除段落边界；原文可以按范围重新拼接。
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push({ text: text.slice(start, end), start, end }); start = end;
  }
  return parts;
}

export class ImportedMemoryBuilder {
  readonly sources: LongMemorySource[] = [];
  readonly records: LongMemoryRecord[] = [];
  readonly segments: MemoryImportDataset['segments'] = [];
  readonly attachments: MemoryImportDataset['attachments'] = [];
  constructor(readonly scope: LongMemoryScope, readonly datasetId: string) {}
  source(file: SourceFile, identity: string, text: string, label?: string): LongMemorySource[] {
    const recordedAt = Date.parse(file.modifiedAt!) || 0;
    const values = splitImportText(text, 30000).filter(part => part.text.trim()).map((part, index): LongMemorySource => ({
      id: `source:${importHash(JSON.stringify([this.datasetId, identity, index]))}`, scopeId: this.scope.id, version: 1, origin: 'import', text: part.text, recordedAt,
      reference: { resourceId: `memory-import:${this.datasetId}:${file.id}`, label: (label || file.path).slice(0, 480) },
    }));
    this.sources.push(...values); return values;
  }
  add(file: SourceFile, identity: string, text: string, options: { kind?: LongMemoryKind; topic?: string[]; subject?: string; attribute?: string; value?: string;
    raw?: string; start?: number; representation?: 'file_text' | 'normalized'; dependencies?: Array<{ kind: 'record'; id: string; version: number }>; fileIds?: string[];
    prefix?: string; sourceLabel?: string; recordedAt?: number; validFrom?: number; validTo?: number; eventAt?: number } = {}): LongMemoryRecord[] {
    if (!text.trim()) return [];
    const sources = this.source(file, identity, options.raw ?? text, options.sourceLabel);
    if (!sources.length) throw new Error(`记忆来源为空：${file.path}`);
    const sourceParts = splitImportText(options.raw ?? text, 30000).filter(part => part.text.trim());
    if (options.fileIds?.length) for (const source of sources) this.attachments.push({ sourceId: source.id, fileIds: options.fileIds });
    const recordedAt = options.recordedAt ?? (Date.parse(file.modifiedAt!) || 0);
    if (options.recordedAt !== undefined) for (const source of sources) source.recordedAt = recordedAt;
    const values = splitImportText(text).filter(part => part.text.trim()).map((part, index): LongMemoryRecord => {
      const id = `record:${importHash(JSON.stringify([this.datasetId, identity, index]))}`;
      const selectedSources = options.raw !== undefined && options.raw !== text ? sources : sources.filter((_, index) => sourceParts[index].end > part.start && sourceParts[index].start < part.end);
      const dependencies = [...selectedSources.map(source => ({ kind: 'source' as const, id: source.id, version: 1 })), ...options.dependencies ?? []];
      if (dependencies.length > 128) throw new Error(`单项来源过长，请先分段整理：${file.path}`);
      this.segments.push({ fileId: file.id, sourceId: selectedSources[0].id, recordId: id, start: (options.start ?? 0) + part.start, end: (options.start ?? 0) + part.end, representation: options.representation ?? 'file_text' });
      return { id, scopeId: this.scope.id, version: 1, kind: options.kind ?? 'fact', origin: 'import', confidence: 'inferred',
        subject: (options.subject || file.path).slice(0, 512), text: options.prefix ? `${options.prefix}\n${part.text}` : part.text, topic: (options.topic ?? ['导入档案', ...file.path.split('/')]).slice(0, 8).map(value => value.slice(0, 120)),
        ...(options.attribute ? { attribute: options.attribute.slice(0, 256) } : {}), ...(options.value ? { value: options.value.slice(0, 4000) } : {}),
        entities: [], recordedAt, validFrom: options.validFrom ?? recordedAt, ...(options.validTo !== undefined ? {validTo: options.validTo} : {}),
        ...(options.eventAt !== undefined ? {eventAt: options.eventAt} : {}), dependencies, supersedes: [] };
    });
    this.records.push(...values); return values;
  }
  archive(): LongMemoryArchive {
    return { format: 'graycode-long-memory', version: 1, createdAt: Date.now(), scopes: [{ ...this.scope, revision: 0, invalidation: 0 }], sources: this.sources, records: this.records, tombstones: [] };
  }
}
