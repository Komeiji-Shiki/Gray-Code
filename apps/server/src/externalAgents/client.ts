import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import crossSpawn from 'cross-spawn';
import type { ClientConnection, InitializeResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';
import type { ExternalAgentProfile } from '@graycode/contracts';
import packageMetadata from '../../../../package.json';
import { stopOwnedProcess } from '../workspace/processLifecycle';

export interface AcpClient {
  connection: ClientConnection;
  info: InitializeResponse;
  child: ChildProcess;
  stderr(): string;
  stop(): Promise<void>;
}

/** 每个会话持有实际进程，取消超时只结束该会话；协议本身由官方 SDK 处理。 */
export async function openAcpClient(profile: ExternalAgentProfile, directory: string, signal: AbortSignal, callbacks: {
  update(value: SessionNotification): void;
  permission(value: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>;
}): Promise<AcpClient> {
  // 普通聊天启动时不解析外部代理 SDK，也不启动任何代理程序。
  const sdk = await import('@agentclientprotocol/sdk');
  signal.throwIfAborted();
  const child = crossSpawn(profile.command, profile.args, { cwd: directory, env: { ...process.env, ...profile.env },
    stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
  const connection = sdk.client({ name: 'GrayCode' })
    .onNotification('session/update', ({ params }) => callbacks.update(params))
    .onRequest('session/request_permission', ({ params, signal }) => callbacks.permission(params, signal))
    .connect(sdk.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
  child.once('error', error => connection.close(error));
  child.once('exit', (code, reason) => connection.close(new Error(`代理进程退出：${code ?? reason ?? 'unknown'}`)));
  const abort = () => connection.close(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => connection.close(new Error('外部代理初始化超时。')), 30000); timer.unref();
  try {
    const info = await connection.agent.request('initialize', {
      protocolVersion: sdk.PROTOCOL_VERSION, clientInfo: { name: 'GrayCode', version: packageMetadata.version },
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
    });
    signal.throwIfAborted();
    if (info.protocolVersion !== sdk.PROTOCOL_VERSION) throw new Error(`外部代理使用不兼容的 ACP 版本：${info.protocolVersion}`);
    return { connection, info, child, stderr: () => stderr,
      stop: async () => { connection.close(); await stopOwnedProcess(child); } };
  } catch (error) {
    connection.close(error);
    await stopOwnedProcess(child).catch(closeError => console.error('外部代理启动失败后的关闭错误：', closeError));
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr.trim() ? '\n' + stderr.trim() : ''}`);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
