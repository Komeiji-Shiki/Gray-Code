/**
 * 检查点模块共享文件哈希（CPF-06 / CP-DUP-1）。
 *
 * 流式计算文件 MD5（createReadStream），不整文件读入内存。
 *
 * 收敛说明（CP-DUP-1）：CheckpointSnapshotBuilder 与 CheckpointRestoreEngine
 * 各自维护过一份相同实现，现统一引用本模块，避免并发/错误语义漂移。
 * CheckpointManager.getFileHash 的收敛由后续批次处理（保持现状）。
 */
import * as crypto from 'crypto';
import { createReadStream } from 'fs';

/** 流式计算文件 MD5（不整文件读入内存） */
export async function hashFileStreaming(filePath: string): Promise<string> {
    const hash = crypto.createHash('md5');
    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve());
    });
    return hash.digest('hex');
}
