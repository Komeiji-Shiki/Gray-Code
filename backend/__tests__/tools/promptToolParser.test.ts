import {
    extractPromptToolParts,
    IncrementalPromptToolParser,
    MALFORMED_TOOL_CALL_NAME,
    TOOL_CALL_PARSE_ERROR_ARG_KEY
} from '../../core/parsers/promptToolParser';
import { TOOL_CALL_END, TOOL_CALL_START } from '../../tools/jsonFormatter';
import { XMLValidator } from 'fast-xml-parser';

function jsonBlock(inner: string): string {
    return `${TOOL_CALL_START}\n${inner}\n${TOOL_CALL_END}`;
}

describe('extractPromptToolParts - JSON 模式', () => {
    test('解析合法的 JSON 工具调用', () => {
        const text = jsonBlock('{"tool": "read_file", "parameters": {"path": "a.txt"}}');

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall).toEqual({
            name: 'read_file',
            args: { path: 'a.txt' }
        });
    });

    test('宽松解析：容忍尾逗号', () => {
        const text = jsonBlock('{"tool": "read_file", "parameters": {"path": "a.txt",},}');

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.name).toBe('read_file');
    });

    test('宽松解析：容忍字符串值内的裸换行', () => {
        const text = jsonBlock(
            '{"tool": "write_file", "parameters": {"path": "a.txt", "content": "line1\nline2"}}'
        );

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.name).toBe('write_file');
        expect(parts[0].functionCall?.args.content).toBe('line1\nline2');
    });

    test('解析失败的非空块生成携带解析错误的合成 functionCall', () => {
        // 单引号 JSON：宽松解析也修不了
        const text = jsonBlock("{'tool': 'read_file', 'parameters': {}}");

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall).toBeDefined();
        expect(parts[0].functionCall?.args[TOOL_CALL_PARSE_ERROR_ARG_KEY]).toContain('could not be parsed');
    });

    test('解析失败时尽力提取意图工具名', () => {
        // JSON 语法错误（缺右括号）但 tool 字段可辨认
        const text = jsonBlock('{"tool": "delete_file", "parameters": {"path": "a.txt"');

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.name).toBe('delete_file');
        expect(parts[0].functionCall?.args[TOOL_CALL_PARSE_ERROR_ARG_KEY]).toBeDefined();
    });

    test('提取不到工具名时使用占位名称', () => {
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

    test('JSON 有效但缺 tool 字段时给出针对性错误', () => {
        const text = jsonBlock('{"parameters": {"path": "a.txt"}}');

        const { parts } = extractPromptToolParts(text, 'json');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.args[TOOL_CALL_PARSE_ERROR_ARG_KEY]).toContain('`tool` field');
    });
});

describe('extractPromptToolParts - XML 模式', () => {
    test('解析包含 CDATA 代码内容的工具调用', () => {
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

    test('数字字符串参数不被 XML 解析器自动转换破坏', () => {
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

    test('缺少 tool_name 的块生成解析失败反馈', () => {
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

    test('对象数组参数（read_file.files）通过 item 元素解析', () => {
        const text = `<tool_use>
  <tool_name>read_file</tool_name>
  <parameters>
    <files>
      <item>
        <path>a.txt</path>
      </item>
      <item>
        <path>b.txt</path>
      </item>
    </files>
  </parameters>
</tool_use>`;

        const { parts } = extractPromptToolParts(text, 'xml');

        expect(parts[0].functionCall?.args.files).toEqual([
            { path: 'a.txt' },
            { path: 'b.txt' }
        ]);
    });

    test('解析器拒绝的块仍生成可读失败反馈（意图工具名保留）', () => {
        // __proto__ 危险键名会让 fast-xml-parser 5.x 直接拒绝整个块（[SECURITY] 错误），
        // 链路必须把解析失败转成携带意图工具名的失败反馈，而不是静默丢弃
        const text = `<tool_use>
  <tool_name>read_file</tool_name>
  <parameters>
    <__proto__><polluted>yes</polluted></__proto__>
    <path>a.txt</path>
  </parameters>
</tool_use>`;

        const { parts } = extractPromptToolParts(text, 'xml');

        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.name).toBe('read_file');
        expect(parts[0].functionCall?.args[TOOL_CALL_PARSE_ERROR_ARG_KEY]).toBeDefined();
        expect(parts[0].functionCall?.args[TOOL_CALL_PARSE_ERROR_ARG_KEY]).toContain('could not be parsed');
    });

    test('DOCTYPE 自定义实体不被展开（processEntities: false 链路保护）', () => {
        const text = `<!DOCTYPE tool_use [
  <!ENTITY secret "expanded-value">
]>
<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <path>a.txt</path>
    <content>&secret;</content>
  </parameters>
</tool_use>`;

        const { parts } = extractPromptToolParts(text, 'xml');

        // DOCTYPE 声明作为块前文本透出，工具调用本身正常解析
        const fnPart = parts.find(p => p.functionCall);
        expect(fnPart?.functionCall?.name).toBe('write_file');
        // 实体引用保持字面量，不展开为 expanded-value
        expect(fnPart?.functionCall?.args.content).toBe('&secret;');
    });

    test('超深嵌套输入被拒绝并转为可读失败反馈，不抛异常不执行', () => {
        const depth = 150;
        const nested = '<a>'.repeat(depth) + '</a>'.repeat(depth);
        const text = `<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <content>${nested}</content>
  </parameters>
</tool_use>`;

        const { parts } = extractPromptToolParts(text, 'xml');

        // maxNestedTags: 100 超限后整个块被拒绝，转为携带意图工具名的失败反馈
        expect(parts).toHaveLength(1);
        expect(parts[0].functionCall?.name).toBe('write_file');
        expect(parts[0].functionCall?.args[TOOL_CALL_PARSE_ERROR_ARG_KEY]).toBeDefined();
    });

    test('XMLValidator.validate 错误对象仍包含 err.msg 和 err.line（5.10.1 API 回归）', () => {
        // 失败诊断路径依赖 validator 的报错形状；XMLParser 5.x 对语法错误很宽容，
        // 所以直接针对 validator API 锁定 err.msg / err.line 结构
        const result = XMLValidator.validate('<tool_use><parameters><path>a.txt</parameters></tool_use>');

        expect(result).not.toBe(true);
        if (result !== true) {
            expect(typeof result.err.msg).toBe('string');
            expect(typeof result.err.line).toBe('number');
        }
    });
});

describe('IncrementalPromptToolParser - 增量解析与 CDATA 边界', () => {
    test('XML 模式：CDATA 内的 </tool_use> 不结束块（整体输入）', () => {
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

    test('XML 模式：跨 chunk 劈开的 CDATA 与结束标记仍正确解析', () => {
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

    test('JSON 模式：结束标记被 chunk 边界劈开仍正确解析', () => {
        const text = `${TOOL_CALL_START}\n{"tool": "read_file", "parameters": {"path": "a.txt"}}\n${TOOL_CALL_END}after`;

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
