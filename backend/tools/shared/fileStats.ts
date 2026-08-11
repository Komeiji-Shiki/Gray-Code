// 从 utils.ts 拆分而来（行数统计 + 文件大小格式化）

import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import { isBinaryFile } from './multimodal';

/** 行数统计的文件大小上限：超过后 lineCount 的参考价值很低，不值得付出读取成本 */
const MAX_LINE_COUNT_FILE_SIZE_BYTES = 4 * 1024 * 1024;

/** 分块读取统计行数时的块大小 */
const LINE_COUNT_CHUNK_SIZE = 64 * 1024;

function countLineFeeds(bytes: Uint8Array, length: number): number {
    let newlines = 0;
    for (let i = 0; i < length; i++) {
        if (bytes[i] === 0x0A) {
            newlines++;
        }
    }
    return newlines;
}

export async function countTextFileLines(uri: vscode.Uri, filePath: string): Promise<number | undefined> {
    // 文件发现类工具需要在不读取完整内容到返回值的前提下提示文本文件规模。
    // 二进制文件或读取失败时保持 undefined，避免把该能力变成硬失败。
    //
    // 修改原因：旧实现为了数行数把整个文件读入内存、解码、两次全量 replace
    // 再 split 建数组，且没有大小护栏（大 .log/.csv 会全量进内存）。
    // 修改方式：先用 stat 做大小护栏；本地文件分块读取直接统计 0x0A 字节，
    // 无需解码与字符串分配。行数 = LF 数 + 1，与旧实现 split('\n').length 一致
    //（CRLF 含 LF 仍正确；古老的 CR-only 文件会低估，作为辅助元数据可接受）。
    if (isBinaryFile(filePath)) {
        return undefined;
    }

    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (typeof stat.size === 'number') {
            if (stat.size > MAX_LINE_COUNT_FILE_SIZE_BYTES) {
                return undefined;
            }
            if (stat.size === 0) {
                return 1;
            }
        }

        // 本地文件：分块读取，峰值内存只有一个 64KB 缓冲区
        if (uri.scheme === 'file' && uri.fsPath) {
            const handle = await fsp.open(uri.fsPath, 'r');
            try {
                const buffer = Buffer.alloc(LINE_COUNT_CHUNK_SIZE);
                let newlines = 0;
                while (true) {
                    const { bytesRead } = await handle.read(buffer, 0, LINE_COUNT_CHUNK_SIZE, null);
                    if (bytesRead <= 0) {
                        break;
                    }
                    newlines += countLineFeeds(buffer, bytesRead);
                }
                return newlines + 1;
            } finally {
                await handle.close();
            }
        }

        // 非 file scheme：无法部分读取，退化为整体读取后按字节统计（已有大小护栏）
        const content = await vscode.workspace.fs.readFile(uri);
        return countLineFeeds(content, content.length) + 1;
    } catch {
        return undefined;
    }
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
