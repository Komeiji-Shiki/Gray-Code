import {
    agentMailbox,
    formatAgentMessagesForModel,
    MAIN_SESSION_RUN_ID,
} from '../../core/services/agentMailbox';
import { setStreamAbortManager } from '../../core/streamAbortBridge';
import { createChatFlowHarness } from '../__fixtures__/harnessFixtures';

describe('agent_message claim persistence boundary', () => {
    afterEach(() => {
        setStreamAbortManager(undefined);
        agentMailbox.clearAll();
    });

    test('等待旧流期间另一重试已写入并 ack 时，不会把同一 claim 再写入历史', async () => {
        agentMailbox.enqueueMainSessionSystemMessage({
            conversationId: 'conv_claim',
            messageId: 'background-task:bgagent_claim',
            fromRunId: 'run_claim',
            fromAgentName: 'researcher',
            text: '[Background task completed]\n\nResult: once only',
        });
        const claim = agentMailbox.claimMainSessionAgentMessages('conv_claim')!;
        const message = formatAgentMessagesForModel(claim.messages);

        const waitForOldStreamCompletion = jest.fn(async () => {
            // 模拟前一条已经在后端启动、但前端因切换会话返回 false 的请求：它在第二条
            // 重试等待旧流时完成 addMessage 并确认 claim。
            expect(agentMailbox.acknowledgeMessageClaim(
                'conv_claim',
                MAIN_SESSION_RUN_ID,
                claim.claimId,
            )).toBe(true);
        });
        setStreamAbortManager({ waitForOldStreamCompletion });

        const { flowService, conversationManager } = createChatFlowHarness();
        const outputs: any[] = [];
        for await (const output of flowService.handleChatStream({
            conversationId: 'conv_claim',
            configId: 'cfg-1',
            message,
            source: 'agent_message',
            agentMessageClaimId: claim.claimId,
        } as any)) {
            outputs.push(output);
        }

        expect(waitForOldStreamCompletion).toHaveBeenCalledWith('conv_claim', expect.any(Number));
        expect(outputs).toEqual([
            expect.objectContaining({
                conversationId: 'conv_claim',
                error: expect.objectContaining({ code: 'INVALID_AGENT_MESSAGE_CLAIM' }),
            }),
        ]);
        expect(conversationManager.addMessage).not.toHaveBeenCalled();
        expect(conversationManager.rejectAllPendingToolCalls).not.toHaveBeenCalled();
    });

    test('进入写入阶段后不能被另一页面退回，同一结果只写入一次', async () => {
        agentMailbox.enqueueMainSessionSystemMessage({
            conversationId: 'conv_delivery',
            messageId: 'background-task:bgagent_delivery',
            fromRunId: 'run_delivery',
            fromAgentName: 'researcher',
            text: '[Background task completed]\n\nResult: persist exactly once',
        });
        const claim = agentMailbox.claimMainSessionAgentMessages('conv_delivery')!;
        const message = formatAgentMessagesForModel(claim.messages);
        const { flowService, conversationManager, checkpointService } = createChatFlowHarness();

        checkpointService.createUserMessageCheckpoint.mockImplementationOnce(async () => {
            // 模拟 Webview 重载后的旧生命周期在后端已经通过最终校验后尝试退回。
            // 领取已处于“正在写入”状态，必须拒绝退回，否则下一次会重复领取。
            expect(agentMailbox.releaseMessageClaim(
                'conv_delivery',
                MAIN_SESSION_RUN_ID,
                claim.claimId,
            )).toBe(false);
            return null;
        });

        for await (const _output of flowService.handleChatStream({
            conversationId: 'conv_delivery',
            configId: 'cfg-1',
            message,
            source: 'agent_message',
            agentMessageClaimId: claim.claimId,
        } as any)) {
            // drain
        }

        expect(conversationManager.addMessage).toHaveBeenCalledTimes(1);
        expect(agentMailbox.getMessageClaim('conv_delivery', MAIN_SESSION_RUN_ID, claim.claimId)).toBeUndefined();

        const retryOutputs: any[] = [];
        for await (const output of flowService.handleChatStream({
            conversationId: 'conv_delivery',
            configId: 'cfg-1',
            message,
            source: 'agent_message',
            agentMessageClaimId: claim.claimId,
        } as any)) {
            retryOutputs.push(output);
        }
        expect(retryOutputs).toEqual([
            expect.objectContaining({
                error: expect.objectContaining({ code: 'INVALID_AGENT_MESSAGE_CLAIM' }),
            }),
        ]);
        expect(conversationManager.addMessage).toHaveBeenCalledTimes(1);
    });

    test('写入前失败会解除占用但保留领取，允许后续原样重试', async () => {
        agentMailbox.enqueueMainSessionSystemMessage({
            conversationId: 'conv_retry',
            messageId: 'background-task:bgagent_retry',
            fromRunId: 'run_retry',
            text: '[Background task completed]\n\nResult: retry after transient failure',
        });
        const claim = agentMailbox.claimMainSessionAgentMessages('conv_retry')!;
        const message = formatAgentMessagesForModel(claim.messages);
        const { flowService, conversationManager, checkpointService } = createChatFlowHarness();
        checkpointService.createUserMessageCheckpoint.mockRejectedValueOnce(new Error('checkpoint unavailable'));

        await expect((async () => {
            for await (const _output of flowService.handleChatStream({
                conversationId: 'conv_retry',
                configId: 'cfg-1',
                message,
                source: 'agent_message',
                agentMessageClaimId: claim.claimId,
            } as any)) {
                // drain
            }
        })()).rejects.toThrow('checkpoint unavailable');

        expect(conversationManager.addMessage).not.toHaveBeenCalled();
        expect(agentMailbox.hasMessageClaim('conv_retry', MAIN_SESSION_RUN_ID, claim.claimId)).toBe(true);
        // finally 已解除“正在写入”，所以同一领取可以再次进入写入阶段。
        expect(agentMailbox.beginMessageClaimDelivery('conv_retry', MAIN_SESSION_RUN_ID, claim.claimId)).toBe(true);
        expect(agentMailbox.endMessageClaimDelivery('conv_retry', MAIN_SESSION_RUN_ID, claim.claimId)).toBe(true);
    });
});
