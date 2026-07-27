/**
 * xmlFormatter 回归测试
 *
 * 覆盖两个解析修复：
 * 1. <tool_name> 带属性时（fast-xml-parser 会解析为 { '#text': ..., '@_xxx': ... }），
 *    工具名仍能正确提取为字符串，而不是把对象当作工具名往下传。
 * 2. 带属性的纯文本参数节点（如 <content lang="en">xxx</content>）保留 #text 内容，
 *    而不是把内容整个丢掉变成 {}。
 */

import {
    convertFunctionCallToXML,
    convertFunctionResponseToXML,
    parseXMLToolCalls
} from '../../tools/xmlFormatter';

describe('parseXMLToolCalls - tool_name 形态容错', () => {
    it('常规字符串 tool_name 正常解析（回归保护）', () => {
        const calls = parseXMLToolCalls(`<tool_use>
  <tool_name>read_file</tool_name>
  <parameters>
    <paths><item>a.txt</item></paths>
  </parameters>
</tool_use>`);

        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('read_file');
        expect(calls[0].args).toEqual({ paths: ['a.txt'] });
    });

    it('tool_name 携带属性时仍提取出字符串工具名', () => {
        const calls = parseXMLToolCalls(`<tool_use>
  <tool_name priority="high">read_file</tool_name>
  <parameters>
    <paths><item>a.txt</item></paths>
  </parameters>
</tool_use>`);

        expect(calls).toHaveLength(1);
        expect(typeof calls[0].name).toBe('string');
        expect(calls[0].name).toBe('read_file');
    });

    it('tool_name 为空时跳过该调用', () => {
        const calls = parseXMLToolCalls(`<tool_use>
  <tool_name></tool_name>
  <parameters><path>a.txt</path></parameters>
</tool_use>`);

        expect(calls).toHaveLength(0);
    });
});

describe('parseXMLToolCalls - 带属性参数节点', () => {
    it('带属性的纯文本参数节点保留文本内容', () => {
        const calls = parseXMLToolCalls(`<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <path>a.txt</path>
    <content lang="en">hello world</content>
  </parameters>
</tool_use>`);

        expect(calls).toHaveLength(1);
        expect(calls[0].args.path).toBe('a.txt');
        // 以前这里会因为 #text 与 @_ 属性一起被跳过而丢成 {}
        expect(calls[0].args.content).toBe('hello world');
    });

    it('带属性的嵌套对象参数仍按子元素解析', () => {
        const calls = parseXMLToolCalls(`<tool_use>
  <tool_name>example_tool</tool_name>
  <parameters>
    <options kind="advanced">
      <depth>3</depth>
      <mode>fast</mode>
    </options>
  </parameters>
</tool_use>`);

        expect(calls).toHaveLength(1);
        expect(calls[0].args.options).toEqual({ depth: '3', mode: 'fast' });
    });
});

describe('parseXMLToolCalls - CDATA 感知切块', () => {
    it('CDATA 内包含 </tool_use> 时不提前截断', () => {
        const calls = parseXMLToolCalls(`<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <path>doc.md</path>
    <content><![CDATA[end marker looks like </tool_use> inside cdata]]></content>
  </parameters>
</tool_use>`);

        expect(calls).toHaveLength(1);
        expect(calls[0].args.content).toBe('end marker looks like </tool_use> inside cdata');
    });
});

describe('convertFunctionCallToXML - 历史重放格式', () => {
    it('数组参数重放为 <item> 嵌套元素而非 JSON 文本', () => {
        const xml = convertFunctionCallToXML('read_file', { paths: ['a.txt', 'b.txt'] });

        expect(xml).toContain('<item>a.txt</item>');
        expect(xml).not.toContain('["a.txt"');

        // 重放输出必须能被自己的解析器读回同样的结构
        const calls = parseXMLToolCalls(xml);
        expect(calls).toHaveLength(1);
        expect(calls[0].args).toEqual({ paths: ['a.txt', 'b.txt'] });
    });

    it('对象数组参数重放后可解析回原结构', () => {
        const xml = convertFunctionCallToXML('write_file', {
            files: [{ path: 'a.txt', content: 'if (a < b) {}' }]
        });

        const calls = parseXMLToolCalls(xml);
        expect(calls).toHaveLength(1);
        expect(calls[0].args).toEqual({ files: [{ path: 'a.txt', content: 'if (a < b) {}' }] });
    });

    it('特殊字符标量参数使用 CDATA 保护并可往返', () => {
        const xml = convertFunctionCallToXML('write_file', { path: 'a.txt', content: '<x> & </y>' });

        const calls = parseXMLToolCalls(xml);
        expect(calls[0].args.content).toBe('<x> & </y>');
    });
});

describe('convertFunctionResponseToXML - 响应转义', () => {
    it('响应内容中的标记文本被 CDATA 包裹，不破坏结构', () => {
        const xml = convertFunctionResponseToXML('read_file', {
            success: true,
            content: 'docs about </tool_result> and <tool_use> markers'
        });

        expect(xml).toContain('<![CDATA[');
        // 真正的闭合标签必须在 CDATA 结束之后
        const cdataEnd = xml.lastIndexOf(']]>');
        const closeTag = xml.lastIndexOf('</tool_result>');
        expect(cdataEnd).toBeGreaterThan(-1);
        expect(closeTag).toBeGreaterThan(cdataEnd);
    });

    it('普通响应仍保持可读 JSON 内容', () => {
        const xml = convertFunctionResponseToXML('todo_write', { success: true, total: 3 });

        expect(xml).toContain('"total": 3');
        expect(xml.trim().startsWith('<tool_result tool="todo_write">')).toBe(true);
        expect(xml.trim().endsWith('</tool_result>')).toBe(true);
    });
});
