/**
 * 会话元数据构建与解析的纯函数。
 */

import { t } from '../../../i18n';
import type { Content, ConversationHistory, ConversationMetadata } from '../types';
import type { ConversationStorageIntegrity } from '../storageTypes';

export function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

export function getTextPreviewFromContent(content: Content | undefined, maxLength = 50): string | undefined {
    if (!content || !Array.isArray(content.parts)) return undefined;
    const text = content.parts
        .map(part => typeof part.text === 'string' ? part.text : '')
        .join('')
        .trim();
    if (!text) return undefined;
    return text.slice(0, maxLength);
}

export function buildBranchTitle(sourceTitle: string | undefined, branchAtIndex: number): string {
    const base = typeof sourceTitle === 'string' && sourceTitle.trim()
        ? sourceTitle.trim()
        : 'Conversation';
    const maxBaseLength = 44;
    const compactBase = base.length > maxBaseLength ? `${base.slice(0, maxBaseLength)}...` : base;
    return `${compactBase} · Branch @${branchAtIndex + 1}`;
}

export function buildBranchCustomMetadata(
    sourceCustom: Record<string, unknown> | undefined,
    sourceConversationId: string,
    branchAtIndex: number,
    messageCount: number,
    preview: string | undefined,
    createdAt: number,
    sourceNodeId?: string
): Record<string, unknown> {
    const copied: Record<string, unknown> = {};
    const allowedKeys = [
        'inputModelConfig',
        'promptModeConfig',
        'inputPinnedFiles',
        'inputSkills',
        'todoList'
    ];

    if (sourceCustom && typeof sourceCustom === 'object') {
        for (const key of allowedKeys) {
            if (sourceCustom[key] !== undefined) {
                copied[key] = cloneJson(sourceCustom[key]);
            }
        }
    }

    copied.messageCount = messageCount;
    if (preview) copied.preview = preview;
    copied.updatedAt = createdAt;
    copied.branch = {
        sourceConversationId,
        sourceMessageIndex: branchAtIndex,
        // BR-09：sourceNodeId 与 sourceMessageIndex 双写（新字段为主，旧字段兼容过渡）
        ...(sourceNodeId ? { sourceNodeId } : {}),
        createdAt
    };

    return copied;
}

export function resolveIntegrityStatus(
    integrity: ConversationStorageIntegrity | null
): ConversationMetadata['integrityStatus'] | undefined {
    if (!integrity) return undefined;
    if (!integrity.historyExists) return 'history_missing';
    if (!integrity.historyReadable) return 'history_corrupt';
    if (!integrity.metadataExists) return 'meta_missing';
    if (!integrity.metadataReadable) return 'meta_corrupt';
    return 'ok';
}

export function createFallbackMetadata(
    conversationId: string,
    history: ConversationHistory | null
): ConversationMetadata {
    const timestamps = (history || [])
        .map(item => item.timestamp)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const now = Date.now();
    const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : now;
    const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : now;

    return {
        id: conversationId,
        title: t('modules.conversation.defaultTitle', { conversationId }),
        createdAt,
        updatedAt,
        custom: {},
    };
}
