/**
 * GrayCode - 检查点服务
 *
 * 封装与 CheckpointManager / SettingsManager 相关的通用检查点逻辑，
 * 统一管理：
 * - 用户消息前/后的检查点
 * - 模型消息前/后的检查点
 * - 工具执行前/后的检查点
 * - 按索引删除检查点
 */

import type { CheckpointManager, CheckpointRecord } from '../../../checkpoint';
import type { SettingsManager } from '../../../settings/SettingsManager';
import type { ConversationManager } from '../../../conversation/ConversationManager';
import type { CheckpointOperationProgress } from '../../../checkpoint';

export class CheckpointService {
    private checkpointManager?: CheckpointManager;
    private settingsManager?: SettingsManager;

    constructor(
        private conversationManager: ConversationManager,
        checkpointManager?: CheckpointManager,
        settingsManager?: SettingsManager
    ) {
        this.checkpointManager = checkpointManager;
        this.settingsManager = settingsManager;
    }

    /**
     * M1: 流式下发的存档记录摘要化——去掉 fileHashes/fileStats（完整数据在 manifest），
     * 避免把全量哈希映射经 IPC 下发 webview（CPF-03 只完成一半的补全）。
     * createCheckpoint 返回值保留完整数据（兼容既有调用方/测试），此处仅裁剪流出边界。
     */
    private toStreamSummary(record: CheckpointRecord | null): CheckpointRecord | null {
        if (!record) {
            return null;
        }
        const summary = { ...record };
        delete (summary as Partial<CheckpointRecord>).fileHashes;
        delete (summary as Partial<CheckpointRecord>).fileStats;
        return summary as CheckpointRecord;
    }

    /**
     * 设置检查点管理器
     */
    setCheckpointManager(checkpointManager: CheckpointManager): void {
        this.checkpointManager = checkpointManager;
    }

    /**
     * 设置设置管理器
     */
    setSettingsManager(settingsManager: SettingsManager): void {
        this.settingsManager = settingsManager;
    }

    /**
     * 为用户消息创建检查点
     *
     * @param conversationId 对话 ID
     * @param position       位置：'before' | 'after'
     * @param messageIndex   可选，指定消息索引（编辑场景）；
     *                       未指定时：
     *                       - before: 使用当前历史长度
     *                       - after:  使用最后一条消息索引
     */
    async createUserMessageCheckpoint(
        conversationId: string,
        position: 'before' | 'after',
        messageIndex?: number
    ): Promise<CheckpointRecord | null> {
        if (!this.checkpointManager || !this.settingsManager) {
            return null;
        }

        if (position === 'before') {
            if (!this.settingsManager.shouldCreateBeforeUserMessageCheckpoint()) {
                return null;
            }

            let index = messageIndex;
            if (index === undefined) {
                const history = await this.conversationManager.getHistoryRef(conversationId);
                index = history.length; // 新用户消息将插入的位置
            }

            // BCP-01: 由消息索引反查稳定节点 ID；before 存档的“即将插入”位置通常无消息 → undefined，不阻塞
            const messageNodeId = await this.conversationManager.getMessageNodeIdAt(conversationId, index);
            return this.toStreamSummary(await this.checkpointManager.createCheckpoint(
                conversationId,
                index,
                'user_message',
                'before',
                { messageNodeId }
            ));
        }

        // position === 'after'
        if (!this.settingsManager.shouldCreateAfterUserMessageCheckpoint()) {
            return null;
        }

        let index = messageIndex;
        if (index === undefined) {
            const history = await this.conversationManager.getHistoryRef(conversationId);
            if (history.length === 0) {
                return null;
            }
            index = history.length - 1; // 刚刚添加的用户消息
        }

        // BCP-01: 由消息索引反查稳定节点 ID
        const messageNodeId = await this.conversationManager.getMessageNodeIdAt(conversationId, index);
        return this.toStreamSummary(await this.checkpointManager.createCheckpoint(
            conversationId,
            index,
            'user_message',
            'after',
            { messageNodeId }
        ));
    }

    /**
     * 为模型消息创建检查点
     *
     * @param conversationId 对话 ID
     * @param position       位置：'before' | 'after'
     * @param iteration      当前迭代次数，仅在 position === 'before' 时使用
     */
    async createModelMessageCheckpoint(
        conversationId: string,
        position: 'before' | 'after',
        iteration?: number
    ): Promise<CheckpointRecord | null> {
        if (!this.checkpointManager || !this.settingsManager) {
            return null;
        }

        if (position === 'before') {
            if (!this.settingsManager.shouldCreateBeforeModelMessageCheckpoint()) {
                return null;
            }

            // 根据 modelOuterLayerOnly 设置决定是否在每次迭代都创建
            const outerLayerOnly = this.settingsManager.isModelOuterLayerOnly();
            if (outerLayerOnly && iteration !== 1) {
                // 仅在最外层模式下、第一次迭代创建
                return null;
            }

            const history = await this.conversationManager.getHistoryRef(conversationId);
            const index = history.length; // 模型消息将要插入的位置

            // BCP-01: before 存档挂到“即将写入”索引上，该位置通常尚无消息 → nodeId 缺省，不阻塞
            const messageNodeId = await this.conversationManager.getMessageNodeIdAt(conversationId, index);
            return this.toStreamSummary(await this.checkpointManager.createCheckpoint(
                conversationId,
                index,
                'model_message',
                'before',
                { messageNodeId }
            ));
        }

        // position === 'after'
        if (!this.settingsManager.shouldCreateAfterModelMessageCheckpoint()) {
            return null;
        }

        const history = await this.conversationManager.getHistoryRef(conversationId);
        if (history.length === 0) {
            return null;
        }
        const index = history.length - 1; // 刚刚添加的模型消息

        // BCP-01: 由消息索引反查稳定节点 ID
        const messageNodeId = await this.conversationManager.getMessageNodeIdAt(conversationId, index);
        return this.toStreamSummary(await this.checkpointManager.createCheckpoint(
            conversationId,
            index,
            'model_message',
            'after',
            { messageNodeId }
        ));
    }

    /**
     * 为工具执行创建检查点
     *
     * 这里不额外做开关判断，直接委托给 CheckpointManager，由其根据配置决定是否实际创建。
     *
     * BCP-01: 支持显式传 messageNodeId（调用方已知节点时）；未传时由当前消息索引反查
     * （工具执行所在的模型消息已在历史中，通常可解析到稳定节点 ID）。
     *
     * M7: 支持透传 progress 回调（可选用）；返回值按 M1 摘要化（不含 fileHashes/fileStats）。
     */
    async createToolExecutionCheckpoint(
        conversationId: string,
        messageIndex: number,
        toolName: string,
        phase: 'before' | 'after',
        messageNodeId?: string,
        options?: { progress?: (progress: CheckpointOperationProgress) => void }
    ): Promise<CheckpointRecord | null> {
        if (!this.checkpointManager) {
            return null;
        }
        // BCP-01: 未显式传 nodeId 时由索引反查（只读历史元数据，无副作用）
        const resolvedNodeId = messageNodeId
            ?? await this.conversationManager.getMessageNodeIdAt(conversationId, messageIndex);
        return this.toStreamSummary(await this.checkpointManager.createCheckpoint(
            conversationId,
            messageIndex,
            toolName,
            phase,
            {
                ...(options && options.progress ? { progress: options.progress } : {}),
                ...(resolvedNodeId ? { messageNodeId: resolvedNodeId } : {})
            }
        ));
    }

    /**
     * 删除指定索引及之后的所有检查点
     *
     * @param excludeCheckpointId 可选，保留该检查点（回档场景：支持反复回档到同一存档点）
     */
    async deleteCheckpointsFromIndex(
        conversationId: string,
        startIndex: number,
        excludeCheckpointId?: string
    ): Promise<void> {
        if (!this.checkpointManager) {
            return;
        }
        await this.checkpointManager.deleteCheckpointsFromIndex(conversationId, startIndex, excludeCheckpointId);
    }
}

