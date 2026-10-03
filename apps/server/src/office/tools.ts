import { readFile, stat } from 'node:fs/promises';
import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../application';
import { officeCreateDeclaration, officeEditDeclaration, officeReadDeclaration } from '../../../../backend/tools/office/declarations';
import { FileReadAccess } from '../workspace/readAccess';
import { fileHash } from '../workspace/fileTransaction';
import { MAX_OFFICE_BYTES, OfficeArchive, officeFormat } from './archive';
import { createOffice, type OfficeCell, type OfficeContent } from './create';
import { editParagraphs, readParagraphs, slideParts, type ParagraphEdit } from './paragraphs';
import { editSpreadsheet, readSpreadsheet } from './spreadsheet';

async function readOffice(app: PlatformApplication, context: ToolContext, file: string) {
  const absolute = await new FileReadAccess(app, context).resolve(file);
  const info = await stat(absolute);
  if (!info.isFile() || info.size > MAX_OFFICE_BYTES) throw new Error('Office 工具只读取不超过 64 MiB 的普通文件。');
  const bytes = await readFile(absolute, { signal: context.signal });
  return { bytes, hash: fileHash(bytes), format: officeFormat(file) };
}

/** 单次内容预算按条目推进；长文字使用条目内游标，避免静默丢掉段落尾部。 */
function page(items: Array<Record<string, unknown>>, offset: number, limit: number, textOffset: number) {
  const result: Array<Record<string, unknown>> = [];
  let budget = 16000, index = offset, character = textOffset;
  for (; index < items.length && result.length < limit; index++) {
    const item = items[index];
    const source = typeof item.text === 'string' ? item.text : JSON.stringify(item.value ?? '');
    if (character > source.length) throw new Error('textOffset 超出了这个条目的文字长度。');
    const remaining = source.slice(character);
    if (JSON.stringify(item).length > budget || remaining.length > budget) {
      if (!budget) break;
      const length = Math.min(remaining.length, Math.max(1, Math.floor(budget / 2)));
      result.push({ ...item, text: remaining.slice(0, length),
        // 长单元格不能在 value 中再放一次完整值，续读仍以 text 为准。
        ...(item.address ? { value: undefined, formula: undefined } : {}), textOffset: character, truncated: true });
      character += length;
      if (character === source.length) { index++; character = 0; }
      break;
    }
    result.push(character ? { ...item, text: remaining, textOffset: character,
      ...(item.address ? { value: undefined } : {}) } : item);
    budget -= JSON.stringify(item).length; character = 0;
  }
  return { items: result, totalItems: items.length, offset,
    ...(index < items.length ? { nextOffset: index, nextTextOffset: character } : {}) };
}

export function officeTools(app: PlatformApplication): RuntimeTool[] {
  return [
    { declaration: officeReadDeclaration(), effects: () => ['workspace_read'], parallelRead: true,
      execute: async (args, context) => {
        const file = String(args.path), { bytes, hash, format } = await readOffice(app, context, file);
        const archive = new OfficeArchive(bytes, format);
        const spreadsheet = format === 'xlsx' ? await readSpreadsheet(bytes, args.sheet as string | undefined) : undefined;
        if (format === 'xlsx' && (args.part !== undefined || args.slide !== undefined) || format !== 'xlsx' && args.sheet !== undefined
          || format === 'docx' && args.slide !== undefined) throw new Error('筛选参数与 Office 文件类型不匹配。');
        let items: Array<Record<string, unknown>> = spreadsheet?.items ?? readParagraphs(archive, format as 'docx' | 'pptx').map(item => ({ ...item }));
        const presentationParts = format === 'pptx' ? slideParts(archive) : undefined;
        const parts = format === 'xlsx' ? undefined : [...new Set([...(presentationParts ?? []), ...items.map(item => item.part)])];
        const slides = presentationParts?.length;
        if (args.part !== undefined) {
          if (!parts?.includes(args.part)) throw new Error(`文档部分不存在：${args.part}`);
          items = items.filter(item => item.part === args.part);
        }
        if (args.slide !== undefined) {
          if (Number(args.slide) > Number(slides)) throw new Error('幻灯片编号超出了文稿范围。');
          items = items.filter(item => item.slide === args.slide);
        }
        const offset = Number(args.offset ?? 0);
        if (offset > items.length) throw new Error('offset 超出了内容条目范围。');
        context.signal.throwIfAborted();
        return { success: true, data: { path: file, format, hash, parts, slides, sheets: spreadsheet?.sheets,
          ...(format === 'xlsx' ? { formulaResults: 'saved-cache' } : {}),
          ...page(items, offset, Number(args.limit ?? 100), Number(args.textOffset ?? 0)) } };
      } },
    { declaration: officeCreateDeclaration(), effects: () => ['workspace_write'],
      execute: async (args, context) => {
        if (!context.workspace) throw new Error('创建 Office 文件前请先选择工作区。');
        context.signal.throwIfAborted();
        const file = String(args.path), format = officeFormat(file);
        const bytes = await createOffice(format, args.content as OfficeContent);
        const receipt = await app.changes.write(context, [{ path: file, bytes, expectedHash: null }]);
        return { success: true, data: { path: file, format, sizeBytes: bytes.length, hash: receipt.hashes[file],
          operationId: receipt.operationId, ...(format === 'xlsx' ? { formulaResults: 'recalculate-on-open' } : {}) } };
      } },
    { declaration: officeEditDeclaration(), effects: () => ['workspace_read', 'workspace_write'],
      execute: async (args, context) => {
        if (!context.workspace) throw new Error('修改 Office 文件前请先选择工作区。');
        const file = String(args.path), { bytes, hash, format } = await readOffice(app, context, file);
        if (hash !== args.expectedHash) throw new Error('FILE_CONFLICT: Office 文件已变化，请重新读取后修改。');
        const archive = new OfficeArchive(bytes, format);
        if (format === 'xlsx') {
          if (!Array.isArray(args.cells) || args.paragraphs !== undefined || args.appendParagraphs !== undefined)
            throw new Error('修改 Excel 文件需要 cells。');
          editSpreadsheet(archive, args.cells as OfficeCell[]);
        } else {
          if (args.cells !== undefined || !args.paragraphs && !args.appendParagraphs) throw new Error('修改 Word/PPT 需要 paragraphs，Word 也支持 appendParagraphs。');
          editParagraphs(archive, format, (args.paragraphs ?? []) as ParagraphEdit[], (args.appendParagraphs ?? []) as string[]);
        }
        context.signal.throwIfAborted();
        const output = archive.bytes(), receipt = await app.changes.write(context, [{ path: file, bytes: output, expectedHash: hash }]);
        return { success: true, data: { path: file, format, sizeBytes: output.length, hash: receipt.hashes[file],
          operationId: receipt.operationId, ...(format === 'xlsx' ? { formulaResults: 'recalculate-on-open' } : {}) } };
      } },
  ];
}
