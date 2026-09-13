import type { IPty } from 'node-pty';

interface StartMessage { type: 'start'; command: string; args: string[]; cwd: string; env: Record<string, string>; cols: number; rows: number }
type Message = StartMessage | { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number } | { type: 'stop' };
let terminal: IPty | undefined;
let ending = false;
function finish(value: Record<string, unknown>, exitCode = 0) {
  if (ending) return; ending = true;
  // 等最后一条退出消息写入 IPC 后结束宿主，同时回收原生组件创建的读取线程。
  if (process.connected) process.send!(value, () => process.exit(exitCode)); else process.exit(exitCode);
}
process.on('message', (message: Message) => {
  try {
    if (message.type === 'start') {
      if (terminal) throw new Error('终端宿主已经启动程序。');
      const { spawn } = require('node-pty') as typeof import('node-pty');
      terminal = spawn(message.command, message.args, { name: 'xterm-256color', cols: message.cols, rows: message.rows, cwd: message.cwd,
        env: message.env, ...(process.platform === 'win32' ? { useConptyDll: true } : {}) });
      terminal.onData(data => { if (process.connected && !ending) process.send!({ type: 'data', data }); });
      terminal.onExit(event => finish({ type: 'exit', exitCode: event.exitCode }));
      process.send!({ type: 'ready', pid: terminal.pid });
    } else if (message.type === 'input') terminal?.write(message.data);
    else if (message.type === 'resize') terminal?.resize(message.cols, message.rows);
    else if (message.type === 'stop') { if (terminal) terminal.kill(); else finish({ type: 'exit', exitCode: 0 }); }
  } catch (error) {
    try { terminal?.kill(); } finally { finish({ type: 'error', message: String(error) }, 1); }
  }
});
process.once('disconnect', () => { try { terminal?.kill(); } finally { process.exit(0); } });
