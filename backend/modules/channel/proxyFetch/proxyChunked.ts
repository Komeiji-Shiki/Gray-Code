/**
 * GrayCode - chunked transfer encoding 解析
 *
 * 由 proxyFetch.ts 拆分而来：真实增量帧校验 + 整包/增量解码。
 * sendRequestOverSocket 与 proxyStreamFetch 的读取逻辑共用这里的实现，
 * 避免两份平行解码逻辑。
 */

/**
 * 增量校验 chunked 编码帧结构（真实解析，替代字节模式扫描）：
 * 从 validatedOffset 起逐帧解析 chunk size 行、chunk 数据与尾部 CRLF；
 * 终止块（size=0）后的 trailer 行必须以空行收尾且与数据末尾对齐才算「完整」。
 *
 * - complete=true：终止帧完整到达，帧尾与数据末尾对齐（无多余字节）；
 * - corrupt=true：帧结构损坏（size 非十六进制 / chunk 数据后缺 CRLF），后续数据无法修复；
 * - 其余情况：数据不足，validatedOffset 记录已通过校验的前缀，下次从该处续扫（O(n) 总开销）。
 */
export function validateChunkedFrames(
    data: Buffer,
    validatedOffset: number
): { complete: boolean; corrupt: boolean; validatedOffset: number } {
    let offset = Math.min(validatedOffset, data.length);
    while (offset < data.length) {
        // 定位 chunk size 行结束（\r\n）
        let sizeEnd = -1;
        for (let i = offset; i < data.length - 1; i++) {
            if (data[i] === 0x0d && data[i + 1] === 0x0a) {
                sizeEnd = i;
                break;
            }
        }
        if (sizeEnd === -1) {
            // size 行不完整：等待更多数据
            return { complete: false, corrupt: false, validatedOffset: offset };
        }

        const sizeLine = data.subarray(offset, sizeEnd).toString('ascii').trim();
        const chunkSize = parseInt(sizeLine, 16);
        if (isNaN(chunkSize)) {
            // 帧损坏：不可修复
            return { complete: false, corrupt: true, validatedOffset: data.length };
        }

        if (chunkSize === 0) {
            // 终止块：其后允许 0..n 行 trailer，必须以空行（\r\n）收尾
            let cursor = sizeEnd + 2;
            while (true) {
                let lineEnd = -1;
                for (let i = cursor; i < data.length - 1; i++) {
                    if (data[i] === 0x0d && data[i + 1] === 0x0a) {
                        lineEnd = i;
                        break;
                    }
                }
                if (lineEnd === -1) {
                    // trailer 行不完整：从终止块起点续扫（trailer 量小，重复扫描可忽略）
                    return { complete: false, corrupt: false, validatedOffset: sizeEnd };
                }
                if (lineEnd === cursor) {
                    // 空行：终止帧结束。仅当与数据末尾对齐才算完整；
                    // 多余字节视为可疑（Connection: close 下服务器不应在终止块后继续输出）
                    return { complete: lineEnd + 2 === data.length, corrupt: false, validatedOffset: lineEnd + 2 };
                }
                cursor = lineEnd + 2;
            }
        }

        const chunkDataStart = sizeEnd + 2;
        const chunkDataEnd = chunkDataStart + chunkSize;
        if (chunkDataEnd + 2 > data.length) {
            // chunk 数据/尾部 CRLF 不完整：等待更多数据
            return { complete: false, corrupt: false, validatedOffset: offset };
        }
        if (data[chunkDataEnd] !== 0x0d || data[chunkDataEnd + 1] !== 0x0a) {
            // chunk 数据后不是 CRLF：帧损坏，不可修复
            return { complete: false, corrupt: true, validatedOffset: data.length };
        }
        offset = chunkDataEnd + 2;
    }
    // 已消费全部数据仍未遇到终止块：等待更多数据
    return { complete: false, corrupt: false, validatedOffset: offset };
}

/**
 * 解码 chunked transfer encoding
 */
export function decodeChunkedBuffer(data: Buffer): string {
    const resultChunks: Buffer[] = [];
    let offset = 0;

    while (offset < data.length) {
        // 查找 chunk size 行的结束 (\r\n)
        let sizeEnd = -1;
        for (let i = offset; i < data.length - 1; i++) {
            if (data[i] === 0x0d && data[i + 1] === 0x0a) {
                sizeEnd = i;
                break;
            }
        }

        if (sizeEnd === -1) {
            break;
        }

        // 解析 chunk size（十六进制）
        const sizeLine = data.subarray(offset, sizeEnd).toString('ascii');
        const chunkSize = parseInt(sizeLine.trim(), 16);

        if (chunkSize === 0 || isNaN(chunkSize)) {
            break;
        }

        // 计算 chunk 数据的位置
        const chunkDataStart = sizeEnd + 2;
        const chunkDataEnd = chunkDataStart + chunkSize;

        if (chunkDataEnd > data.length) {
            break;
        }

        // 提取 chunk 数据
        resultChunks.push(data.subarray(chunkDataStart, chunkDataEnd));

        // 移动到下一个 chunk
        offset = chunkDataEnd + 2;
    }

    return Buffer.concat(resultChunks).toString('utf8');
}

/**
 * 增量解码 chunked transfer encoding：只解码已完整到达的块。
 * 返回已解码字节、已消费偏移与是否遇到终止块（chunkSize 0）。
 * sendRequestOverSocket 与 proxyStreamFetch 共用，避免两份平行解码逻辑。
 */
export function decodeChunkedStreamIncremental(data: Buffer): { decoded: Buffer | null; consumed: number; terminated: boolean } {
    const pieces: Buffer[] = [];
    let offset = 0;
    let terminated = false;

    while (offset < data.length) {
        // 查找 chunk size 行的结束 (\r\n)
        let sizeEnd = -1;
        for (let i = offset; i < data.length - 1; i++) {
            if (data[i] === 0x0d && data[i + 1] === 0x0a) {
                sizeEnd = i;
                break;
            }
        }

        if (sizeEnd === -1) {
            // 没找到完整的 size 行，保留剩余数据
            break;
        }

        // 解析 chunk size（十六进制）
        const sizeLine = data.subarray(offset, sizeEnd).toString('ascii').trim();
        const chunkSize = parseInt(sizeLine, 16);

        if (isNaN(chunkSize)) {
            // 无效的 size，跳过这行
            offset = sizeEnd + 2;
            continue;
        }

        if (chunkSize === 0) {
            // 结束标记
            terminated = true;
            offset = data.length;
            break;
        }

        // 计算 chunk 数据的位置
        const chunkDataStart = sizeEnd + 2;
        const chunkDataEnd = chunkDataStart + chunkSize;

        if (chunkDataEnd + 2 > data.length) {
            // 数据不完整，保留从 offset 开始的所有数据
            break;
        }

        // 提取 chunk 数据（原始字节，解码由调用方的流式 TextDecoder 完成）
        pieces.push(data.subarray(chunkDataStart, chunkDataEnd));

        // 移动到下一个 chunk（跳过 \r\n）
        offset = chunkDataEnd + 2;
    }

    return {
        decoded: pieces.length > 0 ? Buffer.concat(pieces) : null,
        consumed: offset,
        terminated
    };
}
