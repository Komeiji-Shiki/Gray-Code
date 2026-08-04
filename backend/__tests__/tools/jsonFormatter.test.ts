/**
 * jsonFormatter 回归测试
 *
 * 覆盖 JSON 工具调用块解析中的结束标记检测修复：
 * 字符串值里出现字面 <<<END_TOOL_CALL>>>（如 write_file 的 content 恰好含该标记）时，
 * 结束标记检测必须跳过位于 JSON 字符串内部的标记，否则非贪婪正则会在字符串中间
 * 提前截断块，导致 JSON 解析失败。
 */

import {
    convertFunctionCallToJSON,
    parseJSONToolCalls,
    parseJSONToolCall,
    TOOL_CALL_START,
    TOOL_CALL_END
} from '../../tools/jsonFormatter';

describe('parseJSONToolCalls - 基础回归', () => {
    it('单个工具调用正常解析', () => {
        const calls = parseJSONToolCalls(`${TOOL_CALL_START}
{"tool": "read_file", "parameters": {"path": "a.txt"}}
${TOOL_CALL_END}`);

        expect(calls).toHaveLength(1);
        expect(calls[0].tool).toBe('read_file');
        expect(calls[0].parameters).toEqual({ path: 'a.txt' });
    });

    it('多个工具调用按顺序解析', () => {
        const calls = parseJSONToolCalls(`${TOOL_CALL_START}
{"tool": "read_file", "parameters": {"path": "a.txt"}}
${TOOL_CALL_END}
${TOOL_CALL_START}
{"tool": "write_file", "parameters": {"path": "b.txt", "content": "hi"}}
${TOOL_CALL_END}`);

        expect(calls).toHaveLength(2);
        expect(calls[0].tool).toBe('read_file');
        expect(calls[1].tool).toBe('write_file');
    });

    it('parseJSONToolCall 单调用变体返回第一个结果', () => {
        const call = parseJSONToolCall(`${TOOL_CALL_START}
{"tool": "read_file", "parameters": {"path": "a.txt"}}
${TOOL_CALL_END}`);

        expect(call).not.toBeNull();
        expect(call!.tool).toBe('read_file');
    });
});

describe('parseJSONToolCalls - 字符串内结束标记', () => {
    it('字符串值包含字面 <<<END_TOOL_CALL>>> 时不提前截断', () => {
        const text = `${TOOL_CALL_START}
{"tool": "write_file", "parameters": {"path": "a.txt", "content": "prefix ${TOOL_CALL_END} suffix"}}
${TOOL_CALL_END}`;

        const calls = parseJSONToolCalls(text);

        expect(calls).toHaveLength(1);
        expect(calls[0].tool).toBe('write_file');
        expect(calls[0].parameters.content).toBe(`prefix ${TOOL_CALL_END} suffix`);
    });

    it('多行字符串内容（含真实换行）内嵌结束标记时完整解析', () => {
        const text = `${TOOL_CALL_START}
{"tool": "write_file", "parameters": {"path": "a.txt", "content": "line1
${TOOL_CALL_END}
line3"}}
${TOOL_CALL_END}`;

        const calls = parseJSONToolCalls(text);

        expect(calls).toHaveLength(1);
        expect(calls[0].parameters.content).toBe(`line1
${TOOL_CALL_END}
line3`);
    });

    it('字符串内 \\" 转义不影响字符串开关状态，标记仍被跳过', () => {
        const text = `${TOOL_CALL_START}
{"tool": "write_file", "parameters": {"path": "a.txt", "content": "say \\" ${TOOL_CALL_END} inside"}}
${TOOL_CALL_END}`;

        const calls = parseJSONToolCalls(text);

        expect(calls).toHaveLength(1);
        expect(calls[0].parameters.content).toBe(`say " ${TOOL_CALL_END} inside`);
    });

    it('字符串内标记不影响后续工具调用块的解析', () => {
        const text = `${TOOL_CALL_START}
{"tool": "write_file", "parameters": {"path": "a.txt", "content": "x ${TOOL_CALL_END} y"}}
${TOOL_CALL_END}
${TOOL_CALL_START}
{"tool": "read_file", "parameters": {"path": "b.txt"}}
${TOOL_CALL_END}`;

        const calls = parseJSONToolCalls(text);

        expect(calls).toHaveLength(2);
        expect(calls[0].tool).toBe('write_file');
        expect(calls[0].parameters.content).toBe(`x ${TOOL_CALL_END} y`);
        expect(calls[1].tool).toBe('read_file');
        expect(calls[1].parameters).toEqual({ path: 'b.txt' });
    });

    it('convertFunctionCallToJSON 输出含标记内容可被解析读回', () => {
        const json = convertFunctionCallToJSON('write_file', {
            path: 'a.txt',
            content: `hello ${TOOL_CALL_END} world`
        });

        const calls = parseJSONToolCalls(json);

        expect(calls).toHaveLength(1);
        expect(calls[0].parameters.content).toBe(`hello ${TOOL_CALL_END} world`);
    });
});
