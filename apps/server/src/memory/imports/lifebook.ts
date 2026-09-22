import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SourceFile } from './files';
import { importHash } from './files';
import { ImportedMemoryBuilder } from './text';

const folders: Record<string, string> = { daily: '日记', weekly: '周总结', monthly: '月总结', quarterly: '季度总结', yearly: '年度总结', nodes: '人物与事物', pending: '待整理', extra: '补充资料', 临时: '临时记录' };
export async function decodeImportText(file: SourceFile): Promise<string> {
  const bytes = await fs.readFile(file.absolute);
  if (importHash(bytes) !== file.sha256) throw new Error(`解析期间文件发生变化：${file.path}`);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error(`此文件不是完整的 UTF-8 文本，原文件应先保留并确认编码：${file.path}`); }
}

/** 可检索条目保留发言者，原始 JSON、附加字段与图片另按字节完整保存。 */
export async function readLifeBookDocuments(files: SourceFile[], builder: ImportedMemoryBuilder, signal?: AbortSignal) {
  const byPath = new Map(files.map(file => [file.path.toLowerCase(), file]));
  let documents = 0, turns = 0, unrecognizedLines = 0, imageReferences = 0;
  const missingImages = new Set<string>();
  for (const file of files) {
    signal?.throwIfAborted();
    if (/\.md$/i.test(file.path)) {
      const text = await decodeImportText(file), [folder, ...parts] = file.path.split('/');
      builder.add(file, file.path, text, { kind: folder === 'nodes' ? 'fact' : 'event', topic: ['LifeBook', folders[folder] ?? folder, ...parts], subject: path.posix.basename(file.path, '.md') });
      documents++; continue;
    }
    if (!/\.jsonl$/i.test(file.path)) continue;
    const text = await decodeImportText(file); let offset = 0, lineNumber = 0;
    for (const line of text.split(/(?<=\n)/)) {
      lineNumber++; const start = offset; offset += line.length; if (!line.trim()) continue;
      let row: Record<string, unknown> | undefined;
      try { const parsed = JSON.parse(line.replace(/^\uFEFF/, '')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) row = parsed; } catch { /* 无法解析的行按原文保留为可查看记录。 */ }
      const identity = `${file.path}:${lineNumber}`;
      if (row?.type === 'header' || row?.type === 'footer') continue;
      if (row?.type !== 'turn' || typeof row.user !== 'string' || typeof row.assistant !== 'string') {
        builder.add(file, identity, line, {kind:'event',start,topic:['LifeBook','对话原文',...file.path.split('/').slice(1)]});unrecognizedLines++;continue;
      }
      turns++;
      const images = Array.isArray(row.images) ? row.images.filter((value): value is string => typeof value === 'string') : [];
      const fileIds = images.flatMap(image => {
        imageReferences++; const name = path.posix.normalize('conversations/' + image.replaceAll('\\', '/'));
        const found = byPath.get(name.toLowerCase());
        if (!found) { missingImages.add(name); return []; } return [found.id];
      });
      const stamp = typeof row.timestamp === 'string' ? row.timestamp : '', topic = ['LifeBook','对话',...file.path.split('/').slice(1)];
      const user = row.user || (images.length ? '原始消息包含图片，图片内容保留在关联附件中。' : '');
      builder.add(file, identity + ':user', user, {kind:'event',subject:'原始对话：用户',topic,representation:'normalized',fileIds,
        prefix:`原始对话 · 用户${stamp ? ' · ' + stamp : ''}`,sourceLabel:`${file.path} · 第 ${row.turn_id ?? lineNumber} 回合 · 用户`});
      builder.add(file, identity + ':assistant', row.assistant, {kind:'event',subject:'原始对话：助手',topic,representation:'normalized',
        prefix:`原始对话 · 助手（模型输出）${stamp ? ' · ' + stamp : ''}`,sourceLabel:`${file.path} · 第 ${row.turn_id ?? lineNumber} 回合 · 助手`});
    }
  }
  return { documents, turns, unrecognizedLines, imageReferences, missingImages: [...missingImages] };
}
