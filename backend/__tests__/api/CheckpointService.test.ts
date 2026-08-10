/**
 * BCP-01 测试：CheckpointService 由消息索引反查 messageNodeId 并透传给 CheckpointManager。
 *
 * 覆盖：
 * - createUserMessageCheckpoint（before/after）：由最终确定的 index 反查 nodeId；
 * - createModelMessageCheckpoint（before/after）：同上；
 * - createToolExecutionCheckpoint：显式 nodeId 优先；未传时内部反查；
 *   反查不到（旧历史/越界索引）时 manager 收到空 options（无 messageNodeId 键，兼容旧行为）。
 */

import { CheckpointService } from '../../modules/api/chat/services/CheckpointService';
import type { CheckpointManager } from '../../modules/checkpoint/CheckpointManager';
import type { CheckpointRecord } from '../../modules/checkpoint/CheckpointManager';
import type { ConversationManager } from '../../modules/conversation/ConversationManager';
import { makeRecord } from '../__fixtures__/checkpointFixtures';

interface Harness {
    service: CheckpointService;
    checkpointManager: { createCheckpoint: jest.Mock };
    conversationManager: {
        getHistoryRef: jest.Mock;
        getMessageNodeIdAt: jest.Mock;
    };
}

function createHarness(): Harness {
    const checkpointManager = {
        createCheckpoint: jest.fn().mockImplementation(
            async (
                conversationId: string,
                messageIndex: number,
                toolName: string,
                phase: 'before' | 'after',
                options?: { messageNodeId?: string }
            ) =>
                makeRecord({ conversationId, messageIndex, toolName, phase, messageNodeId: options?.messageNodeId })
        )
    };
    const conversationManager = {
        getHistoryRef: jest.fn().mockResolvedValue([]),
        getMessageNodeIdAt: jest.fn().mockResolvedValue(undefined)
    };
    const settingsManager = {
        shouldCreateBeforeUserMessageCheckpoint: jest.fn().mockReturnValue(true),
        shouldCreateAfterUserMessageCheckpoint: jest.fn().mockReturnValue(true),
        shouldCreateBeforeModelMessageCheckpoint: jest.fn().mockReturnValue(true),
        shouldCreateAfterModelMessageCheckpoint: jest.fn().mockReturnValue(true),
        isModelOuterLayerOnly: jest.fn().mockReturnValue(false)
    };
    const service = new CheckpointService(
        conversationManager as unknown as ConversationManager,
        checkpointManager as unknown as CheckpointManager,
        settingsManager as any
    );
    return { service, checkpointManager, conversationManager };
}

describe('BCP-01: CheckpointService 反查并透传 messageNodeId', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('createUserMessageCheckpoint(after)：由最后一条消息索引反查 nodeId 并透传', async () => {
        const { service, checkpointManager, conversationManager } = createHarness();
        conversationManager.getHistoryRef.mockResolvedValue([{ role: 'user' }, { role: 'model' }]);
        conversationManager.getMessageNodeIdAt.mockResolvedValue('node-user');

        const result = await service.createUserMessageCheckpoint('conv-1', 'after');

        expect(conversationManager.getMessageNodeIdAt).toHaveBeenCalledWith('conv-1', 1);
        expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith(
            'conv-1', 1, 'user_message', 'after', { messageNodeId: 'node-user' }
        );
        expect(result?.messageNodeId).toBe('node-user');
        expect(result?.messageIndex).toBe(1);
    });

    test('createUserMessageCheckpoint(before)：显式 messageIndex 时按该索引反查（编辑场景）', async () => {
        const { service, checkpointManager, conversationManager } = createHarness();
        conversationManager.getMessageNodeIdAt.mockResolvedValue('node-edit');

        const result = await service.createUserMessageCheckpoint('conv-1', 'before', 5);

        expect(conversationManager.getMessageNodeIdAt).toHaveBeenCalledWith('conv-1', 5);
        expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith(
            'conv-1', 5, 'user_message', 'before', { messageNodeId: 'node-edit' }
        );
        expect(result?.messageNodeId).toBe('node-edit');
    });

    test('createModelMessageCheckpoint(after)：由最后一条模型消息索引反查并透传', async () => {
        const { service, checkpointManager, conversationManager } = createHarness();
        conversationManager.getHistoryRef.mockResolvedValue([{ role: 'user' }, { role: 'model' }]);
        conversationManager.getMessageNodeIdAt.mockResolvedValue('node-model');

        const result = await service.createModelMessageCheckpoint('conv-1', 'after');

        expect(conversationManager.getMessageNodeIdAt).toHaveBeenCalledWith('conv-1', 1);
        expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith(
            'conv-1', 1, 'model_message', 'after', { messageNodeId: 'node-model' }
        );
        expect(result?.messageNodeId).toBe('node-model');
    });

    test('createModelMessageCheckpoint(before)：反查不到（即将插入位置无消息）时 nodeId 缺省，不阻塞', async () => {
        const { service, checkpointManager, conversationManager } = createHarness();
        conversationManager.getHistoryRef.mockResolvedValue([{ role: 'user' }]);
        conversationManager.getMessageNodeIdAt.mockResolvedValue(undefined);

        const result = await service.createModelMessageCheckpoint('conv-1', 'before');

        // index = history.length（2 不存在），反查返回 undefined → options 携带 messageNodeId: undefined
        expect(conversationManager.getMessageNodeIdAt).toHaveBeenCalledWith('conv-1', 1);
        expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith(
            'conv-1', 1, 'model_message', 'before', { messageNodeId: undefined }
        );
        expect(result).not.toBeNull();
        expect(result?.messageNodeId).toBeUndefined();
    });

    test('createToolExecutionCheckpoint：显式 messageNodeId 优先，不再反查', async () => {
        const { service, checkpointManager, conversationManager } = createHarness();

        const result = await service.createToolExecutionCheckpoint(
            'conv-1', 2, 'write_file', 'before', 'node-explicit'
        );

        expect(conversationManager.getMessageNodeIdAt).not.toHaveBeenCalled();
        expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith(
            'conv-1', 2, 'write_file', 'before', { messageNodeId: 'node-explicit' }
        );
        expect(result?.messageNodeId).toBe('node-explicit');
    });

    test('createToolExecutionCheckpoint：未传 nodeId 时由消息索引反查', async () => {
        const { service, checkpointManager, conversationManager } = createHarness();
        conversationManager.getMessageNodeIdAt.mockResolvedValue('node-tool');

        const result = await service.createToolExecutionCheckpoint('conv-1', 2, 'write_file', 'after');

        expect(conversationManager.getMessageNodeIdAt).toHaveBeenCalledWith('conv-1', 2);
        expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith(
            'conv-1', 2, 'write_file', 'after', { messageNodeId: 'node-tool' }
        );
        expect(result?.messageNodeId).toBe('node-tool');
    });

    test('createToolExecutionCheckpoint：反查不到（旧历史/越界）→ manager 收到空 options，兼容旧行为', async () => {
        const { service, checkpointManager, conversationManager } = createHarness();
        conversationManager.getMessageNodeIdAt.mockResolvedValue(undefined);

        const result = await service.createToolExecutionCheckpoint('conv-1', 2, 'write_file', 'after');

        expect(conversationManager.getMessageNodeIdAt).toHaveBeenCalledWith('conv-1', 2);
        expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith(
            'conv-1', 2, 'write_file', 'after', {}
        );
        expect(result).not.toBeNull();
        expect(result?.messageNodeId).toBeUndefined();
    });

    test('progress 回调与 messageNodeId 可同时透传', async () => {
        const { service, checkpointManager, conversationManager } = createHarness();
        conversationManager.getMessageNodeIdAt.mockResolvedValue('node-progress');
        const progress = jest.fn();

        await service.createToolExecutionCheckpoint('conv-1', 2, 'write_file', 'before', undefined, { progress });

        expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith(
            'conv-1', 2, 'write_file', 'before', { progress, messageNodeId: 'node-progress' }
        );
    });
});
