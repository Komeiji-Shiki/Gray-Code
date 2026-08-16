/**
 * 子代理上下文裁剪测试（SEC）。
 *
 * 覆盖 trimSubAgentHistoryForContext：
 * - 未超预算时不复制（返回原引用，零开销）
 * - 超预算时从最旧开始整轮丢弃（functionCall/functionResponse 配对整体移除，无孤儿）
 * - 首条用户任务消息始终保留
 * - 单条超大文本/工具结果：截断并标记，且不修改调用方持有的原 history
 * - 预算 = 渠道 maxContextTokens × 0.8（缺省 128000）
 */

import {
    compactSubAgentHistoryForContext,
    estimateSubAgentHistoryTokens,
    trimSubAgentHistoryForContext
} from '../../tools/subagents/executor';
import type { Content } from '../../modules/conversation/types';
import type { BaseChannelConfig } from '../../modules/config/configs/base';

function userMsg(text: string): Content {
    return { role: 'user', parts: [{ text }] };
}

function modelCallMsg(callId: string, toolName = 'read_file', argSize = 100): Content {
    return {
        role: 'model',
        parts: [{
            functionCall: {
                id: callId,
                name: toolName,
                args: { payload: 'a'.repeat(argSize) }
            }
        }]
    };
}

function toolResultMsg(callId: string, resultSize = 100): Content {
    return {
        role: 'user',
        parts: [{
            functionResponse: {
                id: callId,
                name: 'read_file',
                response: { result: 'b'.repeat(resultSize) }
            }
        }]
    };
}

function modelTextMsg(text: string): Content {
    return { role: 'model', parts: [{ text }] };
}

function channelConfig(maxContextTokens: number): BaseChannelConfig {
    return {
        id: 'channel_1',
        name: 'Test',
        type: 'openai',
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
        timeout: 1000,
        maxContextTokens
    } as BaseChannelConfig;
}

/** 校验没有孤立的 functionResponse（每个响应都能在其前找到配对的 functionCall） */
function expectNoOrphanResponses(history: Content[]): void {
    const seenCallIds = new Set<string>();
    for (const message of history) {
        for (const part of message.parts || []) {
            if (part.functionCall?.id) {
                seenCallIds.add(part.functionCall.id);
            }
            if (part.functionResponse?.id) {
                expect(seenCallIds.has(part.functionResponse.id)).toBe(true);
            }
        }
    }
}

describe('trimSubAgentHistoryForContext（SEC）', () => {
    test('未超预算：返回原引用（零开销，不复制不修改）', () => {
        const history = [userMsg('task'), modelCallMsg('c1', 'read_file'), toolResultMsg('c1'), modelTextMsg('answer')];
        const result = trimSubAgentHistoryForContext(history, channelConfig(128000));
        expect(result).toBe(history);
    });

    test('超预算：从最旧开始整轮丢弃，首条用户任务消息与配对完整性保留', () => {
        // 3 轮工具调用 + 终答；预算 80 token ≈ 不足 1 轮 → 丢弃最旧的 2 轮
        const history: Content[] = [
            userMsg('task'),
            modelCallMsg('c1'), toolResultMsg('c1'),
            modelCallMsg('c2'), toolResultMsg('c2'),
            modelCallMsg('c3'), toolResultMsg('c3'),
            modelTextMsg('answer')
        ];
        const result = trimSubAgentHistoryForContext(history, channelConfig(100));
        expect(result.length).toBeLessThan(history.length);
        // 首条用户任务消息始终保留
        expect(result[0].parts?.[0].text).toBe('task');
        // 最旧的 c1/c2 轮被整轮丢弃，最近的 c3 轮与终答保留
        expect(result.some(m => m.parts?.some(p => p.functionCall?.id === 'c1'))).toBe(false);
        expect(result.some(m => m.parts?.some(p => p.functionCall?.id === 'c2'))).toBe(false);
        expect(result.some(m => m.parts?.some(p => p.functionCall?.id === 'c3'))).toBe(true);
        expectNoOrphanResponses(result);
    });

    test('预算极小：整轮丢弃到预算内（保底首条任务 + 末尾内容）', () => {
        const history: Content[] = [
            userMsg('task'),
            modelCallMsg('c1'), toolResultMsg('c1'),
            modelCallMsg('c2'), toolResultMsg('c2'),
            modelTextMsg('answer')
        ];
        const result = trimSubAgentHistoryForContext(history, channelConfig(20));
        expect(result[0].parts?.[0].text).toBe('task');
        // 末尾内容保留：终答不丢（末尾两轮保护）
        expect(result[result.length - 1].parts?.[0].text).toBe('answer');
        // 丢弃只发生在最旧处：剩余的仍是原顺序的子序列
        const originalRoles = history.map(m => m.role);
        const resultRoles = result.map(m => m.role);
        let idx = 0;
        for (const role of resultRoles) {
            const found = originalRoles.indexOf(role, idx);
            expect(found).not.toBe(-1);
            idx = found + 1;
        }
        expectNoOrphanResponses(result);
    });

    test('单条超大文本：截断并标记，且不修改调用方持有的原 history', () => {
        const huge = 'x'.repeat(300000); // ≈ 75000 token
        const history = [userMsg('task'), modelTextMsg(huge)];
        // 预算 = 50000 × 0.8 = 40000 < 75000 → 触发裁剪
        const result = trimSubAgentHistoryForContext(history, channelConfig(50000));
        // 原 history 未被修改
        expect(history[1].parts?.[0].text?.length).toBe(300000);
        // 裁剪结果截断为上限 + 截断标记
        const trimmedText = result[1].parts?.[0].text ?? '';
        expect(trimmedText.length).toBeLessThan(300000);
        expect(trimmedText).toContain('sub-agent context trim');
    });

    test('单条超大工具结果：functionResponse 内的字符串被截断且配对保留', () => {
        const history = [
            userMsg('task'),
            modelCallMsg('c1', 'read_file', 10),
            toolResultMsg('c1', 300000)
        ];
        const result = trimSubAgentHistoryForContext(history, channelConfig(50000));
        const response = result[2].parts?.[0].functionResponse?.response as Record<string, unknown>;
        const text = String(response?.result ?? '');
        expect(text.length).toBeLessThan(300000);
        expect(text).toContain('sub-agent context trim');
        expectNoOrphanResponses(result);
    });

    test('删掉一轮后仍超预算时继续删除，不能在刚好跨过阈值时提前停止', () => {
        const history: Content[] = [
            userMsg('task'),
            modelCallMsg('c1', 'read_file', 800), toolResultMsg('c1', 800),
            modelCallMsg('c2', 'read_file', 800), toolResultMsg('c2', 800),
            modelTextMsg('answer')
        ];
        const result = trimSubAgentHistoryForContext(history, channelConfig(250));
        expect(result.some(m => m.parts?.some(p => p.functionCall?.id === 'c1'))).toBe(false);
        expect(result.some(m => m.parts?.some(p => p.functionCall?.id === 'c2'))).toBe(true);
        expect(result[result.length - 1].parts?.[0].text).toBe('answer');
        expect(estimateSubAgentHistoryTokens(result)).toBeLessThanOrEqual(200);
        expectNoOrphanResponses(result);
    });

    test('保护区包含多个超大工具结果时仍会按最终预算收敛', () => {
        const history = [
            userMsg('task'),
            modelCallMsg('c1', 'read_file', 10),
            toolResultMsg('c1', 500000),
            modelCallMsg('c2', 'read_file', 10),
            toolResultMsg('c2', 500000)
        ];
        const result = trimSubAgentHistoryForContext(history, channelConfig(50000));
        expect(estimateSubAgentHistoryTokens(result)).toBeLessThanOrEqual(40000);
        expect(result.some(m => m.parts?.some(p => p.functionCall?.id === 'c2'))).toBe(true);
        expectNoOrphanResponses(result);
    });

    test('系统提示词和工具声明会从子代理历史预算中扣除', () => {
        const history = [userMsg('task'), modelTextMsg('x'.repeat(100000))];
        const result = trimSubAgentHistoryForContext(history, channelConfig(50000), {
            systemPrompt: 'system '.repeat(1000),
            toolDeclarations: [{ name: 'read_file', description: 'tool '.repeat(1000) }]
        });
        expect(estimateSubAgentHistoryTokens(result)).toBeLessThan(40000);
        expect(result[1].parts?.[0].text).toContain('sub-agent context trim');
    });

    test('独立压缩调用主模型总结服务，保留最近工具调用、配对和 provider 推理元数据', async () => {
        const currentCall = modelCallMsg('c3', 'read_file', 20);
        currentCall.parts[0].thoughtSignatures = { gemini: 'sig-c3' };
        const history: Content[] = [
            userMsg('task'),
            modelCallMsg('c1', 'read_file', 1000), toolResultMsg('c1', 1000),
            modelCallMsg('c2', 'read_file', 1000), toolResultMsg('c2', 1000),
            currentCall, toolResultMsg('c3', 1000)
        ];
        const generatedSummary: Content = {
            role: 'user',
            parts: [{ text: 'model-generated sub-agent summary' }],
            isSummary: true,
            isAutoSummary: true
        };
        const summarizeHistory = jest.fn(async (dropped: Content[]) => {
            expect(dropped.some(message => message.parts?.some(part => part.functionCall?.id === 'c1'))).toBe(true);
            return generatedSummary;
        });
        const result = await compactSubAgentHistoryForContext(history, channelConfig(300), {
            systemPrompt: 'agent system prompt',
            summarizeHistory
        });
        expect(summarizeHistory).toHaveBeenCalledTimes(1);
        expect(result.some(message => message.parts?.[0]?.text === 'model-generated sub-agent summary')).toBe(true);
        expect(result.some(message => message.parts?.some(part => part.functionCall?.id === 'c1'))).toBe(false);
        expect(result.some(message => message.parts?.some(part => part.functionCall?.id === 'c3'))).toBe(true);
        expect(result.find(message => message.parts?.some(part => part.functionCall?.id === 'c3'))?.parts[0].thoughtSignatures)
            .toEqual({ gemini: 'sig-c3' });
        expectNoOrphanResponses(result);
    });


    test('预算按渠道 maxContextTokens 的 80% 计算（缺省 128000）', () => {
        // 无 maxContextTokens：预算 = 128000 * 0.8 = 102400 token
        const history = [
            userMsg('task'),
            modelTextMsg('x'.repeat(300000)), // ≈ 75000 token
            modelTextMsg('y'.repeat(300000))  // 合计 ≈ 150000 token > 102400
        ];
        const config = channelConfig(128000);
        delete (config as Partial<BaseChannelConfig>).maxContextTokens;
        const result = trimSubAgentHistoryForContext(history, config);
        expect(result[0].parts?.[0].text).toBe('task');
        expect(result[1].parts?.[0].text).toContain('sub-agent context trim');
    });
});
