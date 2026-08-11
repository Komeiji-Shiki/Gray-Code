/**
 * conversation/helpers - cleanFunctionResponseForAPI / cleanContentForAPI 测试（FIX-B）
 *
 * 重点覆盖：
 * - agentInbox（A-COMM 信箱消息）在顶层与 data 子对象中保持不变：一次性消费由 mailbox
 *   drain/claim 保证，稳定历史字节保障 provider 前缀缓存；
 * - 既有内部字段剥离行为不回归（diffContentId / diffs / toolId / channelName / modelId 等）；
 * - subagents 的 steps / toolsUsed 保留给 AI（告知主模型子代理是否调用过工具及调用数量）；
 * - 模型需要保留的字段（success / error / duration / killed / data.output / data.message / data.results）不受影响。
 */

import {
    cleanFunctionResponseForAPI,
    cleanContentForAPI,
    ensureBackgroundTaskSourceForDisplay,
    isRealUserMessage
} from '../../modules/conversation';
import type { Content, ContentPart } from '../../modules/conversation';

describe('isRealUserMessage', () => {
    test('保留新旧真实用户消息语义，但排除后台任务回执', () => {
        expect(isRealUserMessage({ role: 'user', isUserInput: true })).toBe(true);
        expect(isRealUserMessage({ role: 'user' })).toBe(true);
        expect(isRealUserMessage({ role: 'user', source: 'background_task' })).toBe(false);
        expect(isRealUserMessage({ role: 'user', source: 'agent_message' })).toBe(false);
        expect(isRealUserMessage({ role: 'user', isFunctionResponse: true })).toBe(false);
        expect(isRealUserMessage({ role: 'user', isSummary: true })).toBe(false);
        expect(isRealUserMessage({ role: 'user', isAutoSummary: true })).toBe(false);
        // 逻辑截断：被总结覆盖的原始消息不构成新回合边界
        expect(isRealUserMessage({ role: 'user', isSummarized: true })).toBe(false);
    });
});

describe('ensureBackgroundTaskSourceForDisplay', () => {
    const receipt = (extra: Partial<Content> = {}): Content => ({
        role: 'user',
        parts: [{ text: '[Background task completed]\n\nResult: ...' }],
        ...extra
    });

    test('旧数据缺 source 的回执消息补 source=background_task（不写盘，仅内存）', () => {
        const result = ensureBackgroundTaskSourceForDisplay(receipt());
        expect(result.source).toBe('background_task');
        // 原对象不被修改（纯函数）
        expect(receipt().source).toBeUndefined();
    });

    test('已有 source 的消息保持原值，不重复覆盖', () => {
        expect(ensureBackgroundTaskSourceForDisplay(receipt({ source: 'background_task' })).source).toBe('background_task');
        expect(ensureBackgroundTaskSourceForDisplay(receipt({ source: 'user' })).source).toBe('user');
    });

    test('普通用户消息（非回执前缀）不被误判', () => {
        const normal = receipt({ parts: [{ text: '帮我看看这段代码' }] });
        expect(ensureBackgroundTaskSourceForDisplay(normal).source).toBeUndefined();
    });

    test('functionResponse / model 消息不被误判', () => {
        expect(ensureBackgroundTaskSourceForDisplay(receipt({ isFunctionResponse: true })).source).toBeUndefined();
        expect(ensureBackgroundTaskSourceForDisplay({ role: 'model', parts: [{ text: '[Background task completed] xxx' }] }).source).toBeUndefined();
    });

    test('无 parts 的消息安全跳过（不抛错）', () => {
        expect(ensureBackgroundTaskSourceForDisplay({ role: 'user' } as Content)).toEqual({ role: 'user' } as Content);
    });
});

describe('cleanFunctionResponseForAPI', () => {
    test('保留顶层 agentInbox，避免历史前缀在后续请求中被改写', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            agentInbox: [{ fromRunId: 'run_a', text: 'hi', threadId: 't1', hopDepth: 1, createdAt: 1 }],
            duration: 123
        });
        expect(cleaned?.agentInbox).toHaveLength(1);
        expect(cleaned?.success).toBe(true);
        expect(cleaned?.duration).toBe(123);
    });

    test('保留 data 子对象中的 agentInbox', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            data: {
                applied: true,
                agentInbox: [{ fromRunId: 'run_a', text: 'hi', threadId: 't1', hopDepth: 1, createdAt: 1 }]
            }
        });
        expect((cleaned?.data as any)?.agentInbox).toHaveLength(1);
        expect((cleaned?.data as any)?.applied).toBe(true);
    });

    test('同时保留顶层与 data 的 agentInbox，其余内部字段仍正常清理', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            agentInbox: [{ fromRunId: 'run_a', text: 'top' }],
            data: {
                applied: true,
                output: 'out',
                agentInbox: [{ fromRunId: 'run_a', text: 'data' }]
            }
        });
        expect(cleaned).toEqual({
            success: true,
            agentInbox: [{ fromRunId: 'run_a', text: 'top' }],
            data: {
                applied: true,
                output: 'out',
                agentInbox: [{ fromRunId: 'run_a', text: 'data' }]
            }
        });
    });

    test('既有剥离行为不回归：顶层 diffContentId / diffId / diffs / pendingDiffId 被剥离', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            diffContentId: 'd1',
            diffId: 'd2',
            diffs: [{ a: 1 }],
            pendingDiffId: 'd3'
        });
        expect(cleaned?.diffContentId).toBeUndefined();
        expect(cleaned?.diffId).toBeUndefined();
        expect(cleaned?.diffs).toBeUndefined();
        expect(cleaned?.pendingDiffId).toBeUndefined();
        expect(cleaned?.success).toBe(true);
    });

    test('保留子代理工具使用信息：data.steps / data.toolsUsed 不被剥离（含非空列表）', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            data: {
                agentName: '漫画查看员',
                runId: 'subagent_run_x',
                response: '分析内容…',
                channelName: 'ch',
                modelId: 'm1',
                steps: 3,
                toolsUsed: ['read_file', 'get_symbols']
            }
        });
        const data = cleaned?.data as any;
        // 纯 UI 字段仍剥离
        expect(data.channelName).toBeUndefined();
        expect(data.modelId).toBeUndefined();
        // 工具使用信息保留（非空列表，防止实现误剥离非空值）
        expect(data.agentName).toBe('漫画查看员');
        expect(data.runId).toBe('subagent_run_x');
        expect(data.steps).toBe(3);
        expect(data.toolsUsed).toEqual(['read_file', 'get_symbols']);
        expect(data.response).toBe('分析内容…');
    });

    test('既有剥离行为不回归：data 中 subagents/命令元数据被剥离，results 内容保留', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            data: {
                toolId: 't1',
                terminalId: 'term1',
                multiRoot: true,
                command: 'ls',
                cwd: '/a',
                shell: 'sh',
                channelName: 'ch',
                modelId: 'm1',
                steps: [{ step: 1 }],
                results: [
                    { path: 'a.ts', diffContentId: 'd1', pendingDiffId: 'p1', lineCount: 2, success: true },
                    { path: 'b.ts', success: false }
                ]
            }
        });
        const data = cleaned?.data as any;
        expect(data.toolId).toBeUndefined();
        expect(data.terminalId).toBeUndefined();
        expect(data.multiRoot).toBeUndefined();
        expect(data.command).toBeUndefined();
        expect(data.cwd).toBeUndefined();
        expect(data.shell).toBeUndefined();
        expect(data.channelName).toBeUndefined();
        expect(data.modelId).toBeUndefined();
        // steps / toolsUsed 保留给 AI：告知子代理是否调用过工具及调用数量
        expect(data.steps).toEqual([{ step: 1 }]);
        expect(data.results).toHaveLength(2);
        expect(data.results[0]).toEqual({ path: 'a.ts', lineCount: 2, success: true });
        expect(data.results[1]).toEqual({ path: 'b.ts', success: false });
    });

    test('保留模型需要的字段：killed / duration / data.output / data.message', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: false,
            error: 'boom',
            killed: true,
            duration: 42,
            data: { output: 'stderr', message: 'done' }
        });
        expect(cleaned).toEqual({
            success: false,
            error: 'boom',
            killed: true,
            duration: 42,
            data: { output: 'stderr', message: 'done' }
        });
    });

    test('非对象输入原样返回（undefined / 字符串）', () => {
        expect(cleanFunctionResponseForAPI(undefined)).toBeUndefined();
        expect(cleanFunctionResponseForAPI('raw' as any)).toBe('raw');
    });

    test('H1-3：数组输入原样返回（typeof \'object\' 无法拦截数组，直接透传不改写）', () => {
        const arr = [{ success: true, agentInbox: [{ fromRunId: 'run_a', text: 'x' }] }];
        const cleaned = cleanFunctionResponseForAPI(arr as any);
        // 数组没有内部字段剥离语义：原引用原样返回，不做任何改写
        expect(cleaned).toBe(arr);
    });

    test('HIGH-1：当轮（isHistoryMessage=false）保留顶层与 data 的 agentInbox，仍剥离其它内部字段', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            agentInbox: [{ fromRunId: 'run_a', text: 'hi' }],
            diffContentId: 'd1',
            duration: 42,
            data: {
                applied: true,
                agentInbox: [{ fromRunId: 'run_a', text: 'hi-data' }],
                toolId: 't1',
                results: [{ path: 'a.ts', diffContentId: 'd2', success: true }]
            }
        }, false);
        // 当轮保留 agentInbox（主模型可见）
        expect(cleaned?.agentInbox).toHaveLength(1);
        expect((cleaned?.data as any)?.agentInbox).toHaveLength(1);
        // 其它内部字段照常剥离
        expect(cleaned?.diffContentId).toBeUndefined();
        expect((cleaned?.data as any)?.toolId).toBeUndefined();
        expect((cleaned?.data as any)?.results[0]).toEqual({ path: 'a.ts', success: true });
        expect(cleaned?.duration).toBe(42);
        expect((cleaned?.data as any)?.applied).toBe(true);
    });

    test('HIGH-1：当轮无 agentInbox 时输出与默认一致（不凭空引入字段）', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            data: { applied: true }
        }, false);
        expect(cleaned).toEqual({ success: true, data: { applied: true } });
    });

    test('默认历史模式同样保留 agentInbox，保证相邻请求的已发送前缀逐字节稳定', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            agentInbox: [{ fromRunId: 'run_a', text: 'hi' }],
            data: { applied: true, agentInbox: [{ fromRunId: 'run_a', text: 'hi-data' }] }
        });
        expect(cleaned?.agentInbox).toHaveLength(1);
        expect((cleaned?.data as any)?.agentInbox).toHaveLength(1);
    });
});

describe('cleanContentForAPI', () => {
    test('functionResponse part 保留 agentInbox 并剥离其它内部字段，保留 id/name 与展示字段', () => {
        const content: Content = {
            role: 'model',
            parts: [
                {
                    functionResponse: {
                        name: 'stub_tool',
                        id: 'call_1',
                        response: {
                            success: true,
                            agentInbox: [{ fromRunId: 'run_a', text: 'hi' }],
                            data: {
                                applied: true,
                                agentInbox: [{ fromRunId: 'run_a', text: 'hi' }],
                                toolId: 't1'
                            }
                        }
                    }
                }
            ]
        };
        const cleaned = cleanContentForAPI(content);
        const part = cleaned.parts[0] as ContentPart;
        expect(part.functionResponse?.name).toBe('stub_tool');
        expect(part.functionResponse?.id).toBe('call_1');
        expect((part.functionResponse?.response as any)?.agentInbox).toHaveLength(1);
        expect((part.functionResponse?.response as any)?.data?.agentInbox).toHaveLength(1);
        expect((part.functionResponse?.response as any)?.data?.toolId).toBeUndefined();
        expect((part.functionResponse?.response as any)?.data?.applied).toBe(true);
    });
});
