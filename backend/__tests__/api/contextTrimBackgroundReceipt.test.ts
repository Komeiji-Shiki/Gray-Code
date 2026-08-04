/**
 * ContextTrimService 后台任务回执回合边界回归测试。
 *
 * 背景：后台子 Agent 完成结果曾作为普通 user 消息回流，被识别为新回合。
 * 当上一回合约 350k token 时，裁剪器会整体丢弃上一回合，只留下约 20k 的后台回执回合。
 */

import { ContextTrimService } from '../../modules/api/chat/services/ContextTrimService';
import type { Content } from '../../modules/conversation/types';

function createService(): ContextTrimService {
    return new ContextTrimService({} as any, {} as any, {} as any, {} as any);
}

describe('ContextTrimService.identifyRounds - background task receipt', () => {
    it('后台任务回执是原任务的异步延续，不创建新的裁剪回合', () => {
        const history: Content[] = [
            {
                role: 'user',
                parts: [{ text: '执行一个很长的任务' }],
                isUserInput: true
            },
            {
                role: 'model',
                parts: [{ text: '正在处理' }],
                usageMetadata: { totalTokenCount: 350000 }
            },
            {
                role: 'user',
                parts: [{ text: '[Background task completed]\nResult: ...' }],
                isUserInput: false,
                source: 'background_task'
            },
            {
                role: 'model',
                parts: [{ text: '已收到后台结果' }],
                usageMetadata: { totalTokenCount: 20000 }
            }
        ];

        const rounds = createService().identifyRounds(history);

        expect(rounds).toEqual([
            { startIndex: 0, endIndex: 4, tokenCount: 20000 }
        ]);
    });

    it('后续真实用户消息仍正常开始新回合，旧历史无 isUserInput 标记也兼容', () => {
        const history: Content[] = [
            { role: 'user', parts: [{ text: '旧历史用户消息' }] },
            { role: 'model', parts: [{ text: '旧回答' }] },
            { role: 'user', parts: [{ text: '后台结果' }], source: 'background_task' },
            { role: 'model', parts: [{ text: '后台结果总结' }] },
            { role: 'user', parts: [{ text: '新的真实问题' }], isUserInput: true },
            { role: 'model', parts: [{ text: '新回答' }] }
        ];

        const rounds = createService().identifyRounds(history);

        expect(rounds.map(round => [round.startIndex, round.endIndex])).toEqual([
            [0, 4],
            [4, 6]
        ]);
    });
});
