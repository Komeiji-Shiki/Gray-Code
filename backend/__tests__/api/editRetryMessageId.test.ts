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

import { ChatFlowService } from '../../modules/api/chat/services/ChatFlowService';
import { StreamAbortManager } from '../../../webview/stream/StreamAbortManager';
import type { Content } from '../../modules/conversation/types';

function createHarness() {
    const conversationManager = {
        getHistory: jest.fn().mockResolvedValue([]),
        getMessage: jest.fn().mockResolvedValue(undefined),
        getMessagesRaw: jest.fn().mockResolvedValue([]),
        getHistoryRef: jest.fn().mockResolvedValue([]),
        updateMessage: jest.fn().mockResolvedValue(undefined),
        deleteToMessage: jest.fn().mockResolvedValue(0),
        deleteMessagesInRange: jest.fn().mockResolvedValue(undefined),
        getCustomMetadata: jest.fn().mockResolvedValue(undefined),
        setCustomMetadata: jest.fn().mockResolvedValue(undefined),
        rejectAllPendingToolCalls: jest.fn().mockResolvedValue(undefined),
        addContent: jest.fn().mockResolvedValue(undefined),
        settleFunctionResponses: jest.fn().mockResolvedValue(undefined),
        getMessageNodeIdAt: jest.fn().mockResolvedValue(undefined),
        updateMessagesBatch: jest.fn().mockResolvedValue(undefined),
    };
    const configManager = {
        getConfig: jest.fn().mockResolvedValue({
            enabled: true,
            type: 'custom',
            toolMode: 'function_call',
            model: 'test-model',
        }),
    };
    const diffInterruptService = {
        markUserInterrupt: jest.fn(),
        cancelAllPending: jest.fn().mockResolvedValue(undefined),
        resetUserInterrupt: jest.fn(),
    };
    const checkpointService = {
        deleteCheckpointsFromIndex: jest.fn().mockResolvedValue(undefined),
        createUserMessageCheckpoint: jest.fn().mockResolvedValue(null),
    };
    const toolIterationLoopService = {
        clearTrimState: jest.fn().mockResolvedValue(undefined),
        runNonStreamLoop: jest.fn().mockResolvedValue({
            content: { role: 'model' as const, parts: [{ text: 'ok' }] },
            exceededMaxIterations: false,
        }),
        runToolLoop: jest.fn().mockReturnValue((async function* () { })()),
    };
    const messageBuilderService = {
        buildUserMessageParts: jest.fn().mockReturnValue([{ text: 'edited' }]),
    };
    const flowService = new ChatFlowService(
        configManager as never,
        conversationManager as never,
        undefined as never,
        messageBuilderService as never,
        {} as never,
        toolIterationLoopService as never,
        checkpointService as never,
        diffInterruptService as never,
        {} as never,
        {} as never,
    );
    return { flowService, conversationManager, toolIterationLoopService };
}

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

describe('M1：编辑/删除接口消息索引 id 校验', () => {
    beforeEach(() => {
        // 避免其他测试注册的全局 abort manager 影响本测试（H1 等待退化为 no-op）
        StreamAbortManager.setGlobalInstance(undefined);
    });

    describe('handleEditAndRetry（非流式）', () => {
        it('不带 messageId 时保持旧行为（兼容旧前端）', async () => {
            const { flowService, conversationManager, toolIterationLoopService } = createHarness();
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

        it('携带匹配 messageId 时正常继续', async () => {
            const { flowService, conversationManager } = createHarness();
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

        it('携带不匹配 messageId 时返回 MESSAGE_CHANGED，不执行任何历史变更', async () => {
            const { flowService, conversationManager } = createHarness();
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
        it('携带不匹配 messageId 时 yield MESSAGE_CHANGED 错误 chunk', async () => {
            const { flowService, conversationManager } = createHarness();
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

        it('携带匹配 messageId 时正常继续', async () => {
            const { flowService, conversationManager } = createHarness();
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

        it('不带 messageId 时保持旧行为（兼容旧前端）', async () => {
            const { flowService, conversationManager } = createHarness();
            conversationManager.getMessagesRaw.mockResolvedValue(history);

            const result = await flowService.handleDeleteToMessage({ conversationId: 'c1', targetIndex: 2 });

            expect(result).toEqual({ success: true, deletedCount: 0 });
            expect(conversationManager.deleteToMessage).toHaveBeenCalledWith('c1', 2);
        });

        it('携带匹配 messageId 时正常删除', async () => {
            const { flowService, conversationManager } = createHarness();
            conversationManager.getMessagesRaw.mockResolvedValue(history);

            const result = await flowService.handleDeleteToMessage({
                conversationId: 'c1',
                targetIndex: 2,
                // 注意：DeleteToMessageRequestData 未声明 messageId（types.ts 仅允许为
                // EditAndRetryRequestData 增加该字段），实现侧按可选读取；测试经断言透传。
                messageId: 'u1',
            } as never);

            expect(result.success).toBe(true);
            expect(conversationManager.deleteToMessage).toHaveBeenCalledWith('c1', 2);
        });

        it('携带不匹配 messageId 时返回 MESSAGE_CHANGED，不执行删除', async () => {
            const { flowService, conversationManager } = createHarness();
            conversationManager.getMessagesRaw.mockResolvedValue(history);

            const result = await flowService.handleDeleteToMessage({
                conversationId: 'c1',
                targetIndex: 2,
                messageId: 'u1-drifted',
            } as never);

            expect(result).toEqual({
                success: false,
                error: { code: 'MESSAGE_CHANGED', message: expect.any(String) },
            });
            expect(conversationManager.deleteToMessage).not.toHaveBeenCalled();
            expect(conversationManager.setCustomMetadata).not.toHaveBeenCalled();
        });
    });
});
