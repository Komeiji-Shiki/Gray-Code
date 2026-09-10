import * as fs from 'fs/promises';
import type { SearchFileHost, FileLocation } from './fileHost';
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';
export interface TextDetectionResult {
    isText: boolean;
    encoding: TextEncoding;
    /** BOM 字节数（需要跳过） */
    bomLength: number;
    reason?: string;
}
export function detectTextFromHeader(header: Uint8Array): TextDetectionResult {
    if (!header || header.length === 0) {
        return { isText: true, encoding: 'utf-8', bomLength: 0 };
    }

    // BOM 检测
    if (header.length >= 3 && header[0] === 0xEF && header[1] === 0xBB && header[2] === 0xBF) {
        return { isText: true, encoding: 'utf-8', bomLength: 3 };
    }
    if (header.length >= 2 && header[0] === 0xFF && header[1] === 0xFE) {
        return { isText: true, encoding: 'utf-16le', bomLength: 2 };
    }
    if (header.length >= 2 && header[0] === 0xFE && header[1] === 0xFF) {
        return { isText: true, encoding: 'utf-16be', bomLength: 2 };
    }

    // UTF-16（无 BOM）启发式：大量 NUL 且集中在偶/奇位
    const sampleLen = Math.min(header.length, 1024);
    let evenZeros = 0;
    let oddZeros = 0;
    for (let i = 0; i < sampleLen; i++) {
        if (header[i] === 0x00) {
            if (i % 2 === 0) evenZeros++;
            else oddZeros++;
        }
    }
    const evenCount = Math.ceil(sampleLen / 2);
    const oddCount = Math.floor(sampleLen / 2) || 1;
    const evenZeroRatio = evenZeros / (evenCount || 1);
    const oddZeroRatio = oddZeros / oddCount;

    if (oddZeroRatio > 0.3 && evenZeroRatio < 0.05) {
        return { isText: true, encoding: 'utf-16le', bomLength: 0 };
    }
    if (evenZeroRatio > 0.3 && oddZeroRatio < 0.05) {
        return { isText: true, encoding: 'utf-16be', bomLength: 0 };
    }

    // NUL 基本可判为二进制（非 UTF-16）
    for (let i = 0; i < sampleLen; i++) {
        if (header[i] === 0x00) {
            return { isText: false, encoding: 'utf-8', bomLength: 0, reason: 'NUL byte detected' };
        }
    }

    // 控制字符占比过高：倾向二进制
    let suspicious = 0;
    for (let i = 0; i < sampleLen; i++) {
        const b = header[i];
        const isAllowedWhitespace = b === 0x09 || b === 0x0A || b === 0x0D; // \t \n \r
        const isControl =
            (b < 0x20 && !isAllowedWhitespace) ||
            b === 0x7F;
        if (isControl) suspicious++;
    }
    const suspiciousRatio = suspicious / (sampleLen || 1);
    if (suspiciousRatio > 0.3) {
        return { isText: false, encoding: 'utf-8', bomLength: 0, reason: `High control-char ratio: ${suspiciousRatio.toFixed(2)}` };
    }

    return { isText: true, encoding: 'utf-8', bomLength: 0 };
}
function swapByteOrder16(data: Uint8Array): Uint8Array {
    const len = data.length - (data.length % 2);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i += 2) {
        out[i] = data[i + 1];
        out[i + 1] = data[i];
    }
    return out;
}
export function decodeTextBytes(bytes: Uint8Array, detection: TextDetectionResult): string {
    const start = Math.max(0, detection.bomLength || 0);
    const sliced = bytes.subarray(start);

    if (detection.encoding === 'utf-16be') {
        const swapped = swapByteOrder16(sliced);
        return new TextDecoder('utf-16le').decode(swapped);
    }

    if (detection.encoding === 'utf-16le') {
        return new TextDecoder('utf-16le').decode(sliced);
    }

    return new TextDecoder('utf-8').decode(sliced);
}
/** 替换后保留原编码与 BOM，避免把 UTF-16 文件静默改写成 UTF-8。 */
export function encodeTextBytes(text: string, detection: TextDetectionResult): Uint8Array {
    const bytes = Buffer.from(text, detection.encoding === 'utf-8' ? 'utf8' : 'utf16le');
    if (detection.encoding === 'utf-16be') bytes.swap16();
    if (!detection.bomLength) return bytes;
    const bom = detection.encoding === 'utf-8' ? [0xef, 0xbb, 0xbf]
        : detection.encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff];
    return Buffer.concat([Buffer.from(bom), bytes]);
}
export function createTextReader(host: SearchFileHost) {
async function tryGetFileSizeBytes(uri: FileLocation): Promise<number | undefined> {
    try {
        const stat = await host.stat(uri);
        return typeof stat.size === 'number' ? stat.size : undefined;
    } catch {
        return undefined;
    }
}
async function readHeaderBytes(uri: FileLocation, maxBytes: number): Promise<Uint8Array> {
    if (host.readHeader) return host.readHeader(uri, maxBytes);
    const n = Math.max(0, Math.floor(maxBytes));
    if (n <= 0) {
        return new Uint8Array();
    }

    // 本地文件优先用 Node fs 做真正的“只读文件头”
    if (uri.scheme === 'file' && uri.fsPath) {
        try {
            const handle = await fs.open(uri.fsPath, 'r');
            try {
                const buffer = Buffer.alloc(n);
                const { bytesRead } = await handle.read(buffer, 0, n, 0);
                return buffer.subarray(0, bytesRead);
            } finally {
                await handle.close();
            }
        } catch {
            // 回退到 vscode fs
        }
    }

    // 非 file scheme：无法保证部分读取，退化为读取后截取（有大小护栏即可）
    const content = await host.readFile(uri);
    return content.subarray(0, Math.min(n, content.length));
}
return { tryGetFileSizeBytes,readHeaderBytes };
}
