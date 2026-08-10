import { XMLValidator } from 'fast-xml-parser';
import type { ContentPart } from '../modules/conversation';
import { parseJsonLenient, parseJSONToolCalls, findEndMarkerOutsideString, TOOL_CALL_END, TOOL_CALL_START, type JsonEndMarkerScanState } from './jsonFormatter';
import { findToolUseEnd, parseXMLToolCalls } from './xmlFormatter';

export type PromptToolMode = 'json' | 'xml';

/**
 * 解析失败的工具调用块会被转换为携带此参数的合成 functionCall，
 * 执行层（ToolExecutionService）检测到该参数后不会真正执行工具，
 * 而是直接把解析错误作为工具结果回传给模型。
 *
 * 为什么需要：以前解析失败的块会静默降级为普通文本，模型发出的
 * 工具调用意图直接消失——没有工具响应也没有错误提示，模型只能靠猜。
 */
export const TOOL_CALL_PARSE_ERROR_ARG_KEY = '__toolCallParseError';

/** 提取不到意图工具名时使用的占位名称 */
export const MALFORMED_TOOL_CALL_NAME = 'malformed_tool_call';

const XML_TOOL_START = '<tool_use>';
const XML_TOOL_END = '</tool_use>';

interface MarkerDef {
    start: string;
    end: string;
}

export interface ExtractPromptToolPartsOptions {
    flushIncompleteTailAsText?: boolean;
}

export interface ExtractPromptToolPartsResult {
    parts: ContentPart[];
    trailingIncomplete?: string;
}

function getMarkers(mode: PromptToolMode): MarkerDef {
    return mode === 'json'
        ? { start: TOOL_CALL_START, end: TOOL_CALL_END }
        : { start: XML_TOOL_START, end: XML_TOOL_END };
}

function longestSuffixPrefixLength(text: string, marker: string): number {
    const max = Math.min(text.length, marker.length - 1);
    for (let len = max; len > 0; len--) {
        if (text.endsWith(marker.slice(0, len))) {
            return len;
        }
    }
    return 0;
}

function toFunctionCallParts(blockText: string, mode: PromptToolMode): ContentPart[] | null {
    if (mode === 'json') {
        const calls = parseJSONToolCalls(blockText);
        if (calls.length === 0) {
            return null;
        }
        return calls.map(call => ({
            functionCall: {
                name: call.tool,
                args: call.parameters || {}
            }
        }));
    }

    const calls = parseXMLToolCalls(blockText);
    if (calls.length === 0) {
        return null;
    }
    return calls.map(call => ({
        functionCall: {
            name: call.name,
            args: call.args || {}
        }
    }));
}

function pushTextPart(parts: ContentPart[], text: string): void {
    if (text.length > 0) {
        parts.push({ text });
    }
}

function extractInnerBlockContent(blockText: string, mode: PromptToolMode): string {
    const markers = getMarkers(mode);
    return blockText.slice(markers.start.length, blockText.length - markers.end.length).trim();
}

function extractIntendedToolName(inner: string, mode: PromptToolMode): string | null {
    const match = mode === 'json'
        ? inner.match(/"tool"\s*:\s*"([^"]+)"/)
        : inner.match(/<tool_name>\s*([\s\S]*?)\s*<\/tool_name>/);
    const name = match?.[1]?.trim();
    return name && /^[\w.\-\/]+$/.test(name) ? name : null;
}

function describeJsonBlockFailure(inner: string): string {
    try {
        parseJsonLenient(inner);
        return 'the JSON is valid but does not contain a {"tool": "...", "parameters": {...}} object with a string `tool` field';
    } catch (e) {
        return `invalid JSON (${e instanceof Error ? e.message : String(e)})`;
    }
}

/**
 * 为 XML 块解析失败给出具体原因。
 * 以前只有一句笼统的 "not valid XML"，模型难以定位问题；
 * 现在借助 XMLValidator 报出具体语法错误和行号，缺 <tool_name> 时单独指出。
 */
function describeXmlBlockFailure(inner: string): string {
    if (!inner.includes('<tool_name>')) {
        return 'the <tool_use> block is missing a <tool_name> element';
    }

    const validation = XMLValidator.validate(`<tool_use>${inner}</tool_use>`);
    if (validation !== true) {
        return `invalid XML (${validation.err.msg} at line ${validation.err.line})`;
    }

    return 'the <tool_use> block is valid XML but could not be interpreted as a tool call '
        + '(check that <tool_name> is not empty and parameters use the documented element structure)';
}

/**
 * 为解析失败但存在完整边界标记的块构造合成 functionCall part。
 * 块内容为空时返回 null（视为非调用意图，保持文本处理）。
 */
function buildParseFailurePart(blockText: string, mode: PromptToolMode): ContentPart | null {
    const inner = extractInnerBlockContent(blockText, mode);
    if (inner.length === 0) {
        return null;
    }

    const intendedTool = extractIntendedToolName(inner, mode);
    const reason = mode === 'json'
        ? describeJsonBlockFailure(inner)
        : describeXmlBlockFailure(inner);

    return {
        functionCall: {
            name: intendedTool ?? MALFORMED_TOOL_CALL_NAME,
            args: {
                [TOOL_CALL_PARSE_ERROR_ARG_KEY]:
                    `Your tool call block was detected but could not be parsed (${mode.toUpperCase()} mode): ${reason}. ` +
                    'Fix the syntax and send the tool call again. Common causes: unescaped newlines or quotes inside JSON string values, trailing commas, or malformed XML tags.'
            }
        }
    };
}

export function detectPromptToolMode(text: string): PromptToolMode | null {
    const jsonIndex = text.indexOf(TOOL_CALL_START);
    const xmlIndex = text.indexOf(XML_TOOL_START);

    if (jsonIndex === -1 && xmlIndex === -1) {
        return null;
    }
    if (jsonIndex !== -1 && (xmlIndex === -1 || jsonIndex <= xmlIndex)) {
        return 'json';
    }
    return 'xml';
}

export class IncrementalPromptToolParser {
    private readonly startMarker: string;
    private readonly endMarker: string;
    private buffer = '';
    /**
     * 未完成块的续扫状态：pos 为下次搜索结束标记的起点（相对当前 buffer），
     * inCdata 表示该位置是否处于未闭合的 CDATA 段内（仅 XML 模式使用）。
     *
     * 修改原因：以前每个新 chunk 到来都从块头重新 indexOf 结束标记，
     * 大块（几 MB 的 write_file 内容 × 上千 chunk）时累计成本 O(n²)。
     * 修改方式：记录安全的续扫位置与 CDATA 状态，累计成本降为 O(n)。
     */
    private pendingScan: { pos: number; inCdata: boolean; jsonState?: JsonEndMarkerScanState } | null = null;

    constructor(private readonly mode: PromptToolMode) {
        const markers = getMarkers(mode);
        this.startMarker = markers.start;
        this.endMarker = markers.end;
    }

    appendText(fragment: string): ContentPart[] {
        if (!fragment) {
            return [];
        }
        this.buffer += fragment;
        return this.consume(false);
    }

    flushIncompleteAsText(): ContentPart[] {
        return this.consume(true);
    }

    getPendingText(): string {
        return this.buffer;
    }

    reset(): void {
        this.buffer = '';
        this.pendingScan = null;
    }

    /**
     * 在 buffer 中查找结束标记。
     * XML 模式使用 CDATA 感知扫描（CDATA 内的 </tool_use> 不算块结束）；
     * JSON 模式使用字符串感知扫描（复用 jsonFormatter 的 findEndMarkerOutsideString 状态机），
     * 参数值内出现字面 <<<END_TOOL_CALL>>> 时不会被提前截断；
     * 未找到时记录字符串状态（jsonState），供下一 chunk 续扫时保持 inString/escaped。
     */
    private findEndMarker(
        from: number,
        inCdata: boolean,
        jsonState?: JsonEndMarkerScanState
    ): { endIndex: number; resumePos: number; inCdata: boolean; jsonState?: JsonEndMarkerScanState } {
        if (this.mode === 'xml') {
            return findToolUseEnd(this.buffer, from, { inCdata });
        }
        const scan = findEndMarkerOutsideString(this.buffer, from, jsonState);
        if (scan.endIndex !== -1) {
            return { endIndex: scan.endIndex, resumePos: scan.endIndex, inCdata: false, jsonState: scan.state };
        }
        return {
            endIndex: -1,
            // 续扫起点只回退到 buffer 尾部「可能成为结束标记前缀」的最长后缀处。
            // 固定按 endMarker.length-1 回退的旧实现有缺陷：实际到达的标记前缀更短时
            // （如只到 `<<<`），resumePos 会落在 JSON 内容中间；下一 chunk 以 buffer 末尾
            // 的字符串状态（inString/escaped）从中间重启扫描，引号被重新解释（本应闭合的
            // 引号被当成开启），状态机失步，被 chunk 边界劈开的结束标记从此再也找不到。
            // 最长后缀前缀区不含引号，故续扫起点处的字符串状态与保存的 end 状态一致。
            resumePos: this.buffer.length - longestSuffixPrefixLength(this.buffer, this.endMarker),
            inCdata: false,
            jsonState: scan.state
        };
    }

    private consume(flushIncompleteTailAsText: boolean): ContentPart[] {
        const parts: ContentPart[] = [];

        while (this.buffer.length > 0) {
            const startIndex = this.buffer.indexOf(this.startMarker);

            if (startIndex === -1) {
                this.pendingScan = null;
                if (flushIncompleteTailAsText) {
                    pushTextPart(parts, this.buffer);
                    this.buffer = '';
                } else {
                    const keepLength = longestSuffixPrefixLength(this.buffer, this.startMarker);
                    const visibleLength = this.buffer.length - keepLength;
                    if (visibleLength > 0) {
                        pushTextPart(parts, this.buffer.slice(0, visibleLength));
                    }
                    this.buffer = this.buffer.slice(visibleLength);
                }
                break;
            }

            if (startIndex > 0) {
                pushTextPart(parts, this.buffer.slice(0, startIndex));
                this.buffer = this.buffer.slice(startIndex);
                this.pendingScan = null;
            }

            const scanFrom = Math.max(this.startMarker.length, this.pendingScan?.pos ?? 0);
            const scan = this.findEndMarker(scanFrom, this.pendingScan?.inCdata ?? false, this.pendingScan?.jsonState);
            if (scan.endIndex === -1) {
                if (flushIncompleteTailAsText) {
                    pushTextPart(parts, this.buffer);
                    this.buffer = '';
                    this.pendingScan = null;
                } else {
                    this.pendingScan = { pos: scan.resumePos, inCdata: scan.inCdata, jsonState: scan.jsonState };
                }
                break;
            }

            const blockText = this.buffer.slice(0, scan.endIndex + this.endMarker.length);
            const functionCallParts = toFunctionCallParts(blockText, this.mode);
            if (functionCallParts && functionCallParts.length > 0) {
                parts.push(...functionCallParts);
            } else {
                // 解析失败的非空块转为合成错误调用，让模型能收到可读的失败反馈；
                // 空块（inner 为空，仅边界标记）丢弃边界标记，仅保留标记之前的文本，
                // 避免 <<<START>>>/<<<END>>> 这类边界标记泄漏进正文。
                const failurePart = buildParseFailurePart(blockText, this.mode);
                if (failurePart) {
                    parts.push(failurePart);
                } else {
                    const markers = getMarkers(this.mode);
                    const markerStart = blockText.indexOf(markers.start);
                    if (markerStart > 0) {
                        pushTextPart(parts, blockText.slice(0, markerStart));
                    }
                }
            }

            this.buffer = this.buffer.slice(scan.endIndex + this.endMarker.length);
            this.pendingScan = null;
        }

        return parts;
    }
}

export function extractPromptToolParts(
    text: string,
    mode: PromptToolMode,
    options: ExtractPromptToolPartsOptions = {}
): ExtractPromptToolPartsResult {
    const flushIncompleteTailAsText = options.flushIncompleteTailAsText ?? true;
    const parser = new IncrementalPromptToolParser(mode);
    const parts = parser.appendText(text);

    if (flushIncompleteTailAsText) {
        parts.push(...parser.flushIncompleteAsText());
        return { parts };
    }

    return {
        parts,
        trailingIncomplete: parser.getPendingText() || undefined
    };
}
