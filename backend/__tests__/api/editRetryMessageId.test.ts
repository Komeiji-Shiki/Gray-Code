/**
 * M1：编辑/删除接口消息索引 id 校验（messageId 防索引漂移）回归测试。
 *
 * 覆盖：
 * 1. handleEditAndRetry / handleEditAndRetryStream 携带 messageId 且索引处消息 id 一致 →
 *    正常继续（不校验旧行为回归：不带 messageId 仍按旧行为操作）；
 * 2. 携带 messageId 但索引处消息 id 不一致（索引漂移）→ 返回 MESSAGE_CHANGED 且不执行
 *    任何历史变更；
 * 3. handleDeleteToMessage 相同语义（messageId 为可选字段，旧前端不带时保持旧行为）。
 */

import { StreamAbortManager } from '../../../webview/stream/StreamAbortManager';
import { ConversationManager, MemoryStorageAdapter } from '../../modules/conversation';
import type { Content } from '../../modules/conversation/types';
import { createChatFlowHarness } from '../__fixtures__/harnessFixtures';


/** 读取流式生成器输出数组中的错误码 */
function collectStreamErrors(stream: AsyncGenerator<unknown>): Promise<Array<{ code?: string }>> {
    return (async () => {
        const errors: Array<{ code?: string }> = [];
        for await (const output of stream) {
            const error = (output as { error?: { code?: string } })?.error;
            if (error) {
                errors.push(error);
            }
        }
        return errors;
    })();
}

const targetUserMessage: Content = {
    id: 'u1',
    role: 'user',
    parts: [{ text: 'original question' }],
    isUserInput: true,
};

describe('编辑/删除接口消息索引 id 校验', () => {
    beforeEach(() => {
        // 避免其他测试注册的全局 abort manager 影响本测试（H1 等待退化为 no-op）
        StreamAbortManager.setGlobalInstance(undefined);
    });

    describe('handleEditAndRetry（非流式）', () => {
        test('不带 messageId 时保持旧行为（兼容旧前端）', async () => {
            const { flowService, conversationManager, toolIterationLoopService } = createChatFlowHarness();
            conversationManager.getMessage.mockResolvedValue(targetUserMessage);

            const result = await flowService.handleEditAndRetry({
                conversationId: 'c1',
                messageIndex: 0,
                newMessage: 'edited',
                configId: 'cfg-1',
            });

            expect(result.success).toBe(true);
            expect(conversationManager.updateMessage).toHaveBeenCalled();
            expect(toolIterationLoopService.runNonStreamLoop).toHaveBeenCalled();
        });

        test('携带匹配 messageId 时正常继续', async () => {
            const { flowService, conversationManager } = createChatFlowHarness();
            conversationManager.getMessage.mockResolvedValue(targetUserMessage);

            const result = await flowService.handleEditAndRetry({
                conversationId: 'c1',
                messageIndex: 0,
                newMessage: 'edited',
                configId: 'cfg-1',
                messageId: 'u1',
            });

            expect(result.success).toBe(true);
            expect(conversationManager.updateMessage).toHaveBeenCalled();
        });

        test('携带不匹配 messageId 时返回 MESSAGE_CHANGED，不执行任何历史变更', async () => {
            const { flowService, conversationManager } = createChatFlowHarness();
            conversationManager.getMessage.mockResolvedValue(targetUserMessage);

            const result = await flowService.handleEditAndRetry({
                conversationId: 'c1',
                messageIndex: 0,
                newMessage: 'edited',
                configId: 'cfg-1',
                // 索引漂移：前端记录的 id 与索引处实际消息不一致
                messageId: 'u1-drifted',
            });

            expect(result).toEqual({
                success: false,
                error: { code: 'MESSAGE_CHANGED', message: expect.any(String) },
            });
            expect(conversationManager.updateMessage).not.toHaveBeenCalled();
            expect(conversationManager.deleteToMessage).not.toHaveBeenCalled();
        });
    });

    describe('handleEditAndRetryStream（流式）', () => {
        test('携带不匹配 messageId 时 yield MESSAGE_CHANGED 错误 chunk', async () => {
            const { flowService, conversationManager } = createChatFlowHarness();
            conversationManager.getMessage.mockResolvedValue(targetUserMessage);

            const errors = await collectStreamErrors(flowService.handleEditAndRetryStream({
                conversationId: 'c1',
                messageIndex: 0,
                newMessage: 'edited',
                configId: 'cfg-1',
                messageId: 'u1-drifted',
            }));

            expect(errors).toEqual([{ code: 'MESSAGE_CHANGED', message: expect.any(String) }]);
            expect(conversationManager.updateMessage).not.toHaveBeenCalled();
            expect(conversationManager.deleteToMessage).not.toHaveBeenCalled();
        });

        test('携带匹配 messageId 时正常继续', async () => {
            const { flowService, conversationManager } = createChatFlowHarness();
            conversationManager.getMessage.mockResolvedValue(targetUserMessage);

            const outputs: unknown[] = [];
            for await (const output of flowService.handleEditAndRetryStream({
                conversationId: 'c1',
                messageIndex: 0,
                newMessage: 'edited',
                configId: 'cfg-1',
                messageId: 'u1',
            })) {
                outputs.push(output);
            }

            expect(conversationManager.updateMessage).toHaveBeenCalled();
        });
    });

    describe('handleDeleteToMessage', () => {
        const history = [
            { id: 'u0', role: 'user', parts: [{ text: 'q0' }] },
            { id: 'm0', role: 'model', parts: [{ text: 'a0' }] },
            { id: 'u1', role: 'user', parts: [{ text: 'q1' }] },
            { id: 'm1', role: 'model', parts: [{ text: 'a1' }] },
        ] as Content[];

        test('不带 messageId 时保持旧行为（兼容旧前端）', async () => {
            const { flowService, conversationManager } = createChatFlowHarness();
            conversationManager.getMessagesRaw.mockResolvedValue(history);

            const result = await flowService.handleDeleteToMessage({ conversationId: 'c1', targetIndex: 2 });

            expect(result).toEqual({ success: true, deletedCount: 0 });
            expect(conversationManager.deleteToMessage).toHaveBeenCalledWith(
                'c1', 2, undefined, { deletedMessageIds: [] }
            );
        });

        test('携带匹配 messageId 时正常删除', async () => {
            const { flowService, conversationManager, checkpointService } = createChatFlowHarness();
            conversationManager.getMessagesRaw.mockResolvedValue(history);
            conversationManager.deleteToMessage.mockImplementation(async (
                _conversationId: string,
                targetIndex: number,
                _expectedMessageId?: string,
                capture?: { deletedMessageIds: string[] },
            ) => {
                if (capture) capture.deletedMessageIds = history.slice(targetIndex).map(message => message.id!);
                return history.length - targetIndex;
            });

            const result = await flowService.handleDeleteToMessage({
                conversationId: 'c1',
                targetIndex: 2,
                messageId: 'u1',
            });

            expect(result.success).toBe(true);
            expect(conversationManager.deleteToMessage).toHaveBeenCalledWith(
                'c1', 2, 'u1', { deletedMessageIds: ['u1', 'm1'] }
            );
            expect(checkpointService.deleteCheckpointsFromIndex).toHaveBeenCalledWith(
                'c1', 2, undefined, new Set(['u1', 'm1'])
            );
        });

        test('预检快照返回前发生前序删除时，锁内 messageId 校验拒绝漂移且不提交清理副作用', async () => {
            const storage = new MemoryStorageAdapter();
            const realManager = new ConversationManager(storage);
            await realManager.createConversation('c1', 'race');
            await storage.saveHistory('c1', history);

            const { flowService, conversationManager, checkpointService, diffInterruptService } = createChatFlowHarness();
            let firstRead = true;
            conversationManager.getMessagesRaw.mockImplementation(async (conversationId: string) => {
                const staleSnapshot = await realManager.getMessagesRaw(conversationId);
                if (firstRead) {
                    firstRead = false;
                    // 在预检取得快照后、快照交给编排层前提交另一写操作：u1 从 index 2
                    // 漂移到 index 1。编排层会基于旧快照通过预检，但 manager 锁内必须拒绝。
                    await realManager.deleteMessage(conversationId, 0);
                }
                return staleSnapshot;
            });
            conversationManager.deleteToMessage.mockImplementation(
                (
                    conversationId: string,
                    targetIndex: number,
                    expectedMessageId?: string,
                    capture?: { deletedMessageIds: string[] },
                ) => realManager.deleteToMessage(conversationId, targetIndex, expectedMessageId, capture)
            );

            const result = await flowService.handleDeleteToMessage({
                conversationId: 'c1',
                targetIndex: 2,
                messageId: 'u1',
            });

            expect(result).toEqual({
                success: false,
                error: { code: 'MESSAGE_CHANGED', message: expect.any(String) },
            });
            // 只保留竞态写入本身的效果；若仍按旧 index 2 截断，m1 会被错误删除。
            expect((await realManager.getMessagesRaw('c1')).map(message => message.id))
                .toEqual(['m0', 'u1', 'm1']);
            expect(conversationManager.deleteToMessage).toHaveBeenCalledWith(
                'c1', 2, 'u1', { deletedMessageIds: [] }
            );
            expect(diffInterruptService.markUserInterrupt).not.toHaveBeenCalled();
            expect(diffInterruptService.cancelAllPending).not.toHaveBeenCalled();
            expect(diffInterruptService.resetUserInterrupt).not.toHaveBeenCalled();
            expect(conversationManager.rejectAllPendingToolCalls).not.toHaveBeenCalled();
            expect(checkpointService.deleteCheckpointsFromIndex).not.toHaveBeenCalled();
        });

        test('历史截断提交后 metadata 失效写入失败不伪装成删除失败', async () => {
            const storage = new MemoryStorageAdapter();
            const realManager = new ConversationManager(storage);
            await realManager.createConversation('c_metadata', 'metadata failure');
            await storage.saveHistory('c_metadata', history);
            jest.spyOn(realManager as any, 'invalidateContextManagementState')
                .mockRejectedValueOnce(new Error('metadata disk failure'));

            await expect(realManager.deleteToMessage('c_metadata', 2, 'u1'))
                .resolves.toBe(2);
            expect((await realManager.getMessagesRaw('c_metadata')).map(message => message.id))
                .toEqual(['u0', 'm0']);
        });

        test('携带不匹配 messageId 时返回 MESSAGE_CHANGED，不执行删除', async () => {
            const { flowService, conversationManager } = createChatFlowHarness();
            conversationManager.getMessagesRaw.mockResolvedValue(history);

            const result = await flowService.handleDeleteToMessage({
                conversationId: 'c1',
                targetIndex: 2,
                messageId: 'u1-drifted',
            });

            expect(result).toEqual({
                success: false,
                error: { code: 'MESSAGE_CHANGED', message: expect.any(String) },
            });
            expect(conversationManager.deleteToMessage).not.toHaveBeenCalled();
            expect(conversationManager.setCustomMetadata).not.toHaveBeenCalled();
        });
    });
});
