import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import spawn from 'cross-spawn';
import type { DebugAdapterDefinition, DebugAdapterInfo, DebugConfiguration } from '@graycode/contracts';
import { executable } from './languageCatalog';
import { DapConnection } from './dapConnection';
import { stopDevelopmentProcess } from './process';

export interface DebugAdapterRuntime {
  connect(configuration?: Record<string, any>): Promise<DapConnection>;
  close(): Promise<void>;
  child?: ChildProcessWithoutNullStreams;
}
export function bundledDebugServer(): string {
  for (let directory = __dirname;; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'resources', 'debuggers', 'js-debug', 'src', 'dapDebugServer.js');
    if (fs.existsSync(candidate)) return candidate;
    if (directory === path.dirname(directory)) throw new Error('安装内容缺少 Node.js 调试器，请修复安装。');
  }
}
export function connectDap(host: string, port: number): Promise<DapConnection> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error('连接调试器超时。')), 10_000);
    const failed = (error: Error) => { clearTimeout(timer); reject(error); };
    socket.once('error', failed);
    socket.once('connect', () => {
      clearTimeout(timer); socket.off('error', failed); socket.setNoDelay(true);
      resolve(new DapConnection(socket, socket));
    });
  });
}
export class DebugAdapterCatalog {
  private pythonAvailable?: Promise<boolean>;
  definitions(custom: DebugAdapterDefinition[]) {
    const defaults: DebugAdapterDefinition[] = [
      { id: 'node', name: 'Node.js / TypeScript', command: process.execPath, args: [bundledDebugServer(), '0', '127.0.0.1'], transport: 'tcp' },
      { id: 'python', name: 'Python · debugpy', command: executable('python') ?? 'python', args: ['-m', 'debugpy.adapter'], transport: 'stdio' },
    ];
    return [...custom, ...defaults.filter(item => !custom.some(value => value.id === item.id))];
  }
  async list(custom: DebugAdapterDefinition[], refresh = false): Promise<DebugAdapterInfo[]> {
    if (refresh) this.pythonAvailable = undefined;
    const definitions = this.definitions(custom);
    return Promise.all(definitions.map(async definition => {
      if (custom.some(item => item.id === definition.id)) return { id: definition.id, name: definition.name, source: 'custom', available: true,
        requirement: '使用已保存的启动配置，连接结果以实际会话为准。', configurationTemplate: definition };
      if (definition.id === 'node') return { id: 'node', name: definition.name, source: 'bundled', available: true,
        requirement: '调试器与 Node 运行环境随程序提供。TypeScript 项目请先构建并生成 source map，也可指定项目自己的运行程序。',
        documentationUrl: 'https://github.com/microsoft/vscode-js-debug' };
      this.pythonAvailable ??= new Promise(resolve => execFile(definition.command, ['-c', 'import debugpy; print(debugpy.__version__)'],
        { windowsHide: true, timeout: 5000, maxBuffer: 8192 }, error => resolve(!error)));
      return { id: 'python', name: definition.name, source: 'system', available: await this.pythonAvailable,
        requirement: '需要 Python 和该解释器环境中的 debugpy。可填写项目虚拟环境的 Python 完整路径。',
        documentationUrl: 'https://github.com/microsoft/debugpy', configurationTemplate: definition };
    }));
  }
  async start(definition: DebugAdapterDefinition, configuration: DebugConfiguration, cwd: string,
    custom: boolean, output: (category: string, text: string) => void): Promise<DebugAdapterRuntime> {
    if (configuration.adapterId === 'python' && configuration.request === 'attach' && !custom) {
      if (!configuration.port) throw new Error('请填写 debugpy 的监听端口。');
      return { connect: child => connectDap(child?.connect?.host ?? configuration.host ?? '127.0.0.1', child?.connect?.port ?? configuration.port!), close: async () => {} };
    }
    if (definition.transport === 'tcp' && !definition.command) {
      if (!definition.port) throw new Error('请填写调试适配器的监听端口。');
      return { connect: () => connectDap(definition.host ?? '127.0.0.1', definition.port!), close: async () => {} };
    }
    const command = configuration.adapterId === 'python' && configuration.runtimeExecutable ? configuration.runtimeExecutable : definition.command;
    const child = spawn(command, definition.args, { cwd, shell: false, windowsHide: true,
      env: { ...process.env, ...(command === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
    child.stderr.on('data', bytes => output('adapter', bytes.toString()));
    let failure: Error | undefined;
    child.once('error', error => { failure = error; });
    const runtime: DebugAdapterRuntime = { child, close: () => stopDevelopmentProcess(child), connect: async () => { throw new Error('调试器正在启动。'); } };
    try {
      if (definition.transport === 'stdio') {
        let connected = false;
        runtime.connect = async childConfiguration => {
          if (childConfiguration?.connect?.port) return connectDap(childConfiguration.connect.host ?? '127.0.0.1', childConfiguration.connect.port);
          if (connected) throw new Error('此调试器不支持在同一标准输入中创建第二个会话。');
          if (failure) throw failure;
          connected = true;
          const connection = new DapConnection(child.stdout, child.stdin);
          child.once('error', error => connection.dispose(error));
          return connection;
        };
      } else if (definition.id === 'node' && !custom) {
        const port = await new Promise<number>((resolve, reject) => {
          let received = '';
          const finish = (error?: Error, port?: number) => {
            clearTimeout(timer); child.stdout.off('data', data); child.off('error', fail); child.off('exit', exited);
            error ? reject(error) : resolve(port!);
          };
          const data = (bytes: Buffer) => {
            received = (received + bytes.toString()).slice(-8192);
            const match = /Debug server listening at 127\.0\.0\.1:(\d+)/.exec(received);
            if (match) finish(undefined, Number(match[1]));
          };
          const fail = (error: Error) => finish(error);
          const exited = (code: number | null) => finish(new Error('Node 调试器启动失败：' + code));
          const timer = setTimeout(() => finish(new Error('Node 调试器没有返回监听端口。')), 10_000);
          child.stdout.on('data', data); child.once('error', fail); child.once('exit', exited);
        });
        child.stdout.on('data', bytes => output('adapter', bytes.toString()));
        runtime.connect = () => connectDap('127.0.0.1', port);
      } else {
        if (!definition.port) throw new Error('TCP 调试器需要填写固定监听端口。');
        child.stdout.on('data', bytes => output('adapter', bytes.toString()));
        // 自定义程序没有统一的就绪事件；只在它仍存活时重试其明确配置的端口。
        const deadline = Date.now() + 10_000;
        runtime.connect = async () => {
          for (;;) {
            if (failure) throw failure;
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('调试器已退出。');
            try { return await connectDap(definition.host ?? '127.0.0.1', definition.port!); }
            catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
          }
        };
      }
      return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }
}
