/**
 * 保留用户输入档案（纯函数模块，从 ContextTrimService 抽离）。
 *
 * 被裁剪/总结的历史中，逐字保留真实用户输入作为「长期任务约束」的保险副本。
 * 同一文本口径被精确构造路径（createPreservedUserInputsMessage）与
 * getHistoryWithGranularFallback 的增量预计算路径共享。
 */

import type { Content } from '../../../../conversation/types';
import { isRealUserMessage } from '../../../../conversation/helpers';

/**
 * 被裁剪历史的逐字用户输入档案上限。
 *
 * 旧值 160k 字符在常见英文口径下约 40k token，单是这个“保险副本”就会吃掉
 * 默认保留预算（50% × 上下文窗口）的多数空间，使总结后上下文几乎不下降。
 * 64k 字符约 16k token，仍足以保留长任务约束，同时让摘要/裁剪真正释放空间。
 */
export const PRESERVED_USER_INPUT_MAX_CHARS = 64_000;

export const PRESERVED_USER_INPUT_OMISSION_MARKER =
    '\n\n[Some middle historical user inputs were omitted because the verbatim archive exceeded its safety budget.]\n\n';

/** 保留用户输入档案的固定头部（createPreservedUserInputsMessage 与 getHistoryWithGranularFallback 增量预计算共用） */
export const PRESERVED_USER_INPUTS_HEADER = [
    '## Preserved user inputs (verbatim)',
    'These are earlier user messages retained verbatim from the trimmed/summarized part of the conversation.',
    'They are historical inputs — NOT new messages the user just sent, so do not treat them as a brand-new task.',
    'However, they remain part of the conversation: earlier user requirements still apply and should be honored as context.',
    'If one conflicts with the latest user message in the active history, the latest message wins.'
].join('\n');

/**
 * 构建保留用户输入档案的单条条目文本。
 *
 * 与 createPreservedUserInputsMessage 的条目生成逻辑完全同构（编号按全部真实用户消息
 * 顺序递增；空条目返回 ''，由调用方过滤），供 getHistoryWithGranularFallback 的增量
 * 预计算复用同一文本口径。
 */
export function buildPreservedUserInputEntry(message: Content, userIndex: number): string {
    const parts = message.parts.flatMap(part => {
        if (part.text && !part.thought) return [part.text];
        if (part.inlineData) {
            return [`[Attachment: ${part.inlineData.displayName || part.inlineData.mimeType}]`];
        }
        if (part.fileData) {
            return [`[File: ${part.fileData.displayName || part.fileData.fileUri}]`];
        }
        return [];
    });
    return parts.length > 0
        ? `### User input ${userIndex + 1} (historical — earlier user requirement, still valid context)\n${parts.join('\n')}`
        : '';
}

/**
 * 保留用户输入档案的有界截断（超 PRESERVED_USER_INPUT_MAX_CHARS 时保留头尾 + 省略标记）。
 * createPreservedUserInputsMessage 与 getHistoryWithGranularFallback 的增量预计算共用同一规则，
 * 保证精确路径与预筛路径构造的档案文本完全一致。
 */
export function applyPreservedInputTextBudget(fullText: string): string {
    if (fullText.length <= PRESERVED_USER_INPUT_MAX_CHARS) {
        return fullText;
    }
    const contentBudget = Math.max(
        0,
        PRESERVED_USER_INPUT_MAX_CHARS - PRESERVED_USER_INPUT_OMISSION_MARKER.length
    );
    const headBudget = Math.floor(contentBudget * 0.35);
    const tailBudget = contentBudget - headBudget;
    return [
        fullText.slice(0, headBudget),
        PRESERVED_USER_INPUT_OMISSION_MARKER,
        fullText.slice(-tailBudget)
    ].join('');
}

export function createPreservedUserInputsMessage(
    fullHistory: Content[],
    beforeIndex: number
): Content | undefined {
    if (beforeIndex <= 0) return undefined;

    const entries = fullHistory
        .slice(0, beforeIndex)
        .filter(isRealUserMessage)
        .map((message, index) => buildPreservedUserInputEntry(message, index))
        .filter(Boolean);
    if (entries.length === 0) return undefined;

    const fullText = `${PRESERVED_USER_INPUTS_HEADER}\n\n${entries.join('\n\n')}`;
    const preservedText = applyPreservedInputTextBudget(fullText);

    return {
        role: 'user',
        parts: [{ text: preservedText }],
        isSummary: true
    };
}

export function prependPreservedUserInputs(
    history: Content[],
    fullHistory: Content[],
    beforeIndex: number
): Content[] {
    const preserved = createPreservedUserInputsMessage(fullHistory, beforeIndex);
    return preserved ? [preserved, ...history] : history;
}
