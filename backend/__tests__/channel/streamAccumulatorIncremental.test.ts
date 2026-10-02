/**
 * StreamAccumulator 增量热路径回归测试
 *
 * 1. Responses 思考摘要：正常顺序直接追加，乱序 / done 替换 / 其他分支改写后回退到完整排序校准；
 *    多段顺序、done 替换与最终全文需要与完整校准逐字一致。
 * 2. 非 Responses 工具参数：用增量闭合扫描门控 JSON.parse，只在顶层对象可能闭合时解析；
 *    预填参数、非对象值、整体替换回退旧行为，中断保存与最终错误保持不变。
 */

import { StreamAccumulator } from '../../modules/channel';
import type { StreamChunk } from '../../modules/channel';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { tryParseFunctionCallArgs } from '../../modules/channel/streamAccumulator/streamContentBuilder';

function makeIdFactory(): () => string {
    let n = 0;
    return () => `test_fc_${++n}`;
}

function chunkOf(parts: unknown[], extra: Partial<StreamChunk> = {}): StreamChunk {
    return { delta: parts, ...extra } as unknown as StreamChunk;
}

function countJsonParse<T>(fn: () => T): { result: T; calls: number } {
    const realParse = JSON.parse;
    let calls = 0;
    const spy = jest.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: any) => {
        calls++;
        return realParse(text, reviver);
    }) as typeof JSON.parse);
    try {
        return { result: fn(), calls };
    } finally {
        spy.mockRestore();
    }
}

function createResponsesStream() {
    const formatter = new OpenAIResponsesFormatter();
    const accumulator = new StreamAccumulator();
    accumulator.setProviderType('openai-responses');
    const visible: string[] = [];
    const feed = (event: Record<string, unknown>) => {
        const delta = accumulator.add(formatter.parseStreamChunk({ output_index: 0, item_id: 'rs_1', ...event }));
        visible.push(...delta.filter(part => part.thought).map(part => part.text || ''));
        return delta;
    };
    feed({ type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning', summary: [] } });
    const summaryDelta = (summary_index: number, delta: string) =>
        feed({ type: 'response.reasoning_summary_text.delta', summary_index, delta });
    const thought = () => accumulator.getStreamingContent().parts.find(part => part.thought)!;
    return { accumulator, feed, summaryDelta, visible, thought };
}

describe('StreamAccumulator - Responses 摘要增量追加', () => {
    test('正常追加：逐片段产出增量，不递增修订号，全文与摘要逐字一致', () => {
        const { accumulator, summaryDelta, visible, thought } = createResponsesStream();
        summaryDelta(0, '先');
        const revision = accumulator.getContentRevision();
        const pieces = Array.from({ length: 200 }, (_, i) => `片段${i} `);
        for (const piece of pieces) summaryDelta(0, piece);

        const expected = '先' + pieces.join('');
        expect(accumulator.getContentRevision()).toBe(revision);
        expect(visible.join('')).toBe(expected);
        expect(thought()).toMatchObject({
            text: expected,
            openaiResponsesReasoning: { id: 'rs_1', status: 'in_progress', summary: [{ type: 'summary_text', text: expected }] }
        });
    });

    test('多段摘要：新段以换行衔接，空增量开启的新段也保持 join 语义', () => {
        const { summaryDelta, feed, visible, thought } = createResponsesStream();
        summaryDelta(0, '第一');
        summaryDelta(0, '段');
        feed({ type: 'response.reasoning_summary_part.added', summary_index: 1, part: { type: 'summary_text', text: '' } });
        summaryDelta(1, '');
        summaryDelta(1, '第二段');
        summaryDelta(2, '第三');
        summaryDelta(2, '段');

        expect(visible.join('')).toBe('第一段\n第二段\n第三段');
        expect(thought()).toMatchObject({
            text: '第一段\n第二段\n第三段',
            openaiResponsesReasoning: { summary: [
                { type: 'summary_text', text: '第一段' },
                { type: 'summary_text', text: '第二段' },
                { type: 'summary_text', text: '第三段' }
            ] }
        });
    });

    test('乱序 delta：较早段与较小新索引重新排序，修订号递增，之后继续正常追加', () => {
        const { accumulator, summaryDelta, visible, thought } = createResponsesStream();
        summaryDelta(0, 'A');
        summaryDelta(2, 'C');
        const revision = accumulator.getContentRevision();

        // 较早段收到 delta：全文不再是旧全文的追加，只能由快照校准
        summaryDelta(0, 'a');
        expect(thought().text).toBe('Aa\nC');
        expect(accumulator.getContentRevision()).toBeGreaterThan(revision);

        // 新段索引小于已有最大值：按索引插入中间
        summaryDelta(1, 'B');
        expect(thought().text).toBe('Aa\nB\nC');

        // 回到最后一段继续追加：恢复增量产出
        const before = accumulator.getContentRevision();
        summaryDelta(2, 'c');
        expect(accumulator.getContentRevision()).toBe(before);
        expect(visible.at(-1)).toBe('c');
        expect(thought()).toMatchObject({
            text: 'Aa\nB\nCc',
            openaiResponsesReasoning: { summary: [
                { type: 'summary_text', text: 'Aa' },
                { type: 'summary_text', text: 'B' },
                { type: 'summary_text', text: 'Cc' }
            ] }
        });
        // 乱序插入的部分不作为增量重复发送，只有可前缀追加的部分出现在 visible 中
        expect(visible).toEqual(['A', '\nC', 'c']);
    });

    test('done 替换：以 done 全文替换对应段，之后的 delta 基于替换后全文继续', () => {
        const { accumulator, summaryDelta, feed, thought } = createResponsesStream();
        summaryDelta(0, '草稿');
        const revision = accumulator.getContentRevision();
        feed({ type: 'response.reasoning_summary_text.done', summary_index: 0, text: '定稿' });
        expect(accumulator.getContentRevision()).toBeGreaterThan(revision);
        expect(thought()).toMatchObject({
            text: '定稿',
            openaiResponsesReasoning: { status: 'completed', summary: [{ type: 'summary_text', text: '定稿' }] }
        });

        summaryDelta(1, '第二段');
        expect(thought()).toMatchObject({
            text: '定稿\n第二段',
            openaiResponsesReasoning: { status: 'in_progress' }
        });

        feed({ type: 'response.output_item.done', item: {
            id: 'rs_1', type: 'reasoning', status: 'completed', encrypted_content: 'enc',
            summary: [{ type: 'summary_text', text: '定稿' }, { type: 'summary_text', text: '权威第二段' }]
        } });
        expect(accumulator.getFinalContent().parts[0]).toMatchObject({
            text: '定稿\n权威第二段',
            thoughtSignatures: { 'openai-responses': 'enc' },
            openaiResponsesReasoning: { status: 'completed', summary: [
                { type: 'summary_text', text: '定稿' },
                { type: 'summary_text', text: '权威第二段' }
            ] }
        });
    });

    test('其他分支改写 part 后回退完整校准：沿用分段状态而不是被改写的全文', () => {
        const { accumulator, summaryDelta, feed, thought } = createResponsesStream();
        summaryDelta(0, '摘要');
        // reasoning_text 增量走通用合并分支，直接改写 part.text
        feed({ type: 'response.reasoning_text.delta', delta: '正文' });
        expect(thought().text).toBe('摘要正文');

        const revision = accumulator.getContentRevision();
        summaryDelta(0, '续');
        expect(thought().text).toBe('摘要续');
        expect(accumulator.getContentRevision()).toBeGreaterThan(revision);
    });
});

describe('StreamAccumulator - 工具参数增量解析门控', () => {
    /** 修改前的语义：每个片段追加后对累计全文执行一次 tryParseFunctionCallArgs */
    function referenceStates(initial: Record<string, unknown>, fragments: string[]) {
        const fc: any = { ...initial };
        return fragments.map(fragment => {
            fc.partialArgs = (fc.partialArgs || '') + fragment;
            if (fc.partialArgs.trim()) tryParseFunctionCallArgs(fc);
            return { args: fc.args, partialArgs: fc.partialArgs, prefilledArgs: fc.prefilledArgs };
        });
    }

    function streamFragments(provider: 'openai' | 'anthropic', start: Record<string, unknown>, fragments: string[]) {
        const acc = new StreamAccumulator('function_call', makeIdFactory());
        acc.setProviderType(provider);
        acc.add(chunkOf([{ functionCall: start }]));
        const states = fragments.map(fragment => {
            acc.add(chunkOf([{ functionCall: { name: '', args: {}, partialArgs: fragment, index: 0 } }]));
            const fc = acc.getStreamingContent().parts.find(part => part.functionCall)!.functionCall as any;
            return { args: fc.args, partialArgs: fc.partialArgs, prefilledArgs: fc.prefilledArgs };
        });
        return { acc, states };
    }

    function splitEvery(text: string, size: number): string[] {
        const out: string[] = [];
        for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
        return out;
    }

    test('OpenAI 长参数分片：只在闭合时解析，结果与逐片段解析一致且只上报一次', () => {
        const args = { path: 'src/a.ts', content: 'line\n'.repeat(400) };
        const fragments = splitEvery(JSON.stringify(args), 3);
        const start = { name: 'write_file', args: {}, partialArgs: '', id: 'call_1', index: 0 };

        const { result, calls } = countJsonParse(() => streamFragments('openai', start, fragments));
        expect(result.states).toEqual(referenceStates(start, fragments));
        expect(calls).toBe(1);

        const completed = result.acc.getNewCompletedFunctionCalls();
        expect(completed).toEqual([{ index: 0, name: 'write_file', id: 'call_1', args }]);
        expect(result.acc.getNewCompletedFunctionCalls()).toHaveLength(0);
        expect(result.acc.getFinalContent().parts[0].functionCall?.args).toEqual(args);
    });

    test('字符串中含括号与转义引号：不被误判闭合，逐字符分片仍在真正结尾完成', () => {
        const args = { content: 'if (a) { b["}"] = "\\"{"; }\\', nested: { list: [1, { k: '}]' }] } };
        const text = JSON.stringify(args);
        const fragments = splitEvery(text, 1);
        const start = { name: 'edit', args: {}, partialArgs: '', id: 'call_1', index: 0 };

        const { result, calls } = countJsonParse(() => streamFragments('openai', start, fragments));
        expect(result.states).toEqual(referenceStates(start, fragments));
        expect(calls).toBe(1);
        // 最后一个字符之前一直未完成
        expect(result.states[fragments.length - 2].args).toEqual({});
        expect(result.states[fragments.length - 1].args).toEqual(args);
    });

    test('Anthropic 空对象预填：增量自身构成完整 JSON 时完成', () => {
        const start = { name: 'read_file', args: {}, partialArgs: '', prefilledArgs: true, id: 'toolu_1', index: 0 };
        const fragments = ['{"pa', 'th":"a', '.txt"', '}'];
        const { result, calls } = countJsonParse(() => streamFragments('anthropic', start, fragments));
        expect(result.states).toEqual(referenceStates(start, fragments));
        expect(calls).toBeLessThanOrEqual(2);
        expect(result.acc.getNewCompletedFunctionCalls()).toEqual([
            { index: 0, name: 'read_file', id: 'toolu_1', args: { path: 'a.txt' } }
        ]);
    });

    test('Anthropic 非空预填：剩余片段与完整重放两种语义都与旧行为一致', () => {
        const start = { name: 'edit', args: { a: 1 }, partialArgs: '', prefilledArgs: true, id: 'toolu_1', index: 0 };
        const remainder = [',"b":', '"x}"', '}'];
        const remainderRun = streamFragments('anthropic', start, remainder);
        expect(remainderRun.states).toEqual(referenceStates(start, remainder));
        expect(remainderRun.states.at(-1)?.args).toEqual({ a: 1, b: 'x}' });

        const replay = ['{"a":1,', '"b":2}'];
        const replayRun = streamFragments('anthropic', start, replay);
        expect(replayRun.states).toEqual(referenceStates(start, replay));
        expect(replayRun.states.at(-1)?.args).toEqual({ a: 1, b: 2 });
    });

    test('Anthropic 空参数且无增量：content_block_stop 后可提前执行', () => {
        const acc = new StreamAccumulator('function_call', makeIdFactory());
        acc.setProviderType('anthropic');
        acc.add(chunkOf([{ functionCall: { name: 'list', args: {}, partialArgs: '', prefilledArgs: true, id: 'toolu_1', index: 0 } }]));
        acc.add(chunkOf([{ functionCall: { name: '', args: {}, partialArgs: '', index: 0 } }]));
        acc.add(chunkOf([], { providerEvent: { type: 'content_block_stop', contentIndex: 0 } }));
        expect(acc.getFinalContent().parts[0].functionCall).toEqual({ name: 'list', args: {}, id: 'toolu_1' });
    });

    test('非对象值与前导非 JSON 空白：回退逐片段解析，最终错误不变', () => {
        const start = { name: 'tool', args: {}, partialArgs: '', id: 'call_1', index: 0 };
        for (const fragments of [['[1,', '2]'], ['"str', 'ing"'], ['\u00a0{"a"', ':1}']]) {
            const run = streamFragments('openai', start, fragments);
            expect(run.states).toEqual(referenceStates(start, fragments));
            expect(() => run.acc.getFinalContent()).toThrow(/Arguments for tool "tool" must be a JSON object|Invalid JSON arguments for tool "tool"/);
        }
    });

    test('整体替换（finalArgs）后重新扫描，替换后的增量仍能完成', () => {
        const acc = new StreamAccumulator('function_call', makeIdFactory());
        acc.setProviderType('custom');
        acc.add(chunkOf([{ functionCall: { name: 'tool', args: {}, partialArgs: '{"a":', id: 'call_1', index: 0 } }]));
        acc.add(chunkOf([{ functionCall: { args: {}, partialArgs: '{"b":', index: 0, finalArgs: true } }]));
        acc.add(chunkOf([{ functionCall: { args: {}, partialArgs: '2}', index: 0 } }]));
        expect(acc.getFinalContent().parts[0].functionCall?.args).toEqual({ b: 2 });
    });

    test('中断时保存的部分参数与最终解析错误保持不变', () => {
        const start = { name: 'write_file', args: {}, partialArgs: '', id: 'call_1', index: 0 };
        const fragments = ['{"path":"a.ts",', '"content":"{unfinished'];
        const { acc, states } = streamFragments('openai', start, fragments);
        expect(states).toEqual(referenceStates(start, fragments));

        const streaming = acc.getStreamingContent({ parsePartialArgs: true }).parts[0].functionCall as any;
        expect(streaming).toMatchObject({ args: {}, partialArgs: '{"path":"a.ts","content":"{unfinished', index: 0 });
        expect(acc.getStreamingContent({ parsePartialArgs: true, includeInternalFields: false }).parts[0].functionCall)
            .toEqual({ name: 'write_file', args: {}, id: 'call_1' });
        expect(acc.getNewCompletedFunctionCalls()).toHaveLength(0);
        expect(() => acc.getFinalContent()).toThrow('Invalid JSON arguments for tool "write_file"');
    });

    test('闭合后的多余片段与括号错配：与逐片段解析结果一致', () => {
        const start = { name: 'tool', args: {}, partialArgs: '', id: 'call_1', index: 0 };
        for (const fragments of [['{"a":1}', '{"b":2}'], ['{"a":[1}', ']}'], ['{"a":1}}', '']]) {
            const run = streamFragments('openai', start, fragments);
            expect(run.states).toEqual(referenceStates(start, fragments));
        }
    });
});
