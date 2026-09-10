import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

test('MCP resource and prompt selection uses the live manager without extra stdio processes', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: async () => ({ role: 'model', parts: [{ text: 'ok' }] }) } });
  const router = new ApplicationRouter(app), owner = { actorId: 'owner', clientId: 'mcp-resource-test' };
  const call = (type: string, data: any = {}) => router.call(owner, 'ui.request', { type, data }) as Promise<any>;
  try {
    const marker = path.join(f.root, 'resource-started');
    await call('ui.settings.begin');
    await call('createMcpServer', { customId: 'resource', input: { name: 'Resource Fixture', enabled: true, autoConnect: true,
      transport: { type: 'stdio', command: process.execPath, args: [path.resolve('packages/core/tests/fixtures/mcp-resource-server.cjs'), marker] } } });
    await call('ui.settings.save');
    await call('connectMcpServer', { serverId: 'resource' });
    const pidBefore = await readFile(marker, 'utf8');

    const servers = await call('getMcpServers');
    expect(servers.servers[0].status).toBe('connected');
    expect(servers.servers[0].capabilities.resources).toHaveLength(2);
    expect(servers.servers[0].capabilities.prompts).toHaveLength(1);

    const listedResources = await call('mcp.listResources');
    expect(listedResources.success).toBe(true);
    const entry = listedResources.resources.find((item: any) => item.serverId === 'resource');
    expect(entry.status).toBe('connected');
    expect(entry.resources.map((item: any) => item.uri).sort()).toEqual(['fixture://hello', 'fixture://slow']);

    const filtered = await call('mcp.listResources', { serverId: 'resource' });
    expect(filtered.resources).toHaveLength(1);

    const read = await call('mcp.readResource', { serverId: 'resource', uri: 'fixture://hello' });
    expect(read.success).toBe(true);
    expect(read.content.uri).toBe('fixture://hello');
    expect(read.content.text).toContain('hello resource content');

    await expect(call('mcp.readResource', { serverId: 'resource', uri: '' })).rejects.toThrow('资源 URI');
    await expect(call('mcp.readResource', { serverId: 'missing', uri: 'fixture://hello' })).rejects.toThrow('不存在');
    await expect(call('mcp.readResource', { serverId: 'resource', uri: 'fixture://missing' })).rejects.toThrow('Unknown resource');

    const listedPrompts = await call('mcp.listPrompts');
    const promptEntry = listedPrompts.prompts.find((item: any) => item.serverId === 'resource');
    expect(promptEntry.prompts[0]).toMatchObject({ name: 'greet' });
    expect(promptEntry.prompts[0].arguments.find((item: any) => item.name === 'name').required).toBe(true);

    const prompt = await call('mcp.getPrompt', { serverId: 'resource', promptName: 'greet', arguments: { name: 'World' } });
    expect(prompt.success).toBe(true);
    expect(prompt.messages[0].content.text).toBe('Hello, World!');

    const styled = await call('mcp.getPrompt', { serverId: 'resource', promptName: 'greet', arguments: { name: 'World', style: 'warm' } });
    expect(styled.messages[0].content.text).toContain('warm');

    await expect(call('mcp.getPrompt', { serverId: 'resource', promptName: 'greet', arguments: {} })).rejects.toThrow('缺少提示参数');
    await expect(call('mcp.getPrompt', { serverId: 'resource', promptName: 'greet', arguments: { name: 1 } })).rejects.toThrow('字符串键值对');
    await expect(call('mcp.getPrompt', { serverId: 'resource', promptName: 'missing', arguments: {} })).rejects.toThrow('Unknown prompt');

    const aborted = new AbortController(); aborted.abort();
    await expect(call('mcp.readResource', { serverId: 'resource', uri: 'fixture://hello', signal: aborted.signal })).rejects.toThrow('取消');
    await expect(call('mcp.getPrompt', { serverId: 'resource', promptName: 'greet', arguments: { name: 'World' }, signal: aborted.signal })).rejects.toThrow('取消');

    const slow = new AbortController();
    const pending = call('mcp.readResource', { serverId: 'resource', uri: 'fixture://slow', signal: slow.signal });
    slow.abort();
    await expect(pending).rejects.toThrow();

    expect(await readFile(marker, 'utf8')).toBe(pidBefore);

    await call('ui.settings.begin');
    await call('createMcpServer', { customId: 'draft-only', input: { name: 'Draft', enabled: true, autoConnect: false,
      transport: { type: 'stdio', command: process.execPath, args: ['-e', 'process.exit(0)'] } } });
    const liveOnly = await call('mcp.listResources');
    expect(liveOnly.resources.some((item: any) => item.serverId === 'draft-only')).toBe(false);
    await call('ui.settings.discard');

    await call('disconnectMcpServer', { serverId: 'resource' });
    const afterDisconnect = await call('mcp.listResources', { serverId: 'resource' });
    expect(afterDisconnect.resources[0].status).toBe('disconnected');
    expect(afterDisconnect.resources[0].resources).toEqual([]);
    await expect(call('mcp.readResource', { serverId: 'resource', uri: 'fixture://hello' })).rejects.toThrow('未连接');
    await expect(call('mcp.getPrompt', { serverId: 'resource', promptName: 'greet', arguments: { name: 'World' } })).rejects.toThrow('未连接');
  } finally { await app.close(); await f.cleanup(); }
});
