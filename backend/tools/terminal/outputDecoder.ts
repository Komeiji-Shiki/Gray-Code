/**
 * Terminal output processing
 *
 * Split from execute_command.ts: output line memory guard
 * (MAX_RETAINED_OUTPUT_LINES), GBK fallback decoding (byte sniffing +
 * replacement-char counting), output truncation, and max output lines
 * config lookup.
 */

import { StringDecoder } from 'string_decoder';
import { TextDecoder } from 'util';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { getDefaultExecuteCommandConfig } from '../../modules/settings';
import type { TerminalProcess } from './processRunner';

/**
 * 终端输出行数上限：长运行进程（服务器、日志循环、timeout=0 后台任务）持续输出时
 * 内存无限增长；超出上限的旧行被丢弃并计数，供截断提示使用。
 */
const MAX_RETAINED_OUTPUT_LINES = 50000;

/** 单行输出上限：长流式输出（无换行的巨块，如 `print('x'*2e9)`）会在单行内无限累积，
 *  内存与最终响应体均无界；超限时截断保留尾部并计入 omittedOutputLines。 */
export const MAX_SINGLE_LINE_CHARS = 1_000_000;

/**
 * 输出数组前段清理的摊销阈值。
 *
 * 修改原因：pushOutputLines 每次超限都 splice(0, dropped)，当输出逐行到达时
 * 每 push 一行都要对 5 万行数组做一次 O(n) 前段删除，总复杂度退化为 O(n²)。
 * 修改方式：超限量小于阈值时只计数不物理删除，数组在“上限 + 阈值”内有界浮动，
 * 累计超限达到阈值后再做一次前段删除（摊销后总删除次数与超限量成正比）。
 * 语义不变：输出仍被截断到 MAX_RETAINED_OUTPUT_LINES（允许阈值内的浮动），
 * omittedOutputLines 统计被丢弃的行数。
 */
const OUTPUT_TRIM_AMORTIZE_THRESHOLD = 1000;

export function pushOutputLines(tp: TerminalProcess, lines: string[]): void {
    if (lines.length === 0) return;
    for (const line of lines) {
        if (line.length > MAX_SINGLE_LINE_CHARS) {
            // 超长单行：保留尾部（模型更关心末尾的最新输出），头部截断并计数
            tp.output.push(line.slice(line.length - MAX_SINGLE_LINE_CHARS));
            tp.omittedOutputLines = (tp.omittedOutputLines ?? 0) + 1;
        } else {
            tp.output.push(line);
        }
    }
    if (tp.output.length > MAX_RETAINED_OUTPUT_LINES) {
        const dropped = tp.output.length - MAX_RETAINED_OUTPUT_LINES;
        tp.omittedOutputLines = (tp.omittedOutputLines ?? 0) + dropped;
        // 摊销清理：累计超限达到阈值才做一次前段删除（见 OUTPUT_TRIM_AMORTIZE_THRESHOLD 注释）
        if (tp.output.length - MAX_RETAINED_OUTPUT_LINES >= OUTPUT_TRIM_AMORTIZE_THRESHOLD) {
            tp.output.splice(0, tp.output.length - MAX_RETAINED_OUTPUT_LINES);
        }
    }
}

/**
 * 获取最大输出行数配置
 * 从设置中读取，默认 50 行
 * -1 表示无限制
 */
export function getMaxOutputLines(): number {
    const settingsManager = getGlobalSettingsManager();
    const config = settingsManager?.getExecuteCommandConfig() || getDefaultExecuteCommandConfig();
    return config.maxOutputLines ?? 50;
}

/**
 * 截取最后 N 行
 */
export function getLastLines(lines: string[], n: number): string[] {
    if (lines.length <= n) {
        return lines;
    }
    return lines.slice(-n);
}

export type StreamDecodeMode = 'utf8' | 'gbk';

/**
 * 流式解码状态（跨 chunk 保持）。
 *
 * pendingBytes：utf8 阶段从字节流末尾扣下的「可能是不完整 UTF-8 序列」的跨 chunk 前缀。
 * 修改原因：旧实现把字节直接交给 StringDecoder，切换 GBK 时 StringDecoder 内部已缓冲的
 *          多字节前缀无法取回，被静默丢弃（GBK 流首字符损坏）。
 * 修改方式：decodeWithMode 内自管 pendingBytes 缓冲，切换 GBK 时把扣下的前缀与当前 chunk
 *          一起交给 GBK 解码器；进程关闭时由 flushDecodeState 冲刷。
 */
export interface StreamDecodeState {
    mode: StreamDecodeMode;
    pendingBytes?: Buffer;
}

/**
 * 计算字节流末尾「可能是不完整 UTF-8 序列」的字节数。
 *
 * 从末尾向前找最近的 UTF-8 lead 字节（110xxxxx / 1110xxxx / 11110xxx），
 * 若其后连续续字节不足则整段视为未完成前缀；末尾 3 字节内无 lead
 * （纯 ASCII / 孤立续字节）或续字节充足则视为完整，返回 0。
 * 未完成前缀最长 3 字节（4 字节 lead + 2 个续字节）。
 */
function utf8IncompleteTailLength(buf: Buffer): number {
    const n = buf.length;
    for (let i = n - 1; i >= 0 && i >= n - 3; i--) {
        const b = buf[i];
        if (b < 0x80) {
            // ASCII：之前的字节全部完整
            return 0;
        }
        if ((b & 0xC0) === 0x80) {
            // 续字节：继续向前找 lead
            continue;
        }
        // lead 字节
        let need: number;
        if ((b & 0xE0) === 0xC0) need = 2;
        else if ((b & 0xF0) === 0xE0) need = 3;
        else need = 4; // 11110xxx
        const have = n - 1 - i;
        return have < need - 1 ? n - i : 0;
    }
    return 0;
}

/** 模块级复用的 UTF-8 解码器（非流式）：只解码已确认完整的字节序列，无隐藏状态 */
const utf8TextDecoder = new TextDecoder('utf-8');

/**
 * 模块级复用的 GBK 预览解码器（非流式，仅供 shouldFallbackToGbk 的预览判定使用）。
 *
 * 修改原因：decodeWithMode 每 chunk 都 new TextDecoder('gbk')，高频输出时反复构造解码器。
 * 修改方式：提升为模块级实例复用；注意它与流式 gbkDecoder 互不共享，
 *          本实例只做非流式 decode（不传 stream:true），状态互不污染。
 */
const gbkPreviewDecoder = new TextDecoder('gbk');

/**
 * 统计 Unicode 替换字符数量
 *
 * 当字节流按错误编码解码时，通常会出现大量 U+FFFD（�）
 */
function countReplacementChars(text: string): number {
    let count = 0;
    for (const ch of text) {
        if (ch === '\uFFFD') {
            count += 1;
        }
    }
    return count;
}

/**
 * 判断是否应从 UTF-8 降级到 GBK 解码
 */
function shouldFallbackToGbk(utf8Text: string, gbkText: string, chunk: Buffer): boolean {
    // 纯 ASCII 内容不需要降级
    if (!chunk.some(byte => byte >= 0x80)) {
        return false;
    }

    const utf8ReplacementCount = countReplacementChars(utf8Text);
    if (utf8ReplacementCount === 0) {
        return false;
    }

    const gbkReplacementCount = countReplacementChars(gbkText);
    return gbkReplacementCount < utf8ReplacementCount;
}

/**
 * 根据当前模式解码流式输出
 *
 * @param utf8Decoder 兼容保留参数：历史调用方（含既有测试）仍按 4 参调用；
 *                    本实现自管跨 chunk 前缀缓冲，不依赖 StringDecoder 的内部缓冲状态。
 */
export function decodeWithMode(
    chunk: Buffer,
    modeRef: StreamDecodeState,
    utf8Decoder?: StringDecoder,
    gbkDecoder?: TextDecoder
): string {
    if (modeRef.mode === 'gbk' && gbkDecoder) {
        return gbkDecoder.decode(chunk, { stream: true });
    }

    // 拼接上一 chunk 扣下的前缀后重新切分，前缀随本 chunk 一起完整解码
    const pending = modeRef.pendingBytes;
    const combined = pending && pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    const tailLen = utf8IncompleteTailLength(combined);
    const completeLen = combined.length - tailLen;
    modeRef.pendingBytes = tailLen > 0 ? Buffer.from(combined.subarray(completeLen)) : undefined;

    const utf8Text = completeLen > 0 ? utf8TextDecoder.decode(combined.subarray(0, completeLen)) : '';
    if (!gbkDecoder) {
        // 无 GBK 兜底（非 Windows）：同样扣住跨 chunk 前缀，close 时由 flushDecodeState 冲刷
        return utf8Text;
    }

    const gbkPreview = gbkPreviewDecoder.decode(chunk);
    if (shouldFallbackToGbk(utf8Text, gbkPreview, chunk)) {
        modeRef.mode = 'gbk';
        // 把扣下的跨 chunk 前缀与本 chunk 一起交给 GBK 解码：
        // 本 chunk 的 utf8 输出（替换字符垃圾）被丢弃，前缀字节不再丢失
        modeRef.pendingBytes = undefined;
        return gbkDecoder.decode(combined, { stream: true });
    }

    return utf8Text;
}

/**
 * 冲刷流式解码状态（进程关闭时调用），返回解码器剩余的尾部文本。
 *
 * - gbk 模式：flush TextDecoder 的流缓冲；
 * - utf8 模式：冲刷跨 chunk 扣下的未完成前缀（非流式解码，未完成序列 → 替换字符，
 *   与原 StringDecoder.end() 语义一致）。
 */
export function flushDecodeState(modeRef: StreamDecodeState, gbkDecoder?: TextDecoder): string {
    if (modeRef.mode === 'gbk' && gbkDecoder) {
        return gbkDecoder.decode();
    }
    const pending = modeRef.pendingBytes;
    modeRef.pendingBytes = undefined;
    return pending && pending.length > 0 ? utf8TextDecoder.decode(pending) : '';
}