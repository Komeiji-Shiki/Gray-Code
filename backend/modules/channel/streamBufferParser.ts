/**
 * 流式响应缓冲区解析。
 *
 * 从 ChannelManager 提取出来：它是纯函数（不依赖任何实例状态），却埋在 1000+ 行的类里，
 * 既无法单独测试，也让「上游到底回了什么」这一层的行为难以推敲。
 */

export interface StreamBufferParseResult {
    /** 本次解析出的完整 chunk */
    chunks: any[];
    /** 尚不完整、需要等待后续数据的残留 */
    remaining: string;
    /**
     * 流已结束但仍解析不出来的原始内容。
     *
     * 上游并不总是按约定格式回复：网关的 502 HTML、代理的纯文本错误都会落在这里。
     * 调用方必须把它带进错误信息——丢掉的话用户只会看到「没有响应体」，
     * 再往前端走就变成一句和真实原因毫无关系的「模型返回空内容」。
     */
    unparsed?: string;
}

/**
 * 流式缓冲解析器内部兜底上限（字符）。
 *
 * 仅作为解析器独立调用的纯兜底：主防线在 ChannelManager（解析无进展时 64MB
 * PARSE_ERROR 终止）。本上限必须严格大于主防线阈值，否则解析器会先于主防线
 * 把超限缓冲"消费"（返回 remaining=''），使 ChannelManager 的 no-progress
 * 检测失明、合法巨型单事件（40MB 级多模态附件）被静默丢弃。
 */
export const MAX_STREAM_BUFFER_CHARS = 128 * 1024 * 1024;
/** 单条 SSE data 行的硬上限（同样必须大于主防线 64MB 阈值） */
export const MAX_SSE_LINE_CHARS = 128 * 1024 * 1024;

/**
 * SSE 心跳/保活载荷识别。
 *
 * 上游（或中间网关）在长时间思考/等待期间会周期性回传 keep-alive 类事件，
 * 常见形态：
 * - `data: keep_alive` / `data: keep-alive` / `data: keepalive`
 * - `data: ping` / `data: heartbeat`
 * - 纯空白 data 行
 *
 * 这类载荷不是 JSON，也不是错误文本。把它当成「不完整的 JSON」继续累积，
 * 会让后续所有真实事件全部解析失败（currentData 被心跳文本污染），
 * 流结束时被误报为「模型返回空内容」并触发无谓的超时重试。
 */
const KEEPALIVE_RE = /^(keep[_-]?alive|keepalive|ping|heartbeat)$/i;

/**
 * 巨型单事件重复解析守卫：currentData 超过该长度后，仅当末尾字符是对象/数组/
 * 字符串收尾符才尝试 JSON.parse（base64/增量文本以字母数字结尾直接跳过）。
 * 真实 provider 的完成事件必以 } / ] / " 结尾（顶层标量除外，不产生）。
 */
const LARGE_JSON_PARSE_GUARD_BYTES = 4 * 1024;

function isKeepAlivePayload(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return true;
    return KEEPALIVE_RE.test(trimmed);
}

/** 判断一段文本是否可能是「尚未收完的 JSON」前缀（多行 data 事件拼接用） */
function looksLikeJsonPrefix(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * 解析流式响应缓冲区
 *
 * 支持两种格式：
 * 1. SSE (Server-Sent Events): data: {...}\n\n (Gemini ?alt=sse, OpenAI, Anthropic)
 * 2. JSON 数组格式（逐步发送）
 *
 * @param buffer 累积的原始文本
 * @param final 流是否已经结束（结束后不再保留 remaining，解析不了的内容转为 unparsed）
 */
export function parseStreamBuffer(buffer: string, final = false): StreamBufferParseResult {
    const chunks: any[] = [];
    let remaining = '';

    if (buffer.length > MAX_STREAM_BUFFER_CHARS) {
        return {
            chunks: [],
            remaining: '',
            unparsed: `Stream buffer exceeded ${MAX_STREAM_BUFFER_CHARS} characters and was dropped`
        };
    }

    // 按行检测 SSE 格式
    // Gemini 使用 ?alt=sse 时返回这种格式
    // 注意：不能用 buffer.includes('data:') 做全文判定 — 非 SSE 错误体（如 JSON 里的 "no data: found"）会被误判，
    // 后续找不到任何 data: 行 → chunks 为空 → 错误文本在 final 前又被当成 remaining，到 final 时才进 unparsed。
    // 现在按行判定：只有存在以 "data:" 开头的行才算 SSE。
    const lines = buffer.split(/\r?\n/);
    if (lines.some(line => line.startsWith('data:'))) {
        // 稳健的 SSE 解析策略：
        // 1. 只提取以 "data:" 开头的有效行
        // 2. 忽略 chunked 编码大小指示器、空行、注释等
        // 3. 累积不完整的 data: 行直到可以解析

        // 累积当前正在处理的 data 内容
        let currentData = '';

        for (const line of lines) {
            // 只处理以 "data:" 开头的行
            if (line.startsWith('data:')) {
                const piece = line.slice(5).trim();

                // 单条 data 行超限：上游异常（如未按 SSE 分帧的二进制/日志流），
                // 直接丢弃整段，避免 currentData 无限累积
                if (piece.length > MAX_SSE_LINE_CHARS) {
                    currentData = '';
                    continue;
                }

                // 跳过结束标记
                if (piece === '[DONE]') {
                    currentData = '';
                    continue;
                }

                if (currentData) {
                    // 之前累积的内容还不完整：SSE 多行 data 事件按规范用单个换行连接，
                    // 而不是覆盖丢弃（旧实现这里直接覆盖，事件内容静默丢失）。
                    // 但只有「看起来像 JSON 前缀」的内容才允许继续累积——
                    // 心跳类纯文本（keep_alive/ping 等）直接替换掉，
                    // 防止污染 currentData 导致后续真实事件全部解析失败。
                    if (looksLikeJsonPrefix(currentData)) {
                        currentData += '\n' + piece;
                    } else {
                        currentData = piece;
                    }
                } else {
                    // 开始新的数据
                    currentData = piece;
                }

                // 尝试立即解析。巨型单事件（如 40MB base64 附件）跨多个包到达时，
                // 每个包都对逐渐变长的 currentData 做一次完整 JSON.parse 是 O(n²) 纯浪费：
                // 不完整时必然失败。超过阈值后仅当末尾字符是对象/数组/字符串的合法
                // 收尾符才尝试解析（base64 增量以字母/数字/+/= 结尾直接跳过）。
                if (currentData) {
                    const canBeComplete = currentData.length <= LARGE_JSON_PARSE_GUARD_BYTES
                        || currentData.trimEnd().endsWith('}') || currentData.trimEnd().endsWith(']') || currentData.trimEnd().endsWith('"');
                    if (canBeComplete) {
                        try {
                            chunks.push(JSON.parse(currentData));
                            currentData = '';
                        } catch (e) {
                            // 不完整，需要继续累积（或保持为可替换的心跳内容）
                        }
                    }
                }
            } else if (currentData && line.trim()) {
                // 非 data: 行但有内容，可能是 JSON 的延续
                // 检查是否像是 JSON 的一部分（不是 chunked 大小指示器）
                // chunked 大小指示器通常是纯十六进制数字
                const isChunkedSize = /^[0-9a-fA-F]+$/.test(line.trim());

                // 与 data: 行同规则：只有 JSON 前缀内容才允许跨行续接，
                // 心跳类纯文本（keep_alive/ping 等）不会被延续行越撑越大
                if (!isChunkedSize && looksLikeJsonPrefix(currentData)) {
                    currentData += line;

                    const canBeComplete = currentData.length <= LARGE_JSON_PARSE_GUARD_BYTES
                        || currentData.trimEnd().endsWith('}') || currentData.trimEnd().endsWith(']') || currentData.trimEnd().endsWith('"');
                    if (canBeComplete) {
                        try {
                            chunks.push(JSON.parse(currentData));
                            currentData = '';
                        } catch (e) {
                            // 继续累积
                        }
                    }
                }
            }
            // 非 data: 行一律忽略（空行、注释行、chunked 大小指示器、事件名等）：
            // 只在 data: 行累积，避免垃圾内容被拼进正在解析的 JSON。
        }

        // 处理剩余的未完成数据
        if (currentData) {
            if (final) {
                try {
                    chunks.push(JSON.parse(currentData));
                } catch (e) {
                    // 心跳类纯文本在流结束时直接丢弃（不是错误，不应进入错误详情）
                    if (isKeepAlivePayload(currentData)) {
                        return { chunks, remaining: '', unparsed: undefined };
                    }
                    // 解析不了就原样带出去：上游可能是用纯文本报的错
                    return { chunks, remaining: '', unparsed: currentData };
                }
            } else {
                // 保留为 remaining，等待更多数据（保留原始的 data: 前缀；
                // 多行 data 事件的续行也补回 data: 前缀，保证下次解析仍只在 data: 行累积）
                remaining = 'data: ' + currentData.replace(/\n/g, '\ndata: ');
            }
        }

        return { chunks, remaining };
    }

    const trimmedBuffer = buffer.trim();

    // JSON 格式：每行一个完整的 JSON 对象
    if (trimmedBuffer.startsWith('{') || trimmedBuffer.startsWith('[')) {
        const lines = buffer.split('\n');
        const unparsedLines: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // 处理 JSON 数组的开始/结束符号
            let jsonStr = line;
            if (jsonStr.startsWith('[')) jsonStr = jsonStr.slice(1);
            if (jsonStr.endsWith(']')) jsonStr = jsonStr.slice(0, -1);
            if (jsonStr.startsWith(',')) jsonStr = jsonStr.slice(1);
            if (jsonStr.endsWith(',')) jsonStr = jsonStr.slice(0, -1);
            jsonStr = jsonStr.trim();

            if (!jsonStr) continue;

            try {
                chunks.push(JSON.parse(jsonStr));
            } catch (e) {
                if (i === lines.length - 1 && !final) {
                    // 最后一行且流未结束：可能只是还没收完
                    remaining = lines[i];
                } else {
                    // 中间行解析失败：不静默丢弃，流结束后进 unparsed 供错误详情
                    // （旧实现只有 final 分支保留，非 final 的中间行错误被静默吞掉）
                    unparsedLines.push(line);
                }
            }
        }

        return unparsedLines.length > 0
            ? { chunks, remaining, unparsed: unparsedLines.join('\n') }
            : { chunks, remaining };
    }

    // 无法识别的格式，尝试直接解析为 JSON
    try {
        return { chunks: [JSON.parse(trimmedBuffer)], remaining: '' };
    } catch (e) {
        // 流还没结束：保留等待更多数据。
        // 流已经结束还是解析不了：说明上游根本没按约定格式回，必须把原文带出去。
        return final
            ? { chunks: [], remaining: '', unparsed: trimmedBuffer }
            : { chunks: [], remaining: buffer };
    }
}
