import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { startHttpServer } from '../../../apps/server/src/transport/http';
import { fixture } from './fixtures';

test('积压恢复先完整发送已接受的大图片帧，再通知客户端重建快照', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const token = 'isolated-event-backlog-fixture-token';
  const server = await startHttpServer(app, { token });
  let release!: () => void; const permission = new Promise<void>(resolve => { release = resolve; });
  const check = jest.spyOn(ApplicationRouter.prototype, 'mayReceive').mockImplementation(async () => { await permission; return true; });
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/events?client=fixture`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader(); const initial = await reader.read();
    const payload = 'x'.repeat(1_100_000);
    app.publish({ type: 'fixture.large', payload });
    for (let index = 0; index < 40; index++) app.publish({ type: 'fixture.queued', index, payload: 'y'.repeat(40_000) });
    expect(server.diagnostics().backlogResets).toBe(1);
    expect(server.diagnostics().queuedBytes).toBeLessThan(payload.length + 1000);
    release();
    const chunks: Uint8Array[] = initial.value ? [initial.value] : [];
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(chunk.value); }
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain(JSON.stringify({ type: 'fixture.large', payload }));
    expect(text.lastIndexOf('event: reset')).toBeGreaterThan(text.indexOf('fixture.large'));
    expect(text).not.toContain('fixture.queued');
  } finally { release(); controller.abort(); check.mockRestore(); await server.close(); await app.close(); await f.cleanup(); }
});
