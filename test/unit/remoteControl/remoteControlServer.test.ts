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
  meta: { title?: string; updatedAt?: number; custom?: Record<string, unknown> };
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
      meta: {
        title: 'Test Chat',
        updatedAt: 1000,
        // 与真实 meta.json 同构：messageCount/preview 在 custom 段，顶层没有
        custom: { messageCount: 2, preview: 'hi' }
      },
      messages: [{
        role: 'user',
        parts: [
          { text: 'hi' },
          { inlineData: { mimeType: 'image/png', data: 'a'.repeat(1000) }, text: '' },
          { functionCall: { name: 'read_file', arguments: '{}' } }
        ]
      }]
    },
    conv_empty: { meta: { title: 'Empty', updatedAt: 900, custom: {} }, messages: [] }
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
      case 'chat.editBranchStream':
      case 'chat.rerollStream':
        return { started: true };
      case 'conversation.createConversation':
      case 'conversation.setTitle':
      case 'conversation.deleteConversation':
      case 'workspace.setActive':
      case 'workspace.writeTextFile':
      case 'deleteSingleMessage':
        return { success: true };
      case 'workspace.openFolder':
        return { success: true, activeWorkspaceUri: 'file:///C%3A/new', workspaces: [], saved: [] };
      case 'workspace.removeSaved':
        return { success: true, saved: [] };
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
      case 'getSettings':
        return {
          success: true,
          settings: {
            checkForUpdates: true,
            maxToolIterations: 200,
            activeChannelId: 'ch1',
            ui: { language: 'zh-CN', theme: 'auto', sound: { enabled: true, volume: 80, assets: { warning: { dataBase64: 'AAAA' } } } },
            proxy: { enabled: true, url: 'http://user:pass@127.0.0.1:7890' },
            toolsConfig: {
              generate_image: { apiKey: 'secret-img', model: 'flux' },
              token_count: { gemini: { apiKey: 'secret-tok', baseUrl: '', model: '' } },
              apply_diff: { format: 'unified', autoSave: false, autoSaveDelay: 3000, diffGuardEnabled: true, autoApplyWithoutDiffView: false }
            },
            remoteControl: { enabled: true, port: 17532 },
            storagePath: { customDataPath: '', migrationStatus: 'none' }
          }
        };
      case 'updateSettings':
        return { success: true, settings: { ok: true } };
      case 'settings.setActiveChannelId':
      case 'config.updateConfig':
        return { success: true };
      case 'tools.getTools':
        return { tools: [{ name: 'read_file', description: 'Read files', enabled: true, category: 'file' }] };
      case 'tools.getAutoExecConfig':
        return { config: { execute_command: false, read_file: true } };
      case 'dependencies.list':
        return { dependencies: [{ name: 'python', installed: true, installedVersion: '3.12' }, { name: 'node', installed: false }] };
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
  /** V2 去虚拟化：进程内直连 handler（响应直接返回，不再经 MessageRouter/虚拟客户端） */
  invokeHandler = async (type: string, data: any): Promise<any> => {
    this.calls.push({ type, data, requestId: '', clientId: 'remote-control' });
    return this.respond(type, data);
  };
  /** V2 去虚拟化：直连流式任务（started 应答直接返回） */
  runStream = async (type: string, data: any): Promise<any> => {
    this.calls.push({ type, data, requestId: '', clientId: 'remote-control' });
    return this.respond(type, data);
  };
  /** 会话变更通知（桌面端列表实时刷新） */
  notifyConversationsChanged(): void {
    this.calls.push({ type: 'notifyConversationsChanged', data: {}, requestId: '', clientId: '' });
  }
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

  test('GET /api/conversations lists all conversations sorted by updatedAt with custom.messageCount', async () => {
    const res = await requestJson(port, 'GET', '/api/conversations');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.conversations).toHaveLength(2);
    expect(res.body.conversations[0].id).toBe('conv_test_1');
    expect(res.body.conversations[0].title).toBe('Test Chat');
    expect(res.body.conversations[0].messageCount).toBe(2);
    expect(res.body.conversations[0].preview).toBe('hi');
    expect(res.body.conversations[1].id).toBe('conv_empty');
    // 真实 meta.json 顶层没有 messageCount：必须从 custom 段读取，否则恒为 0
    expect(res.body.conversations[1].messageCount).toBe(0);
    expect(res.body.total).toBe(2);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.offset).toBe(0);
    expect(res.body.limit).toBe(30);
  });

  test('GET /api/conversations paginates with limit/offset (newest-first across pages)', async () => {
    // 注入 35 个会话验证分页（limit=10 → 4 页 + hasMore 边界）
    // 关键：listConversations 返回顺序无更新序保证，服务端必须先按 updatedAt 降序
    // 再切片——第 4 页内容必须全部旧于第 1 页（不可跨页乱序）
    const extra: Record<string, FakeConv> = {};
    for (let i = 0; i < 35; i++) {
      extra[`conv_page_${i}`] = {
        meta: { title: `Page Chat ${i}`, updatedAt: 100 + i, custom: { messageCount: i } },
        messages: []
      };
    }
    const saved = host.conversations;
    host.conversations = { ...saved, ...extra };
    try {
      const page1 = await requestJson(port, 'GET', '/api/conversations?limit=10&offset=0');
      expect(page1.status).toBe(200);
      expect(page1.body.total).toBe(37);
      expect(page1.body.conversations).toHaveLength(10);
      expect(page1.body.hasMore).toBe(true);
      // 全局最新（conv_test_1=1000）必须在第 1 页首位
      expect(page1.body.conversations[0].id).toBe('conv_test_1');
      const page4 = await requestJson(port, 'GET', '/api/conversations?limit=10&offset=30');
      expect(page4.body.conversations).toHaveLength(7);
      expect(page4.body.hasMore).toBe(false);
      // 页间不重叠
      const ids1 = new Set(page1.body.conversations.map((c: any) => c.id));
      const ids4 = new Set(page4.body.conversations.map((c: any) => c.id));
      for (const id of ids4) expect(ids1.has(id)).toBe(false);
      // 跨页单调递减：第 1 页最旧 >= 第 4 页最新
      const minPage1 = Math.min(...page1.body.conversations.map((c: any) => c.updatedAt));
      const maxPage4 = Math.max(...page4.body.conversations.map((c: any) => c.updatedAt));
      expect(minPage1).toBeGreaterThanOrEqual(maxPage4);
      // 页内也是降序
      for (let i = 1; i < page1.body.conversations.length; i++) {
        expect(page1.body.conversations[i - 1].updatedAt).toBeGreaterThanOrEqual(page1.body.conversations[i].updatedAt);
      }
    } finally {
      host.conversations = saved;
    }
  });

  test('GET /api/conversations clamps invalid limit/offset to defaults', async () => {
    const res = await requestJson(port, 'GET', '/api/conversations?limit=0&offset=-5');
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(30);
    expect(res.body.offset).toBe(0);
    const res2 = await requestJson(port, 'GET', '/api/conversations?limit=999999&offset=abc');
    expect(res2.body.limit).toBe(100);
    expect(res2.body.offset).toBe(0);
  });

  test('GET /api/messages paginates from the tail (window + total + hasMore)', async () => {
    // 20 条消息：limit=8 offset=0 → 最后 8 条；offset=8 → 再前 8 条；offset=16 → 前 4 条
    const msgs = Array.from({ length: 20 }, (_, i) => ({ role: 'user', parts: [{ text: `msg ${i}` }], index: i }));
    const saved = host.conversations;
    host.conversations = { ...saved, conv_many: { meta: { title: 'Many', updatedAt: 500, custom: {} }, messages: msgs } };
    try {
      const last = await requestJson(port, 'GET', '/api/messages?conversationId=conv_many&limit=8&offset=0');
      expect(last.status).toBe(200);
      expect(last.body.total).toBe(20);
      expect(last.body.hasMore).toBe(true);
      expect(last.body.messages).toHaveLength(8);
      expect(last.body.messages[7].parts[0].text).toBe('msg 19');
      expect(last.body.messages[0].parts[0].text).toBe('msg 12');

      const mid = await requestJson(port, 'GET', '/api/messages?conversationId=conv_many&limit=8&offset=8');
      expect(mid.body.messages).toHaveLength(8);
      expect(mid.body.messages[0].parts[0].text).toBe('msg 4');
      expect(mid.body.messages[7].parts[0].text).toBe('msg 11');

      const first = await requestJson(port, 'GET', '/api/messages?conversationId=conv_many&limit=8&offset=16');
      expect(first.body.messages).toHaveLength(4);
      expect(first.body.hasMore).toBe(false);
      expect(first.body.messages[0].parts[0].text).toBe('msg 0');

      // 超过总数 → 空窗口
      const beyond = await requestJson(port, 'GET', '/api/messages?conversationId=conv_many&limit=8&offset=999');
      expect(beyond.body.messages).toHaveLength(0);
      expect(beyond.body.hasMore).toBe(false);
    } finally {
      host.conversations = saved;
    }
  });

  test('GET /api/messages default limit is 120 and clamps to max 500', async () => {
    const msgs = Array.from({ length: 130 }, (_, i) => ({ role: 'user', parts: [{ text: `m ${i}` }], index: i }));
    const saved = host.conversations;
    host.conversations = { ...saved, conv_big: { meta: { title: 'Big', updatedAt: 600, custom: {} }, messages: msgs } };
    try {
      const def = await requestJson(port, 'GET', '/api/messages?conversationId=conv_big');
      expect(def.body.messages).toHaveLength(120);
      expect(def.body.hasMore).toBe(true);
      const max = await requestJson(port, 'GET', '/api/messages?conversationId=conv_big&limit=99999');
      expect(max.body.messages).toHaveLength(130);
      expect(max.body.hasMore).toBe(false);
    } finally {
      host.conversations = saved;
    }
  });

  test('stream terminal chunks trigger conversation.updateSummary with messageCount + preview', async () => {
    host.calls = [];
    const done = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const summary = host.calls.find((c) => c.type === 'conversation.updateSummary');
        if (summary) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
      setTimeout(() => { clearInterval(timer); resolve(); }, 3000).unref?.();
    });
    // 模拟桌面端 StreamChunkProcessor 真实装配形状：conversationId/streamId 位于
    // 每个 chunk 元素上（streamChunkBatch 包装层没有）——此前读取包装层字段导致
    // 真实批量流被当作无主消息、摘要永不落盘
    server.onClientMessage({
      type: 'streamChunkBatch',
      data: [
        { conversationId: 'conv_test_1', streamId: 'remote_x1', type: 'chunk', chunk: 'hello ' },
        { conversationId: 'conv_test_1', streamId: 'remote_x1', type: 'chunk', chunk: 'world' },
        { conversationId: 'conv_test_1', streamId: 'remote_x1', type: 'complete', content: 'hello world' }
      ]
    });
    await done;
    const summary = host.calls.find((c) => c.type === 'conversation.updateSummary');
    expect(summary).toBeDefined();
    expect(summary!.data.conversationId).toBe('conv_test_1');
    expect(summary!.data.messageCount).toBe(1);
    expect(summary!.data.preview).toBe('hi');
    expect(summary!.clientId).toBe('remote-control');
  });

  test('single streamChunk with nested data.conversationId also syncs summary', async () => {
    host.calls = [];
    const done = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const summary = host.calls.find((c) => c.type === 'conversation.updateSummary');
        if (summary) { clearInterval(timer); resolve(); }
      }, 10);
      setTimeout(() => { clearInterval(timer); resolve(); }, 3000).unref?.();
    });
    server.onClientMessage({
      type: 'streamChunk',
      data: { conversationId: 'conv_empty', streamId: 'remote_x7', type: 'complete', content: 'done' }
    });
    await done;
    const summary = host.calls.find((c) => c.type === 'conversation.updateSummary');
    expect(summary).toBeDefined();
    expect(summary!.data.conversationId).toBe('conv_empty');
  });

  test('cancelled/error terminal chunks also sync summary, plain chunks do not', async () => {
    host.calls = [];
    // 非终结 chunk（真实批量形状）：不触发摘要同步
    server.onClientMessage({
      type: 'streamChunkBatch',
      data: [
        { conversationId: 'conv_test_1', streamId: 'remote_x2', type: 'chunk', chunk: 'a' },
        { conversationId: 'conv_test_1', streamId: 'remote_x2', type: 'chunk', chunk: 'b' }
      ]
    });
    server.onClientMessage({
      type: 'streamChunk',
      data: { conversationId: 'conv_test_1', streamId: 'remote_x3', type: 'chunk', chunk: 'c' }
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(host.calls.some((c) => c.type === 'conversation.updateSummary')).toBe(false);

    const waitSummary = () => new Promise<void>((resolve) => {
      const before = host.calls.filter((c) => c.type === 'conversation.updateSummary').length;
      const timer = setInterval(() => {
        const now = host.calls.filter((c) => c.type === 'conversation.updateSummary').length;
        if (now > before) { clearInterval(timer); resolve(); }
      }, 10);
      setTimeout(() => { clearInterval(timer); resolve(); }, 3000).unref?.();
    });
    const p1 = waitSummary();
    server.onClientMessage({
      type: 'streamChunkBatch',
      data: [
        { conversationId: 'conv_test_1', streamId: 'remote_x4', type: 'cancelled', content: 'partial' }
      ]
    });
    await p1;
    const p2 = waitSummary();
    server.onClientMessage({
      type: 'streamChunkBatch',
      data: [
        { conversationId: 'conv_test_1', streamId: 'remote_x5', type: 'error', error: { message: 'boom' } }
      ]
    });
    await p2;
    const count = host.calls.filter((c) => c.type === 'conversation.updateSummary').length;
    expect(count).toBe(2);
  });

  test('summary sync uses last non-functionResponse user message as preview', async () => {
    host.calls = [];
    const saved = host.conversations;
    host.conversations = {
      ...saved,
      conv_preview: {
        meta: { title: 'Preview', updatedAt: 700, custom: {} },
        messages: [
          { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { name: 'read_file', response: '{}' } }] },
          { role: 'model', parts: [{ text: 'thinking...' }] },
          { role: 'user', isFunctionResponse: false, parts: [{ text: '你好，请分析这段代码并给出优化建议……' }, { thought: true, text: 'private thought' }] }
        ]
      }
    };
    try {
      const done = new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const summary = host.calls.find((c) => c.type === 'conversation.updateSummary');
          if (summary) { clearInterval(timer); resolve(); }
        }, 10);
        setTimeout(() => { clearInterval(timer); resolve(); }, 3000).unref?.();
      });
      server.onClientMessage({
        type: 'streamChunkBatch',
        data: [
          { conversationId: 'conv_preview', streamId: 'remote_x6', type: 'complete', content: 'done' }
        ]
      });
      await done;
      const summary = host.calls.find((c) => c.type === 'conversation.updateSummary');
      expect(summary).toBeDefined();
      expect(summary!.data.messageCount).toBe(3);
      // 跳过 functionResponse 与 model，取最后一条用户消息文本；思考段不计入预览
      expect(summary!.data.preview).toBe('你好，请分析这段代码并给出优化建议……');
    } finally {
      host.conversations = saved;
    }
  });

  test('POST /api/send returns streamId for new-chat race-free routing', async () => {
    host.calls = [];
    const res = await post(port, '/api/send', { text: 'race check' });
    expect(res.status).toBe(200);
    expect(typeof res.body.streamId).toBe('string');
    expect(res.body.streamId.startsWith('remote_')).toBe(true);
    const call = host.calls.find((c) => c.type === 'chatStream');
    expect(call).toBeDefined();
    expect(call!.data.streamId).toBe(res.body.streamId);
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

  test('POST /api/workspace-add routes workspace.openFolder (desktop folder dialog)', async () => {
    host.calls = [];
    const res = await post(port, '/api/workspace-add', {});
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'workspace.openFolder');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({});
    expect(res.body.activeWorkspaceUri).toBe('file:///C%3A/new');
  });

  test('POST /api/workspace-add surfaces cancel without error', async () => {
    host.respondOverrides['workspace.openFolder'] = { canceled: true };
    const res = await post(port, '/api/workspace-add', {});
    expect(res.status).toBe(200);
    expect(res.body.canceled).toBe(true);
    delete host.respondOverrides['workspace.openFolder'];
  });

  test('POST /api/workspace-remove routes workspace.removeSaved with fsPath', async () => {
    host.calls = [];
    const res = await post(port, '/api/workspace-remove', { fsPath: 'C:\\saved' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'workspace.removeSaved');
    expect(call).toBeDefined();
    expect(call!.data.fsPath).toBe('C:\\saved');
  });

  test('POST /api/workspace-remove rejects control-char fsPath with 400', async () => {
    const res = await post(port, '/api/workspace-remove', { fsPath: 'C:\\x\u0000y' });
    expect(res.status).toBe(400);
  });

  test('POST /api/conversation-delete routes conversation.deleteConversation', async () => {
    host.calls = [];
    const res = await post(port, '/api/conversation-delete', { conversationId: 'conv_test_1' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'conversation.deleteConversation');
    expect(call).toBeDefined();
    expect(call!.data.conversationId).toBe('conv_test_1');
  });

  test('POST /api/conversation-delete rejects invalid conversationId with 400', async () => {
    const res = await post(port, '/api/conversation-delete', { conversationId: '../evil' });
    expect(res.status).toBe(400);
  });

  test('POST /api/edit-message routes chat.editBranchStream with branch mode', async () => {
    host.calls = [];
    const res = await post(port, '/api/edit-message', {
      conversationId: 'conv_test_1',
      messageId: 'msg_123',
      newText: 'edited content'
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'chat.editBranchStream');
    expect(call).toBeDefined();
    expect(call!.data.conversationId).toBe('conv_test_1');
    expect(call!.data.userNodeId).toBe('msg_123');
    expect(call!.data.messageId).toBe('msg_123');
    expect(call!.data.newText).toBe('edited content');
    expect(call!.data.configId).toBe('ch1');
    expect(call!.data.mode).toBe('branch');
    expect(call!.data.streamId).toMatch(/^remote_/);
  });

  test('POST /api/edit-message rejects empty newText with 400', async () => {
    const res = await post(port, '/api/edit-message', {
      conversationId: 'conv_test_1',
      messageId: 'msg_123',
      newText: '   '
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/edit-message rejects control-char messageId with 400', async () => {
    const res = await post(port, '/api/edit-message', {
      conversationId: 'conv_test_1',
      messageId: 'msg\u0000x',
      newText: 'hi'
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/reroll routes chat.rerollStream with assistantNodeId', async () => {
    host.calls = [];
    const res = await post(port, '/api/reroll', {
      conversationId: 'conv_test_1',
      assistantNodeId: 'assistant_42'
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'chat.rerollStream');
    expect(call).toBeDefined();
    expect(call!.data.conversationId).toBe('conv_test_1');
    expect(call!.data.assistantNodeId).toBe('assistant_42');
    expect(call!.data.configId).toBe('ch1');
  });

  test('POST /api/reroll rejects missing assistantNodeId with 400', async () => {
    const res = await post(port, '/api/reroll', { conversationId: 'conv_test_1' });
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

  test('POST /api/workspace-switch: open workspace routes workspace.setActive (pin)', async () => {
    host.calls = [];
    const res = await post(port, `/api/workspace-switch`, { workspaceUri: 'file:///C%3A/work' });
    expect(res.status).toBe(200);
    expect(res.body.opened).toBe(false);
    const call = host.calls.find((c) => c.type === 'workspace.setActive');
    expect(call).toBeDefined();
    expect(call!.data.workspaceUri).toBe('file:///C%3A/work');
  });

  test('POST /api/workspace-switch: saved-but-not-open workspace opens via workspace.openFolder with fsPath', async () => {
    host.calls = [];
    const res = await post(port, `/api/workspace-switch`, { workspaceUri: 'file:///C%3A/saved' });
    expect(res.status).toBe(200);
    expect(res.body.opened).toBe(true);
    const openCall = host.calls.find((c) => c.type === 'workspace.openFolder');
    expect(openCall).toBeDefined();
    expect(openCall!.data).toEqual({ fsPath: 'C:\\saved' });
    // 未打开的收藏工作区不再静默走 setActive（此前 WorkspaceManager 直接 no-op）
    expect(host.calls.some((c) => c.type === 'workspace.setActive')).toBe(false);
  });

  test('POST /api/workspace-switch: unknown workspace returns 404', async () => {
    host.calls = [];
    const res = await post(port, `/api/workspace-switch`, { workspaceUri: 'file:///C%3A/nowhere' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('POST /api/workspace-switch rejects empty workspaceUri with 400', async () => {
    const res = await post(port, `/api/workspace-switch`, { workspaceUri: '' });
    expect(res.status).toBe(400);
  });

  test('POST /api/workspace-add with fsPath routes workspace.openFolder without desktop dialog', async () => {
    host.calls = [];
    const res = await post(port, '/api/workspace-add', { fsPath: 'C:\\new-proj' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'workspace.openFolder');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ fsPath: 'C:\\new-proj' });
  });

  test('POST /api/workspace-add rejects relative fsPath with 400', async () => {
    const res = await post(port, '/api/workspace-add', { fsPath: 'relative\\path' });
    expect(res.status).toBe(400);
  });

  test('POST /api/workspace-add rejects traversal fsPath with 400', async () => {
    const res = await post(port, '/api/workspace-add', { fsPath: 'C:\\..\\evil' });
    expect(res.status).toBe(400);
  });

  test('GET /api/fs browses absolute directories (win32 drive root path)', async () => {
    const res = await requestJson(port, 'GET', `/api/fs?path=${encodeURIComponent('C:\\Users')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe('C:\\Users');
    expect(res.body.parent).toBe('C:\\');
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  test('GET /api/fs with empty path returns drive list on win32', async () => {
    const res = await requestJson(port, 'GET', '/api/fs?path=');
    expect(res.status).toBe(200);
    if (process.platform === 'win32') {
      expect(Array.isArray(res.body.drives)).toBe(true);
      expect(res.body.drives.length).toBeGreaterThan(0);
      expect(res.body.drives[0]).toMatch(/^[A-Z]:\\$/);
    } else {
      expect(res.body.entries).toBeDefined();
    }
  });

  test('GET /api/fs rejects relative paths with 400', async () => {
    const res = await requestJson(port, 'GET', `/api/fs?path=${encodeURIComponent('relative/dir')}`);
    expect(res.status).toBe(400);
  });

  test('GET /api/fs rejects traversal and control chars with 400', async () => {
    const res1 = await requestJson(port, 'GET', `/api/fs?path=${encodeURIComponent('C:\\Users\\..\\x')}`);
    expect(res1.status).toBe(400);
    const res2 = await requestJson(port, 'GET', `/api/fs?path=${encodeURIComponent('C:\\x\u0000y')}`);
    expect(res2.status).toBe(400);
  });

  test('GET /api/fs lists directory entries sorted with directories only', async () => {
    const res = await requestJson(port, 'GET', `/api/fs?path=${encodeURIComponent('C:\\')}`);
    expect(res.status).toBe(200);
    expect(res.body.entries.every((e: any) => e.type === 'directory')).toBe(true);
    expect(res.body.entries.every((e: any) => typeof e.name === 'string' && typeof e.path === 'string')).toBe(true);
  });

  test('GET /api/settings routes getSettings and redacts secrets', async () => {
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/settings');
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'getSettings');
    expect(call).toBeDefined();
    const s = res.body.settings;
    expect(s.toolsConfig.generate_image.apiKey).toBe('********');
    expect(s.toolsConfig.token_count.gemini.apiKey).toBe('********');
    expect(s.ui.sound.assets.warning.dataBase64).toBeUndefined();
    expect(s.proxy.url).not.toContain('user:pass');
    expect(s.proxy.url).toContain('***@');
    // 非敏感字段原样保留
    expect(s.checkForUpdates).toBe(true);
    expect(s.toolsConfig.apply_diff.format).toBe('unified');
  });

  test('POST /api/settings routes updateSettings with patch and returns sanitized settings', async () => {
    host.calls = [];
    const res = await post(port, '/api/settings', { settings: { ui: { sound: { volume: 60 } } } });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'updateSettings');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ settings: { ui: { sound: { volume: 60 } } } });
    expect(res.body.ok).toBe(true);
  });

  test('POST /api/settings rejects non-object settings with 400', async () => {
    const res = await post(port, '/api/settings', { settings: 'nope' });
    expect(res.status).toBe(400);
    const res2 = await post(port, '/api/settings', { settings: [1, 2] });
    expect(res2.status).toBe(400);
  });

  test('POST /api/settings rejects oversized patch with 413', async () => {
    const res = await post(port, '/api/settings', { settings: { pad: 'x'.repeat(70 * 1024) } });
    expect(res.status).toBe(413);
  });

  test('GET /api/tools routes tools.getTools and tools.getAutoExecConfig', async () => {
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/tools');
    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(1);
    expect(res.body.tools[0].name).toBe('read_file');
    expect(res.body.autoExec).toEqual({ execute_command: false, read_file: true });
    expect(host.calls.some((c) => c.type === 'tools.getTools')).toBe(true);
    expect(host.calls.some((c) => c.type === 'tools.getAutoExecConfig')).toBe(true);
  });

  test('GET /api/dependencies routes dependencies.list', async () => {
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/dependencies');
    expect(res.status).toBe(200);
    expect(res.body.dependencies.dependencies).toHaveLength(2);
    expect(host.calls.some((c) => c.type === 'dependencies.list')).toBe(true);
  });

  test('POST /api/channel-toggle routes config.updateConfig with enabled flag', async () => {
    host.calls = [];
    const res = await post(port, '/api/channel-toggle', { configId: 'ch2', enabled: false });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'config.updateConfig');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ configId: 'ch2', updates: { enabled: false } });
  });

  test('POST /api/channel-toggle rejects invalid configId with 400', async () => {
    const res = await post(port, '/api/channel-toggle', { configId: '../x', enabled: true });
    expect(res.status).toBe(400);
  });

  test('POST /api/channel-active routes settings.setActiveChannelId', async () => {
    host.calls = [];
    const res = await post(port, '/api/channel-active', { configId: 'ch2' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'settings.setActiveChannelId');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ channelId: 'ch2' });
  });

  test('POST /api/remote-action routes remoteControl.apply restart/stop', async () => {
    host.calls = [];
    host.respondOverrides['remoteControl.apply'] = { ok: true };
    const res = await post(port, '/api/remote-action', { type: 'restart' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'remoteControl.apply');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ type: 'restart' });
    delete host.respondOverrides['remoteControl.apply'];
  });

  test('POST /api/remote-action rejects invalid type with 400', async () => {
    const res = await post(port, '/api/remote-action', { type: 'explode' });
    expect(res.status).toBe(400);
  });

  test('GET /api/status includes activeChannelId', async () => {
    const res = await requestJson(port, 'GET', '/api/status');
    expect(res.status).toBe(200);
    expect(res.body.activeChannelId).toBe('ch1');
  });

  test('GET /api/files routes listWorkspaceDirectory with path whitelist', async () => {
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/files?path=src');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    const call = host.calls.find((c) => c.type === 'listWorkspaceDirectory');
    expect(call!.data.path).toBe('src');
  });

  test('GET /api/files with empty path lists workspace root (root-directory semantic)', async () => {
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/files?path=');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    const call = host.calls.find((c) => c.type === 'listWorkspaceDirectory');
    expect(call!.data.path).toBe('');
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

  // ==========================================================================
  // V2 渠道完整管理（新增/编辑/删除）+ 模型管理 + 模型模式 + 发送参数透传
  // ==========================================================================

  test('POST /api/config-create routes config.createConfig', async () => {
    host.calls = [];
    host.respondOverrides['config.createConfig'] = 'ch_new';
    const res = await post(port, '/api/config-create', { type: 'gemini', name: 'My Channel' });
    expect(res.status).toBe(200);
    expect(res.body.configId).toBe('ch_new');
    const call = host.calls.find((c) => c.type === 'config.createConfig');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ type: 'gemini', name: 'My Channel' });
    delete host.respondOverrides['config.createConfig'];
  });

  test('POST /api/config-create rejects unknown type / missing name with 400', async () => {
    const res1 = await post(port, '/api/config-create', { type: 'wat', name: 'X' });
    expect(res1.status).toBe(400);
    const res2 = await post(port, '/api/config-create', { type: 'gemini', name: '' });
    expect(res2.status).toBe(400);
  });

  test('POST /api/config-update routes config.updateConfig and keeps masked apiKey untouched', async () => {
    host.calls = [];
    const res = await post(port, '/api/config-update', {
      configId: 'ch1',
      updates: { name: 'Renamed', apiKey: '********', url: 'https://x' }
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'config.updateConfig');
    expect(call).toBeDefined();
    // apiKey 占位串不落库（保持已设置的密钥不变）
    expect(call!.data.updates.apiKey).toBeUndefined();
    expect(call!.data.updates.name).toBe('Renamed');
    expect(call!.data.updates.url).toBe('https://x');
  });

  test('POST /api/config-update writes real apiKey when provided', async () => {
    host.calls = [];
    const res = await post(port, '/api/config-update', {
      configId: 'ch1',
      updates: { apiKey: 'sk-real-key' }
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'config.updateConfig');
    expect(call).toBeDefined();
    expect(call!.data.updates.apiKey).toBe('sk-real-key');
  });

  test('POST /api/config-update rejects invalid configId / oversized updates', async () => {
    const res1 = await post(port, '/api/config-update', { configId: '../x', updates: {} });
    expect(res1.status).toBe(400);
    const res2 = await post(port, '/api/config-update', { configId: 'ch1', updates: { big: 'x'.repeat(70 * 1024) } });
    expect(res2.status).toBe(413);
  });

  test('POST /api/config-delete routes config.deleteConfig', async () => {
    host.calls = [];
    const res = await post(port, '/api/config-delete', { configId: 'ch2' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'config.deleteConfig');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ configId: 'ch2' });
  });

  test('GET /api/config returns full editable config with masked apiKey', async () => {
    const res = await requestJson(port, 'GET', '/api/config?configId=ch1');
    expect(res.status).toBe(200);
    expect(res.body.config.id).toBe('ch1');
    expect(res.body.config.name).toBe('Channel One');
    expect(res.body.config.model).toBe('m1');
    expect(res.body.config.type).toBeDefined();
    expect(res.body.config.models).toHaveLength(2);
  });

  test('POST /api/models-add routes models.addModels', async () => {
    host.calls = [];
    const res = await post(port, '/api/models-add', {
      configId: 'ch1',
      models: [{ id: 'm3', name: 'Model 3' }]
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'models.addModels');
    expect(call).toBeDefined();
    expect(call!.data.models).toEqual([{ id: 'm3', name: 'Model 3' }]);
  });

  test('POST /api/models-add rejects malformed models with 400', async () => {
    const res = await post(port, '/api/models-add', { configId: 'ch1', models: [{ id: '', name: 'x' }] });
    expect(res.status).toBe(400);
  });

  test('POST /api/models-remove routes models.removeModel', async () => {
    host.calls = [];
    const res = await post(port, '/api/models-remove', { configId: 'ch1', modelId: 'm1' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'models.removeModel');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ configId: 'ch1', modelId: 'm1' });
  });

  test('POST /api/models-get routes models.getModels and trims fields', async () => {
    host.calls = [];
    host.respondOverrides['models.getModels'] = {
      success: true,
      models: [{ id: 'g1', name: 'G1', description: 'desc' }, { id: 'g2', name: 'G2', description: 'desc2' }]
    };
    const res = await post(port, '/api/models-get', { configId: 'ch1' });
    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(2);
    expect(res.body.models[0]).toEqual({ id: 'g1', name: 'G1' });
    delete host.respondOverrides['models.getModels'];
  });

  test('GET /api/prompt-modes returns modes with currentModeId', async () => {
    host.respondOverrides['getPromptModes'] = {
      modes: [
        { id: 'code', name: 'Code', icon: 'symbol-method' },
        { id: 'plan', name: 'Plan', icon: 'list-unordered' }
      ],
      currentModeId: 'code'
    };
    const res = await requestJson(port, 'GET', '/api/prompt-modes');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.currentModeId).toBe('code');
    expect(res.body.modes).toHaveLength(2);
    expect(res.body.modes[0]).toEqual({ id: 'code', name: 'Code', icon: 'symbol-method' });
    delete host.respondOverrides['getPromptModes'];
  });

  test('POST /api/send passes promptModeId/configId/modelId through to chatStream', async () => {
    host.calls = [];
    const res = await post(port, '/api/send', {
      text: 'hello',
      configId: 'ch2',
      modelId: 'openai/gpt-4o',
      promptModeId: 'plan'
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'chatStream');
    expect(call).toBeDefined();
    expect(call!.data.configId).toBe('ch2');
    expect(call!.data.modelOverride).toBe('openai/gpt-4o');
    expect(call!.data.promptModeId).toBe('plan');
  });

  test('POST /api/send with explicit conversationId does not re-create conversation', async () => {
    host.calls = [];
    const res = await post(port, '/api/send', { text: 'hello', conversationId: 'conv_test_1' });
    expect(res.status).toBe(200);
    expect(host.calls.some((c) => c.type === 'conversation.createConversation')).toBe(false);
    const call = host.calls.find((c) => c.type === 'chatStream');
    expect(call!.data.conversationId).toBe('conv_test_1');
  });

  test('POST /api/send with unknown conversationId creates it then notifies list refresh', async () => {
    host.calls = [];
    const res = await post(port, '/api/send', { text: 'brand new chat' });
    expect(res.status).toBe(200);
    expect(host.calls.some((c) => c.type === 'conversation.createConversation')).toBe(true);
    // 新会话落库后通知列表刷新（桌面端最近对话实时出现）
    expect(host.calls.some((c) => c.type === 'notifyConversationsChanged')).toBe(true);
  });

  test('rename / delete conversation notify list refresh', async () => {
    host.calls = [];
    await post(port, '/api/rename', { conversationId: 'conv_test_1', title: 'Renamed' });
    expect(host.calls.some((c) => c.type === 'notifyConversationsChanged')).toBe(true);
    host.calls = [];
    await post(port, '/api/conversation-delete', { conversationId: 'conv_test_1' });
    expect(host.calls.some((c) => c.type === 'notifyConversationsChanged')).toBe(true);
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
