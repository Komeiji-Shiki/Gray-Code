/**
 * R7a H1-4：子代理发给子模型的 history 剥离已投递 agentInbox（防重放）——单元测试。
 *
 * 覆盖 stripReplayedAgentInboxForModel：
 * - 只保留**最后一条**消息中尚未投递的 agentInbox（首次投递仍可见，与主路径
 *   formatHistoryForAPI「当轮保留、跨轮剥离」语义对齐）；
 * - 更早条目中的顶层与 data.agentInbox 一律剥离，其余字段原样保留（浅拷贝不改写原对象）；
 * - continueFromRunId 续跑场景（baseContents 前置）：旧 run transcript 中的 agentInbox 全部剥离。
 */

import { stripReplayedAgentInboxForModel } from '../../tools/subagents/executor';
import type { Content } from '../../modules/conversation/types';

function frContent(callId: string, inboxText: string): Content {
    return {
        role: 'user',
        isFunctionResponse: true,
        parts: [{
            functionResponse: {
                id: callId,
                name: 'stub_tool',
                response: {
                    success: true,
                    agentInbox: [{ fromRunId: 'run_a', text: inboxText, threadId: 't1', hopDepth: 1, createdAt: 1 }],
                    data: {
                        applied: true,
                        agentInbox: [{ fromRunId: 'run_a', text: inboxText, threadId: 't1', hopDepth: 1, createdAt: 1 }]
                    }
                }
            }
        }]
    } as Content;
}

describe('stripReplayedAgentInboxForModel（H1-4）', () => {
    it('同 run 后续迭代：只保留最后一条未投递的 agentInbox，更早条目全部剥离', () => {
        const history: Content[] = [
            { role: 'user', parts: [{ text: 'task' }] },
            { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'stub_tool', args: {} } }] },
            frContent('call_1', 'msg-1'),   // 已在上一轮请求投递过 → 剥离
            { role: 'model', parts: [{ functionCall: { id: 'call_2', name: 'stub_tool', args: {} } }] },
            frContent('call_2', 'msg-2')    // 尚未投递（最后一条）→ 保留
        ];

        const stripped = stripReplayedAgentInboxForModel(history);

        const frParts = stripped
            .filter(m => m.parts?.some(p => !!p.functionResponse))
            .map(m => (m.parts![0] as any).functionResponse.response);
        expect(frParts).toHaveLength(2);
        // 更早条目：顶层与 data 均剥离，其余字段保留
        expect(frParts[0].agentInbox).toBeUndefined();
        expect(frParts[0].data.agentInbox).toBeUndefined();
        expect(frParts[0].success).toBe(true);
        expect(frParts[0].data.applied).toBe(true);
        // 最后一条：保留（首次投递）
        expect(frParts[1].agentInbox).toHaveLength(1);
        expect(frParts[1].agentInbox[0].text).toBe('msg-2');
        expect(frParts[1].data.agentInbox).toHaveLength(1);
    });

    it('continueFromRunId 续跑：旧 run transcript（baseContents）中的 agentInbox 全部剥离', () => {
        const history: Content[] = [
            { role: 'user', parts: [{ text: 'old task' }] },
            { role: 'model', parts: [{ functionCall: { id: 'call_old', name: 'stub_tool', args: {} } }] },
            frContent('call_old', 'old-msg'),
            { role: 'user', parts: [{ text: 'new prompt' }] }  // 最后一条（无 functionResponse）→ 不保留任何 agentInbox
        ];

        const stripped = stripReplayedAgentInboxForModel(history);

        const frParts = stripped
            .filter(m => m.parts?.some(p => !!p.functionResponse))
            .map(m => (m.parts![0] as any).functionResponse.response);
        expect(frParts).toHaveLength(1);
        expect(frParts[0].agentInbox).toBeUndefined();
        expect(frParts[0].data.agentInbox).toBeUndefined();
        expect(frParts[0].success).toBe(true);
    });

    it('浅拷贝：不改写原始 history（持久化 transcript 不受影响）', () => {
        const original: Content[] = [
            { role: 'user', parts: [{ text: 'task' }] },
            frContent('call_1', 'msg-1'),
            frContent('call_2', 'msg-2')
        ];

        stripReplayedAgentInboxForModel(original);

        // 原始对象未被改写（agentInbox 仍在）
        const frParts = original
            .filter(m => m.parts?.some(p => !!p.functionResponse))
            .map(m => (m.parts![0] as any).functionResponse.response);
        expect(frParts[0].agentInbox).toHaveLength(1);
        expect(frParts[1].agentInbox).toHaveLength(1);
    });

    it('无 functionResponse / 空历史 / 非对象 response 均原样返回', () => {
        const history: Content[] = [
            { role: 'user', parts: [{ text: 'only text' }] },
            { role: 'model', parts: [{ text: 'reply' }] }
        ];
        expect(stripReplayedAgentInboxForModel(history)).toBe(history);
        expect(stripReplayedAgentInboxForModel([])).toEqual([]);

        const stringResponse: Content = {
            role: 'user',
            parts: [{ functionResponse: { id: 'c1', name: 't', response: 'raw-string' as unknown as Record<string, unknown> } }]
        };
        const stripped = stripReplayedAgentInboxForModel([stringResponse]);
        // 最后一条：保留原样（字符串 response 不做处理）
        expect(stripped[0]).toBe(stringResponse);
    });
});
