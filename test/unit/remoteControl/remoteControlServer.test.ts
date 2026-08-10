/**
 * RemoteControlServer HTTP 集成测试
 *
 * 用内存 fake host 起真实 http.Server（临时端口），逐端点断言：
 * - 安全基线：Host/Origin 校验、JSON-only、请求体上限、会话 ID/路径/工具响应形状白名单；
 * - 消息管道：chatStream/cancelStream/retryStream/toolConfirmation/deleteSingleMessage/
 *   conversation.setTitle 等按既有类型与载荷路由；
 * - 工作区：files/file/open-file/workspace-switch 透传 webview FileHandlers 既有消息；
 * - SSE：hello/消息流/workspace/bye 事件。
 */

import * as http from 'http';
import { RemoteControlServer, type RemoteControlServerHost } from '../../../backend/modules/remoteControl/RemoteControlServer';

interface FakeConv {
  meta: { title?: string; updatedAt?: number; messageCount?: number; preview?: string };
  messages: unknown[];
}

class FakeHost implements RemoteControlServerHost {
  server: RemoteControlServer | null = null;
  calls: Array<{ type: string; data: any; requestId: string; clientId: string }> = [];
  settings = { remoteControl: { enabled: true, port: 0 }, activeChannelId: 'ch1' as string | null };
  lang = 'zh-CN';
  version = '1.7.10dev-test';
  workspace = { workspaceUri: 'file:///C%3A/work', activeFilePath: 'src/a.ts' };
  conversations: Record<string, FakeConv> = {
    conv_test_1: {
      meta: { title: 'Test Chat', updatedAt: 1000, messageCount: 2, preview: 'hi' },
      messages: [{
        role: 'user',
        parts: [
          { text: 'hi' },
          { inlineData: { mimeType: 'image/png', data: 'a'.repeat(1000) }, text: '' },
          { functionCall: { name: 'read_file', arguments: '{}' } }
        ]
      }]
    },
    conv_empty: { meta: { title: 'Empty', updatedAt: 900, messageCount: 0, preview: '' }, messages: [] }
  };
  respondOverrides: Record<string, unknown> = {};
  configs = [
    { id: 'ch1', name: 'Channel One', model: 'm1', models: [{ id: 'm1', name: 'Model 1' }, { id: 'm2', name: 'Model 2' }] },
    { id: 'ch2', name: 'Channel Two', model: '', models: [] }
  ];

  private respond(type: string, data: any): unknown {
    if (Object.prototype.hasOwnProperty.call(this.respondOverrides, type)) {
      return this.respondOverrides[type];
    }
    switch (type) {
      case 'chatStream':
      case 'retryStream':
      case 'toolConfirmation':
        return { started: true };
      case 'conversation.createConversation':
      case 'conversation.setTitle':
      case 'workspace.setActive':
      case 'workspace.writeTextFile':
      case 'deleteSingleMessage':
        return { success: true };
      case 'listWorkspaceDirectory':
        return {
          success: true,
          workspaceUri: this.workspace.workspaceUri,
          path: data?.path || '',
          entries: [
            { name: 'src', path: 'src', type: 'directory' },
            { name: 'a.ts', path: 'src/a.ts', type: 'file', size: 42 }
          ]
        };
      case 'readWorkspaceTextFile':
        return { success: true, path: data?.path, content: 'const a = 1;\n' };
      case 'openWorkspaceFileAt':
        return { success: true, path: data?.path };
      case 'config.listConfigs':
        return this.configs.map((c) => c.id);
      case 'config.getConfig':
        return this.configs.find((c) => c.id === data?.configId) || null;
      case 'models.setActiveModel':
        return { success: true };
      case 'getWorkspaceList':
        return { activeWorkspaceUri: this.workspace.workspaceUri, workspaces: [{ name: 'work', uri: this.workspace.workspaceUri, index: 0 }] };
      case 'workspace.getSaved':
        return { saved: [{ name: 'saved-project', uri: 'file:///C%3A/saved', fsPath: 'C:\\saved' }] };
      default:
        return {};
    }
  }

  getSettings() { return this.settings as any; }
  getUiLanguage() { return this.lang; }
  getAppVersion() { return this.version; }
  getWorkspaceSnapshot() { return this.workspace; }
  conversationManager = {
    listConversations: async () => Object.keys(this.conversations),
    getMetadata: async (id: string) => this.conversations[id]?.meta ?? null,
    getMessages: async (id: string) => this.conversations[id]?.messages ?? []
  };
  configManager = {
    listConfigs: async () => (this.settings.activeChannelId ? [{ id: this.settings.activeChannelId, enabled: true }] : [])
  };
  route = async (type: string, data: any, requestId: string, clientId: string): Promise<boolean> => {
    this.calls.push({ type, data, requestId, clientId });
    if (this.server) {
      setImmediate(() => {
        this.server?.onClientMessage({ type: 'response', requestId, data: this.respond(type, data) });
      });
    }
    return true;
  };
}

/** 在临时端口起服务（随机端口，EADDRINUSE 时换端口重试一次） */
async function startServer(host: FakeHost): Promise<RemoteControlServer> {
  const server = new RemoteControlServer(host);
  host.server = server;
  host.settings.remoteControl = { enabled: true, port: 30000 + Math.floor(Math.random() * 20000) };
  server.syncFromSettings();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const status = server.getStatus();
    if (status.running) return server;
    if (status.error) {
      host.settings.remoteControl = { enabled: true, port: 30000 + Math.floor(Math.random() * 20000) };
      server.syncFromSettings();
      continue;
    }
  }
  throw new Error('Failed to start remote control server for test: ' + server.getStatus().error);
}

function requestJson(
  port: number,
  method: string,
  path: string,
  opts: { body?: unknown; contentType?: string; host?: string } = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        host: 'localhost',
        port,
        path,
        method,
        agent: false,
        headers: {
          Host: opts.host || `localhost:${port}`,
          ...(body !== undefined ? { 'Content-Type': opts.contentType || 'application/json', 'Content-Length': Buffer.byteLength(body) } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed: any = text;
          try { parsed = JSON.parse(text); } catch { /* keep raw */ }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** POST JSON body 并解析响应 */
function post(port: number, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return requestJson(port, 'POST', path, { body });
}

function requestRaw(port: number, method: string, path: string, rawBody = '', contentType?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port,
        path,
        method,
        agent: false,
        headers: {
          Host: `localhost:${port}`,
          ...(contentType ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(rawBody) } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') }));
      }
    );
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

describe('RemoteControlServer HTTP', () => {
  let host: FakeHost;
  let server: RemoteControlServer;
  let port: number;

  beforeAll(async () => {
    host = new FakeHost();
    server = await startServer(host);
    port = server.getPort();
  });

  afterAll(async () => {
    await server.dispose();
  });

  test('GET / serves self-contained HTML page', async () => {
    const res = await requestJson(port, 'GET', '/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<!DOCTYPE html>');
    expect(res.body).toContain('var T =');
    expect(res.body).toContain('data-tab="chat"');
    expect(res.body).toContain('data-tab="files"');
    expect(res.body).toContain('data-tab="settings"');
  });

  test('GET /favicon.ico returns 204', async () => {
    const res = await requestRaw(port, 'GET', '/favicon.ico');
    expect(res.status).toBe(204);
  });

  test('Host header validation: attacker domain rejected with 403', async () => {
    const res = await requestRaw(port, 'GET', '/', '', undefined);
    // 使用非本机 Host 头模拟 DNS rebinding
    const evil = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request({ host: 'localhost', port, path: '/', method: 'GET', agent: false, headers: { Host: 'evil.example.com' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode || 0 }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(evil.status).toBe(403);
    expect(res.status).toBe(200); // 正常 Host 不受影响
  });

  test('unknown route returns 404', async () => {
    const res = await requestJson(port, 'GET', '/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  test('POST without application/json rejected with 415', async () => {
    const res = await requestRaw(port, 'POST', '/api/send', 'text=hello', 'text/plain');
    expect(res.status).toBe(415);
  });

  test('invalid JSON body rejected with 400', async () => {
    const res = await requestRaw(port, 'POST', '/api/send', '{not json', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body).toContain('Invalid JSON body');
  });

  test('oversized body rejected with 413', async () => {
    const big = 'x'.repeat(300 * 1024);
    const res = await requestRaw(port, 'POST', '/api/send', big, 'application/json');
    expect(res.status).toBe(413);
  });

  test('GET /api/status returns ok with appVersion and workspace info', async () => {
    const res = await requestJson(port, 'GET', '/api/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.appVersion).toBe('1.7.10dev-test');
    expect(res.body.running).toBe(true);
    expect(res.body.workspaceUri).toBe('file:///C%3A/work');
    expect(res.body.workspaceName).toBe('work');
    expect(res.body.activeFilePath).toBe('src/a.ts');
  });

  test('GET /api/conversations lists only conversations with messages, sorted by updatedAt', async () => {
    const res = await requestJson(port, 'GET', '/api/conversations');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].id).toBe('conv_test_1');
    expect(res.body.conversations[0].title).toBe('Test Chat');
  });

  test('GET /api/messages returns messages for existing conversation', async () => {
    const res = await requestJson(port, 'GET', '/api/messages?conversationId=conv_test_1');
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].role).toBe('user');
  });

  test('GET /api/messages strips attachment blobs but keeps text and tool calls', async () => {
    const res = await requestJson(port, 'GET', '/api/messages?conversationId=conv_test_1');
    expect(res.status).toBe(200);
    const parts = res.body.messages[0].parts;
    expect(parts).toHaveLength(3);
    expect(parts[0].text).toBe('hi');
    expect(parts[1].inlineData).toBeUndefined();
    expect(parts[1].fileData).toBeUndefined();
    expect(parts[2].functionCall.name).toBe('read_file');
  });

  test('GET /api/messages rejects unknown conversation with 404 (disk DoS guard)', async () => {
    const res = await requestJson(port, 'GET', '/api/messages?conversationId=conv_not_exists');
    expect(res.status).toBe(404);
  });

  test('GET /api/messages rejects invalid conversationId with 400', async () => {
    const res = await requestJson(port, 'GET', '/api/messages?conversationId=../evil');
    expect(res.status).toBe(400);
  });

  test('POST /api/send routes chatStream with same pipeline payload', async () => {
    host.calls = [];
    const res = await post(port, `/api/send`, {
      conversationId: 'conv_test_1',
      text: 'hello from phone'
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const call = host.calls.find((c) => c.type === 'chatStream');
    expect(call).toBeDefined();
    expect(call!.data.conversationId).toBe('conv_test_1');
    expect(call!.data.message).toBe('hello from phone');
    expect(call!.data.configId).toBe('ch1');
    expect(typeof call!.data.messageId).toBe('string');
    expect(call!.data.streamId).toMatch(/^remote_/);
  });

  test('POST /api/send without conversationId auto-creates conversation', async () => {
    host.calls = [];
    const res = await post(port, `/api/send`, { text: 'brand new chat' });
    expect(res.status).toBe(200);
    expect(res.body.conversationId).toMatch(/^conv_/);
    const created = host.calls.find((c) => c.type === 'conversation.createConversation');
    expect(created).toBeDefined();
    expect(created!.data.title).toBe('brand new chat');
    const stream = host.calls.find((c) => c.type === 'chatStream');
    expect(stream!.data.conversationId).toBe(res.body.conversationId);
  });

  test('POST /api/send rejects empty text with 400', async () => {
    const res = await post(port, `/api/send`, { conversationId: 'conv_test_1', text: '   ' });
    expect(res.status).toBe(400);
  });

  test('POST /api/send rejects over-length text with 400', async () => {
    const res = await post(port, `/api/send`, { conversationId: 'conv_test_1', text: 'x'.repeat(20001) });
    expect(res.status).toBe(400);
  });

  test('POST /api/send rejects invalid conversationId with 400', async () => {
    const res = await post(port, `/api/send`, { conversationId: '../bad', text: 'hi' });
    expect(res.status).toBe(400);
  });

  test('POST /api/send fails with readable error when no channel enabled', async () => {
    const oldActive = host.settings.activeChannelId;
    host.settings.activeChannelId = null;
    try {
      const res = await post(port, `/api/send`, { conversationId: 'conv_test_1', text: 'hi' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('No channel enabled');
    } finally {
      host.settings.activeChannelId = oldActive;
    }
  });

  test('POST /api/cancel routes cancelStream', async () => {
    host.calls = [];
    const res = await post(port, `/api/cancel`, { conversationId: 'conv_test_1' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'cancelStream');
    expect(call).toBeDefined();
    expect(call!.data.conversationId).toBe('conv_test_1');
  });

  test('POST /api/cancel rejects invalid conversationId with 400', async () => {
    const res = await post(port, `/api/cancel`, { conversationId: '' });
    expect(res.status).toBe(400);
  });

  test('POST /api/rename routes conversation.setTitle', async () => {
    host.calls = [];
    const res = await post(port, `/api/rename`, { conversationId: 'conv_test_1', title: 'New Title' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'conversation.setTitle');
    expect(call).toBeDefined();
    expect(call!.data.title).toBe('New Title');
  });

  test('POST /api/retry routes retryStream with resolved configId', async () => {
    host.calls = [];
    const res = await post(port, `/api/retry`, { conversationId: 'conv_test_1' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'retryStream');
    expect(call).toBeDefined();
    expect(call!.data.conversationId).toBe('conv_test_1');
    expect(call!.data.configId).toBe('ch1');
  });

  test('POST /api/delete-message routes deleteSingleMessage', async () => {
    host.calls = [];
    const res = await post(port, `/api/delete-message`, { conversationId: 'conv_test_1', targetIndex: 0 });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'deleteSingleMessage');
    expect(call).toBeDefined();
    expect(call!.data.targetIndex).toBe(0);
  });

  test('POST /api/delete-message rejects negative targetIndex with 400', async () => {
    const res = await post(port, '/api/delete-message', { conversationId: 'conv_test_1', targetIndex: -1 });
    expect(res.status).toBe(400);
  });

  test('POST /api/delete-message rejects absurd targetIndex with 400', async () => {
    const res = await post(port, '/api/delete-message', { conversationId: 'conv_test_1', targetIndex: 99999999 });
    expect(res.status).toBe(400);
  });

  test('POST /api/tool-confirm routes toolConfirmation with resolved configId', async () => {
    host.calls = [];
    const res = await post(port, '/api/tool-confirm', {
      conversationId: 'conv_test_1',
      toolResponses: [{ id: 'tool_1', name: 'write_file', confirmed: true }]
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'toolConfirmation');
    expect(call).toBeDefined();
    expect(call!.data.conversationId).toBe('conv_test_1');
    expect(call!.data.configId).toBe('ch1');
    expect(call!.data.toolResponses).toEqual([{ id: 'tool_1', name: 'write_file', confirmed: true }]);
    expect(call!.data.streamId).toMatch(/^remote_/);
  });

  test('POST /api/tool-confirm rejects malformed toolResponses with 400', async () => {
    const res = await post(port, '/api/tool-confirm', {
      conversationId: 'conv_test_1',
      toolResponses: [{ id: 123, name: 'x', confirmed: 'yes' }]
    });
    expect(res.status).toBe(400);
  });

  test('GET /api/workspace returns workspace snapshot', async () => {
    const res = await requestJson(port, 'GET', '/api/workspace');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.workspaceUri).toBe('file:///C%3A/work');
    expect(res.body.activeFilePath).toBe('src/a.ts');
  });

  test('GET /api/workspaces merges open and saved workspaces', async () => {
    const res = await requestJson(port, 'GET', '/api/workspaces');
    expect(res.status).toBe(200);
    expect(res.body.activeWorkspaceUri).toBe('file:///C%3A/work');
    expect(res.body.workspaces).toHaveLength(1);
    expect(res.body.saved).toHaveLength(1);
  });

  test('POST /api/workspace-switch routes workspace.setActive', async () => {
    host.calls = [];
    const res = await post(port, `/api/workspace-switch`, { workspaceUri: 'file:///C%3A/saved' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'workspace.setActive');
    expect(call).toBeDefined();
    expect(call!.data.workspaceUri).toBe('file:///C%3A/saved');
  });

  test('POST /api/workspace-switch rejects empty workspaceUri with 400', async () => {
    const res = await post(port, `/api/workspace-switch`, { workspaceUri: '' });
    expect(res.status).toBe(400);
  });

  test('GET /api/files routes listWorkspaceDirectory with path whitelist', async () => {
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/files?path=src');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    const call = host.calls.find((c) => c.type === 'listWorkspaceDirectory');
    expect(call!.data.path).toBe('src');
  });

  test('GET /api/files rejects absolute paths with 400', async () => {
    const res = await requestJson(port, 'GET', '/api/files?path=' + encodeURIComponent('C:/Windows'));
    expect(res.status).toBe(400);
  });

  test('path whitelist rejects single-encoded traversal and trailing-dot segments', async () => {
    const traversal = await requestJson(port, 'GET', '/api/files?path=' + encodeURIComponent('../evil'));
    expect(traversal.status).toBe(400);
    const dots = await requestJson(port, 'GET', '/api/files?path=' + encodeURIComponent('..../x'));
    expect(dots.status).toBe(400);
    const trailingDot = await requestJson(port, 'GET', '/api/files?path=' + encodeURIComponent('foo./x'));
    expect(trailingDot.status).toBe(400);
  });

  test('path whitelist treats double-encoded traversal as literal (no second decode)', async () => {
    // %252e%252e%252f 经 URLSearchParams 一次解码后为字面量 %2e%2e%2f，不是 `..` 段
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/files?path=' + encodeURIComponent('%2e%2e%2fevil'));
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'listWorkspaceDirectory');
    expect(call!.data.path).toBe('%2e%2e%2fevil');
  });

  test('GET /api/file routes readWorkspaceTextFile', async () => {
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/file?path=' + encodeURIComponent('src/a.ts'));
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('const a');
    const call = host.calls.find((c) => c.type === 'readWorkspaceTextFile');
    expect(call!.data.path).toBe('src/a.ts');
  });

  test('GET /api/file truncates oversized content with truncated flag', async () => {
    host.respondOverrides = { readWorkspaceTextFile: { success: true, path: 'big.ts', content: 'x'.repeat(2 * 1024 * 1024) } };
    try {
      const res = await requestJson(port, 'GET', '/api/file?path=' + encodeURIComponent('big.ts'));
      expect(res.status).toBe(200);
      expect(res.body.truncated).toBe(true);
      expect(res.body.content.length).toBe(1024 * 1024);
    } finally {
      host.respondOverrides = {};
    }
  });

  test('POST /api/file routes workspace.writeTextFile', async () => {
    host.calls = [];
    const res = await post(port, `/api/file`, { path: 'src/a.ts', content: 'let b = 2;\n' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'workspace.writeTextFile');
    expect(call).toBeDefined();
    expect(call!.data.path).toBe('src/a.ts');
    expect(call!.data.content).toBe('let b = 2;\n');
  });

  test('POST /api/file rejects path traversal with 400', async () => {
    const res = await post(port, `/api/file`, { path: '../secret.txt', content: 'x' });
    expect(res.status).toBe(400);
  });

  test('POST /api/file rejects content over 1MB with 413', async () => {
    const res = await post(port, `/api/file`, { path: 'big.txt', content: 'x'.repeat(1024 * 1024 + 1) });
    expect(res.status).toBe(413);
  });

  test('POST /api/open-file routes openWorkspaceFileAt with startLine', async () => {
    host.calls = [];
    const res = await post(port, `/api/open-file`, { path: 'src/a.ts', startLine: 3 });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'openWorkspaceFileAt');
    expect(call).toBeDefined();
    expect(call!.data.path).toBe('src/a.ts');
    expect(call!.data.startLine).toBe(3);
  });

  test('GET /api/configs lists configs with name/model', async () => {
    const res = await requestJson(port, 'GET', '/api/configs');
    expect(res.status).toBe(200);
    expect(res.body.configs).toHaveLength(2);
    expect(res.body.configs[0].name).toBe('Channel One');
    expect(res.body.configs[0].model).toBe('m1');
  });

  test('GET /api/config returns config with trimmed models list', async () => {
    const res = await requestJson(port, 'GET', '/api/config?configId=ch1');
    expect(res.status).toBe(200);
    expect(res.body.config.models).toEqual([
      { id: 'm1', name: 'Model 1' },
      { id: 'm2', name: 'Model 2' }
    ]);
  });

  test('GET /api/config rejects invalid configId with 400', async () => {
    const res = await requestJson(port, 'GET', '/api/config?configId=' + encodeURIComponent('../x'));
    expect(res.status).toBe(400);
  });

  test('POST /api/model routes models.setActiveModel', async () => {
    host.calls = [];
    const res = await post(port, `/api/model`, { configId: 'ch1', modelId: 'm2' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'models.setActiveModel');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ configId: 'ch1', modelId: 'm2' });
  });

  test('POST /api/model routes models.setActiveModel with provider-style model id', async () => {
    host.calls = [];
    const res = await post(port, '/api/model', { configId: 'ch1', modelId: 'openai/gpt-4o' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'models.setActiveModel');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ configId: 'ch1', modelId: 'openai/gpt-4o' });
  });

  test('POST /api/model rejects control-char modelId with 400', async () => {
    const res = await post(port, '/api/model', { configId: 'ch1', modelId: 'bad\u0000model' });
    expect(res.status).toBe(400);
  });

  test('SSE: hello event then message + workspace events broadcast', async () => {
    const events: Array<{ event: string; data: any }> = [];
    const sse = new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: 'localhost', port, path: '/api/stream', method: 'GET', agent: false, headers: { Host: `localhost:${port}` } },
        (res) => {
          let buf = '';
          res.on('data', (c: Buffer) => {
            buf += c.toString('utf-8');
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const lines = frame.split('\n');
              let event = 'message';
              const dataLines: string[] = [];
              for (const line of lines) {
                if (line.startsWith('event: ')) event = line.slice(7);
                else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
              }
              if (dataLines.length === 0) continue;
              let parsed: any;
              try { parsed = JSON.parse(dataLines.join('\n')); } catch { continue; }
              events.push({ event, data: parsed });
              if (events.some((e) => e.event === 'workspace')) {
                req.destroy();
                resolve();
              }
            }
          });
        }
      );
      req.on('error', (err) => {
        if (events.some((e) => e.event === 'workspace')) resolve();
        else reject(err);
      });
      req.end();
    });

    // 等待 hello 到达后广播
    await new Promise((r) => setTimeout(r, 150));
    server.onClientMessage({
      type: 'streamChunk',
      requestId: 'remote_xxx',
      conversationId: 'conv_test_1',
      data: { type: 'chunk', chunk: 'hello ' }
    });
    server.notifyWorkspaceChange();
    await sse;

    expect(events.some((e) => e.event === 'hello' && e.data.ok === true)).toBe(true);
    expect(events.some((e) => e.event === 'message' && e.data.data.chunk === 'hello ')).toBe(true);
    const wsEvent = events.find((e) => e.event === 'workspace');
    expect(wsEvent).toBeDefined();
    expect(wsEvent!.data.activeFilePath).toBe('src/a.ts');
  });

  test('SSE: more than MAX_SSE_CLIENTS rejected with 503', async () => {
    const open = (): Promise<http.ClientRequest> => new Promise((resolve) => {
      const req = http.request(
        { host: 'localhost', port, path: '/api/stream', method: 'GET', agent: false, headers: { Host: `localhost:${port}` } },
        () => { /* keep open */ }
      );
      req.end();
      resolve(req);
    });
    const conns: http.ClientRequest[] = [];
    try {
      for (let i = 0; i < 8; i++) conns.push(await open());
      await new Promise((r) => setTimeout(r, 100));
      const res = await requestJson(port, 'GET', '/api/stream');
      expect(res.status).toBe(503);
    } finally {
      conns.forEach((c) => c.destroy());
    }
  });

  test('dispose stops server cleanly', async () => {
    const h2 = new FakeHost();
    const s2 = await startServer(h2);
    expect(s2.isRunning()).toBe(true);
    await s2.dispose();
    expect(s2.isRunning()).toBe(false);
    expect(s2.getStatus().running).toBe(false);
    // 重启后仍可再次启用（restart 链未被 dispose 破坏）
    h2.server = s2;
    h2.settings.remoteControl = { enabled: true, port: 30000 + Math.floor(Math.random() * 20000) };
    s2.syncFromSettings();
    await new Promise((r) => setTimeout(r, 200));
    expect(s2.getStatus().running).toBe(true);
    await s2.dispose();
  });
});
