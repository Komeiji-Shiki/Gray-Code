import path from 'node:path';
import { access } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { captureBotAgent } from '../../../apps/server/src/bots/profiles';
import { fixture } from './fixtures';

test('MCP configuration drafts do not spawn processes; committed stdio discovery and calls run through the task core', async () => {
  const f = await fixture(); await f.store.close();
  const captured: string[][] = [];
  let toolText = 'stdio works';
  const app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async input => {
    captured.push(input.tools.map(tool => tool.name));
    const user = input.messages.map(message => message.isUserInput === true).lastIndexOf(true);
    if (input.messages.slice(user).some(message => message.isFunctionResponse)) return { role: 'model', parts: [{ text: 'Finished' }] };
    return { role: 'model', parts: [{ functionCall: { id: 'mcp-call', name: 'mcp__fixture__echo', args: { text: toolText } } }] };
  } } });
  const router = new ApplicationRouter(app), owner = { actorId: 'owner', clientId: 'mcp-test' };
  const call = (type: string, data = {}) => router.call(owner, 'ui.request', { type, data }) as Promise<any>;
  try {
    const marker = path.join(f.root, 'started');
    await call('ui.settings.begin');
    await call('createMcpServer', { customId: 'fixture', input: { name: 'Fixture', enabled: true, autoConnect: true,
      transport: { type: 'stdio', command: process.execPath, args: [path.resolve('packages/core/tests/fixtures/mcp-server.cjs'), marker] } } });
    await expect(access(marker)).rejects.toThrow();
    await expect(call('connectMcpServer', { serverId: 'fixture' })).rejects.toThrow('请先保存');
    expect((await call('tools.getAutoExecConfig')).config.mcp__fixture__echo).toBeUndefined();
    await call('ui.settings.save');
    await call('connectMcpServer', { serverId: 'fixture' });
    expect((await call('getMcpServers')).servers[0].status).toBe('connected');
    expect((await call('tools.getMcpTools')).tools[0].name).toBe('mcp__fixture__echo');
    const chat = await router.call(owner, 'conversations.create', { title: 'MCP' }) as { id: string };
    const start = (agentId = 'default') => app.runtime.start({ actorId: 'owner', agentId, requestKey: toolText, conversationId: chat.id, message: { role: 'user', parts: [{ text: toolText }] } });
    const run = await start();
    expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    const history = await app.storage.readFullHistory(chat.id);
    expect(history.messages.find(message => message.isFunctionResponse)?.parts[0]).toMatchObject({ functionResponse: { response: { success: true, data: { structuredContent: { echoed: 'stdio works' } } } } });
    expect(history.messages.find(message => message.isFunctionResponse)?.parts[1]).toMatchObject({ inlineData: { mimeType: 'application/octet-stream', data: Buffer.from('fixture binary').toString('base64') } });
    // Discord 捕获的配置同样保留 MCP 缺省自动执行，避免桌面正常而 Bot 再次请求确认。
    toolText = 'bot default';
    const bot = await captureBotAgent(app, 'owner', chat.id, { agentId: 'default', toolsEnabled: true });
    const botRun = await start(bot.id);
    expect((await app.runtime.wait(botRun.id))?.status).toBe('completed');
    expect((await app.storage.readRunEvents(botRun.id)).some(event => event.type === 'approval.requested')).toBe(false);

    await call('ui.settings.begin');
    await call('tools.setToolAutoExec', { toolName: 'mcp__fixture__echo', autoExec: false });
    await call('ui.settings.save');
    const approvalReady = new Promise<string>(resolve => {
      const off = app.runtime.subscribe(event => {
        if (event.type === 'event' && event.event.type === 'approval.requested') { off(); resolve(String(event.event.payload.id)); }
      });
    });
    toolText = 'confirmed';
    const askingBot = await captureBotAgent(app, 'owner', chat.id, { agentId: 'default', toolsEnabled: true });
    const askingRun = await start(askingBot.id);
    const approvalId = await approvalReady;
    expect((await app.storage.readRunEvents(askingRun.id)).some(event => event.type === 'tool.started')).toBe(false);
    await app.runtime.resolveApproval(approvalId, 'owner', true);
    expect((await app.runtime.wait(askingRun.id))?.status).toBe('completed');
    expect((await app.storage.readFullHistory(chat.id)).messages.filter(message => message.isFunctionResponse).at(-1)?.parts[0])
      .toMatchObject({ functionResponse: { response: { success: true, data: { structuredContent: { echoed: 'confirmed' } } } } });

    await call('ui.settings.begin');
    await call('tools.setToolAutoExec', { toolName: 'mcp__fixture__echo', autoExec: true });
    await call('ui.settings.save');
    toolText = 'wait';
    const started = new Promise<void>(resolve => { const off = app.subscribe(event => { if (event.type === 'event' && (event.event as any).type === 'tool.started') { off(); resolve(); } }); });
    const pending = await start(); await started; await app.runtime.cancel(pending.id, 'owner');
    expect((await app.runtime.wait(pending.id))?.status).toBe('cancelled');
    expect(captured.every(names => names.includes('mcp__fixture__echo'))).toBe(true);
    expect((await app.storage.readFullHistory(chat.id)).messages.filter(message => message.isFunctionResponse)).toHaveLength(4);
    await call('disconnectMcpServer', { serverId: 'fixture' });
    expect(app.mcp.names()).toEqual([]);
  } finally { await app.close(); await f.cleanup(); }
});

test('MCP headers are encrypted in the same settings transaction and JSON edits remain in a reversible draft', async () => {
  const f = await fixture(); await f.store.close();
  const key = randomBytes(32);
  const app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: {
    encrypt: async text => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decrypt: async data => { const bytes = Buffer.from(data), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(); },
  } });
  const router = new ApplicationRouter(app), owner = { actorId: 'owner', clientId: 'mcp-json' };
  const call = (type: string, data = {}) => router.call(owner, 'ui.request', { type, data }) as Promise<any>;
  try {
    await call('ui.settings.begin');
    await call('mcp.replaceJson', { config: { mcpServers: { private: { type: 'streamable-http', url: 'http://localhost:1/mcp', headers: { Authorization: 'fixture-secret' }, autoConnect: false } } } });
    expect(app.product.mcpConfigs()).toEqual([]);
    await call('ui.settings.save');
    const saved = await app.storage.getRecord('product-settings', 'main');
    expect(JSON.stringify(saved)).not.toContain('fixture-secret');
    expect(app.product.mcpConfigs()[0].transport).toMatchObject({ headers: { Authorization: 'fixture-secret' } });
    await call('deleteMcpServer', { serverId: 'private' });
    await call('ui.settings.discard');
    expect((await call('getMcpServers')).servers).toHaveLength(1);
    const json = await call('mcp.getJson');
    expect(json.mcpServers.private.headers.Authorization).toBe('fixture-secret');
  } finally { await app.close(); await f.cleanup(); }
});
