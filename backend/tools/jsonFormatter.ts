/**
 * GrayCode - JSON 工具格式转换器
 *
 * 将工具声明转换为 JSON 提示词格式
 * 使用动态边界（类似 heredoc）避免内容中的代码块干扰解析
 *
 * 格式：
 * <<<TOOL_CALL>>>
 * {"tool": "...", "parameters": {...}}
 * <<<END_TOOL_CALL>>>
 */

import type { ToolDeclaration } from './types';

/**
 * 工具调用边界标记
 */
export const TOOL_CALL_START = '<<<TOOL_CALL>>>';
export const TOOL_CALL_END = '<<<END_TOOL_CALL>>>';

/** JSON 解析失败告警节流：一次调用内大量失败块时只记录前几次，避免刷屏 */
// 模块级计数在 parseJSONToolCalls 入口清零（按调用批次重置），
// 否则跨调用累计后节流永久失效，后续所有失败块都不再告警。
let jsonParseWarnCount = 0;
const MAX_JSON_PARSE_WARNS = 5;

/**
 * JSON 工具调用的格式定义
 */
export interface JSONToolCall {
    tool: string;
    parameters: Record<string, any>;
}

/**
 * 将参数 schema 转换为简化的类型描述
 */
function schemaToTypeDescription(schema: any): string {
    if (!schema) return 'any';
    
    if (schema.type === 'array') {
        const itemType = schema.items?.type || 'any';
        return `${itemType}[]`;
    }
    
    if (schema.type === 'object' && schema.properties) {
        const props = Object.entries(schema.properties)
            .map(([key, val]: [string, any]) => `${key}: ${schemaToTypeDescription(val)}`)
            .join(', ');
        return `{ ${props} }`;
    }
    
    return schema.type || 'any';
}

/**
 * 生成参数的 JSON Schema 示例
 */
function generateParameterExample(schema: any): any {
    if (!schema) return null;
    
    if (schema.type === 'string') {
        return schema.example || 'string_value';
    }
    if (schema.type === 'number' || schema.type === 'integer') {
        return schema.example || 0;
    }
    if (schema.type === 'boolean') {
        return schema.example ?? true;
    }
    if (schema.type === 'array') {
        const itemExample = generateParameterExample(schema.items);
        return [itemExample];
    }
    if (schema.type === 'object' && schema.properties) {
        const obj: Record<string, any> = {};
        for (const [key, val] of Object.entries(schema.properties)) {
            obj[key] = generateParameterExample(val);
        }
        return obj;
    }
    return null;
}

/**
 * 将工具声明转换为 JSON 格式的提示词
 * 
 * @param tools 工具声明数组
 * @returns JSON 格式的工具说明文本
 */
export function convertToolsToJSON(tools: ToolDeclaration[]): string {
    if (!tools || tools.length === 0) {
        return '';
    }
    
    // 生成工具列表描述
    const toolDescriptions = tools.map(tool => {
        const params = tool.parameters.properties;
        const required = tool.parameters.required || [];
        
        // 生成参数说明
        const paramsList = Object.entries(params).map(([name, schema]: [string, any]) => {
            const isRequired = required.includes(name);
            const typeInfo = schemaToTypeDescription(schema);
            const description = schema.description || '';
            return `    - ${name} (${typeInfo})${isRequired ? ' [required]' : ''}: ${description}`;
        }).join('\n');
        
        // 生成示例参数
        const exampleParams: Record<string, any> = {};
        for (const [name, schema] of Object.entries(params)) {
            exampleParams[name] = generateParameterExample(schema);
        }
        
        return `### ${tool.name}
${tool.description}

Parameters:
${paramsList}

Example:
\`\`\`json
${JSON.stringify({ tool: tool.name, parameters: exampleParams }, null, 2)}
\`\`\``;
    }).join('\n\n---\n\n');
    
    return `## Tool Usage Guide

You are a powerful AI assistant with access to various tools. You should actively use these tools to gather information, perform actions, and provide accurate responses.

### How to Call Tools

When you need to use a tool, output a JSON object wrapped in special boundary markers:

${TOOL_CALL_START}
{"tool": "tool_name", "parameters": {...}}
${TOOL_CALL_END}

You can call multiple tools by outputting multiple tool blocks:

${TOOL_CALL_START}
{"tool": "read_file", "parameters": {"path": "file1.txt"}}
${TOOL_CALL_END}

Reading multiple files (each item may optionally specify a line range):

${TOOL_CALL_START}
{"tool": "read_file", "parameters": {"files": [{"path": "file1.txt"}, {"path": "src/main.ts", "startLine": 10, "endLine": 20}]}}
${TOOL_CALL_END}

${TOOL_CALL_START}
{"tool": "write_file", "parameters": {"path": "output.txt", "content": "Hello!"}}
${TOOL_CALL_END}

### Best Practices

1. **Actively use tools**: When you need information you don't have, use the appropriate tool to get it. Don't guess or make assumptions when tools can provide accurate data.

2. **Place tool calls at the end**: Structure your response so that tool calls appear at the end of your message. First provide any explanations or context, then call the necessary tools.

3. **One step at a time**: After each tool call, wait for the result before proceeding. Use the tool results to inform your next steps.

4. **Combine tools effectively**: You can call multiple tools in a single response when needed. Use the results from one tool to inform subsequent tool calls.

### Syntax Rules

- Each tool call must be wrapped in ${TOOL_CALL_START} and ${TOOL_CALL_END} markers
- The content between markers must be a valid JSON object
- Use proper JSON syntax (double quotes for strings, no trailing commas)
- Arrays use standard JSON array syntax: ["item1", "item2"]
- The boundary markers ensure that any code blocks in parameters won't interfere with parsing

---

## Available Tools

${toolDescriptions}`;
}

/**
 * 将 functionCall 转换为 JSON 格式的文本（使用边界标记）
 *
 * @param name 工具名称
 * @param args 工具参数
 * @returns 带边界标记的 JSON 工具调用文本
 */
export function convertFunctionCallToJSON(name: string, args: Record<string, any>): string {
    const toolCall: JSONToolCall = {
        tool: name,
        parameters: args
    };
    return `${TOOL_CALL_START}\n${JSON.stringify(toolCall, null, 2)}\n${TOOL_CALL_END}`;
}

/**
 * 将 functionResponse 转换为 JSON 格式的文本
 *
 * @param name 工具名称
 * @param response 工具响应
 * @returns 工具响应文本
 *
 * 注意：multimodal 字段会被移除，因为多模态数据应该作为 inlineData 附件单独发送
 */
export function convertFunctionResponseToJSON(name: string, response: Record<string, any>): string {
    // 移除 multimodal 字段，避免将 base64 图片数据嵌入文本
    // multimodal 数据应该作为 inlineData parts 单独发送
    const { multimodal, ...textResponse } = response;
    return `Tool result for "${name}":\n${JSON.stringify(textResponse, null, 2)}`;
}

/**
 * 从文本中提取所有 JSON 工具调用
 *
 * 解析策略：先严格 JSON.parse，失败后尝试修复模型高频错误
 * （字符串内的裸换行/制表符、尾逗号）后重试，减少因细小语法瑕疵
 * 导致整个工具调用丢失的情况。
 *
 * @param text 包含工具调用边界标记的文本
 * @returns 解析出的工具调用数组
 */
export function parseJSONToolCalls(text: string): JSONToolCall[] {
    const results: JSONToolCall[] = [];

    // 按调用批次重置告警节流计数：模块级计数不重置会让节流永久失效
    jsonParseWarnCount = 0;
    
    // 匹配 <<<TOOL_CALL>>> ... <<<END_TOOL_CALL>>> 边界
    // 结束标记用状态机定位：跳过位于 JSON 字符串内部的 <<<END_TOOL_CALL>>>。
    // 字符串值里可能出现字面结束标记（如 write_file 的 content 恰好含该标记），
    // 非贪婪正则会在字符串中间提前截断块，导致 JSON 解析失败。
    let searchFrom = 0;
    while (true) {
        const startIndex = text.indexOf(TOOL_CALL_START, searchFrom);
        if (startIndex === -1) {
            break;
        }
        const blockStart = startIndex + TOOL_CALL_START.length;
        const endScan = findEndMarkerOutsideString(text, blockStart);
        if (endScan.endIndex === -1) {
            // 该块没有闭合的结束标记。
            // 修改原因：旧实现静默跳过，模型收不到失败反馈，可能反复输出同样的未闭合块。
            // 修改方式：对齐 promptToolParser.buildParseFailurePart 语义——块内容为空时视为
            //          非调用意图（如流式刚发出开始标记）静默跳过；有内容时构造解析失败
            //          反馈（malformed_tool_call + __toolCallParseError），让模型补全结束标记重发。
            const unclosedContent = text.substring(blockStart).trim();
            if (unclosedContent.length > 0) {
                results.push({
                    tool: 'malformed_tool_call',
                    parameters: {
                        __toolCallParseError: 'The tool call block is missing the closing marker (<<<END_TOOL_CALL>>>). Fix it and send the tool call again.'
                    }
                });
            }
            searchFrom = blockStart;
            continue;
        }
        const endIndex = endScan.endIndex;
        try {
            const jsonStr = text.substring(blockStart, endIndex).trim();
            const parsed = parseJsonLenient(jsonStr);
            
            // 验证是否是有效的工具调用格式
            if (parsed && typeof parsed === 'object' && typeof (parsed as any).tool === 'string') {
                const toolName = (parsed as any).tool as string;
                if (!toolName.trim()) {
                    // 空 tool 名：不再静默丢弃整块，构造带解析错误的调用反馈给模型
                    results.push({
                        tool: 'malformed_tool_call',
                        parameters: {
                            __toolCallParseError: 'The tool call block has an empty "tool" field. Fix it and send the tool call again.'
                        }
                    });
                } else {
                    results.push({
                        tool: toolName,
                        parameters: (parsed as any).parameters || {}
                    });
                }
            }
        } catch (error) {
            // JSON 解析失败，跳过这个块（上层 promptToolParser 会生成解析失败反馈）
            // 节流：只记录前几次，避免批量失败块 console.warn 刷屏
            if (jsonParseWarnCount < MAX_JSON_PARSE_WARNS) {
                jsonParseWarnCount++;
                console.warn(`Failed to parse JSON tool call (${jsonParseWarnCount}/${MAX_JSON_PARSE_WARNS}; further failures suppressed):`, error);
            }
        }
        searchFrom = endIndex + TOOL_CALL_END.length;
    }
    
    return results;
}

/**
 * 字符串感知扫描的增量状态：供流式分块续扫时保持字符串开关状态。
 */
export interface JsonEndMarkerScanState {
    /** 扫描停止时是否处于 JSON 字符串内部 */
    inString: boolean;
    /** 字符串内最后一个字符是否为转义符（\） */
    escaped: boolean;
}

export interface JsonEndMarkerScanResult {
    /** <<<END_TOOL_CALL>>> 的起始下标；未找到为 -1 */
    endIndex: number;
    /** 扫描结束时的字符串状态（未找到时供下一 chunk 续扫） */
    state: JsonEndMarkerScanState;
}

/**
 * 从 startIndex 起查找第一个位于 JSON 字符串之外的 <<<END_TOOL_CALL>>> 标记。
 *
 * 用简单状态机跟踪双引号字符串的开关（含 \" 转义）：字符串值内部出现的
 * 字面结束标记会被跳过，避免把工具调用块截断在字符串中间。
 *
 * @param initialState 增量续扫状态：上次扫描在字符串中途停止时传入
 *        （inString=true），避免把字符串内部的引号当作新字符串边界。
 * @returns 结束标记的起始下标与扫描结束状态；未找到时 endIndex 为 -1
 */
export function findEndMarkerOutsideString(
    text: string,
    startIndex: number,
    initialState?: JsonEndMarkerScanState
): JsonEndMarkerScanResult {
    let inString = initialState?.inString ?? false;
    let escaped = initialState?.escaped ?? false;

    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (text.startsWith(TOOL_CALL_END, i)) {
            return { endIndex: i, state: { inString, escaped } };
        }
    }
    return { endIndex: -1, state: { inString, escaped } };
}

/**
 * 宽松 JSON 解析：严格解析失败后修复常见模型错误再重试一次。
 * 修复也失败时抛出原始错误（保留真实的诊断信息）。
 */
export function parseJsonLenient(jsonStr: string): unknown {
    try {
        return JSON.parse(jsonStr);
    } catch (firstError) {
        const repaired = repairCommonJsonMistakes(jsonStr);
        if (repaired !== jsonStr) {
            try {
                return JSON.parse(repaired);
            } catch {
                throw firstError;
            }
        }
        throw firstError;
    }
}

/**
 * 修复模型输出 JSON 时的两类高频错误：
 *
 * 1. 字符串值内的裸控制字符（换行/回车/制表符）→ 转义序列
 *    （模型在 content 类参数里最容易直接输出真实换行）
 * 2. 字符串外的尾逗号（, 后紧跟 } 或 ]）→ 删除
 *
 * 单引号 JSON 等高风险修复不做（会误伤内容中的撇号）。
 */
function repairCommonJsonMistakes(input: string): string {
    let out = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (inString) {
            if (escaped) {
                out += ch;
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                out += ch;
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
                out += ch;
                continue;
            }
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }
            out += ch;
            continue;
        }

        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }

        // 字符串外的尾逗号：向前看下一个非空白字符，若是 } 或 ] 则丢弃该逗号
        if (ch === ',') {
            let j = i + 1;
            while (j < input.length && /\s/.test(input[j])) {
                j++;
            }
            if (j < input.length && (input[j] === '}' || input[j] === ']')) {
                continue;
            }
        }

        out += ch;
    }

    return out;
}

/**
 * 从文本中提取单个 JSON 工具调用（用于流式解析）
 *
 * @param text 包含工具调用的文本
 * @returns 解析出的工具调用，如果没有找到返回 null
 */
export function parseJSONToolCall(text: string): JSONToolCall | null {
    const calls = parseJSONToolCalls(text);
    return calls.length > 0 ? calls[0] : null;
}