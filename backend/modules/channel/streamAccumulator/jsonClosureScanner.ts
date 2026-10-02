/**
 * GrayCode - 工具参数增量 JSON 闭合扫描
 *
 * 非 Responses 渠道（OpenAI Chat、Anthropic、Gemini Interactions 等）逐片段到达工具参数；
 * 长补丁/文件内容下，每个片段都对累计全文 JSON.parse 会让扫描量随长度平方增长，且几乎每次都抛异常。
 * 这里只扫描新到字符，维护「字符串内 / 转义 / 括号深度」，给出「顶层对象可能已闭合」的必要条件；
 * 真正是否合法仍由调用方用原有 JSON.parse 判定，因此不会改变解析结果，只减少注定失败的尝试。
 */

/**
 * - pending：只见过 JSON 空白（或空串），与旧逻辑 trim() 为空时跳过解析一致；
 * - object：首个非空白字符是 '{'，可以用深度判断闭合；
 * - other：首字符不是 '{'（数组、标量、非 JSON 空白、垃圾数据），无法判断，调用方回退为每片段尝试解析。
 */
export type JsonClosureMode = 'pending' | 'object' | 'other';

export interface JsonClosureState {
    mode: JsonClosureMode;
    depth: number;
    inString: boolean;
    escaped: boolean;
}

export function createJsonClosureState(): JsonClosureState {
    return { mode: 'pending', depth: 0, inString: false, escaped: false };
}

/**
 * 把新增字符并入扫描状态（原地修改并返回 state）。
 *
 * 只把 JSON 规范的四种空白视为前导空白：其他 Unicode 空白（如 NBSP、BOM）JSON.parse 不接受，
 * 归入 other 让调用方走旧路径，保证与旧的 trim() + parse 行为逐字一致。
 */
export function scanJsonClosure(state: JsonClosureState, chunk: string): JsonClosureState {
    let i = 0;
    if (state.mode === 'pending') {
        while (i < chunk.length) {
            const ch = chunk[i];
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
                i++;
                continue;
            }
            state.mode = ch === '{' ? 'object' : 'other';
            break;
        }
    }
    if (state.mode !== 'object') return state;

    for (; i < chunk.length; i++) {
        const ch = chunk[i];
        if (state.inString) {
            if (state.escaped) state.escaped = false;
            else if (ch === '\\') state.escaped = true;
            else if (ch === '"') state.inString = false;
            continue;
        }
        if (ch === '"') state.inString = true;
        else if (ch === '{' || ch === '[') state.depth++;
        else if (ch === '}' || ch === ']') state.depth--;
    }
    return state;
}

/**
 * 合法的 JSON 对象文本扫描结束时必然 depth 回到 0 且不在字符串中；反之不成立（括号错配、尾部垃圾）。
 * 返回 false 时 JSON.parse 一定失败，可安全跳过；返回 true 只表示值得尝试一次正式解析。
 */
export function mayBeClosedJsonObject(state: JsonClosureState): boolean {
    return state.mode === 'object' && state.depth === 0 && !state.inString;
}
