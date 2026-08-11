/**
 * GrayCode - XML 工具格式转换器
 *
 * 将工具声明转换为 XML 提示词格式
 * 使用 fast-xml-parser 进行 XML 解析
 */

import { XMLParser } from 'fast-xml-parser';
import type { ToolDeclaration } from './types';

/**
 * XML 解析器配置
 *
 * parseTagValue / parseAttributeValue 必须为 false：
 * fast-xml-parser 的自动类型转换会破坏字符串参数（"1.10" → 1.1、
 * "007" → 7、纯数字文件内容变成 number），写文件场景会静默损坏内容。
 * 正确的类型还原由 schema 驱动的 normalizeToolArgs（递归 coerce）完成，
 * 那边知道每个参数应该是什么类型，而不是靠 XML 解析器猜。
 *
 * processEntities: false / maxNestedTags: 100 是安全加固（F-01）：
 * 工具调用协议不需要 DOCTYPE 或自定义实体，禁止处理实体可以避免
 * 实体展开与递归膨胀攻击；maxNestedTags 限制模型输出的嵌套深度。
 */
const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    processEntities: false,
    maxNestedTags: 100
});

/**
 * 格式化参数类型信息
 */
function formatParameterType(schema: any): string {
    if (schema.type === 'array') {
        const itemType = schema.items?.type || 'any';
        return `array of ${itemType}`;
    }
    if (schema.type === 'object' && schema.properties) {
        const props = Object.keys(schema.properties).join(', ');
        return `object with properties: ${props}`;
    }
    return schema.type || 'any';
}

/**
 * 将工具声明转换为 XML 格式的提示词
 *
 * @param tools 工具声明数组
 * @returns XML 格式的工具说明文本
 */
export function convertToolsToXML(tools: ToolDeclaration[]): string {
    if (!tools || tools.length === 0) {
        return '';
    }
    
    const toolDescriptions = tools.map(tool => {
        // 生成参数说明
        const params = tool.parameters.properties;
        const required = tool.parameters.required || [];
        
        const paramsList = Object.entries(params).map(([name, schema]: [string, any]) => {
            const isRequired = required.includes(name);
            const requiredTag = isRequired ? ' (required)' : ' (optional)';
            const typeInfo = formatParameterType(schema);
            // 修改原因：schema.description 原样嵌入会携带 <、>、& 等字符，生成的工具指南是非法 XML。
            // 修改方式：与 <description> 正文一致，统一走 wrapXmlValue（含特殊字符/换行时包 CDATA）。
            const description = wrapXmlValue(schema.description || '');
            return `  - ${name}${requiredTag} [${typeInfo}]: ${description}`;
        }).join('\n');
        
        // 修改原因：tool.description 原样嵌入，execute_command 等工具的 description 含 <、>、&、" 字符 → 畸形 XML。
        // 修改方式：统一走 wrapXmlValue（含 XML 特殊字符或换行时包 CDATA）。
        return `<tool name="${escapeXmlAttribute(tool.name)}">
  <description>
${wrapXmlValue(tool.description)}
  </description>
  <parameters>
${paramsList}
  </parameters>
</tool>`;
    }).join('\n\n');
    
    return `## Tool Usage Guide

You are a powerful AI assistant with access to various tools. You should actively use these tools to gather information, perform actions, and provide accurate responses.

### How to Call Tools

When you need to use a tool, respond with XML format:
<tool_use>
  <tool_name>tool name here</tool_name>
  <parameters>
    <parameter_name>value</parameter_name>
    <!-- For array parameters, use multiple <item> elements: -->
    <array_param>
      <item>value1</item>
      <item>value2</item>
    </array_param>
    <!-- For object parameters, use nested elements: -->
    <object_param>
      <property1>value1</property1>
      <property2>value2</property2>
    </object_param>
  </parameters>
</tool_use>

**CRITICAL - CDATA for code and special characters**: If a parameter value contains \`<\`, \`>\`, \`&\`, or multi-line code, you MUST wrap the value in a CDATA section, otherwise the XML cannot be parsed:
<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <path>index.html</path>
    <content><![CDATA[<html>
  <body>if (a < b && c > d) { ... }</body>
</html>]]></content>
  </parameters>
</tool_use>

### Examples

Reading a single file:
<tool_use>
  <tool_name>read_file</tool_name>
  <parameters>
    <path>src/main.ts</path>
  </parameters>
</tool_use>

Reading multiple files (each item may optionally specify a line range):
<tool_use>
  <tool_name>read_file</tool_name>
  <parameters>
    <files>
      <item>
        <path>file1.txt</path>
      </item>
      <item>
        <path>src/main.ts</path>
        <startLine>10</startLine>
        <endLine>20</endLine>
      </item>
    </files>
  </parameters>
</tool_use>

Writing files:
<tool_use>
  <tool_name>write_file</tool_name>
  <parameters>
    <path>file1.txt</path>
    <content>Hello, World!</content>
  </parameters>
</tool_use>

### Best Practices

1. **Actively use tools**: When you need information you don't have, use the appropriate tool to get it. Don't guess or make assumptions when tools can provide accurate data.

2. **Place tool calls at the end**: Structure your response so that tool calls appear at the end of your message. First provide any explanations or context, then call the necessary tools.

3. **One step at a time**: After each tool call, wait for the result before proceeding. Use the tool results to inform your next steps.

4. **Combine tools effectively**: You can call multiple tools in a single response when needed. Use the results from one tool to inform subsequent tool calls.

---

## Available Tools

${toolDescriptions}`;
}

/**
 * 将参数值包装为 XML 安全的文本：含 XML 特殊字符或换行时用 CDATA 包裹。
 * CDATA 内容中出现 "]]>" 时按标准做分段处理。
 */
function wrapXmlValue(value: string): string {
    if (!/[<>&]/.test(value) && !value.includes('\n')) {
        return value;
    }
    return `<![CDATA[${value.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

/**
 * XML 属性值转义：属性不能使用 CDATA，必须做实体转义。
 * 用于 <tool_result tool="..."> 等属性插值，防止工具名含引号/尖括号时破坏重放历史结构。
 */
function escapeXmlAttribute(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/** 合法 XML 元素名（保守子集：字母/下划线开头，仅含字母数字、_ . -） */
const XML_ELEMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

/**
 * 危险对象键名：解析出的参数键若为这些名字，直接跳过。
 * fast-xml-parser 5.x 已有危险属性处理，这里在协议层再挡一层，
 * 确保 `__proto__` / `constructor` 等键不会污染最终参数对象的原型。
 */
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);


/** 空容器占位标记属性：XML 无法直接表达空数组/空对象（round-trip 后空元素会变成空字符串），
 * 序列化端把空数组/空对象写成带标记的 <item/>，解析端据此还原为 [] / {}。 */
const EMPTY_CONTAINER_ATTR = '__graycode_empty';
const EMPTY_CONTAINER_ARRAY = 'array';
const EMPTY_CONTAINER_OBJECT = 'object';
/**
 * 非法 XML 键名的可逆表示。
 *
 * 只对无法直接用作元素名的键、保留标签本身及危险键使用该包装；普通参数
 * 继续保持原来的 `<key>value</key>` 格式。键名按 UTF-16 code unit 编成十六进制，
 * 因而任意 JavaScript 字符串（包括空串与未配对代理项）都能安全、无损地放进
 * XML 属性值，而不受 XML 名称和控制字符限制。
 */
const ENCODED_OBJECT_KEY_TAG = '__graycode_encoded_key__';
const ENCODED_OBJECT_KEY_FORMAT = 'utf16-hex';

function isValidXmlElementName(name: string): boolean {
    return XML_ELEMENT_NAME_RE.test(name);
}

function shouldEncodeObjectKey(name: string): boolean {
    return !isValidXmlElementName(name)
        || name === ENCODED_OBJECT_KEY_TAG
        || DANGEROUS_OBJECT_KEYS.has(name);
}

function encodeObjectKey(name: string): string {
    let encoded = '';
    for (let i = 0; i < name.length; i++) {
        encoded += name.charCodeAt(i).toString(16).padStart(4, '0');
    }
    return encoded;
}

function decodeObjectKey(encoded: string): string | null {
    if (encoded.length % 4 !== 0 || !/^[0-9a-f]*$/i.test(encoded)) {
        return null;
    }

    let decoded = '';
    for (let i = 0; i < encoded.length; i += 4) {
        decoded += String.fromCharCode(Number.parseInt(encoded.slice(i, i + 4), 16));
    }
    return decoded;
}

/** 序列化对象属性；非法键使用带编码元数据的保留元素包装。 */
function serializeObjectProperty(key: string, value: unknown, indent: string): string {
    if (!shouldEncodeObjectKey(key)) {
        return `${indent}<${key}>${serializeParameterValue(value, indent)}</${key}>`;
    }

    const encodedKey = encodeObjectKey(key);
    return `${indent}<${ENCODED_OBJECT_KEY_TAG} encoding="${ENCODED_OBJECT_KEY_FORMAT}" name="${encodedKey}">${serializeParameterValue(value, indent)}</${ENCODED_OBJECT_KEY_TAG}>`;
}

/**
 * 将参数值递归序列化为与工具指南一致的 XML 结构：
 * 数组 → <item> 列表，对象 → 嵌套元素，标量 → 文本（必要时 CDATA）。
 *
 * 修改原因：以前对象/数组参数被 JSON.stringify 成文本节点重放，与提示词
 * 教模型的嵌套元素格式不一致，模型会模仿历史里的 JSON-in-XML 错误格式。
 * 键名不是合法 XML 元素名时使用带编码键名的保留元素，既保证 XML 合法，
 * 也让解析器能无损还原对象结构，而不是把整层对象降级成 JSON 字符串。
 */
function serializeParameterValue(value: unknown, indent: string): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value !== 'object') {
        return wrapXmlValue(String(value));
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            // 空数组占位：不加标记会被解析成空字符串，round-trip 后 [] 失真
            const childIndent = `${indent}  `;
            return `\n${childIndent}<item ${EMPTY_CONTAINER_ATTR}="${EMPTY_CONTAINER_ARRAY}"/>\n${indent}`;
        }
        const childIndent = `${indent}  `;
        const inner = value
            .map(item => `${childIndent}<item>${serializeParameterValue(item, childIndent)}</item>`)
            .join('\n');
        return `\n${inner}\n${indent}`;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
        // 空对象占位：不加标记会被解析成空字符串，round-trip 后 {} 失真
        const childIndent = `${indent}  `;
        return `\n${childIndent}<item ${EMPTY_CONTAINER_ATTR}="${EMPTY_CONTAINER_OBJECT}"/>\n${indent}`;
    }
    const childIndent = `${indent}  `;
    const inner = entries
        .map(([key, val]) => serializeObjectProperty(key, val, childIndent))
        .join('\n');
    return `\n${inner}\n${indent}`;
}

/**
 * 将 functionCall 转换为 XML 格式的文本
 *
 * 用于历史重放：必须产出合法 XML，否则模型会“学到”非法格式并在
 * 后续输出中重复同样的错误（代码内容几乎必然包含 < > & 等字符）。
 *
 * @param name 工具名称
 * @param args 工具参数
 * @returns XML 格式的工具调用文本
 */
export function convertFunctionCallToXML(name: string, args: Record<string, any>): string {
    const entries = Object.entries(args);
    const params = entries
        .map(([key, value]) => serializeObjectProperty(key, value, '    '))
        .join('\n');

    return `<tool_use>
  <tool_name>${wrapXmlValue(name)}</tool_name>
  <parameters>
${params}
  </parameters>
</tool_use>`;
}

/**
 * 将 functionResponse 转换为 XML 格式的文本
 *
 * @param name 工具名称
 * @param response 工具响应
 * @returns XML 格式的工具响应文本
 *
 * 注意：multimodal 字段会被移除，因为多模态数据应该作为 inlineData 附件单独发送
 */
export function convertFunctionResponseToXML(name: string, response: Record<string, any>): string {
    // 移除 multimodal 字段，避免将 base64 图片数据嵌入文本
    // multimodal 数据应该作为 inlineData parts 单独发送
    const { multimodal, ...textResponse } = response;
    // CDATA 包裹：响应内容里出现 </tool_result> 或 <tool_use> 等标记文本时，
    // 裸嵌会破坏重放历史的结构（调用侧 wrapXmlValue 早已这么做，响应侧此前漏了）
    return `<tool_result tool="${escapeXmlAttribute(name)}">
${wrapXmlValue(JSON.stringify(textResponse, null, 2))}
</tool_result>`;
}

/**
 * 递归处理参数值，将 XML 结构转换为正确的 JavaScript 类型
 */
function processParameterValue(value: any): any {
    // 如果是 null 或 undefined，直接返回
    if (value === null || value === undefined) {
        return value;
    }
    
    // 如果是原始类型（字符串、数字、布尔），直接返回
    if (typeof value !== 'object') {
        return value;
    }
    
    // 空容器占位标记还原：序列化端把空数组/空对象写成带标记的 <item/>，
    // 解析端据此还原为 [] / {}（否则空容器 round-trip 后变成空字符串）。
    // 必须在 item 数组判定之前检查，避免被“单元素数组退化形态”误吞成 [{}]。
    if (value.item && typeof value.item === 'object' && !Array.isArray(value.item)) {
        const marker = (value.item as Record<string, unknown>)['@___graycode_empty'];
        if (marker === EMPTY_CONTAINER_ARRAY) {
            return [];
        }
        if (marker === EMPTY_CONTAINER_OBJECT) {
            return {};
        }
    }

    // 数组格式：fast-xml-parser 对重复标签生成数组、单标签生成标量/对象。
    // 只有当 item 为数组、或容器对象仅含 item 一个键（单元素数组的退化形态）
    // 时才按数组处理；普通对象的字段恰好叫 item（如 {item: {id: 1}, other: 2}）
    // 不再被误判为数组结构。
    // item 判定前先排除标量：{item: 'x'} 这种“单键对象、值为标量”的结构应保持为对象，
    // 不能被误判成单元素数组 ['x']（对象与单元素数组的 XML 序列化相同，无法区分，
    // 优先保留对象语义；对象型单元素数组 [{...}] 仍可正确还原）。
    if (Array.isArray(value.item)) {
        // 递归处理数组中的每个元素
        return value.item.map((item: any) => processParameterValue(item));
    }
    if (
        value.item !== undefined
        && value.item !== null
        && typeof value.item === 'object'
        && !Array.isArray(value.item)
        && Object.keys(value).every(k => k === 'item')
    ) {
        return [processParameterValue(value.item)];
    }
    
    // 对象：递归处理每个子元素，并统计真实子元素数量
    const result: Record<string, any> = {};
    const childElementCount = populateObjectFromXml(result, value);

    // 带属性的纯文本节点（如 <content lang="en">xxx</content>）会被解析为
    // { '#text': 'xxx', '@_lang': 'en' }。以前这里把 #text 一起跳过，
    // 导致参数内容整个丢失（变成 {}）。没有子元素时文本内容就是参数值本身。
    if (childElementCount === 0 && '#text' in value) {
        return value['#text'];
    }

    return result;
}

/**
 * 识别保留元素上的编码键名。缺少完整标记时返回 null，使历史中恰好使用该
 * 合法标签名的 XML 仍按普通对象属性解析。
 */
function decodeEncodedKeyNode(node: unknown): string | null {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return null;
    }

    const record = node as Record<string, unknown>;
    if (record['@_encoding'] !== ENCODED_OBJECT_KEY_FORMAT || typeof record['@_name'] !== 'string') {
        return null;
    }
    return decodeObjectKey(record['@_name']);
}

/** 去掉编码元数据后递归处理保留元素承载的真实值。 */
function processEncodedKeyValue(node: Record<string, unknown>): any {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === '@_encoding' || key === '@_name') {
            continue;
        }
        payload[key] = value;
    }

    // 带属性的空元素只剩编码元数据；与普通空 XML 元素一致还原为空字符串。
    if (Object.keys(payload).length === 0) {
        return '';
    }
    return processParameterValue(payload);
}

/**
 * 将 fast-xml-parser 产生的对象节点填充进普通参数对象。
 * 编码键可能因重复保留标签而被解析为数组，因此逐个节点解码；危险键在写入
 * 对象前即被拒绝，避免触发 `__proto__` setter 或覆盖 constructor/prototype。
 */
function populateObjectFromXml(target: Record<string, any>, value: Record<string, any>): number {
    let childElementCount = 0;

    for (const [key, val] of Object.entries(value)) {
        // 跳过属性（@_前缀）、文本节点键与危险键名，防止原型污染
        if (key.startsWith('@_') || key === '#text' || DANGEROUS_OBJECT_KEYS.has(key)) {
            continue;
        }
        childElementCount++;

        if (key !== ENCODED_OBJECT_KEY_TAG) {
            target[key] = processParameterValue(val);
            continue;
        }

        const nodes = Array.isArray(val) ? val : [val];
        const unmarkedNodes: unknown[] = [];
        for (const node of nodes) {
            const decodedKey = decodeEncodedKeyNode(node);
            if (decodedKey === null) {
                unmarkedNodes.push(node);
                continue;
            }
            if (DANGEROUS_OBJECT_KEYS.has(decodedKey)) {
                continue;
            }
            target[decodedKey] = processEncodedKeyValue(node as Record<string, unknown>);
        }

        // 向后兼容：没有编码属性的同名标签仍是一个普通、合法的 XML 键。
        if (unmarkedNodes.length === 1) {
            target[key] = processParameterValue(unmarkedNodes[0]);
        } else if (unmarkedNodes.length > 1) {
            target[key] = unmarkedNodes.map(node => processParameterValue(node));
        }
    }

    return childElementCount;
}

/**
 * XML 工具调用的格式定义
 */
export interface XMLToolCall {
    name: string;
    args: Record<string, any>;
}

/**
 * 从 tool_name 节点提取工具名。
 *
 * 带属性或混合内容的 <tool_name> 会被 fast-xml-parser 解析为对象
 * （如 { '#text': 'read_file', '@_xxx': '...' }），以前直接把对象当作
 * 工具名往下传，执行层按名查找工具必然失败且错误信息难以理解。
 */
function extractToolName(rawName: unknown): string | null {
    if (typeof rawName === 'string') {
        const trimmed = rawName.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (rawName && typeof rawName === 'object' && typeof (rawName as any)['#text'] === 'string') {
        const trimmed = (rawName as any)['#text'].trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    return null;
}

/**
 * 解析单个 tool_use 节点
 */
function parseToolUseNode(toolUse: any): XMLToolCall | null {
    // 提取工具名称
    const name = extractToolName(toolUse.tool_name);
    if (!name) {
        return null;
    }
    
    // 提取参数
    const args: Record<string, any> = {};
    const parameters = toolUse.parameters;
    
    if (parameters && typeof parameters === 'object') {
        populateObjectFromXml(args, parameters);
    }
    
    return { name, args };
}

const TOOL_USE_OPEN = '<tool_use>';
const TOOL_USE_CLOSE = '</tool_use>';
const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/** 未找到结束标记时的安全回退长度（标记可能被 chunk 边界劈开） */
const SCAN_BACKOFF = Math.max(TOOL_USE_CLOSE.length, CDATA_OPEN.length) - 1;

export interface ToolUseEndScanResult {
    /** </tool_use> 的起始下标；未找到为 -1 */
    endIndex: number;
    /** 未找到时：下次追加数据后继续扫描的安全起点 */
    resumePos: number;
    /** 未找到时：扫描停止处是否位于未闭合的 CDATA 段内 */
    inCdata: boolean;
}

/**
 * CDATA 感知地查找 </tool_use> 结束标记。
 *
 * 修改原因：以前用非贪婪正则/indexOf 找第一个 </tool_use>，CDATA 内容里
 * 出现该字符串时（如写关于本格式的文档）块被提前截断，前半解析失败、
 * 后半漏出当正文。
 * 修改方式：跳跃式扫描，跳过 <![CDATA[ ... ]]> 区间内的结束标记；
 * 支持从上次停止的状态续扫（供增量解析器实现 O(n) 累计成本）。
 */
export function findToolUseEnd(
    text: string,
    from: number,
    state?: { inCdata: boolean }
): ToolUseEndScanResult {
    let pos = Math.max(0, from);
    let inCdata = state?.inCdata ?? false;

    while (pos < text.length) {
        if (inCdata) {
            const close = text.indexOf(CDATA_CLOSE, pos);
            if (close === -1) {
                return {
                    endIndex: -1,
                    resumePos: Math.max(pos, text.length - (CDATA_CLOSE.length - 1)),
                    inCdata: true
                };
            }
            pos = close + CDATA_CLOSE.length;
            inCdata = false;
            continue;
        }

        const end = text.indexOf(TOOL_USE_CLOSE, pos);
        const cdata = text.indexOf(CDATA_OPEN, pos);

        if (end !== -1 && (cdata === -1 || end < cdata)) {
            return { endIndex: end, resumePos: end, inCdata: false };
        }
        if (cdata !== -1) {
            pos = cdata + CDATA_OPEN.length;
            inCdata = true;
            continue;
        }
        return {
            endIndex: -1,
            resumePos: Math.max(pos, text.length - SCAN_BACKOFF),
            inCdata: false
        };
    }

    return {
        endIndex: -1,
        resumePos: Math.max(from, text.length - (inCdata ? CDATA_CLOSE.length - 1 : SCAN_BACKOFF)),
        inCdata
    };
}

/**
 * 从文本中提取所有 XML 工具调用
 *
 * 支持：
 * - 多个 <tool_use> 块
 * - 单个块内多个工具调用（通过数组解析）
 * - CDATA 内容中包含 </tool_use> 字符串（通过 CDATA 感知扫描切块）
 *
 * @param xmlText 包含 XML 工具调用的文本
 * @returns 解析出的工具调用数组
 */
export function parseXMLToolCalls(xmlText: string): XMLToolCall[] {
    const results: XMLToolCall[] = [];

    let searchFrom = 0;
    while (searchFrom < xmlText.length) {
        const start = xmlText.indexOf(TOOL_USE_OPEN, searchFrom);
        if (start === -1) {
            break;
        }
        const scan = findToolUseEnd(xmlText, start + TOOL_USE_OPEN.length);
        if (scan.endIndex === -1) {
            break;
        }
        searchFrom = scan.endIndex + TOOL_USE_CLOSE.length;

        try {
            const toolUseXml = xmlText.slice(start, scan.endIndex + TOOL_USE_CLOSE.length);
            const parsed = xmlParser.parse(toolUseXml);
            
            if (parsed.tool_use) {
                const toolUse = parsed.tool_use;
                
                // 检查是否是数组（多个工具调用在一个块内）
                if (Array.isArray(toolUse)) {
                    for (const tu of toolUse) {
                        const call = parseToolUseNode(tu);
                        if (call) {
                            results.push(call);
                        }
                    }
                } else {
                    const call = parseToolUseNode(toolUse);
                    if (call) {
                        results.push(call);
                    }
                }
            }
        } catch (error) {
            console.warn('Failed to parse XML tool call block:', error);
        }
    }
    
    return results;
}

/**
 * 从文本中提取第一个 XML 工具调用
 *
 * 便捷函数，当只需要第一个工具调用时使用
 *
 * @param xmlText 包含 XML 工具调用的文本
 * @returns 第一个工具调用，如果没有找到返回 null
 */
export function parseXMLToolCall(xmlText: string): XMLToolCall | null {
    const calls = parseXMLToolCalls(xmlText);
    return calls.length > 0 ? calls[0] : null;
}
