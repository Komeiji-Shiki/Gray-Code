/**
 * 回归测试：无配对响应的 functionCall（孤儿 tool_calls）不发给 API
 *
 * 背景（真实事故）：「并行工具调用 + 用户中途插话」竞态下，历史可能出现两种非法形态：
 * 1. assistant 消息的 tool_calls 没有任何配对 functionResponse（drain 超时残留/迟到落盘）；
 * 2. 配对响应被追加到用户消息之后（[assistant(tool_calls), user, tool] 非法交替顺序）。
 *
 * 两种形态都会触发 OpenAI 400：An assistant message with 'tool_calls' must be followed
 * by tool messages responding to each 'tool_call_id' (insufficient tool messages...)。
 *
 * 修复（BR-08）：
 * - 主路径 formatHistoryForAPI：调用必须在其所属消息的「紧随其后的连续 FR 块」内存在配对
 *   响应，否则调用与配对响应一并剔除；
 * - openai.ts formatter 防御层（子代理本地历史直传路径）：无配对响应（全历史范围）的
 *   调用不生成 tool_calls。
 */

import { OpenAIFormatter } from '../../modules/channel';
import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { Content } from '../../modules/conversation/types';
import type { OpenAIConfig } from '../../modules/config/types';

function createOpenAIConfig(): OpenAIConfig {
    return {
        id: 'openai-test',
        name: 'OpenAI Test',
        type: 'openai',
        enabled: true,
        url: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'test-model',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call'
    } as OpenAIConfig;
}

describe('formatHistoryForAPI：无配对响应的调用整体剔除（BR-08）', () => {
    const manager = new ConversationManager(new MemoryStorageAdapter());

    test('中断残留（非 rejected、无任何响应）的调用被丢弃，文本保留', () => {
        const forApi = manager.getHistoryForAPIFrom([
            { role: 'user', parts: [{ text: '继续' }] },
            { role: 'model', parts: [
                { text: '正在处理…' },
                { functionCall: { id: 'call_orphan_1', name: 'read_file', args: { path: 'a.txt' } } },
                { functionCall: { id: 'call_orphan_2', name: 'subagents', args: { agentName: 'A' } } }
            ] }
        ]);

        expect(forApi).toHaveLength(2);
        const model = forApi[1];
        expect(model.parts).toEqual([{ text: '正在处理…' }]);
        expect(model.parts.some(p => p.functionCall)).toBe(false);
    });

    test('响应被追加到用户消息之后（错位形态）：调用与配对响应一并剔除', () => {
        const forApi = manager.getHistoryForAPIFrom([
            { role: 'user', parts: [{ text: '第一个问题' }] },
            { role: 'model', parts: [
                { functionCall: { id: 'call_parallel_1', name: 'git_show', args: { file: 'a.test.ts' } } },
                { functionCall: { id: 'call_parallel_2', name: 'git_show', args: { file: 'b.test.ts' } } }
            ] },
            { role: 'user', parts: [{ text: '第二个问题' }] },
            { role: 'user', isFunctionResponse: true, parts: [
                { functionResponse: { id: 'call_parallel_1', name: 'git_show', response: { success: true, data: 'a' } } }
            ] }
        ]);

        // 错位响应不在 assistant 消息的紧后 FR 块内：调用与其响应全部剔除；
        // assistant 消息本身无文本，剔除调用后为空 → 消息整体移除
        expect(forApi).toHaveLength(2);
        expect(forApi.every(m => m.role === 'user')).toBe(true);
        expect(forApi.flatMap(m => m.parts).some(p => p.functionCall)).toBe(false);
        const responses = forApi.flatMap(m => m.parts).filter(p => p.functionResponse);
        expect(responses).toHaveLength(0);
    });

    test('正常成对形态（FR 块紧随 assistant）不受影响', () => {
        const forApi = manager.getHistoryForAPIFrom([
            { role: 'user', parts: [{ text: '继续' }] },
            { role: 'model', parts: [
                { text: '马上' },
                { functionCall: { id: 'call_ok_1', name: 'read_file', args: { path: 'a.txt' } } }
            ] },
            { role: 'user', isFunctionResponse: true, parts: [
                { functionResponse: { id: 'call_ok_1', name: 'read_file', response: { success: true, data: 'x' } } }
            ] }
        ]);

        expect(forApi).toHaveLength(3);
        const model = forApi[1];
        expect(model.parts.some(p => p.functionCall?.id === 'call_ok_1')).toBe(true);
        const fr = forApi[2].parts[0].functionResponse;
        expect(fr?.id).toBe('call_ok_1');
    });

    test('用户显式拒绝（rejected + 占位响应在 FR 块内）保留成对发送', () => {
        const forApi = manager.getHistoryForAPIFrom([
            { role: 'model', parts: [
                { functionCall: { id: 'call_rej_block', name: 'read_file', args: {}, rejected: true } }
            ] },
            { role: 'user', isFunctionResponse: true, parts: [
                { functionResponse: { id: 'call_rej_block', name: 'read_file', response: { success: false, error: 'rejected', rejected: true } } }
            ] }
        ]);

        expect(forApi).toHaveLength(2);
        expect(forApi[0].parts[0].functionCall?.id).toBe('call_rej_block');
        expect(forApi[0].parts[0].functionCall?.rejected).toBeUndefined();
        expect(forApi[1].parts[0].functionResponse?.id).toBe('call_rej_block');
    });

    test('端到端：formatHistoryForAPI 过滤后 OpenAI formatter 不再产生孤儿 tool_calls', () => {
        const formatter = new OpenAIFormatter();
        const history = manager.getHistoryForAPIFrom([
            { role: 'model', parts: [
                { text: '正在处理…' },
                { functionCall: { id: 'call_orphan_e2e', name: 'subagents', args: {} } }
            ] }
        ]);

        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history,
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createOpenAIConfig());

        const messages = request.body.messages as any[];
        expect(messages.filter((m: any) => m.role === 'assistant' && m.tool_calls)).toHaveLength(0);
        expect(messages.filter((m: any) => m.role === 'tool')).toHaveLength(0);
    });
});

describe('OpenAI formatter 防御层：直传历史中的孤儿调用不生成 tool_calls', () => {
    test('子代理本地历史（不经 formatHistoryForAPI）中未响应调用被剔除', () => {
        const formatter = new OpenAIFormatter();
        // 直传形态：assistant 的 call 无任何配对响应
        const history: Content[] = [
            { role: 'user', parts: [{ text: '跑一下' }] },
            { role: 'model', parts: [
                { text: '开始' },
                { functionCall: { id: 'call_direct_1', name: 'read_file', args: { path: 'a.txt' } } }
            ] }
        ];

        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history,
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createOpenAIConfig());

        const messages = request.body.messages as any[];
        const assistantWithCalls = messages.filter((m: any) => m.role === 'assistant' && m.tool_calls);
        expect(assistantWithCalls).toHaveLength(0);
        // 文本形态的 assistant 消息保留
        const assistantText = messages.filter((m: any) => m.role === 'assistant' && !m.tool_calls);
        expect(assistantText.length).toBeGreaterThan(0);
        expect(messages.filter((m: any) => m.role === 'tool')).toHaveLength(0);
    });
});
