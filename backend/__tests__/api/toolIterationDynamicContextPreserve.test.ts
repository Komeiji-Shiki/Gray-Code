import { ToolIterationLoopService } from '../../modules/api/chat/services/ToolIterationLoopService';
import type { Content } from '../../modules/conversation/types';
import { serializePromptContextCache } from '../../modules/prompt/promptContextCache';

/**
 * preserve 历史锚定回归测试。
 *
 * 背景：preserveHistoricalTurnDynamicContexts 曾是空实现（无副作用），已删除；
 * 保留的「preserve 跨回合差分」行为由 createTurnDynamicContext 承担：
 * - preserve 策略：从历史读取上一回合缓存作为 diffBase 传给 PromptManager（差分省略相同 section），
 *   且绝不修改历史消息或触发任何持久化（快照只随新用户消息一次性落盘）；
 * - single 策略：不读历史基准（getHistoryRef 不被调用），始终全量生成。
 */
function createDynamicContextCache(text: string, sectionValues?: Record<string, string>): string {
    return serializePromptContextCache({
        messages: [{ role: 'user', parts: [{ text }] }],
        dynamicSnapshotMessages: [{ role: 'user', parts: [{ text }] }],
        text,
        dynamicSnapshotText: text,
        ...(sectionValues ? { sectionValues } : {})
    });
}

function createService(history: Content[]) {
    const conversationManager = {
        getHistoryRef: jest.fn().mockResolvedValue(history),
        getCustomMetadata: jest.fn().mockResolvedValue(undefined),
        updateMessagesBatch: jest.fn()
    };
    const promptManager = {
        getPromptContextBundle: jest.fn().mockReturnValue({
            beforeHistoryMessages: [],
            afterHistoryMessages: [],
            messages: [],
            dynamicSnapshotMessages: [],
            text: 'bundle text',
            historyPlacement: 'entry'
        })
    };
    const service = new ToolIterationLoopService(
        {} as any,
        conversationManager as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
    );
    service.setPromptManager(promptManager as never);

    return { service, conversationManager, promptManager };
}

describe('ToolIterationLoopService preserve 策略差分基准（createTurnDynamicContext）', () => {
    it('preserve：从历史读取上一回合缓存作为 diffBase，且不修改任何历史消息或持久化字段', async () => {
        const history: Content[] = [
            {
                id: 'user-1',
                role: 'user',
                isUserInput: true,
                turnDynamicContext: createDynamicContextCache('old ctx 1', { TODO_LIST: 'task A' }),
                turnDynamicContextStrategy: 'single',
                parts: [{ text: 'old user 1' }]
            },
            {
                id: 'user-2',
                role: 'user',
                isUserInput: true,
                turnDynamicContext: createDynamicContextCache('current ctx'),
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'current user' }]
            }
        ];
        const { service, conversationManager, promptManager } = createService(history);

        await service.createTurnDynamicContext('conv-1', 'user-2', undefined, 'preserve');

        // 差分基准来自上一回合缓存（sectionValues 完整传入），当前回合消息自身被跳过
        expect(promptManager.getPromptContextBundle).toHaveBeenCalledWith(
            undefined,
            expect.anything(),
            expect.objectContaining({
                diffBase: expect.objectContaining({ sectionValues: { TODO_LIST: 'task A' } })
            })
        );
        // 无副作用：历史消息原样保留，不触发任何持久化写入
        expect(history[0].turnDynamicContextStrategy).toBe('single');
        expect(history[1].turnDynamicContextStrategy).toBe('preserve');
        expect(conversationManager.updateMessagesBatch).not.toHaveBeenCalled();
    });

    it('preserve：历史缓存无 sectionValues（旧缓存）时 diffBase 为 undefined，退化为全量发送', async () => {
        const history: Content[] = [
            {
                id: 'user-1',
                role: 'user',
                isUserInput: true,
                turnDynamicContext: createDynamicContextCache('old ctx'),
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'old user' }]
            },
            {
                id: 'user-2',
                role: 'user',
                isUserInput: true,
                turnDynamicContext: createDynamicContextCache('current ctx'),
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'current user' }]
            }
        ];
        const { service, conversationManager, promptManager } = createService(history);

        await service.createTurnDynamicContext('conv-1', 'user-2', undefined, 'preserve');

        // 旧缓存无 section 级数据：不传 diffBase（全量发送），仍不持久化
        expect(promptManager.getPromptContextBundle).toHaveBeenCalledWith(
            undefined,
            expect.anything(),
            undefined
        );
        expect(conversationManager.updateMessagesBatch).not.toHaveBeenCalled();
    });

    it('single：不读取历史基准（getHistoryRef 不被调用），始终全量生成', async () => {
        const history: Content[] = [
            {
                id: 'user-1',
                role: 'user',
                isUserInput: true,
                turnDynamicContext: createDynamicContextCache('old ctx'),
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'old user' }]
            },
            {
                id: 'user-2',
                role: 'user',
                isUserInput: true,
                turnDynamicContext: createDynamicContextCache('current ctx'),
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'current user' }]
            }
        ];
        const { service, conversationManager, promptManager } = createService(history);

        await service.createTurnDynamicContext('conv-1', 'user-2', undefined, 'single');

        expect(promptManager.getPromptContextBundle).toHaveBeenCalledWith(
            undefined,
            expect.anything(),
            undefined
        );
        // single 分支不读历史基准
        expect(conversationManager.getHistoryRef).not.toHaveBeenCalled();
        expect(conversationManager.updateMessagesBatch).not.toHaveBeenCalled();
    });
});
