/**
 * monitor-smoke.ts - SubAgent monitor embedded-panel smoke test (GRAYCODE_MONITOR_SMOKE=1).
 *
 * Verifies the in-window SubAgent Monitor bridge (no separate BrowserWindow):
 *  1. subagents.monitorReady round-trips and returns manifests
 *  2. subagents.monitor.getRunWindow rejects unknown run ids gracefully
 *  3. subagents.monitor.setVisible controls event delivery
 *  4. llm_delta events are dropped while the panel is hidden and pushed when visible
 *  5. low-frequency status events are still pushed while hidden
 *
 * Run with: GRAYCODE_MONITOR_SMOKE=1 electron .
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { BackendHost } from './host/BackendHost.js';
import { subAgentRunEventBus } from '../../backend/tools/subagents';

const log = (msg: string) => console.log(`[monitor-smoke] ${msg}`);
let failures = 0;
const assert = (cond: boolean, label: string) => {
  if (cond) {
    log(`PASS ${label}`);
  } else {
    failures++;
    log(`FAIL ${label}`);
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runMonitorSmoke(): Promise<void> {
  const userData = path.join(app.getPath('temp'), 'graycode-monitor-smoke-' + Date.now());
  fs.mkdirSync(userData, { recursive: true });

  const received: any[] = [];
  const host = new BackendHost({
    userDataPath: userData,
    extensionPath: path.resolve(__dirname, '..', '..'),
    postToRenderer: (message) => received.push(message),
    native: async <T = any>() => undefined as T,
    onOpenDiffPreview: () => undefined
  });

  try {
    await host.ready;

    const findResponse = (requestId: string) =>
      received.find((r) => r?.requestId === requestId && (r.type === 'response' || r.type === 'error'));

    // 1. monitorReady (via the real renderer entry point, clientId tag as the panel sends)
    await host.handleRendererMessage({
      type: 'subagents.monitorReady',
      requestId: 'smoke_ready',
      clientId: 'subagent-monitor',
      data: {}
    });
    await sleep(300);
    const readyState = findResponse('smoke_ready');
    assert(
      !!readyState && Array.isArray(readyState.data?.manifests) && readyState.success === true,
      `monitorReady returned manifests (${readyState?.data?.manifests?.length ?? 'n/a'} runs)`
    );

    // 2. getRunWindow for an unknown run must fail gracefully (not hang)
    await host.handleRendererMessage({
      type: 'subagents.monitor.getRunWindow',
      requestId: 'smoke_window',
      clientId: 'subagent-monitor',
      data: { runId: 'does-not-exist' }
    });
    await sleep(300);
    const windowState = findResponse('smoke_window');
    assert(
      !!windowState && windowState.success === false && /not found/i.test(String(windowState.error?.message || '')),
      `getRunWindow rejects unknown run (${windowState?.error?.message || 'no response'})`
    );

    // 3. setVisible controls event delivery
    await host.handleRendererMessage({
      type: 'subagents.monitor.setVisible',
      requestId: 'smoke_vis_false',
      clientId: 'subagent-monitor',
      data: { visible: false }
    });
    await sleep(200);
    const visFalse = findResponse('smoke_vis_false');
    assert(!!visFalse && visFalse.success === true && visFalse.data?.visible === false, 'setVisible(false) acknowledged');

    // 4a. hidden panel: llm_delta must NOT be pushed
    received.length = 0;
    subAgentRunEventBus.emit({
      runId: 'smoke-run-hidden',
      agentName: 'Smoke Agent',
      type: 'llm_delta',
      timestamp: Date.now(),
      payload: { delta: [{ text: 'hidden' }] }
    });
    await sleep(300);
    assert(
      !received.some((r) => r?.type === 'subagentMonitor.event' && r?.data?.event?.runId === 'smoke-run-hidden'),
      'llm_delta dropped while panel hidden'
    );

    // 4b. hidden panel: low-frequency status events still pushed
    received.length = 0;
    subAgentRunEventBus.emit({
      runId: 'smoke-run-hidden-status',
      agentName: 'Smoke Agent',
      type: 'tool_started',
      timestamp: Date.now(),
      payload: { toolName: 'read_file', toolId: 't1' }
    });
    await sleep(300);
    assert(
      received.some((r) => r?.type === 'subagentMonitor.event' && r?.data?.event?.runId === 'smoke-run-hidden-status'),
      'status event pushed while panel hidden'
    );

    // 5. visible panel: llm_delta pushed (batched, 50ms flush)
    await host.handleRendererMessage({
      type: 'subagents.monitor.setVisible',
      requestId: 'smoke_vis_true',
      clientId: 'subagent-monitor',
      data: { visible: true }
    });
    await sleep(200);
    received.length = 0;
    subAgentRunEventBus.emit({
      runId: 'smoke-run-visible',
      agentName: 'Smoke Agent',
      type: 'llm_delta',
      timestamp: Date.now(),
      payload: { delta: [{ text: 'hello' }, { text: ' world' }] }
    });
    await sleep(300);
    const deltaEvent = received.find(
      (r) => r?.type === 'subagentMonitor.event' && r?.data?.event?.runId === 'smoke-run-visible'
    );
    assert(
      !!deltaEvent && Array.isArray(deltaEvent.data?.event?.payload?.delta),
      `llm_delta pushed while panel visible (delta=${deltaEvent?.data?.event?.payload?.delta?.length ?? 'n/a'} parts)`
    );

    // 6. openRun (backend "open details") pushes a navigate manifest + command
    received.length = 0;
    const hostBridge = (host as any).subAgentMonitorBridge;
    assert(!!hostBridge, 'backend owns a SubAgentMonitorBridge');
    hostBridge?.openRun('smoke-run-visible', undefined);
    await sleep(300);
    assert(
      received.some((r) => r?.type === 'subagentMonitor.manifest' && r?.data?.focusRunId === 'smoke-run-visible'),
      'openRun pushed navigate manifest with focusRunId'
    );
  } catch (err) {
    failures++;
    log('MONITOR SMOKE ERROR: ' + (err as Error).message);
    console.error(err);
  } finally {
    // 兜底退出：无论成功/断言失败/异常，都排空写队列、清理临时数据目录并以明确状态码
    // 结束进程，绝不让无窗口的 Electron 挂着拖死 CI（与 e2e.ts 的 try/catch/finally 同模式）。
    try {
      await host.dispose();
    } catch (err) {
      console.error('[monitor-smoke] dispose failed:', err);
    }
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结论
    }
    if (failures === 0) {
      log('ALL MONITOR SMOKE TESTS PASSED');
    } else {
      log(`${failures} MONITOR SMOKE TEST(S) FAILED`);
    }
    app.exit(failures === 0 ? 0 : 1);
  }
}
