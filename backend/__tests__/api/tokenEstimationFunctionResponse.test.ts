import { TokenEstimationService } from '../../modules/api/chat/services/TokenEstimationService';
import type { Content } from '../../modules/conversation/types';

function createService(): TokenEstimationService {
    return new TokenEstimationService({} as any, {} as any);
}

function functionResponseMessage(response: Record<string, unknown>): Content {
    return {
        role: 'user',
        isFunctionResponse: true,
        parts: [{
            functionResponse: {
                id: 'fc-subagent',
                name: 'subagents',
                response
            }
        }]
    };
}

describe('TokenEstimationService functionResponse API parity', () => {
    it('不把不会发送给模型的 diff 与 SubAgent UI 元数据计入裁剪预算（steps/toolsUsed 保留）', () => {
        const service = createService();
        const visibleResponse = {
            success: true,
            data: { response: '审核完成' }
        };
        // 仍被剥离：diff/pendingDiffId/channelName/modelId（纯 UI 元数据）
        const responseWithInternalMetadata = {
            success: true,
            diffContentId: 'blob-id',
            diffs: 'x'.repeat(100_000),
            data: {
                response: '审核完成',
                channelName: 'internal-channel',
                modelId: 'internal-model',
                pendingDiffId: 'pending-id'
            }
        };

        expect(service.estimateMessageTokens(functionResponseMessage(responseWithInternalMetadata)))
            .toBe(service.estimateMessageTokens(functionResponseMessage(visibleResponse)));
    });

    it('steps / toolsUsed 保留给 AI 后计入裁剪预算', () => {
        const service = createService();
        const base = {
            success: true,
            data: { response: '审核完成' }
        };
        const withToolUsage = {
            success: true,
            data: {
                response: '审核完成',
                steps: 0,
                toolsUsed: []
            }
        };
        const withTools = {
            success: true,
            data: {
                response: '审核完成',
                steps: 3,
                toolsUsed: ['read_file', 'search_in_files']
            }
        };

        // 工具使用信息现在发给 AI，token 估算应随之增加
        expect(service.estimateMessageTokens(functionResponseMessage(withToolUsage)))
            .toBeGreaterThan(service.estimateMessageTokens(functionResponseMessage(base)));
        expect(service.estimateMessageTokens(functionResponseMessage(withTools)))
            .toBeGreaterThan(service.estimateMessageTokens(functionResponseMessage(withToolUsage)));
    });
});
