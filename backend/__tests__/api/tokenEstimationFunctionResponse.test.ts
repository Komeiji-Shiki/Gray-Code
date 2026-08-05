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
    it('不把不会发送给模型的 diff 与 SubAgent UI 元数据计入裁剪预算', () => {
        const service = createService();
        const visibleResponse = {
            success: true,
            data: { response: '审核完成' }
        };
        const responseWithInternalMetadata = {
            success: true,
            diffContentId: 'blob-id',
            diffs: 'x'.repeat(100_000),
            data: {
                response: '审核完成',
                channelName: 'internal-channel',
                modelId: 'internal-model',
                steps: 999,
                pendingDiffId: 'pending-id'
            }
        };

        expect(service.estimateMessageTokens(functionResponseMessage(responseWithInternalMetadata)))
            .toBe(service.estimateMessageTokens(functionResponseMessage(visibleResponse)));
    });
});
