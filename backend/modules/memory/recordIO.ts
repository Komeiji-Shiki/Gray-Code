import type { FileHandle } from 'fs/promises';

/** 填满缓冲区或读到真实 EOF，不能把一次短读当作文件结束。 */
export async function readRecordBytes(file: FileHandle, buffer: Buffer, position: number): Promise<number> {
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, position + offset);
        if (!bytesRead) break;
        offset += bytesRead;
    }
    return offset;
}

/** 迁移与重写已知原文件长度，提前 EOF 必须中止替换。 */
export async function readRecordBuffer(file: FileHandle, buffer: Buffer, position: number): Promise<void> {
    if (await readRecordBytes(file, buffer, position) !== buffer.length) throw new Error('记忆文件在读取期间被截断。');
}

/** FileHandle.write 允许短写，临时文件写完整后才能原子替换旧文件。 */
export async function writeRecordBuffer(file: FileHandle, buffer: Buffer, position?: number): Promise<void> {
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, position === undefined ? null : position + offset);
        if (!bytesWritten) throw new Error('记忆文件写入没有完成。');
        offset += bytesWritten;
    }
}
