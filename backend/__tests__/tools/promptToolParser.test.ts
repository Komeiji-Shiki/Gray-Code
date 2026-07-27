import {
    extractPromptToolParts,
    IncrementalPromptToolParser,
    MALFORMED_TOOL_CALL_NAME,
    TOOL_CALL_PARSE_ERROR_ARG_KEY
} from '../../tools/promptToolParser';
import { TOOL_CALL_END, TOOL_CALL_START } from '../../tools/jsonFormatter';

function jsonBlock(inner: string): string {
    return `${TOOL_CALL_START}\n${inner}\n${TOOL_CALL_END}`;
}

describe('extractPromptToolParts - JSON 模式', () => {
    it('解析合法的 JSON 工具调用', () => {
        const text = jsonBlock('{"tool": "read_file", "parameters": {"paths": ["a.txt"]}}');

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall).toEqual({
            name: 'read_file',
            args: { paths: ['a.txt'] }
        });
    });

    it('宽松解析：容忍尾逗号', () => {
        const text = jsonBlock('{"tool": "read_file", "parameters": {"paths": ["a.txt"],},}');

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.name).toBe('read_file');
    });

    it('宽松解析：容忍字符串值内的裸换行', () => {
        const text = jsonBlock(
            '{"tool": "write_file", "parameters": {"files": [{"path": "a.txt", "content": "line1\nline2"}]}}'
        );

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.name).toBe('write_file');
        const files = parts[0].functionCall?.args.files as Array<{ path: string; content: string }>;
        expect(files[0].content).toBe('line1\nline2');
    });

    it('解析失败的非空块生成携带解析错误的合成 functionCall', () => {
        // 单引号 JSON：宽松解析也修不了
        const text = jsonBlock("{'tool': 'read_file', 'parameters': {}}");

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall).toBeDefined();
        expect(parts[0].functionCall?.args[TOOL_CALL_PARSE_ERROR_ARG_KEY]).toContain('could not be parsed');
    });

    it('解析失败时尽力提取意图工具名', () => {
        // JSON 语法错误（缺右括号）但 tool 字段可辨认
        const text = jsonBlock('{"tool": "delete_file", "parameters": {"paths": ["a.txt"]');

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.name).toBe('delete_file');
        expect(parts[0].functionCall?.args[TOOL_CALL_PARSE_ERROR_ARG_KEY]).toBeDefined();
    });

    it('提取不到工具名时使用占位名称', () => {
        const text = jsonBlock('this is not json at all');

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.name).toBe(MALFORMED_TOOL_CALL_NAME);
    });

    it('空块保持文本处理（非调用意图）', () => {
        const text = `${TOOL_CALL_START}${TOOL_CALL_END}`;

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].text).toBe(text);
        expect(parts[0].functionCall).toBeUndefined();
    });

    it('JSON 有效但缺 tool 字段时给出针对性错误', () => {
        const text = jsonBlock('{"parameters": {"paths": ["a.txt"]}}');

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.args[TOOL_CALL_PARSE_ERROR_ARG_KEY]).toContain('`tool` field');
    });
});

describe('extractPromptToolParts - XML 模式', () => {
    it('解析包含 CDATA 代码内容的工具调用', () => {
        const text = `<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <path>index.html</path>
    <content><![CDATA[<html>if (a < b && c > d) {}</html>]]></content>
  </parameters>
</tool_use>`;

        const { parts } = extractPromptToolParts(text, 'xml');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.name).toBe('write_file');
        expect(parts[0].functionCall?.args.content).toBe('<html>if (a < b && c > d) {}</html>');
    });

    it('数字字符串参数不被 XML 解析器自动转换破坏', () => {
        const text = `<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <path>version.txt</path>
    <content>1.10</content>
  </parameters>
</tool_use>`;

        const { parts } = extractPromptToolParts(text, 'xml');

        // parseTagValue: false 保证 "1.10" 不会变成数字 1.1；
        // 类型还原由 schema 驱动的 normalizeToolArgs 负责
        expect(parts[0].functionCall?.args.content).toBe('1.10');
    });

    it('缺少 tool_name 的块生成解析失败反馈', () => {
        const text = `<tool_use>
  <parameters>
    <path>a.txt</path>
  </parameters>
</tool_use>`;

        const { parts } = extractPromptToolParts(text, 'xml');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.name).toBe(MALFORMED_TOOL_CALL_NAME);
        expect(parts[0].functionCall?.args[TOOL_CALL_PARSE_ERROR_ARG_KEY]).toBeDefined();
    });

    it('数组参数通过 item 元素解析', () => {
        const text = `<tool_use>
  <tool_name>read_file</tool_name>
  <parameters>
    <paths>
      <item>a.txt</item>
      <item>b.txt</item>
    </paths>
  </parameters>
</tool_use>`;

        const { parts } = extractPromptToolParts(text, 'xml');

        expect(parts[0].functionCall?.args.paths).toEqual(['a.txt', 'b.txt']);
    });
});

describe('IncrementalPromptToolParser - 增量解析与 CDATA 边界', () => {
    it('XML 模式：CDATA 内的 </tool_use> 不结束块（整体输入）', () => {
        const text = `<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <path>doc.md</path>
    <content><![CDATA[fake </tool_use> marker]]></content>
  </parameters>
</tool_use>`;

        const { parts } = extractPromptToolParts(text, 'xml');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.args.content).toBe('fake </tool_use> marker');
    });

    it('XML 模式：跨 chunk 劈开的 CDATA 与结束标记仍正确解析', () => {
        const text = '<tool_use><tool_name>write_file</tool_name><parameters>'
            + '<path>a.md</path><content><![CDATA[fake </tool_use> here]]></content>'
            + '</parameters></tool_use>tail text';

        // 多种 chunk 尺寸遭尽各种标记被劈开的边界情况（1 = 逐字符最严格）
        for (const chunkSize of [1, 3, 7, 16]) {
            const parser = new IncrementalPromptToolParser('xml');
            const parts: any[] = [];
            for (let i = 0; i < text.length; i += chunkSize) {
                parts.push(...parser.appendText(text.slice(i, i + chunkSize)));
            }
            parts.push(...parser.flushIncompleteAsText());

            const fnPart = parts.find(p => p.functionCall);
            expect(fnPart?.functionCall?.args.content).toBe('fake </tool_use> here');

            const tail = parts.filter(p => p.text).map(p => p.text).join('');
            expect(tail).toBe('tail text');
        }
    });

    it('JSON 模式：结束标记被 chunk 边界劈开仍正确解析', () => {
        const text = `${TOOL_CALL_START}\n{"tool": "read_file", "parameters": {"paths": ["a.txt"]}}\n${TOOL_CALL_END}after`;

        for (const chunkSize of [1, 5, 11]) {
            const parser = new IncrementalPromptToolParser('json');
            const parts: any[] = [];
            for (let i = 0; i < text.length; i += chunkSize) {
                parts.push(...parser.appendText(text.slice(i, i + chunkSize)));
            }
            parts.push(...parser.flushIncompleteAsText());

            const fnPart = parts.find(p => p.functionCall);
            expect(fnPart?.functionCall?.name).toBe('read_file');

            const tail = parts.filter(p => p.text).map(p => p.text).join('');
            expect(tail).toBe('after');
        }
    });
});
