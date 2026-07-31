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

                // 跳过结束标记
                if (piece === '[DONE]') {
                    currentData = '';
                    continue;
                }

                if (currentData) {
                    // 之前累积的内容还不完整：SSE 多行 data 事件按规范用单个换行连接，
                    // 而不是覆盖丢弃（旧实现这里直接覆盖，事件内容静默丢失）。
                    currentData += '\n' + piece;
                } else {
                    // 开始新的数据
                    currentData = piece;
                }

                // 尝试立即解析
                if (currentData) {
                    try {
                        chunks.push(JSON.parse(currentData));
                        currentData = '';
                    } catch (e) {
                        // 不完整，需要继续累积
                    }
                }
            } else if (currentData && line.trim()) {
                // 非 data: 行但有内容，可能是 JSON 的延续
                // 检查是否像是 JSON 的一部分（不是 chunked 大小指示器）
                // chunked 大小指示器通常是纯十六进制数字
                const isChunkedSize = /^[0-9a-fA-F]+$/.test(line.trim());

                if (!isChunkedSize) {
                    currentData += line;

                    try {
                        chunks.push(JSON.parse(currentData));
                        currentData = '';
                    } catch (e) {
                        // 继续累积
                    }
                }
            }
            // 忽略：空行、注释行(:开头)、chunked 大小指示器
        }

        // 处理剩余的未完成数据
        if (currentData) {
            if (final) {
                try {
                    chunks.push(JSON.parse(currentData));
                } catch (e) {
                    // 解析不了就原样带出去：上游可能是用纯文本报的错
                    return { chunks, remaining: '', unparsed: currentData };
                }
            } else {
                // 保留为 remaining，等待更多数据（需要保留原始的 data: 前缀）
                remaining = 'data: ' + currentData;
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
