import { ChannelError, ErrorType } from '../types';

/** Malformed tool arguments must never silently become an empty invocation. */
export function parseToolArguments(raw: string | undefined, toolName: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(raw ?? '{}');
    } catch {
        throw new ChannelError(ErrorType.PARSE_ERROR, `Invalid JSON arguments for tool "${toolName}"`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ChannelError(ErrorType.PARSE_ERROR, `Arguments for tool "${toolName}" must be a JSON object`);
    }
    return value as Record<string, unknown>;
}
