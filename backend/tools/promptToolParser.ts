import type { ContentPart } from '../modules/conversation/types';
import { parseJSONToolCalls, TOOL_CALL_END, TOOL_CALL_START } from './jsonFormatter';
import { parseXMLToolCalls } from './xmlFormatter';

export type PromptToolMode = 'json' | 'xml';

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
    }

    private consume(flushIncompleteTailAsText: boolean): ContentPart[] {
        const parts: ContentPart[] = [];

        while (this.buffer.length > 0) {
            const startIndex = this.buffer.indexOf(this.startMarker);

            if (startIndex === -1) {
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
            }

            const endIndex = this.buffer.indexOf(this.endMarker, this.startMarker.length);
            if (endIndex === -1) {
                if (flushIncompleteTailAsText) {
                    pushTextPart(parts, this.buffer);
                    this.buffer = '';
                }
                break;
            }

            const blockText = this.buffer.slice(0, endIndex + this.endMarker.length);
            const functionCallParts = toFunctionCallParts(blockText, this.mode);
            if (functionCallParts && functionCallParts.length > 0) {
                parts.push(...functionCallParts);
            } else {
                pushTextPart(parts, blockText);
            }

            this.buffer = this.buffer.slice(endIndex + this.endMarker.length);
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
