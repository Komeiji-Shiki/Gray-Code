import * as iconv from 'iconv-lite';
import { detectTextEncoding, type TextDetectionResult } from './textEncodingRuntime';
import type { FileLocation, SearchFileHost } from './fileHost';

/** 样本末尾可能切在多字节字符中；UTF-8 检查保留未完成字节，避免误判成旧编码。 */
export function detectStreamingEncoding(sample: Uint8Array): TextDetectionResult {
    const detection = detectTextEncoding(sample);
    if (detection.bomLength || detection.encoding.startsWith('utf-16') || !detection.isText) return detection;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
        return { isText: true, encoding: 'utf-8', bomLength: 0, source: 'utf8' };
    } catch { return detection; }
}

/** 增量解码并按原有 CRLF/CR/LF 语义分行；长行片段只在完整行到达时合并一次。 */
async function* readLines(host: SearchFileHost, file: FileLocation, detection: TextDetectionResult, signal?: AbortSignal): AsyncGenerator<string> {
    const decoder = detection.encoding === 'utf-8' ? new TextDecoder('utf-8', { fatal: true }) : undefined;
    const legacy = decoder ? undefined : iconv.getDecoder(detection.encoding, { stripBOM: false });
    let bom = detection.bomLength, skipLF = false;
    let fragments: string[] = [];
    const split = function* (value: string): Generator<string> {
        if (!value) return;
        if (skipLF && value.startsWith('\n')) value = value.slice(1);
        skipLF = value.endsWith('\r');
        const pieces = value.split(/\r\n|\r|\n/);
        for (let index = 0; index < pieces.length - 1; index++) {
            fragments.push(pieces[index]); yield fragments.join(''); fragments = [];
        }
        if (pieces.at(-1)) fragments.push(pieces.at(-1)!);
    };
    for await (const bytes of host.readChunks!(file, signal)) {
        signal?.throwIfAborted();
        const skipped = Math.min(bom, bytes.length); bom -= skipped;
        const chunk = bytes.subarray(skipped);
        yield* split(decoder ? decoder.decode(chunk, { stream: true }) : legacy!.write(Buffer.from(chunk)));
    }
    yield* split(decoder ? decoder.decode() : legacy!.end() ?? '');
    yield fragments.join('');
}

/** ASCII 开头不能代表整个大文件的编码；增量确认 UTF-8，失败时复用出错位置的完整块识别旧编码。 */
async function detectFileEncoding(host: SearchFileHost, file: FileLocation, initial: TextDetectionResult, signal?: AbortSignal): Promise<TextDetectionResult> {
    if (initial.bomLength || initial.encoding !== 'utf-8') return initial;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let previous: Uint8Array = new Uint8Array();
    for await (const bytes of host.readChunks!(file, signal)) {
        signal?.throwIfAborted();
        try { decoder.decode(bytes, { stream: true }); }
        catch {
            const sample = Buffer.concat([previous, bytes]);
            let detection = detectTextEncoding(sample);
            for (let tail = 1; detection.encoding === 'windows-1252' && tail <= 3 && sample.length > tail; tail++) {
                const candidate = detectTextEncoding(sample.subarray(0, sample.length - tail));
                if (candidate.isText && candidate.encoding !== 'utf-8') detection = candidate;
            }
            return detection;
        }
        previous = bytes;
    }
    try { decoder.decode(); }
    catch { return detectTextEncoding(previous); }
    return initial;
}

/** 批次保留两侧上下文；只搜索中间区域，既不漏边界行，也不重复上一批的命中。 */
export async function* streamingSearchBatches(host: SearchFileHost, file: FileLocation, detection: TextDetectionResult,
    before: number, after: number, signal?: AbortSignal): AsyncGenerator<{ lines: string[]; base: number; start: number; end: number }> {
    let lines: string[] = [], base = 0, start = 0, characters = 0;
    detection = await detectFileEncoding(host, file, detection, signal);
    if (!detection.isText) throw new Error('大文件的编码样本不是文本，未完成搜索。');
    for await (const line of readLines(host, file, detection, signal)) {
        lines.push(line); characters += line.length;
        if (lines.length > start + after && (lines.length >= start + after + 128 || characters >= 512 * 1024)) {
            const end = lines.length - after;
            yield { lines, base, start, end };
            const remove = Math.max(0, end - before);
            lines = lines.slice(remove); base += remove; start = end - remove;
            characters = lines.reduce((total, value) => total + value.length, 0);
        }
    }
    if (lines.length > start) yield { lines, base, start, end: lines.length };
}
