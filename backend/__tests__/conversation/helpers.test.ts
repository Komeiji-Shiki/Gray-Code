/**
 * conversation/helpers - cleanFunctionResponseForAPI / cleanContentForAPI 测试（FIX-B）
 *
 * 重点覆盖：
 * - agentInbox（A-COMM 信箱消息）在顶层与 data 子对象均被剥离 → 历史中的 functionResponse
 *   不会把信箱消息重放给模型（drain 一次性语义、prompt 不膨胀）；
 * - 既有内部字段剥离行为不回归（diffContentId / diffs / toolId / steps 等）；
 * - 模型需要保留的字段（success / error / duration / killed / data.output / data.message / data.results）不受影响。
 */

import {
    cleanFunctionResponseForAPI,
    cleanContentForAPI
} from '../../modules/conversation/helpers';
import type { Content, ContentPart } from '../../modules/conversation/types';

describe('cleanFunctionResponseForAPI', () => {
    it('剥离顶层 agentInbox（A-COMM 信箱消息，禁止历史重放）', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            agentInbox: [{ fromRunId: 'run_a', text: 'hi', threadId: 't1', hopDepth: 1, createdAt: 1 }],
            duration: 123
        });
        expect(cleaned?.agentInbox).toBeUndefined();
        expect(cleaned?.success).toBe(true);
        expect(cleaned?.duration).toBe(123);
    });

    it('剥离 data 子对象中的 agentInbox', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            data: {
                applied: true,
                agentInbox: [{ fromRunId: 'run_a', text: 'hi', threadId: 't1', hopDepth: 1, createdAt: 1 }]
            }
        });
        expect((cleaned?.data as any)?.agentInbox).toBeUndefined();
        expect((cleaned?.data as any)?.applied).toBe(true);
    });

    it('同时剥离顶层与 data 的 agentInbox，其余字段保留', () => {
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
            data: { applied: true, output: 'out' }
        });
    });

    it('既有剥离行为不回归：顶层 diffContentId / diffId / diffs / pendingDiffId 被剥离', () => {
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

    it('既有剥离行为不回归：data 中 subagents/命令元数据被剥离，results 内容保留', () => {
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
        expect(data.steps).toBeUndefined();
        expect(data.results).toHaveLength(2);
        expect(data.results[0]).toEqual({ path: 'a.ts', lineCount: 2, success: true });
        expect(data.results[1]).toEqual({ path: 'b.ts', success: false });
    });

    it('保留模型需要的字段：killed / duration / data.output / data.message', () => {
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

    it('非对象输入原样返回（undefined / 字符串）', () => {
        expect(cleanFunctionResponseForAPI(undefined)).toBeUndefined();
        expect(cleanFunctionResponseForAPI('raw' as any)).toBe('raw');
    });

    it('H1-3：数组输入原样返回（typeof \'object\' 无法拦截数组，直接透传不改写）', () => {
        const arr = [{ success: true, agentInbox: [{ fromRunId: 'run_a', text: 'x' }] }];
        const cleaned = cleanFunctionResponseForAPI(arr as any);
        // 数组没有内部字段剥离语义：原引用原样返回，不做任何改写
        expect(cleaned).toBe(arr);
    });

    it('HIGH-1：当轮（isHistoryMessage=false）保留顶层与 data 的 agentInbox，仍剥离其它内部字段', () => {
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

    it('HIGH-1：当轮无 agentInbox 时输出与默认一致（不凭空引入字段）', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            data: { applied: true }
        }, false);
        expect(cleaned).toEqual({ success: true, data: { applied: true } });
    });

    it('HIGH-1：默认（isHistoryMessage=true）仍剥离 agentInbox——既有防重放行为不回归', () => {
        const cleaned = cleanFunctionResponseForAPI({
            success: true,
            agentInbox: [{ fromRunId: 'run_a', text: 'hi' }],
            data: { applied: true, agentInbox: [{ fromRunId: 'run_a', text: 'hi-data' }] }
        });
        expect(cleaned?.agentInbox).toBeUndefined();
        expect((cleaned?.data as any)?.agentInbox).toBeUndefined();
    });
});

describe('cleanContentForAPI', () => {
    it('functionResponse part 剥离 agentInbox 与内部字段，保留 id/name 与展示字段', () => {
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
        expect((part.functionResponse?.response as any)?.agentInbox).toBeUndefined();
        expect((part.functionResponse?.response as any)?.data?.agentInbox).toBeUndefined();
        expect((part.functionResponse?.response as any)?.data?.toolId).toBeUndefined();
        expect((part.functionResponse?.response as any)?.data?.applied).toBe(true);
    });
});
