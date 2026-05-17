/**
 * Prompt context cache helpers.
 *
 * turnDynamicContext 仍然使用 string 字段保存，但内部存储结构化 JSON，
 * 以支持多条 user/model 临时上下文消息、chat-history 前后位置和 preserve 动态快照。
 */

import type { Content } from '../conversation/types';

export type PromptContextCacheRole = 'user' | 'model';

export interface SerializedPromptContextMessage {
    role: PromptContextCacheRole;
    text: string;
}

interface SerializedPromptContextCacheV1 {
    version: 1;
    /** v1 当前回合完整非 system prompt context。 */
    contextMessages: SerializedPromptContextMessage[];
    /** v1 preserve 旧回合时插回原位的动态快照子集。 */
    dynamicSnapshotMessages: SerializedPromptContextMessage[];
    contextText?: string;
    dynamicSnapshotText?: string;
}

export interface SerializedPromptContextCache {
    version: 2;
    /** 当前回合中位于真实聊天历史之前的 prompt context。 */
    beforeHistoryMessages: SerializedPromptContextMessage[];
    /** 当前回合中位于真实聊天历史之后的 prompt context。 */
    afterHistoryMessages: SerializedPromptContextMessage[];
    /** preserve 旧回合时插回原位的 before-history 动态快照子集。 */
    dynamicSnapshotBeforeHistoryMessages: SerializedPromptContextMessage[];
    /** preserve 旧回合时插回原位的 after-history 动态快照子集。 */
    dynamicSnapshotAfterHistoryMessages: SerializedPromptContextMessage[];
    /** 完整 context 的可见文本，用于 token 计数。 */
    contextText?: string;
    /** 动态快照的可见文本，用于 preserve 历史 token 计数。 */
    dynamicSnapshotText?: string;
    /** legacy 表示旧插入逻辑；entry 表示 chat_history 条目显式控制历史位置。 */
    historyPlacement?: 'legacy' | 'entry';
}

export interface PromptContextBundleLike {
    beforeHistoryMessages?: Content[];
    afterHistoryMessages?: Content[];
    dynamicSnapshotBeforeHistoryMessages?: Content[];
    dynamicSnapshotAfterHistoryMessages?: Content[];
    messages: Content[];
    dynamicSnapshotMessages: Content[];
    text?: string;
    dynamicSnapshotText?: string;
    historyPlacement?: 'legacy' | 'entry';
}

export interface DeserializedPromptContextCache {
    beforeHistoryMessages: Content[];
    afterHistoryMessages: Content[];
    dynamicSnapshotBeforeHistoryMessages: Content[];
    dynamicSnapshotAfterHistoryMessages: Content[];
    contextMessages: Content[];
    dynamicSnapshotMessages: Content[];
    contextText: string;
    dynamicSnapshotText: string;
    historyPlacement: 'legacy' | 'entry';
}

function contentToText(message: Content): string {
    return message.parts?.map(part => part.text || '').join('') || '';
}

function messageToSerialized(message: Content): SerializedPromptContextMessage | null {
    if (message.role !== 'user' && message.role !== 'model') {
        return null;
    }

    const text = contentToText(message).trim();
    if (!text) {
        return null;
    }

    return {
        role: message.role,
        text
    };
}

function serializedToContent(message: SerializedPromptContextMessage): Content | null {
    if (message.role !== 'user' && message.role !== 'model') {
        return null;
    }

    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) {
        return null;
    }

    return {
        role: message.role,
        parts: [{ text }]
    };
}

function normalizeSerializedMessages(value: unknown): SerializedPromptContextMessage[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const messages: SerializedPromptContextMessage[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const role = (item as any).role;
        const text = (item as any).text;
        if ((role !== 'user' && role !== 'model') || typeof text !== 'string' || !text.trim()) {
            continue;
        }
        messages.push({ role, text: text.trim() });
    }
    return messages;
}

function serializedMessagesToContent(value: unknown): Content[] {
    return normalizeSerializedMessages(value)
        .map(serializedToContent)
        .filter((message): message is Content => !!message);
}

function contentMessagesToSerialized(messages: Content[]): SerializedPromptContextMessage[] {
    return messages
        .map(messageToSerialized)
        .filter((message): message is SerializedPromptContextMessage => !!message);
}

export function promptContextMessagesToText(messages: Content[]): string {
    return messages
        .map(contentToText)
        .map(text => text.trim())
        .filter(Boolean)
        .join('\n\n');
}

export function serializePromptContextCache(bundle: PromptContextBundleLike): string {
    const beforeHistoryMessages = bundle.beforeHistoryMessages ?? bundle.messages;
    const afterHistoryMessages = bundle.afterHistoryMessages ?? [];
    const dynamicSnapshotBeforeHistoryMessages = bundle.dynamicSnapshotBeforeHistoryMessages ?? bundle.dynamicSnapshotMessages;
    const dynamicSnapshotAfterHistoryMessages = bundle.dynamicSnapshotAfterHistoryMessages ?? [];
    const contextMessages = [...beforeHistoryMessages, ...afterHistoryMessages];
    const dynamicSnapshotMessages = [
        ...dynamicSnapshotBeforeHistoryMessages,
        ...dynamicSnapshotAfterHistoryMessages
    ];

    const cache: SerializedPromptContextCache = {
        version: 2,
        beforeHistoryMessages: contentMessagesToSerialized(beforeHistoryMessages),
        afterHistoryMessages: contentMessagesToSerialized(afterHistoryMessages),
        dynamicSnapshotBeforeHistoryMessages: contentMessagesToSerialized(dynamicSnapshotBeforeHistoryMessages),
        dynamicSnapshotAfterHistoryMessages: contentMessagesToSerialized(dynamicSnapshotAfterHistoryMessages),
        contextText: bundle.text ?? promptContextMessagesToText(contextMessages),
        dynamicSnapshotText: bundle.dynamicSnapshotText ?? promptContextMessagesToText(dynamicSnapshotMessages),
        historyPlacement: bundle.historyPlacement ?? 'legacy'
    };

    return JSON.stringify(cache);
}

function emptyCache(): DeserializedPromptContextCache {
    return {
        beforeHistoryMessages: [],
        afterHistoryMessages: [],
        dynamicSnapshotBeforeHistoryMessages: [],
        dynamicSnapshotAfterHistoryMessages: [],
        contextMessages: [],
        dynamicSnapshotMessages: [],
        contextText: '',
        dynamicSnapshotText: '',
        historyPlacement: 'legacy'
    };
}

function deserializeV2(parsed: Partial<SerializedPromptContextCache>): DeserializedPromptContextCache {
    const beforeHistoryMessages = serializedMessagesToContent(parsed.beforeHistoryMessages);
    const afterHistoryMessages = serializedMessagesToContent(parsed.afterHistoryMessages);
    const dynamicSnapshotBeforeHistoryMessages = serializedMessagesToContent(parsed.dynamicSnapshotBeforeHistoryMessages);
    const dynamicSnapshotAfterHistoryMessages = serializedMessagesToContent(parsed.dynamicSnapshotAfterHistoryMessages);
    const contextMessages = [...beforeHistoryMessages, ...afterHistoryMessages];
    const dynamicSnapshotMessages = [
        ...dynamicSnapshotBeforeHistoryMessages,
        ...dynamicSnapshotAfterHistoryMessages
    ];

    return {
        beforeHistoryMessages,
        afterHistoryMessages,
        dynamicSnapshotBeforeHistoryMessages,
        dynamicSnapshotAfterHistoryMessages,
        contextMessages,
        dynamicSnapshotMessages,
        contextText: typeof parsed.contextText === 'string'
            ? parsed.contextText
            : promptContextMessagesToText(contextMessages),
        dynamicSnapshotText: typeof parsed.dynamicSnapshotText === 'string'
            ? parsed.dynamicSnapshotText
            : promptContextMessagesToText(dynamicSnapshotMessages),
        historyPlacement: parsed.historyPlacement === 'entry' ? 'entry' : 'legacy'
    };
}

function deserializeV1(parsed: Partial<SerializedPromptContextCacheV1>): DeserializedPromptContextCache {
    const beforeHistoryMessages = serializedMessagesToContent(parsed.contextMessages);
    const dynamicSnapshotBeforeHistoryMessages = serializedMessagesToContent(parsed.dynamicSnapshotMessages);

    return {
        beforeHistoryMessages,
        afterHistoryMessages: [],
        dynamicSnapshotBeforeHistoryMessages,
        dynamicSnapshotAfterHistoryMessages: [],
        contextMessages: beforeHistoryMessages,
        dynamicSnapshotMessages: dynamicSnapshotBeforeHistoryMessages,
        contextText: typeof parsed.contextText === 'string'
            ? parsed.contextText
            : promptContextMessagesToText(beforeHistoryMessages),
        dynamicSnapshotText: typeof parsed.dynamicSnapshotText === 'string'
            ? parsed.dynamicSnapshotText
            : promptContextMessagesToText(dynamicSnapshotBeforeHistoryMessages),
        historyPlacement: 'legacy'
    };
}

export function deserializePromptContextCache(raw: string): DeserializedPromptContextCache {
    const legacyText = typeof raw === 'string' ? raw.trim() : '';

    try {
        const parsed = JSON.parse(raw) as { version?: unknown };
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Invalid prompt context cache');
        }

        if (parsed.version === 2) {
            return deserializeV2(parsed as Partial<SerializedPromptContextCache>);
        }

        if (parsed.version === 1) {
            return deserializeV1(parsed as Partial<SerializedPromptContextCacheV1>);
        }

        throw new Error('Unsupported prompt context cache version');
    } catch {
        if (!legacyText) {
            return emptyCache();
        }

        const legacyMessage: Content = {
            role: 'user',
            parts: [{ text: legacyText }]
        };
        return {
            beforeHistoryMessages: [legacyMessage],
            afterHistoryMessages: [],
            dynamicSnapshotBeforeHistoryMessages: [legacyMessage],
            dynamicSnapshotAfterHistoryMessages: [],
            contextMessages: [legacyMessage],
            dynamicSnapshotMessages: [legacyMessage],
            contextText: legacyText,
            dynamicSnapshotText: legacyText,
            historyPlacement: 'legacy'
        };
    }
}

export function getPromptContextCacheDynamicSnapshotText(raw: string | undefined): string {
    if (!raw?.trim()) {
        return '';
    }
    return deserializePromptContextCache(raw).dynamicSnapshotText;
}
