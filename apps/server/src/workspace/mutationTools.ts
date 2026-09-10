import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { ToolDeclaration, ToolOutcome } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { createWriteFileDeclaration } from '../../../../backend/tools/file/createWriteFileDeclaration';
import { createInsertCodeDeclaration } from '../../../../backend/tools/file/createInsertCodeDeclaration';
import { createDeleteCodeDeclaration } from '../../../../backend/tools/file/createDeleteCodeDeclaration';
import { createDeleteFileDeclaration } from '../../../../backend/tools/file/createDeleteFileDeclaration';
import { createDirectoryDeclaration } from '../../../../backend/tools/file/createDirectoryDeclaration';
import { createApplyDiffDeclaration } from '../../../../backend/tools/file/diff/createApplyDiffDeclaration';
import { prepareDiffProposal } from '../../../../backend/tools/file/diff/prepareProposal';
import { applyLegacyDiffsBestEffort } from '../../../../backend/tools/file/diff/apply';
import type { StructuredDiffHunk, LegacyDiffBlock } from '../../../../backend/tools/file/diff/types';
import { insertAtLine, splitContentLines, deleteLineRange } from '../../../../backend/tools/file/lineMutations';
import { MAX_EDIT_FILE_BYTES } from '../../../../backend/tools/shared/fileSizeGuards';

const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
/** 原文件工具只负责参数和提案；文件效果统一交给宿主事务与审阅服务。 */
export function mutationTools(app: PlatformApplication, format: 'unified' | 'search_replace'): RuntimeTool[] {
  const declarationOptions = { language: 'zh-CN' as const, precreateEmptyFile: false };
  const declaration = (value: { name: string; description: string; parameters: unknown }): ToolDeclaration =>
    ({ name: value.name, description: value.description, parameters: value.parameters as ToolDeclaration['parameters'] });
  async function read(context: ToolContext, file: string, limit?: number) {
    if (!context.workspace) throw new Error('请先选择工作区。');
    return app.files.transaction(context.workspace, async transaction => {
      const value = await transaction.capture(file);
      if (limit && value.bytes && value.bytes.length > limit) throw new Error(`文件超过 ${limit} 字节，请修改较小范围或使用 write_file。`);
      if (value.bytes?.includes(0)) throw new Error('不能将二进制文件作为代码编辑。');
      return { text: value.bytes === null ? '' : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value.bytes), hash: value.hash };
    }, { writeGrants: context.fileWriteGrants });
  }
  async function review(context: ToolContext, file: string, before: { text: string; hash: string | null }, content: string) {
    if (before.hash !== null && normalize(before.text) === content) return { path: file, success: true, status: 'accepted', action: 'unchanged' };
    const result = await app.diffs.propose(context, file, before.text, content, before.hash);
    return { path: file, success: result.status === 'accepted', status: result.status, cancelled: result.status === 'cancelled',
      action: before.hash === null ? 'created' : 'modified', diffContentId: result.id, pendingDiffId: result.id, error: result.error };
  }
  async function batch(entries: Record<string, any>[], operation: (entry: Record<string, any>) => Promise<Record<string, any>>): Promise<ToolOutcome> {
    if (!Array.isArray(entries) || !entries.length) return { success: false, error: '至少提供一个文件条目。' };
    const results: Record<string, any>[] = [];
    for (const entry of entries) {
      try { results.push(await operation(entry)); }
      catch (error) { results.push({ path: entry?.path ?? '', success: false, error: String(error) }); }
    }
    const successCount = results.filter(item => item.success).length;
    const cancelled = results.some(item => item.cancelled);
    return { success: successCount === results.length && !cancelled, cancelled,
      data: { results, successCount, failCount: results.length - successCount, totalCount: results.length },
      ...(successCount !== results.length ? { error: `${results.length - successCount} 个文件未完成修改。` } : {}) };
  }
  return [
    { declaration: declaration(createWriteFileDeclaration(declarationOptions)), effects: () => ['workspace_write'],
      execute: (args, context) => batch([args], async entry => {
        context.signal.throwIfAborted();
        if (typeof entry.path !== 'string' || typeof entry.content !== 'string') throw new Error('需要 path 和完整 content。');
        return review(context, entry.path, await read(context, entry.path), normalize(entry.content));
      }) },
    { declaration: declaration(createApplyDiffDeclaration({ ...declarationOptions, format })), effects: () => ['workspace_write'],
      execute: async (args, context) => {
        const file = String(args.path); const before = await read(context, file, MAX_EDIT_FILE_BYTES);
        if (before.hash === null) return { success: false, error: '文件不存在，请使用 write_file 创建。' };
        const proposal = format === 'search_replace'
          ? applyLegacyDiffsBestEffort(before.text, args.diffs as LegacyDiffBlock[])
          : prepareDiffProposal(before.text, args.hunks as StructuredDiffHunk[] | undefined, args.patch as string | undefined);
        const counts = { diffCount: proposal.results.length, totalCount: proposal.results.length, appliedCount: proposal.appliedCount,
          failedCount: proposal.failedCount, results: proposal.results, fallbackMode: 'fallbackMode' in proposal ? proposal.fallbackMode : 'none' };
        if (!proposal.appliedCount) return { success: false, error: '没有差异块能够应用。', data: { file, status: 'rejected', ...counts } };
        const result = await review(context, file, before, proposal.newContent);
        return { success: result.success && !proposal.failedCount, cancelled: result.cancelled, error: result.error,
          data: { ...result, file, ...counts } };
      } },
    { declaration: declaration(createInsertCodeDeclaration(declarationOptions)), effects: () => ['workspace_write'],
      execute: (args, context) => batch(args.files as Record<string, any>[], async entry => {
        context.signal.throwIfAborted();
        const before = await read(context, entry.path, MAX_EDIT_FILE_BYTES);
        if (before.hash === null) throw new Error('文件不存在，请使用 write_file 创建。');
        const lines = normalize(before.text).split('\n');
        if (!Number.isInteger(entry.line) || entry.line < 1 || entry.line > lines.length + 1 || typeof entry.content !== 'string') throw new Error('插入行号或内容无效。');
        const content = normalize(entry.content);
        return { ...await review(context, entry.path, before, insertAtLine(lines, entry.line, content)), line: entry.line, insertedLines: splitContentLines(content).length };
      }) },
    { declaration: declaration(createDeleteCodeDeclaration(declarationOptions)), effects: () => ['workspace_write'],
      execute: (args, context) => batch(args.files as Record<string, any>[], async entry => {
        context.signal.throwIfAborted();
        const before = await read(context, entry.path, MAX_EDIT_FILE_BYTES);
        if (before.hash === null) throw new Error('文件不存在。');
        const lines = normalize(before.text).split('\n');
        if (!Number.isInteger(entry.start_line) || !Number.isInteger(entry.end_line) || entry.start_line < 1 || entry.end_line < entry.start_line || entry.end_line > lines.length) throw new Error('删除行范围无效。');
        return { ...await review(context, entry.path, before, deleteLineRange(lines, entry.start_line, entry.end_line)),
          start_line: entry.start_line, end_line: entry.end_line, deletedLines: entry.end_line - entry.start_line + 1 };
      }) },
    { declaration: declaration(createDirectoryDeclaration(declarationOptions)), effects: () => ['workspace_write'],
      execute: (args, context) => batch((args.paths as string[]).map(path => ({ path })), async entry => {
        await app.changes.directories(context, [entry.path]); return { path: entry.path, success: true };
      }) },
    { declaration: declaration(createDeleteFileDeclaration(declarationOptions)), effects: () => ['workspace_write', 'data_delete'],
      execute: async (args, context) => {
        const result = await batch((args.paths as string[]).map(path => ({ path })), async entry => {
          await app.changes.removePaths(context, [entry.path]); return { path: entry.path, success: true };
        });
        const data = result.data as { results: { path: string; success: boolean }[] };
        return { ...result, data: { ...data, deletedPaths: data.results.filter(item => item.success).map(item => item.path), failedPaths: data.results.filter(item => !item.success).map(item => item.path) } };
      } },
  ];
}
