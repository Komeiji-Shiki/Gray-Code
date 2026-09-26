// 从 utils.ts 拆分而来（行数统计 + 文件大小格式化）

import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import { isBinaryFile } from './multimodal';
import { MAX_LINE_COUNT_FILE_BYTES } from './fileSizeGuards';
import { TextLineCounter } from '../../../shared/textLines';
export { formatFileSize } from './fileSize';

/** 分块读取统计行数时的块大小 */
const LINE_COUNT_CHUNK_SIZE = 64 * 1024;

export async function countTextFileLines(uri: vscode.Uri, filePath: string): Promise<number | undefined> {
    // 文件发现类工具需要在不读取完整内容到返回值的前提下提示文本文件规模。
    // 二进制文件或读取失败时保持 undefined，避免把该能力变成硬失败。
    // 大小护栏 + 字节流统计，行号规则与 read_file / workspace_files 共用。
    // 读取过程中也检查总字节数，避免 stat 后继续增长的文件绕过护栏。
    if (isBinaryFile(filePath)) {
        return undefined;
    }

    try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (typeof stat.size === 'number') {
            if (stat.size > MAX_LINE_COUNT_FILE_BYTES) {
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
                const counter = new TextLineCounter();
                let totalBytes = 0;
                while (true) {
                    const { bytesRead } = await handle.read(buffer, 0, LINE_COUNT_CHUNK_SIZE, null);
                    if (bytesRead <= 0) {
                        break;
                    }
                    totalBytes += bytesRead;
                    if (totalBytes > MAX_LINE_COUNT_FILE_BYTES) return undefined;
                    counter.push(buffer, bytesRead);
                }
                return counter.lineCount;
            } finally {
                await handle.close();
            }
        }

        // 非 file scheme：无法部分读取，退化为整体读取后按字节统计（已有大小护栏）
        const content = await vscode.workspace.fs.readFile(uri);
        if (content.length > MAX_LINE_COUNT_FILE_BYTES) return undefined;
        const counter = new TextLineCounter();
        counter.push(content);
        return counter.lineCount;
    } catch {
        return undefined;
    }
}

