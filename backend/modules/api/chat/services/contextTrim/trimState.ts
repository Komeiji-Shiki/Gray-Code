/**
 * 裁剪状态持久化辅助（从 ContextTrimService 抽离）。
 *
 * 裁剪状态存储在会话 custom metadata 中，key 为 'trimState'。
 * 历史结构变更（删除/编辑/回档等）由 ConversationManager 统一失效该状态。
 */

import type { ConversationManager } from '../../../../conversation/ConversationManager';
import { CONVERSATION_CONTEXT_TRIM_STATE_KEY } from '../../../../conversation/types';
import type { Logger } from '../../../../../core/logger';

/** 裁剪状态在 custom metadata 中的 key */
export const TRIM_STATE_KEY = CONVERSATION_CONTEXT_TRIM_STATE_KEY;

export const CURRENT_TRIM_STATE_SCHEMA_VERSION = 1;

/**
 * 持久化的裁剪状态
 *
 * 存储在会话的 custom metadata 中，key 为 'trimState'
 */
export interface PersistedTrimState {
    /** 裁剪状态格式版本；旧版本缺少回合边界语义，读取时必须失效并重新评估。 */
    schemaVersion: number;
    /** 裁剪起始索引 */
    trimStartIndex: number;
}

/**
 * 获取持久化的裁剪状态
 */
export async function getTrimState(
    conversationManager: ConversationManager,
    conversationId: string,
    log: Logger
): Promise<PersistedTrimState | null> {
    const rawState = await conversationManager.getCustomMetadata(conversationId, TRIM_STATE_KEY);
    if (!rawState || typeof rawState !== 'object') {
        return null;
    }

    const state = rawState as Partial<PersistedTrimState>;
    if (state.schemaVersion !== CURRENT_TRIM_STATE_SCHEMA_VERSION || !Number.isInteger(state.trimStartIndex)) {
        // 旧状态可能是在工具回合中途推进的，无法判断其合法边界。一次性清除后重新评估，
        // 让升级前被错误遮蔽的历史重新回到候选上下文。
        await conversationManager.invalidateContextManagementState(
            conversationId,
            'trim_state_schema_upgrade'
        );
        log.info('trim_state_cleared_schema_upgrade', {
            conversationId,
            savedSchemaVersion: state.schemaVersion ?? null,
            currentSchemaVersion: CURRENT_TRIM_STATE_SCHEMA_VERSION
        });
        return null;
    }
    return state as PersistedTrimState;
}

/**
 * 保存裁剪状态到持久化存储
 */
export async function saveTrimState(
    conversationManager: ConversationManager,
    conversationId: string,
    state: Omit<PersistedTrimState, 'schemaVersion'>
): Promise<void> {
    await conversationManager.setCustomMetadata(conversationId, TRIM_STATE_KEY, {
        ...state,
        schemaVersion: CURRENT_TRIM_STATE_SCHEMA_VERSION
    });
}

/**
 * 清除指定会话的裁剪状态
 */
export async function clearTrimState(
    conversationManager: ConversationManager,
    conversationId: string
): Promise<void> {
    await conversationManager.invalidateContextManagementState(conversationId, 'context_trim_service_clear');
}
