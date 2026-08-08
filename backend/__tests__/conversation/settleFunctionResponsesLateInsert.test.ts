/**
 * 回归测试：settleFunctionResponses 迟到结果的插入位置（BR-08）
 *
 * 背景（真实事故）：「并行工具调用 + 用户中途插话」竞态下，旧流在新回合已把用户消息
 * 追加到历史末尾之后才结算工具结果。旧实现把新 functionResponse 追加到历史末尾，
 * 形成 [assistant(tool_calls), user, tool] 的非法交替顺序 → OpenAI 400。
 *
 * 修复：新响应插到「所属 functionCall 消息的紧后 FR 块」之后（正常路径下与末尾追加
 * 位置相同，行为不变；竞态路径下插回用户消息之前）。
 */

import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';

function createManager(): ConversationManager {
    return new ConversationManager(new MemoryStorageAdapter());
}

describe('settleFunctionResponses 迟到结果插入位置（BR-08）', () => {
    it('正常路径：assistant 是历史末条时，结果插到其 FR 块之后（与末尾追加等价）', async () => {
        const manager = createManager();
        const convId = 'conv-settle-normal';

        await manager.addContent(convId, { role: 'user', parts: [{ text: '继续' }] });
        await manager.addContent(convId, {
            role: 'model',
            parts: [{ functionCall: { id: 'call_n1', name: 'read_file', args: { path: 'a.txt' } } }]
        });

        await manager.settleFunctionResponses(convId, [{
            functionResponse: { id: 'call_n1', name: 'read_file', response: { success: true, data: 'x' } }
        }]);

        const history = await manager.getHistoryRef(convId);
        expect(history).toHaveLength(3);
        expect(history[1].parts?.[0]?.functionCall?.id).toBe('call_n1');
        expect(history[2].isFunctionResponse).toBe(true);
        expect(history[2].parts?.[0]?.functionResponse?.id).toBe('call_n1');
    });

    it('竞态路径：用户消息已追加在 assistant 之后，迟到结果插回用户消息之前', async () => {
        const manager = createManager();
        const convId = 'conv-settle-late';

        // 1. assistant 输出并行工具调用
        await manager.addContent(convId, { role: 'user', parts: [{ text: '执行命令' }] });
        await manager.addContent(convId, {
            role: 'model',
            parts: [
                { functionCall: { id: 'call_p1', name: 'git_show', args: { file: 'a.test.ts' } } },
                { functionCall: { id: 'call_p2', name: 'git_show', args: { file: 'b.test.ts' } } }
            ]
        });
        // 2. call_p1 先完成，正常结算
        await manager.settleFunctionResponses(convId, [{
            functionResponse: { id: 'call_p1', name: 'git_show', response: { success: true, data: 'a' } }
        }]);
        // 3. 用户中途插话：新回合用户消息追加
        await manager.addContent(convId, { role: 'user', parts: [{ text: '三个子agent检查影响面' }] });
        // 4. call_p2 迟到结算（用户消息之后才完成）
        await manager.settleFunctionResponses(convId, [{
            functionResponse: { id: 'call_p2', name: 'git_show', response: { success: true, data: 'b' } }
        }]);

        const history = await manager.getHistoryRef(convId);
        expect(history).toHaveLength(5);
        // 顺序必须为 [user, assistant(calls), fr(p1), fr(p2), user(插话)]
        expect(history[0].role).toBe('user');
        expect(history[1].role).toBe('model');
        expect(history[2].isFunctionResponse).toBe(true);
        expect(history[2].parts?.[0]?.functionResponse?.id).toBe('call_p1');
        expect(history[3].isFunctionResponse).toBe(true);
        expect(history[3].parts?.[0]?.functionResponse?.id).toBe('call_p2');
        expect(history[4].role).toBe('user');
        expect(history[4].parts?.[0]?.text).toBe('三个子agent检查影响面');
        // assistant 的 tool_calls 与其 tool 消息之间不得夹用户消息
        const assistantIdx = history.findIndex(m => m.role === 'model');
        const interrupted = history.slice(assistantIdx + 1).findIndex(m => m.role === 'user' && !m.isFunctionResponse);
        const lastFr = history.slice(assistantIdx + 1).reduce(
            (acc, m, i) => (m.isFunctionResponse ? i : acc), -1
        );
        expect(interrupted).toBeGreaterThan(lastFr);
    });

    it('占位替换路径不变：已存在的 rejected 占位被就地替换为真实结果', async () => {
        const manager = createManager();
        const convId = 'conv-settle-replace';

        await manager.addContent(convId, { role: 'user', parts: [{ text: '拒绝该工具' }] });
        await manager.addContent(convId, {
            role: 'model',
            parts: [{ functionCall: { id: 'call_r1', name: 'read_file', args: { path: 'a.txt' }, rejected: true } }]
        });
        // rejectToolCalls 写占位（rejectAllPendingToolCalls 的等价路径）
        await manager.rejectToolCalls(convId, 1, ['call_r1']);
        // 迟到真实结果就地替换
        await manager.settleFunctionResponses(convId, [{
            functionResponse: { id: 'call_r1', name: 'read_file', response: { success: true, data: 'real' } }
        }]);

        const history = await manager.getHistoryRef(convId);
        expect(history).toHaveLength(3);
        expect(history[2].isFunctionResponse).toBe(true);
        expect(history[2].parts?.[0]?.functionResponse?.response).toMatchObject({ success: true, data: 'real' });
        // 占位路径 position 不变：仍在 assistant 紧后，且 rejected 标记被清除
        expect(history[1].parts?.[0]?.functionCall?.rejected).toBe(false);
    });
});
