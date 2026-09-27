import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { startHttpServer } from '../../../apps/server/src/transport/http';
import { fixture } from './fixtures';

test('实时与补发的权限读取失败后结束推送，重连仍补回失败项与后续事件', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const token = 'isolated-event-recovery-fixture-token';
  const server = await startHttpServer(app, { token });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('事件恢复验证超时')), 5000);
  const original = ApplicationRouter.prototype.mayReceive;
  let failures = 0;
  const check = jest.spyOn(ApplicationRouter.prototype, 'mayReceive').mockImplementation(function (this: ApplicationRouter, session, event) {
    if (event.type === 'fixture.failed' && failures < 2) { failures++; return Promise.reject(new Error('fixture permission read failure')); }
    return original.call(this, session, event);
  });
  const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, marker: string) => {
    let text = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return { text, ended: true };
        text += Buffer.from(chunk.value).toString('utf8');
        if (text.includes(marker)) return { text, ended: false };
      }
    } catch (error) {
      if (controller.signal.aborted) throw error;
      return { text, ended: true };
    }
  };
  try {
    const url = 'http://127.0.0.1:' + server.port + '/events?client=fixture';
    const options = { headers: { Authorization: 'Bearer ' + token }, signal: controller.signal };
    const response = await fetch(url, options), reader = response.body!.getReader();
    app.publish({ type: 'fixture.before' });
    const before = await readUntil(reader, '"fixture.before"}\n\n');
    const frame = before.text.split('\n\n').find(value => value.includes('"fixture.before"'))!;
    const cursor = /^id: (.+)$/m.exec(frame)![1];
    app.publish({ type: 'fixture.failed' });
    app.publish({ type: 'fixture.after' });
    const interrupted = await readUntil(reader, '"fixture.after"}\n\n');
    expect(interrupted.ended).toBe(true);
    expect(interrupted.text).not.toContain('fixture.after');
    const retryUrl = url + '&after=' + encodeURIComponent(cursor);
    const retry = await fetch(retryUrl, options);
    const failedReplay = await readUntil(retry.body!.getReader(), '"fixture.after"}\n\n');
    expect(failedReplay.ended).toBe(true);
    expect(failedReplay.text).not.toContain('fixture.after');
    const resumed = await fetch(retryUrl, options);
    const replay = await readUntil(resumed.body!.getReader(), '"fixture.after"}\n\n');
    expect(replay.ended).toBe(false);
    expect(replay.text.match(/"fixture.failed"/g)).toHaveLength(1);
    expect(replay.text.match(/"fixture.after"/g)).toHaveLength(1);
    expect(replay.text.indexOf('fixture.failed')).toBeLessThan(replay.text.indexOf('fixture.after'));
    expect(failures).toBe(2);
  } finally { clearTimeout(timeout); controller.abort(); check.mockRestore(); await server.close(); await app.close(); await f.cleanup(); }
});

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
    const payload = '灰魂😺'.repeat(120_000);
    app.publish({ type: 'fixture.large', payload });
    for (let index = 0; index < 40; index++) app.publish({ type: 'fixture.queued', index, payload: 'y'.repeat(40_000) });
    expect(server.diagnostics().backlogResets).toBe(1);
    expect(server.diagnostics().queuedBytes).toBeLessThan(Buffer.byteLength(payload) + 1000);
    release();
    const chunks: Uint8Array[] = initial.value ? [initial.value] : [];
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(chunk.value); }
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toContain(JSON.stringify({ type: 'fixture.large', payload }));
    expect(text.lastIndexOf('event: reset')).toBeGreaterThan(text.indexOf('fixture.large'));
    expect(text).not.toContain('fixture.queued');
  } finally { release(); controller.abort(); check.mockRestore(); await server.close(); await app.close(); await f.cleanup(); }
});
