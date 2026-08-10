/**
 * 子代理 agentInbox 历史稳定性测试。
 *
 * mailbox drain/claim 保证每封信只进入历史一次；进入历史后必须像普通对话内容一样保留，
 * 不能在后续请求中删除，否则 provider 的 KV/prompt cache 会从被改写的位置开始失配。
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

describe('stripReplayedAgentInboxForModel - 缓存前缀稳定', () => {
    it('同 run 后续迭代不改写任何已发送 agentInbox，并返回原数组引用', () => {
        const history: Content[] = [
            { role: 'user', parts: [{ text: 'task' }] },
            { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'stub_tool', args: {} } }] },
            frContent('call_1', 'msg-1'),
            { role: 'model', parts: [{ functionCall: { id: 'call_2', name: 'stub_tool', args: {} } }] },
            frContent('call_2', 'msg-2')
        ];
        const before = JSON.stringify(history);

        const normalized = stripReplayedAgentInboxForModel(history);

        expect(normalized).toBe(history);
        expect(JSON.stringify(normalized)).toBe(before);
        const responses = normalized
            .filter(message => message.parts?.some(part => !!part.functionResponse))
            .map(message => (message.parts![0] as any).functionResponse.response);
        expect(responses[0].agentInbox[0].text).toBe('msg-1');
        expect(responses[0].data.agentInbox[0].text).toBe('msg-1');
        expect(responses[1].agentInbox[0].text).toBe('msg-2');
        expect(responses[1].data.agentInbox[0].text).toBe('msg-2');
    });

    it('continueFromRunId 只在 lastSentHistory 尾部追加新消息，旧请求保持严格前缀', () => {
        const lastSentHistory: Content[] = [
            { role: 'user', parts: [{ text: 'old task' }] },
            { role: 'model', parts: [{ functionCall: { id: 'call_old', name: 'stub_tool', args: {} } }] },
            frContent('call_old', 'old-msg'),
            { role: 'model', parts: [{ text: 'old final reply' }] }
        ];
        const previousProviderBytes = JSON.stringify(lastSentHistory);
        const continuationHistory: Content[] = [
            ...lastSentHistory,
            { role: 'user', parts: [{ text: 'new prompt' }] }
        ];

        const normalized = stripReplayedAgentInboxForModel(continuationHistory);

        expect(normalized).toBe(continuationHistory);
        expect(normalized.slice(0, lastSentHistory.length)).toEqual(lastSentHistory);
        expect(JSON.stringify(normalized.slice(0, lastSentHistory.length))).toBe(previousProviderBytes);
        expect(JSON.stringify(normalized)).toContain('old-msg');
    });

    it('空历史、普通文本与非对象 response 均原样返回', () => {
        const history: Content[] = [
            { role: 'user', parts: [{ text: 'only text' }] },
            { role: 'model', parts: [{ text: 'reply' }] }
        ];
        expect(stripReplayedAgentInboxForModel(history)).toBe(history);

        const empty: Content[] = [];
        expect(stripReplayedAgentInboxForModel(empty)).toBe(empty);

        const stringResponse: Content[] = [{
            role: 'user',
            parts: [{ functionResponse: { id: 'c1', name: 't', response: 'raw-string' as unknown as Record<string, unknown> } }]
        }];
        expect(stripReplayedAgentInboxForModel(stringResponse)).toBe(stringResponse);
    });
});
