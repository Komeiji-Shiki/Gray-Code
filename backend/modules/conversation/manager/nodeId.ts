/**
 * 稳定消息节点 ID（BR-01/BR-02）相关纯函数（拆分自 ConversationManager.ts）。
 *
 * ConversationManager.ts 通过 `export { deterministicNodeId } from './manager/nodeId'`
 * 再导出 deterministicNodeId，保证既有 `import { deterministicNodeId } from '../ConversationManager'`
 * 不断。其余函数由 ConversationManager / manager 下各服务直接 import 使用。
 * 注意：本文件内容按原文件缩进保留（纯移动，不重排）。
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Content, ConversationHistory } from '../types';

/**
 * BR-02：确定性消息节点 ID 生成（RFC 4122 v5 风格）。
 *
 * namespace=conversationId，seed=role+index+timestamp。
 * 幂等硬要求：同一历史多次迁移必须产出同一 ID 集合，因此迁移 ID 不能是随机值。
 */
export function deterministicNodeId(namespace: string, seed: string): string {
    const hash = createHash('sha1');
    hash.update(namespace, 'utf8');
    hash.update('\u0000', 'utf8');
    hash.update(seed, 'utf8');
    const bytes = hash.digest();
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // RFC 4122 version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * BR-01：为新写入/插入的内容补齐稳定节点 ID。
 *
 * - id：已有则保留，否则生成随机 UUID；
 * - parentId：未定义（undefined）时取 parent 的 id（线性链接），首条为 null；显式 null/string 保留。
 */
export function ensureNodeId(content: Content, parent: Content | null | undefined): Content {
    if (typeof content.id !== 'string' || content.id.length === 0) {
        content.id = randomUUID();
    }
    if (content.parentId === undefined) {
        content.parentId = parent?.id ?? null;
    }
    return content;
}

/**
 * BR-02：幂等判据（自判定，无需额外标记文件）——历史中存在无 id 或 parentId 未定义的消息。
 */
export function needsNodeIdMigration(history: ReadonlyArray<Content>): boolean {
    return history.some(message =>
        typeof message.id !== 'string' || message.id.length === 0
        || message.parentId === undefined
    );
}

/**
 * BR-02：迁移前后的结构指纹（不含 id/parentId，用于写回后校验首尾消息与总数未变）。
 */
export function computeHistoryFingerprint(history: ReadonlyArray<Content>): string {
    if (history.length === 0) return 'empty';
    const fingerprintOf = (content: Content | undefined): string => {
        if (!content) return 'none';
        const partKinds = (content.parts || []).map(part => {
            if (part.functionCall) return 'fc';
            if (part.functionResponse) return 'fr';
            if (part.thought) return 'th';
            if (part.inlineData) return 'in';
            return 'tx';
        }).join(',');
        return createHash('sha256')
            .update(String(content.role))
            .update('\u0000').update(String(content.timestamp ?? ''))
            .update('\u0000').update(String((content.parts || []).length))
            .update('\u0000').update(partKinds)
            .digest('hex');
    };
    return `${fingerprintOf(history[0])}|${fingerprintOf(history[history.length - 1])}`;
}

/** BR-02：按数组顺序补齐确定性 id + 线性 parentId（纯函数，不落盘） */
export function buildMigratedHistory(conversationId: string, history: ConversationHistory): ConversationHistory {
    const migrated: ConversationHistory = [];
    let previousId: string | null = null;
    for (let i = 0; i < history.length; i++) {
        const message = history[i];
        const id = (typeof message.id === 'string' && message.id.length > 0)
            ? message.id
            : deterministicNodeId(conversationId, `${message.role}|${i}|${message.timestamp ?? ''}`);
        // 线性链修复：parentId 未定义，或 i>0 时显式 null（主历史只有首条允许 root）→ 取前一条 id。
        // 覆盖场景：读取时插入的 functionResponse 在父消息尚无 id 时被置 null，迁移时补回正确父链。
        const hasValidParent = typeof message.parentId === 'string' && message.parentId.length > 0;
        const parentId = hasValidParent
            ? message.parentId
            : (i === 0 ? null : previousId);
        migrated.push({ ...message, id, parentId });
        previousId = id;
    }
    return migrated;
}
