import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClawdSettings, ClawdStatus } from '@graycode/contracts';
import { t } from '../../../../backend/i18n';

export interface ClawdEvent {
  session_id: string;
  state: 'idle' | 'thinking' | 'working' | 'notification' | 'attention' | 'error';
  event: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
}

export function validateClawdSettings(value: ClawdSettings | undefined): void {
  if (value === undefined) return;
  if (!value || typeof value.enabled !== 'boolean' || typeof value.agentId !== 'string'
    || value.agentId.length > 80 || (value.enabled || value.agentId !== '') && !/^custom-[a-z0-9-]+-[a-f0-9]{12}$/.test(value.agentId)) {
    throw new Error(t('modules.settings.clawdSettings.invalidAgentId'));
  }
}

/** 使用原生本机 HTTP，避免模型代理设置或浏览器 Origin 改变 Clawd 的接收边界。 */
export class ClawdTransport {
  constructor(private readonly runtimePath = join(homedir(), '.clawd', 'runtime.json')) {}

  async send(agentId: string, event: ClawdEvent, signal: AbortSignal): Promise<ClawdStatus> {
    let port: number;
    try {
      const runtime = JSON.parse(await readFile(this.runtimePath, 'utf8'));
      if (runtime.app !== 'clawd-on-desk' || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) return { state: 'offline' };
      port = runtime.port;
    } catch { return { state: 'offline' }; }
    const body = JSON.stringify({ agent_id: agentId, ...event, agent_pid: process.pid, platform: 'webui' });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = request({ hostname: '127.0.0.1', port, path: '/state', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
        }, response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
          response.once('error', reject);
        });
        outgoing.once('error', reject); outgoing.end(body);
      });
      return { state: status === 200 ? 'connected' : status === 204 ? 'unregistered' : 'error', port,
        ...(status === 200 ? { lastSentAt: Date.now() } : {}) };
    } catch { return { state: 'offline', port }; }
  }
}
