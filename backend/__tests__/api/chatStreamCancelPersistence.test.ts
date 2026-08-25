/**
 * 回归测试：handleChatStream 生成器在用户消息落库之前被终止时，
 * 用户消息仍必须落库且携带前端传入的稳定节点 id（BR-01）。
 *
 * 背景（用户实测）：新对话发送首条消息后取消/关闭视图，前端窗口保留乐观插入的消息，
 * 但后端生成器在「before checkpoint chunk」yield 处被消费端 break（视图关闭/重载）
 * 触发的 return() 终结，addMessage 从未执行——主历史缺消息，随后编辑/重试按前端 id
 * 定位报 NODE_NOT_FOUND。
 *
 * 修复前（yield 在 addMessage 之前）：本测试断言失败；
 * 修复后（yield 移到 addMessage 之后）：本测试通过。
 */

import { StreamAbortManager } from '../../../webview/stream/StreamAbortManager';
import { createChatFlowHarness } from '../__fixtures__/harnessFixtures';

describe('chatStream 中途终止时用户消息必须落库', () => {
    beforeEach(() => {
        // 避免其他测试注册的全局 abort manager 影响本测试（H1 等待退化为 no-op）
        StreamAbortManager.setGlobalInstance(undefined);
    });

    test('消费端在 before checkpoint chunk 后终止生成器，用户消息仍落库且携带前端 id', async () => {
        const { flowService, conversationManager, checkpointService } = createChatFlowHarness();
        // before 存档点返回非 null：触发 checkpoints yield（修复前这是危险 yield 点）
        checkpointService.createUserMessageCheckpoint.mockResolvedValue({
            id: 'ck-before',
            toolName: 'user_message',
            phase: 'before',
            timestamp: 1,
            conversationId: 'c1',
        } as never);

        const frontendMessageId = '1787673106788_v0u214u8c';
        const stream = flowService.handleChatStream({
            conversationId: 'c1',
            configId: 'cfg-1',
            message: '你好',
            messageId: frontendMessageId,
        } as never);

        // 消费第一个 chunk 后主动终止生成器——等价于 StreamChunkProcessor.consume 在
        // 视图不可达时 break（for-await 提前退出会对生成器调用 return()）。
        const first = await stream.next();
        expect((first.value as { checkpointOnly?: boolean })?.checkpointOnly).toBe(true);
        await stream.return?.(undefined as never);

        // 用户消息必须已落库，且 id 是前端传入的稳定 id（BR-01：编辑/重试按 id 定位的前提）
        expect(conversationManager.addMessage).toHaveBeenCalledWith(
            'c1',
            'user',
            expect.any(Array),
            expect.objectContaining({ isUserInput: true }),
            frontendMessageId,
        );
    });

    test('正常消费到结束：checkpoint chunk 在用户消息落库之后送出', async () => {
        const { flowService, conversationManager, checkpointService } = createChatFlowHarness();
        checkpointService.createUserMessageCheckpoint.mockImplementation(
            async (_cid: string, phase: 'before' | 'after') => ({
                id: `ck-${phase}`,
                toolName: 'user_message',
                phase,
                timestamp: 1,
                conversationId: 'c1',
            } as never),
        );

        const stream = flowService.handleChatStream({
            conversationId: 'c1',
            configId: 'cfg-1',
            message: '你好',
            messageId: 'u-frontend-1',
        } as never);

        const chunks: Array<Record<string, unknown>> = [];
        for await (const chunk of stream) {
            chunks.push(chunk as unknown as Record<string, unknown>);
        }

        // 两个 checkpoint chunk 都按序送出（before 先、after 后）
        const checkpointChunks = chunks.filter(c => c.checkpointOnly === true);
        expect(checkpointChunks).toHaveLength(2);
        expect((checkpointChunks[0].checkpoints as Array<{ id: string }>)[0].id).toBe('ck-before');
        expect((checkpointChunks[1].checkpoints as Array<{ id: string }>)[0].id).toBe('ck-after');

        expect(conversationManager.addMessage).toHaveBeenCalledWith(
            'c1',
            'user',
            expect.any(Array),
            expect.anything(),
            'u-frontend-1',
        );
    });
});
