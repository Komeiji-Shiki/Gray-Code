/**
 * 用户编辑摘要统计（从 DiffManager 抽离的纯函数层）。
 *
 * 只负责把「系统建议内容 vs 用户最终保存内容」的按行差异压缩成工具响应里的摘要文本，
 * 不依赖任何 VSCode 副作用，不读写文件，不做状态编排。
 */

import { splitLines } from './lineId';
import { myersDiffLines } from './diffAlgorithm';

/**
 * 计算用户新增/替换行摘要（仅当用户修改了 AI 建议时存在）。
 *
 * 格式（每行一条记录，多行用`\n` 分隔；空行内容为空字符串）：
 * - 新增：`+ | newLine | 内容`  （newLine 为用户最终保存内容中的1-based 行号）
 * - 替换：`~ | newLine | 内容`  （newLine 为用户最终保存内容中的1-based 行号）
 * - 删除：`- | baseLine | 内容` （baseLine 为系统建议保存内容中的1-based 行号）
 */
export function computeUserEditedNewLinesSummary(baseContent: string, userContent: string): string {
    const a = splitLines(baseContent);
    const b = splitLines(userContent);
    const ops = myersDiffLines(a, b);

    let baseLine = 1;
    let newLine = 1;

    // replace 的判定：在上一次equal 之后是否出现过delete。
    // - delete 后紧跟insert => 视为 replace（~）
    // - 只有 insert => insert（+）
    let hadDeleteSinceLastEqual = false;

    const result: string[] = [];

    for (const op of ops) {
        if (op.type === 'equal') {
            hadDeleteSinceLastEqual = false;
            baseLine++;
            newLine++;
            continue;
        }

        if (op.type === 'delete') {
            // 删除行：行号使用 baseSuggestedContent（系统建议保存内容）的行号
            result.push(`- | ${baseLine} | ${op.line}`);
            hadDeleteSinceLastEqual = true;
            baseLine++;
            continue;
        }

        // insert（包含新增行，以及replace 的新行）
        const opType = hadDeleteSinceLastEqual ? '~' : '+';
        // 新增/替换行：行号使用 userContent（用户最终保存内容）的行号
        result.push(`${opType} | ${newLine} | ${op.line}`);
        newLine++;
    }

    // 摘要会写入工具响应发给模型：超大编辑（如差分降级为整段替换）时截断，避免把整份文件塞进上下文
    const MAX_SUMMARY_LINES = 500;
    if (result.length > MAX_SUMMARY_LINES) {
        const omitted = result.length - MAX_SUMMARY_LINES;
        return [...result.slice(0, MAX_SUMMARY_LINES), `... (${omitted} more edited lines omitted)`].join('\n');
    }
    return result.join('\n');
}
