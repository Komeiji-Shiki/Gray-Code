import type { ChildProcess } from 'child_process';
import { ProcessSessionError } from '../../../shared/processOutput';

/** 输入必须等待写入回调；取消只结束这次等待，不能撤回已提交的数据。 */
export async function writeProcessInput(child: ChildProcess, text: string, signal?: AbortSignal, inputError?: Error): Promise<void> {
    signal?.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) {
        throw new ProcessSessionError('EXITED', '命令已经退出，不能再发送输入。');
    }
    const input = child.stdin;
    if (inputError || !input || input.destroyed || input.writableEnded || !input.writable) {
        throw new ProcessSessionError('INPUT_CLOSED', '命令输入管道已关闭，进程输出仍可读取。');
    }
    let abort: (() => void) | undefined;
    try {
        await new Promise<void>((resolve, reject) => {
            abort = () => reject(signal!.reason);
            signal?.addEventListener('abort', abort, { once: true });
            input.write(text, (error) => (error ? reject(new ProcessSessionError('INPUT_CLOSED', `命令输入写入失败：${error.message}`)) : resolve()));
        });
    } finally {
        if (abort) signal?.removeEventListener('abort', abort);
    }
}
