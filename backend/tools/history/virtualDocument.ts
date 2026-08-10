/**
 * history_search 虚拟文档格式化引擎
 *
 * 从 history_search.ts 拆分（模块化重构第一批）：
 * 负责将被总结覆盖的对话历史格式化为带行号的"虚拟文档"，
 * 以及行号前缀、显示截断等纯展示辅助函数。
 *
 * 相关模块：
 * - historySearch.ts：search/read 两种模式处理器（消费本模块的格式化输出）
 * - history_search.ts：工具声明 + handler 装配
 */

import type { Content } from '../../modules/conversation/types';
import { DEFAULT_HISTORY_SEARCH_CONFIG } from '../../modules/settings/types';

// ─── 默认常量（当 settingsManager 不可用时的 fallback） ───

const {
    lineDisplayLimit: LINE_DISPLAY_LIMIT
} = DEFAULT_HISTORY_SEARCH_CONFIG;

// ─── 格式化引擎 ─────────────────────────────────────────

/**
 * 从历史消息中提取被总结覆盖的消息（isSummarized 标记）
 *
 * 逻辑截断语义下被总结的原始消息完整保留在历史中并打 isSummarized 标记；
 * 直接按标记过滤（不依赖总结消息位置），手动总结同样生效。
 */
export function getSummarizedMessages(history: Content[]): Content[] {
    return history.filter(message => message.isSummarized === true);
}

/**
 * 获取消息的类型标签
 */
function getMessageTypeTag(message: Content): string {
    const hasFunctionCall = message.parts.some(p => p.functionCall);
    const hasFunctionResponse = message.parts.some(p => p.functionResponse);

    if (hasFunctionCall) return ' [tool_call]';
    if (hasFunctionResponse) return ' [tool_result]';
    return '';
}

/**
 * 将单条消息格式化为文本行数组
 */
function formatMessage(message: Content): string[] {
    const lines: string[] = [];
    const roleTag = message.role === 'user' ? '👤 User' : '🤖 Model';
    const typeTag = getMessageTypeTag(message);

    lines.push(`${roleTag}${typeTag}:`);

    for (const part of message.parts) {
        // 思考过程跳过（不需要检索）
        if (part.thought) continue;

        if (part.text) {
            lines.push(...part.text.split('\n'));
        }

        if (part.functionCall) {
            const argsStr = JSON.stringify(part.functionCall.args);
            lines.push(`${part.functionCall.name}(${argsStr})`);
        }

        if (part.functionResponse) {
            const responseStr = JSON.stringify(part.functionResponse.response);
            lines.push(`${part.functionResponse.name} → ${responseStr}`);
        }
    }

    return lines;
}

/**
 * 将被总结的消息格式化为完整的虚拟文档
 *
 * 两遍扫描：
 * 1. 先生成所有行，记录每个 Round 标题的行索引
 * 2. 回填每个 Round 标题的行号范围 (L start - L end)
 */
export function formatToDocument(messages: Content[]): string[] {
    const docLines: string[] = [];
    let roundNumber = 0;
    // 记录每个 Round 标题在 docLines 中的索引
    const roundHeaderIndices: number[] = [];

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];

        // 遇到非 functionResponse 的 user 消息，标记新回合
        if (message.role === 'user' && !message.isFunctionResponse) {
            roundNumber++;
            if (docLines.length > 0) {
                docLines.push(''); // 回合间空行
            }
            roundHeaderIndices.push(docLines.length);
            docLines.push(''); // 占位，后面回填
        }

        // 格式化消息内容
        const msgLines = formatMessage(message);
        docLines.push(...msgLines);
        docLines.push(''); // 消息间空行
    }

    // 第二遍：回填 Round 标题，写入行号范围
    for (let r = 0; r < roundHeaderIndices.length; r++) {
        const headerIdx = roundHeaderIndices[r];
        const startLine = headerIdx + 1; // 1-based
        const endLine = r + 1 < roundHeaderIndices.length
            ? roundHeaderIndices[r + 1] - 1   // 下一个 Round 的空行分隔符之前
            : docLines.length;                 // 最后一个 Round 到文档末尾

        docLines[headerIdx] = `══ Round ${r + 1} (L${startLine}-L${endLine}) ══════════`;
    }

    return docLines;
}

/**
 * 截断过长的行用于显示，附带提示
 * docLines 内部仍存完整内容，仅在输出时调用
 */
export function truncateLineForDisplay(line: string, lineNum: number, limit: number = LINE_DISPLAY_LIMIT): string {
    if (line.length <= limit) return line;
    return line.substring(0, limit)
        + `... [${line.length} chars, read line ${lineNum} for full content]`;
}

/**
 * 给行数组添加行号前缀（1-based），返回格式化字符串
 * @param truncateLong 是否截断过长的行（默认 false）
 * @param lineLimit 单行显示字符限制
 */
export function addLineNumbers(lines: string[], startLine: number = 1, truncateLong: boolean = false, lineLimit: number = LINE_DISPLAY_LIMIT): string {
    const totalLines = startLine + lines.length - 1;
    const maxDigits = String(totalLines).length;

    return lines.map((line, idx) => {
        const lineNum = startLine + idx;
        const numStr = String(lineNum).padStart(maxDigits, ' ');
        const displayLine = truncateLong ? truncateLineForDisplay(line, lineNum, lineLimit) : line;
        return `${numStr} | ${displayLine}`;
    }).join('\n');
}
