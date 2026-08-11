/**
 * StreamAccumulator 回归测试
 *
 * 覆盖三块修复：
 * 1. contentRevision（结构修订号）：只在结构性变化时递增，
 *    纯文本追加 / partialArgs 追加不递增——StreamResponseProcessor
 *    据此决定是否下发 contentSnapshot，替代逐 chunk 深比较。
 * 2. getNewCompletedFunctionCalls 用 id 去重，同一调用绝不重复上报
 *    （重复上报会导致工具被重复提前执行）。
 * 3. 旧 extractAndConvertToolCalls 路径删除后：
 *    - 非思考文本中的完整工具块仍由 IncrementalPromptToolParser 转换（回归保护）；
 *    - 思考（thought）文本中的工具标记不再被当作真实调用
 *      （与 ToolCallParserService 跳过 thought part 的语义一致）。
 */

import { StreamAccumulator } from '../../modules/channel';
import type { StreamChunk } from '../../modules/channel';

function makeIdFactory(): () => string {
    let n = 0;
    return () => `test_fc_${++n}`;
}

function chunkOf(parts: unknown[], extra: Partial<StreamChunk> = {}): StreamChunk {
    return { delta: parts, ...extra } as unknown as StreamChunk;
}

describe('StreamAccumulator - contentRevision', () => {
    test('纯文本追加不递增修订号（前端可由 delta 还原）', () => {
        const acc = new StreamAccumulator('function_call', makeIdFactory());

        acc.add(chunkOf([{ text: 'hello ' }]));
        const afterFirstText = acc.getContentRevision();

        acc.add(chunkOf([{ text: 'world' }]));
        acc.add(chunkOf([{ text: '!' }]));

        expect(acc.getContentRevision()).toBe(afterFirstText);
        expect(acc.getFinalContent().parts[0].text).toBe('hello world!');
    });

    test('新 part 入列递增修订号', () => {
        const acc = new StreamAccumulator('function_call', makeIdFactory());

        acc.add(chunkOf([{ text: 'normal' }]));
        const r1 = acc.getContentRevision();

        // 思考文本与普通文本不合并 → 新 part
        acc.add(chunkOf([{ text: 'thinking...', thought: true }]));
        expect(acc.getContentRevision()).toBeGreaterThan(r1);
    });

    test('functionCall 参数增量不递增，args 解析成功时递增', () => {
        const acc = new StreamAccumulator('function_call', makeIdFactory());

        acc.add(chunkOf([{ functionCall: { name: 'read_file', index: 0, args: {} } }]));
        const afterShell = acc.getContentRevision();

        // 不完整的参数增量：投影不可见，不应递增
        acc.add(chunkOf([{ functionCall: { index: 0, partialArgs: '{"path":' } }]));
        expect(acc.getContentRevision()).toBe(afterShell);

        // 增量拼接完成，JSON.parse 成功 → 工具调用"完成"，属于结构性变化
        acc.add(chunkOf([{ functionCall: { index: 0, partialArgs: '"a.txt"}' } }]));
        expect(acc.getContentRevision()).toBeGreaterThan(afterShell);

        const fc = acc.getFinalContent().parts.find(p => p.functionCall)?.functionCall;
        expect(fc?.name).toBe('read_file');
        expect(fc?.args).toEqual({ path: 'a.txt' });
    });
});

describe('StreamAccumulator - getNewCompletedFunctionCalls', () => {
    test('空参数占位壳不上报，参数完成后仅上报一次', () => {
        const acc = new StreamAccumulator('function_call', makeIdFactory());

        acc.add(chunkOf([{ functionCall: { name: 'read_file', index: 0, args: {} } }]));
        expect(acc.getNewCompletedFunctionCalls()).toHaveLength(0);

        acc.add(chunkOf([{ functionCall: { index: 0, partialArgs: '{"path":"a.txt"}' } }]));

        const completed = acc.getNewCompletedFunctionCalls();
        expect(completed).toHaveLength(1);
        expect(completed[0].name).toBe('read_file');
        expect(completed[0].id).toBeTruthy();
        expect(completed[0].args).toEqual({ path: 'a.txt' });

        // 同一调用绝不重复上报（重复上报 = 工具被重复执行）
        expect(acc.getNewCompletedFunctionCalls()).toHaveLength(0);
        acc.add(chunkOf([{ text: 'trailing text' }]));
        expect(acc.getNewCompletedFunctionCalls()).toHaveLength(0);
    });

    test('多个并行调用各自上报一次', () => {
        const acc = new StreamAccumulator('function_call', makeIdFactory());

        acc.add(chunkOf([{ functionCall: { name: 'tool_a', index: 0, args: {} } }]));
        acc.add(chunkOf([{ functionCall: { index: 0, partialArgs: '{"x":1}' } }]));
        acc.add(chunkOf([{ functionCall: { name: 'tool_b', index: 1, args: {} } }]));

        const first = acc.getNewCompletedFunctionCalls();
        expect(first.map(c => c.name)).toEqual(['tool_a']);

        acc.add(chunkOf([{ functionCall: { index: 1, partialArgs: '{"y":2}' } }]));

        const second = acc.getNewCompletedFunctionCalls();
        expect(second.map(c => c.name)).toEqual(['tool_b']);
        expect(second[0].id).not.toBe(first[0].id);
    });
});

describe('StreamAccumulator - prompt 模式工具块解析', () => {
    test('json 模式：普通文本中的完整工具块转换为 functionCall（回归保护）', () => {
        const acc = new StreamAccumulator('json', makeIdFactory());

        acc.add(chunkOf([{ text: 'before ' }]));
        acc.add(chunkOf([{ text: '<<<TOOL_CALL>>>\n{"tool": "read_file", "parameters": {"path": "a.txt"}}\n<<<END_TOOL_CALL>>>' }]));
        acc.add(chunkOf([], { done: true }));

        const parts = acc.getFinalContent().parts;
        const fcPart = parts.find(p => p.functionCall);
        expect(fcPart?.functionCall?.name).toBe('read_file');
        expect(fcPart?.functionCall?.args).toEqual({ path: 'a.txt' });
        expect(fcPart?.functionCall?.id).toBeTruthy();
    });

    test('xml 模式：分片到达的工具块也能正确转换', () => {
        const acc = new StreamAccumulator('xml', makeIdFactory());

        acc.add(chunkOf([{ text: '<tool_use>\n  <tool_name>read_' }]));
        acc.add(chunkOf([{ text: 'file</tool_name>\n  <parameters>\n    <path>a.txt</path>\n  </parameters>\n</tool_use>' }]));
        acc.add(chunkOf([], { done: true }));

        const fcPart = acc.getFinalContent().parts.find(p => p.functionCall);
        expect(fcPart?.functionCall?.name).toBe('read_file');
        expect(fcPart?.functionCall?.args).toEqual({ path: 'a.txt' });
    });

    test('思考（thought）文本中的工具标记不被当作真实调用', () => {
        const acc = new StreamAccumulator('json', makeIdFactory());

        const thoughtText = '我打算调用 <<<TOOL_CALL>>>{"tool": "delete_file", "parameters": {"paths": ["a.txt"]}}<<<END_TOOL_CALL>>> 试试';
        acc.add(chunkOf([{ text: thoughtText, thought: true }]));
        acc.add(chunkOf([], { done: true }));

        const parts = acc.getFinalContent().parts;
        expect(parts.some(p => p.functionCall)).toBe(false);
        expect(parts.find(p => p.thought)?.text).toBe(thoughtText);
        expect(acc.getNewCompletedFunctionCalls()).toHaveLength(0);
    });

    test('done 时未闭合的工具块 flush 为文本，不产生 functionCall', () => {
        const acc = new StreamAccumulator('json', makeIdFactory());

        acc.add(chunkOf([{ text: '<<<TOOL_CALL>>>\n{"tool": "read_file"' }]));
        acc.add(chunkOf([], { done: true }));

        const parts = acc.getFinalContent().parts;
        expect(parts.some(p => p.functionCall)).toBe(false);
        expect(parts.map(p => p.text).join('')).toContain('<<<TOOL_CALL>>>');
    });
});


describe('StreamAccumulator - ttft（首字延迟）', () => {
    test('buildContent 计算 ttft = 首块时间 - 请求开始时间', () => {
        const acc = new StreamAccumulator('function_call', makeIdFactory());
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000);
        try {
            acc.setRequestStartTime(1000); // 请求开始 t=1000
            nowSpy.mockReturnValue(2450); // 第一个流式块 t=2450
            acc.add(chunkOf([{ text: 'hello' }]));
            nowSpy.mockReturnValue(3000); // 第二个块 t=3000
            acc.add(chunkOf([{ text: ' world' }]));

            const content = acc.getFinalContent();
            expect(content.ttft).toBe(1450); // 2450 - 1000
            expect(content.firstChunkTime).toBe(2450);
            expect(content.responseDuration).toBe(2000); // 3000 - 1000
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('未设置请求开始时间时不输出 ttft', () => {
        const acc = new StreamAccumulator('function_call', makeIdFactory());
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1000);
        try {
            acc.add(chunkOf([{ text: 'hello' }])); // 未调用 setRequestStartTime
            const content = acc.getFinalContent();
            expect(content.ttft).toBeUndefined();
            expect(content.responseDuration).toBeUndefined();
        } finally {
            nowSpy.mockRestore();
        }
    });
});