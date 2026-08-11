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
  /** 模拟 diffManager 的 pending diff 快照（/api/diff-status、/api/diff-preview 数据源） */
  pendingDiffs: Array<Record<string, any>> = [
    {
      id: 'diff-1234567890-abc',
      status: 'pending',
      filePath: 'src/a.ts',
      toolId: 'tool_1',
      diffGuardWarning: '',
      diffGuardDeletePercent: 0,
      timestamp: Date.now() - 60_000,
      conversationId: 'conv_test_1',
      originalContent: 'line1\nline2\n',
      newContent: 'line1\nchanged\nline3\n'
    }
  ];

  getPendingDiffList(): Array<{
    id: string;
    status: string;
    filePath: string;
    toolId?: string;
    diffGuardWarning?: string;
    diffGuardDeletePercent?: number;
    timestamp: number;
    conversationId?: string;
  }> {
    return this.pendingDiffs.map((d) => ({
      id: d.id,
      status: d.status,
      filePath: d.filePath,
      toolId: d.toolId,
      diffGuardWarning: d.diffGuardWarning,
      diffGuardDeletePercent: d.diffGuardDeletePercent,
      timestamp: d.timestamp,
      conversationId: d.conversationId
    }));
  }

  getPendingDiffContent(diffId: string): { filePath: string; originalContent: string; newContent: string; status: string } | null {
    const d = this.pendingDiffs.find((x) => x.id === diffId);
    if (!d) return null;
    return { filePath: d.filePath, originalContent: d.originalContent, newContent: d.newContent, status: d.status };
  }

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
      case 'diff.accept':
        return { success: true, sessionId: data?.sessionId, status: 'accepted' };
      case 'diff.reject':
        return { success: true, sessionId: data?.sessionId, status: 'rejected' };
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
    // V6 三段式布局：底部三页签已删除，改为全屏面板（#panel-files / #panel-settings）
    expect(res.body).toContain('id="view-chat"');
    expect(res.body).toContain('id="panel-files"');
    expect(res.body).toContain('id="panel-settings"');
    expect(res.body).toContain('id="settings-nav"');
    expect(res.body).not.toContain('data-tab="chat"');
    expect(res.body).not.toContain('data-tab="files"');
    expect(res.body).not.toContain('data-tab="settings"');
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

  test('GET /api/messages strips attachment blobs but keeps metadata, text and tool calls', async () => {
    const res = await requestJson(port, 'GET', '/api/messages?conversationId=conv_test_1');
    expect(res.status).toBe(200);
    const parts = res.body.messages[0].parts;
    expect(parts).toHaveLength(3);
    expect(parts[0].text).toBe('hi');
    // base64 数据被剥离，但保留 mimeType 元数据（移动端据此渲染附件占位，消息数与桌面端一致）
    expect(parts[1].inlineData).toEqual({ mimeType: 'image/png' });
    expect(parts[1].inlineData.data).toBeUndefined();
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

  test('POST /api/send rejects non-existent conversation with 404 (no zombie revival)', async () => {
    host.calls = [];
    const res = await post(port, `/api/send`, { conversationId: 'conv_deleted_1', text: 'hi' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Conversation not found');
    // 不得触发任何创建/流式调用（防已删除会话静默复活）
    expect(host.calls.some((c) => c.type === 'conversation.createConversation')).toBe(false);
    expect(host.calls.some((c) => c.type === 'chatStream')).toBe(false);
  });

  test('GET /api/mcp routes getMcpServers', async () => {
    host.respondOverrides['getMcpServers'] = {
      success: true,
      servers: [{ id: 'mcp1', name: 'Local', transport: { type: 'stdio' }, enabled: true }]
    };
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/mcp');
    expect(res.status).toBe(200);
    expect(res.body.servers).toHaveLength(1);
    expect(res.body.servers[0].id).toBe('mcp1');
    delete host.respondOverrides['getMcpServers'];
  });

  test('POST /api/mcp-create routes createMcpServer with input', async () => {
    host.respondOverrides['createMcpServer'] = { success: true, serverId: 'mcp_new' };
    host.calls = [];
    const res = await post(port, `/api/mcp-create`, {
      input: { id: 'mcp_new', name: 'New', transport: { type: 'sse', url: 'http://localhost:3000' }, enabled: true, autoConnect: true }
    });
    expect(res.status).toBe(200);
    expect(res.body.serverId).toBe('mcp_new');
    const call = host.calls.find((c) => c.type === 'createMcpServer');
    expect(call).toBeDefined();
    expect(call!.data.input.transport.type).toBe('sse');
    delete host.respondOverrides['createMcpServer'];
  });

  test('POST /api/mcp-toggle routes setMcpServerEnabled', async () => {
    host.respondOverrides['setMcpServerEnabled'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/mcp-toggle`, { serverId: 'mcp1', enabled: false });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'setMcpServerEnabled');
    expect(call).toBeDefined();
    expect(call!.data.enabled).toBe(false);
    delete host.respondOverrides['setMcpServerEnabled'];
  });

  test('POST /api/mcp-delete rejects invalid serverId with 400', async () => {
    const res = await post(port, `/api/mcp-delete`, { serverId: '../bad' });
    expect(res.status).toBe(400);
  });

  test('GET /api/subagents routes subagents.list', async () => {
    host.respondOverrides['subagents.list'] = {
      agents: [{ type: 'coder', name: 'Coder', enabled: true }],
      maxConcurrentAgents: 2,
      failureModeAfterRetries: 'fail_parent_tool',
      generalWorkerEnabled: true,
      defaultMaxIterations: 80
    };
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/subagents');
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.maxConcurrentAgents).toBe(2);
    delete host.respondOverrides['subagents.list'];
  });

  test('POST /api/subagent-save routes subagents.create', async () => {
    host.respondOverrides['subagents.create'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/subagent-save`, { type: 'coder', name: 'Coder', description: 'x' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'subagents.create');
    expect(call).toBeDefined();
    expect(call!.data.name).toBe('Coder');
    delete host.respondOverrides['subagents.create'];
  });

  test('POST /api/subagent-toggle routes subagents.setEnabled', async () => {
    host.respondOverrides['subagents.setEnabled'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/subagent-toggle`, { type: 'coder', enabled: false });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'subagents.setEnabled');
    expect(call).toBeDefined();
    expect(call!.data.enabled).toBe(false);
    delete host.respondOverrides['subagents.setEnabled'];
  });

  test('POST /api/prompt-mode-rename routes renamePromptMode', async () => {
    host.respondOverrides['renamePromptMode'] = { success: true, mode: { id: 'code', name: 'Code V2' } };
    host.calls = [];
    const res = await post(port, `/api/prompt-mode-rename`, { modeId: 'code', name: 'Code V2' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'renamePromptMode');
    expect(call).toBeDefined();
    expect(call!.data.name).toBe('Code V2');
    delete host.respondOverrides['renamePromptMode'];
  });

  test('POST /api/prompt-mode-delete routes deletePromptMode', async () => {
    host.respondOverrides['deletePromptMode'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/prompt-mode-delete`, { modeId: 'plan' });
    expect(res.status).toBe(200);
    expect(host.calls.some((c) => c.type === 'deletePromptMode')).toBe(true);
    delete host.respondOverrides['deletePromptMode'];
  });

  test('POST /api/dependency-install routes dependencies.install', async () => {
    host.respondOverrides['dependencies.install'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/dependency-install`, { name: 'python' });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'dependencies.install');
    expect(call).toBeDefined();
    expect(call!.data.name).toBe('python');
    delete host.respondOverrides['dependencies.install'];
  });

  test('POST /api/dependency-install rejects unsafe name with 400', async () => {
    const res = await post(port, `/api/dependency-install`, { name: '../evil' });
    expect(res.status).toBe(400);
  });

  test('GET /api/usage routes usage.getStats and flattens totals to stats top level', async () => {
    host.respondOverrides['usage.getStats'] = {
      totals: { totalTokens: 100, promptTokens: 60, candidatesTokens: 40 },
      byModel: [],
      byDay: [],
      byConversation: []
    };
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/usage');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // totals 平铺到 stats 顶层（移动端需要的扁平结构）
    expect(res.body.stats.totalTokens).toBe(100);
    expect(res.body.stats.promptTokens).toBe(60);
    expect(res.body.stats.candidatesTokens).toBe(40);
    expect(res.body.stats.totals).toBeUndefined();
    expect(res.body.stats.byConversation).toEqual([]);
    expect(res.body.stats.byModel).toEqual([]);
    expect(res.body.stats.byDay).toEqual([]);
    expect(typeof res.body.stats.generatedAt).toBe('number');
    expect(host.calls.some((c) => c.type === 'usage.getStats')).toBe(true);
    delete host.respondOverrides['usage.getStats'];
  });

  test('GET /api/usage flattens all totals fields and tolerates missing ones', async () => {
    host.respondOverrides['usage.getStats'] = {
      totals: {
        promptTokens: 60,
        candidatesTokens: 40,
        thoughtsTokens: 5,
        cacheCreationTokens: 10,
        cacheReadTokens: 20,
        totalTokens: 100,
        conversations: 3,
        modelMessages: 7,
        skippedConversations: 1
      },
      byModel: [{ modelVersion: 'gpt-4o', promptTokens: 60, candidatesTokens: 40, thoughtsTokens: 5, cacheCreationTokens: 10, cacheReadTokens: 20, totalTokens: 100, modelMessages: 7 }],
      byDay: [{ date: '2026-08-10', promptTokens: 60, candidatesTokens: 40, thoughtsTokens: 5, cacheCreationTokens: 10, cacheReadTokens: 20, totalTokens: 100, modelMessages: 7 }],
      byConversation: [{ conversationId: 'conv_1', title: 'A', updatedAt: 1, promptTokens: 60, candidatesTokens: 40, thoughtsTokens: 5, cacheCreationTokens: 10, cacheReadTokens: 20, totalTokens: 100, modelMessages: 7 }],
      generatedAt: 123456789
    };
    try {
      const res = await requestJson(port, 'GET', '/api/usage');
      expect(res.status).toBe(200);
      const s = res.body.stats;
      expect(s.promptTokens).toBe(60);
      expect(s.candidatesTokens).toBe(40);
      expect(s.thoughtsTokens).toBe(5);
      expect(s.cacheCreationTokens).toBe(10);
      expect(s.cacheReadTokens).toBe(20);
      expect(s.totalTokens).toBe(100);
      expect(s.conversations).toBe(3);
      expect(s.modelMessages).toBe(7);
      expect(s.skippedConversations).toBe(1);
      expect(s.generatedAt).toBe(123456789);
      expect(s.byModel).toHaveLength(1);
      expect(s.byDay).toHaveLength(1);
      expect(s.byConversation).toHaveLength(1);
      expect(s.totals).toBeUndefined();
      // 防御空对象：totals 缺失时各计数回落 0，不抛错
      host.respondOverrides['usage.getStats'] = {};
      const res2 = await requestJson(port, 'GET', '/api/usage');
      expect(res2.status).toBe(200);
      expect(res2.body.stats.totalTokens).toBe(0);
      expect(res2.body.stats.byConversation).toEqual([]);
      expect(typeof res2.body.stats.generatedAt).toBe('number');
    } finally {
      delete host.respondOverrides['usage.getStats'];
    }
  });

  test('GET /api/memory-entries routes getMemoryEntries with clamped limit', async () => {
    host.respondOverrides['getMemoryEntries'] = {
      entries: [{ id: 0, text: 'remember this' }, { id: 1, text: 'and that' }],
      total: 2,
      initialized: true
    };
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/memory-entries?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.total).toBe(2);
    const call = host.calls.find((c) => c.type === 'getMemoryEntries');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ limit: 1 });
    // 非法 limit 收敛到默认 5000
    host.calls = [];
    await requestJson(port, 'GET', '/api/memory-entries?limit=0');
    const call2 = host.calls.find((c) => c.type === 'getMemoryEntries');
    expect(call2!.data).toEqual({ limit: 5000 });
    host.calls = [];
    await requestJson(port, 'GET', '/api/memory-entries?limit=99999');
    const call3 = host.calls.find((c) => c.type === 'getMemoryEntries');
    expect(call3!.data).toEqual({ limit: 5000 });
    delete host.respondOverrides['getMemoryEntries'];
  });

  test('GET /api/memory-entries forwards workspaceUri scope parameter (workspace memory)', async () => {
    host.respondOverrides['getMemoryEntries'] = { entries: [], total: 0, initialized: true };
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/memory-entries?limit=100&workspaceUri=' + encodeURIComponent('file:///C:/ws'));
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'getMemoryEntries');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ limit: 100, workspaceUri: 'file:///C:/ws' });
    // 非法 workspaceUri（含控制字符）被剥离，仅传 limit
    host.calls = [];
    await requestJson(port, 'GET', '/api/memory-entries?limit=50&workspaceUri=' + encodeURIComponent('file:///\u0000x'));
    const call2 = host.calls.find((c) => c.type === 'getMemoryEntries');
    expect(call2!.data).toEqual({ limit: 50 });
    delete host.respondOverrides['getMemoryEntries'];
  });

  test('POST /api/memory-add/update/delete forward workspaceUri when present', async () => {
    host.respondOverrides['addMemoryEntry'] = { success: true, id: 9 };
    host.respondOverrides['updateMemoryEntry'] = { success: true };
    host.respondOverrides['deleteMemoryEntry'] = { success: true, removed: 1 };
    host.calls = [];
    const uri = 'file:///C:/ws';
    await post(port, '/api/memory-add', { text: 'hello', workspaceUri: uri });
    await post(port, '/api/memory-update', { id: 3, text: 'edited', workspaceUri: uri });
    await post(port, '/api/memory-delete', { id: 3, workspaceUri: uri });
    expect(host.calls.find((c) => c.type === 'addMemoryEntry')!.data).toEqual({ text: 'hello', workspaceUri: uri });
    expect(host.calls.find((c) => c.type === 'updateMemoryEntry')!.data).toEqual({ id: 3, text: 'edited', workspaceUri: uri });
    expect(host.calls.find((c) => c.type === 'deleteMemoryEntry')!.data).toEqual({ id: 3, workspaceUri: uri });
    // 无 workspaceUri 时保持原形状（全局记忆）
    host.calls = [];
    await post(port, '/api/memory-add', { text: 'global' });
    expect(host.calls.find((c) => c.type === 'addMemoryEntry')!.data).toEqual({ text: 'global' });
    delete host.respondOverrides['addMemoryEntry'];
    delete host.respondOverrides['updateMemoryEntry'];
    delete host.respondOverrides['deleteMemoryEntry'];
  });

  test('GET /api/usage forwards range parameter as startTime (7d/30d/today)', async () => {
    host.respondOverrides['usage.getStats'] = { totals: { totalTokens: 1 }, byModel: [], byDay: [], byConversation: [] };
    host.calls = [];
    const before = Date.now();
    await requestJson(port, 'GET', '/api/usage?range=7d');
    const call7 = host.calls.find((c) => c.type === 'usage.getStats');
    expect(call7).toBeDefined();
    const start7 = call7!.data.startTime as number;
    expect(typeof start7).toBe('number');
    expect(start7).toBeGreaterThan(before - 8 * 86400000);
    expect(start7).toBeLessThanOrEqual(before - 6 * 86400000);
    host.calls = [];
    await requestJson(port, 'GET', '/api/usage?range=30d');
    const call30 = host.calls.find((c) => c.type === 'usage.getStats');
    expect(call30!.data.startTime).toBeGreaterThan(before - 31 * 86400000);
    expect(call30!.data.startTime).toBeLessThanOrEqual(before - 29 * 86400000);
    // all / 非法 range → 不传 startTime
    host.calls = [];
    await requestJson(port, 'GET', '/api/usage?range=all');
    const callAll = host.calls.find((c) => c.type === 'usage.getStats');
    expect(callAll!.data).toEqual({});
    host.calls = [];
    await requestJson(port, 'GET', '/api/usage?range=bogus');
    const callBogus = host.calls.find((c) => c.type === 'usage.getStats');
    expect(callBogus!.data).toEqual({});
    delete host.respondOverrides['usage.getStats'];
  });

  test('POST /api/memory-add routes addMemoryEntry with text', async () => {
    host.respondOverrides['addMemoryEntry'] = { success: true, id: 42 };
    host.calls = [];
    const res = await post(port, '/api/memory-add', { text: 'remember this' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe(42);
    const call = host.calls.find((c) => c.type === 'addMemoryEntry');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ text: 'remember this' });
    delete host.respondOverrides['addMemoryEntry'];
  });

  test('POST /api/memory-add rejects empty and over-length text with 400', async () => {
    host.calls = [];
    const res1 = await post(port, '/api/memory-add', { text: '   ' });
    expect(res1.status).toBe(400);
    const res2 = await post(port, '/api/memory-add', { text: 'x'.repeat(20001) });
    expect(res2.status).toBe(400);
    const res3 = await post(port, '/api/memory-add', { text: 123 });
    expect(res3.status).toBe(400);
    expect(host.calls.some((c) => c.type === 'addMemoryEntry')).toBe(false);
  });

  test('POST /api/memory-update routes updateMemoryEntry with id + text', async () => {
    host.respondOverrides['updateMemoryEntry'] = { success: true };
    host.calls = [];
    const res = await post(port, '/api/memory-update', { id: 7, text: 'updated text' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const call = host.calls.find((c) => c.type === 'updateMemoryEntry');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ id: 7, text: 'updated text' });
    delete host.respondOverrides['updateMemoryEntry'];
  });

  test('POST /api/memory-update rejects invalid id or text with 400', async () => {
    host.calls = [];
    const res1 = await post(port, '/api/memory-update', { id: -1, text: 'hi' });
    expect(res1.status).toBe(400);
    const res2 = await post(port, '/api/memory-update', { id: 1.5, text: 'hi' });
    expect(res2.status).toBe(400);
    const res3 = await post(port, '/api/memory-update', { id: '1', text: 'hi' });
    expect(res3.status).toBe(400);
    const res4 = await post(port, '/api/memory-update', { id: 1, text: '' });
    expect(res4.status).toBe(400);
    expect(host.calls.some((c) => c.type === 'updateMemoryEntry')).toBe(false);
  });

  test('POST /api/memory-delete routes deleteMemoryEntry with id', async () => {
    host.respondOverrides['deleteMemoryEntry'] = { success: true, removed: 1 };
    host.calls = [];
    const res = await post(port, '/api/memory-delete', { id: 3 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const call = host.calls.find((c) => c.type === 'deleteMemoryEntry');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ id: 3 });
    delete host.respondOverrides['deleteMemoryEntry'];
  });

  test('POST /api/memory-delete rejects invalid id with 400', async () => {
    host.calls = [];
    const res1 = await post(port, '/api/memory-delete', { id: -2 });
    expect(res1.status).toBe(400);
    const res2 = await post(port, '/api/memory-delete', { id: null });
    expect(res2.status).toBe(400);
    const res3 = await post(port, '/api/memory-delete', { id: 1.5 });
    expect(res3.status).toBe(400);
    expect(host.calls.some((c) => c.type === 'deleteMemoryEntry')).toBe(false);
  });

  test('GET /api/memory-scopes routes listMemoryScopes', async () => {
    host.respondOverrides['listMemoryScopes'] = {
      scopes: [{ uri: 'file:///C%3A/work', name: 'work', fsPath: 'C:\\work', hasData: true }]
    };
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/memory-scopes');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.scopes).toHaveLength(1);
    expect(res.body.scopes[0].name).toBe('work');
    const call = host.calls.find((c) => c.type === 'listMemoryScopes');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({});
    delete host.respondOverrides['listMemoryScopes'];
  });

  test('POST /api/mcp-connect routes connectMcpServer with serverId', async () => {
    host.respondOverrides['connectMcpServer'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/mcp-connect`, { serverId: 'mcp1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const call = host.calls.find((c) => c.type === 'connectMcpServer');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ serverId: 'mcp1' });
    delete host.respondOverrides['connectMcpServer'];
  });

  test('POST /api/mcp-connect rejects invalid serverId with 400', async () => {
    host.calls = [];
    const res = await post(port, `/api/mcp-connect`, { serverId: '../bad' });
    expect(res.status).toBe(400);
    expect(host.calls.some((c) => c.type === 'connectMcpServer')).toBe(false);
  });

  test('POST /api/mcp-disconnect routes disconnectMcpServer with serverId', async () => {
    host.respondOverrides['disconnectMcpServer'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/mcp-disconnect`, { serverId: 'mcp1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const call = host.calls.find((c) => c.type === 'disconnectMcpServer');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ serverId: 'mcp1' });
    delete host.respondOverrides['disconnectMcpServer'];
  });

  test('POST /api/mcp-disconnect rejects invalid serverId with 400', async () => {
    host.calls = [];
    const res = await post(port, `/api/mcp-disconnect`, { serverId: 'a/b' });
    expect(res.status).toBe(400);
    expect(host.calls.some((c) => c.type === 'disconnectMcpServer')).toBe(false);
  });

  test('POST /api/update-check routes checkUpdateNow', async () => {
    host.respondOverrides['checkUpdateNow'] = { success: true, updateAvailable: true };
    host.calls = [];
    const res = await post(port, `/api/update-check`, {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const call = host.calls.find((c) => c.type === 'checkUpdateNow');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({});
    delete host.respondOverrides['checkUpdateNow'];
  });

  test('POST /api/update-now routes updateNow', async () => {
    host.respondOverrides['updateNow'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/update-now`, {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const call = host.calls.find((c) => c.type === 'updateNow');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({});
    delete host.respondOverrides['updateNow'];
  });

  test('POST /api/settings-export routes settings.export and returns filePath', async () => {
    host.respondOverrides['settings.export'] = { success: true, filePath: 'C:\\backup\\settings.json' };
    host.calls = [];
    const res = await post(port, `/api/settings-export`, {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.filePath).toBe('C:\\backup\\settings.json');
    const call = host.calls.find((c) => c.type === 'settings.export');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({});
    delete host.respondOverrides['settings.export'];
  });

  test('POST /api/settings-export returns cancelled when dialog dismissed', async () => {
    host.respondOverrides['settings.export'] = { success: false, cancelled: true };
    host.calls = [];
    const res = await post(port, `/api/settings-export`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelled: true });
    delete host.respondOverrides['settings.export'];
  });

  test('POST /api/settings-import routes settings.import with overwrite', async () => {
    host.respondOverrides['settings.import'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/settings-import`, { overwrite: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const call = host.calls.find((c) => c.type === 'settings.import');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ overwrite: true });
    delete host.respondOverrides['settings.import'];
  });

  test('POST /api/settings-import defaults overwrite to false', async () => {
    host.respondOverrides['settings.import'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/settings-import`, {});
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'settings.import');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({ overwrite: false });
    delete host.respondOverrides['settings.import'];
  });

  test('GET /api/storage-config routes storagePath.getConfig', async () => {
    host.respondOverrides['storagePath.getConfig'] = {
      success: true,
      customDataPath: '',
      migrationStatus: 'none'
    };
    host.calls = [];
    const res = await requestJson(port, 'GET', '/api/storage-config');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.config.migrationStatus).toBe('none');
    const call = host.calls.find((c) => c.type === 'storagePath.getConfig');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({});
    delete host.respondOverrides['storagePath.getConfig'];
  });

  test('POST /api/storage-reset routes storagePath.reset', async () => {
    host.respondOverrides['storagePath.reset'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/storage-reset`, {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const call = host.calls.find((c) => c.type === 'storagePath.reset');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({});
    delete host.respondOverrides['storagePath.reset'];
  });

  test('POST /api/storage-select routes storagePath.selectFolder', async () => {
    host.respondOverrides['storagePath.selectFolder'] = { success: true };
    host.calls = [];
    const res = await post(port, `/api/storage-select`, {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const call = host.calls.find((c) => c.type === 'storagePath.selectFolder');
    expect(call).toBeDefined();
    expect(call!.data).toEqual({});
    delete host.respondOverrides['storagePath.selectFolder'];
  });

  test('POST /api/storage-select returns cancelled when dialog dismissed', async () => {
    host.respondOverrides['storagePath.selectFolder'] = { success: false, cancelled: true };
    host.calls = [];
    const res = await post(port, `/api/storage-select`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelled: true });
    delete host.respondOverrides['storagePath.selectFolder'];
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

  test('POST /api/settings strips masked apiKey placeholders on write side (generate_image + token_count)', async () => {
    host.calls = [];
    const res = await post(port, '/api/settings', {
      settings: {
        toolsConfig: {
          generate_image: { apiKey: '********', model: 'flux' },
          token_count: {
            gemini: { apiKey: '', baseUrl: 'https://gemini', model: 'm' },
            openai: { apiKey: '********', baseUrl: 'https://openai', model: '' }
          }
        }
      }
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'updateSettings');
    expect(call).toBeDefined();
    const patch = call!.data.settings;
    // 占位/空串 apiKey 不落库（保持已设置的密钥不变），其余字段原样透传
    expect(patch.toolsConfig.generate_image.apiKey).toBeUndefined();
    expect(patch.toolsConfig.generate_image.model).toBe('flux');
    expect(patch.toolsConfig.token_count.gemini.apiKey).toBeUndefined();
    expect(patch.toolsConfig.token_count.gemini.baseUrl).toBe('https://gemini');
    expect(patch.toolsConfig.token_count.openai.apiKey).toBeUndefined();
    expect(patch.toolsConfig.token_count.openai.baseUrl).toBe('https://openai');
  });

  test('POST /api/settings keeps real apiKey values on write side', async () => {
    host.calls = [];
    const res = await post(port, '/api/settings', {
      settings: {
        toolsConfig: {
          generate_image: { apiKey: 'sk-img-real', model: 'flux' },
          token_count: { gemini: { apiKey: 'sk-tok-real', baseUrl: 'https://x' } }
        }
      }
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'updateSettings');
    expect(call).toBeDefined();
    const patch = call!.data.settings;
    expect(patch.toolsConfig.generate_image.apiKey).toBe('sk-img-real');
    expect(patch.toolsConfig.token_count.gemini.apiKey).toBe('sk-tok-real');
  });

  test('POST /api/settings drops proxy.url containing masked userinfo (***@) without overwriting real credentials', async () => {
    host.calls = [];
    const res = await post(port, '/api/settings', {
      settings: { proxy: { enabled: true, url: 'http://***@127.0.0.1:7890' } }
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'updateSettings');
    expect(call).toBeDefined();
    expect(call!.data.settings.proxy.url).toBeUndefined();
    expect(call!.data.settings.proxy.enabled).toBe(true);
  });

  test('POST /api/settings keeps real proxy.url without masked userinfo', async () => {
    host.calls = [];
    const res = await post(port, '/api/settings', {
      settings: { proxy: { enabled: true, url: 'http://user:pass@127.0.0.1:7890' } }
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'updateSettings');
    expect(call).toBeDefined();
    expect(call!.data.settings.proxy.url).toBe('http://user:pass@127.0.0.1:7890');
  });

  test('POST /api/settings stripMaskedSecrets tolerates malformed shapes without throwing', async () => {
    host.calls = [];
    const res = await post(port, '/api/settings', {
      settings: {
        toolsConfig: 'not-an-object',
        proxy: { url: 'http://***@x' },
        ui: { sound: { volume: 60 } }
      }
    });
    expect(res.status).toBe(200);
    const call = host.calls.find((c) => c.type === 'updateSettings');
    expect(call).toBeDefined();
    expect(call!.data.settings.ui.sound.volume).toBe(60);
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

  test('diff endpoints: status list / preview content / accept / reject / input validation', async () => {
    host.calls = [];
    const statusRes = await requestJson(port, 'GET', '/api/diff-status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.ok).toBe(true);
    expect(statusRes.body.pendingDiffs.length).toBeGreaterThan(0);
    expect(statusRes.body.pendingDiffs[0].id).toBe('diff-1234567890-abc');
    expect(statusRes.body.pendingDiffs[0].filePath).toBe('src/a.ts');
    expect(statusRes.body.pendingDiffs[0]).not.toHaveProperty('originalContent');

    const preview = await requestJson(port, 'GET', '/api/diff-preview?diffId=diff-1234567890-abc');
    expect(preview.status).toBe(200);
    expect(preview.body.originalContent).toContain('line1');
    expect(preview.body.newContent).toContain('changed');

    // 非法 ID 400 / 不存在 404（不泄露内容）
    expect((await requestJson(port, 'GET', '/api/diff-preview?diffId=%2E%2E%2Fetc')).status).toBe(400);
    expect((await requestJson(port, 'GET', '/api/diff-preview?diffId=diff-0000-0000')).status).toBe(404);

    const acc = await post(port, '/api/diff-accept', { diffId: 'diff-1234567890-abc' });
    expect(acc.status).toBe(200);
    expect(acc.body.status).toBe('accepted');
    expect(host.calls.some((c) => c.type === 'diff.accept' && c.data.sessionId === 'diff-1234567890-abc')).toBe(true);

    const rej = await post(port, '/api/diff-reject', { diffId: 'diff-1234567890-abc' });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe('rejected');
    expect(host.calls.some((c) => c.type === 'diff.reject' && c.data.sessionId === 'diff-1234567890-abc')).toBe(true);

    expect((await post(port, '/api/diff-accept', { diffId: 'x' })).status).toBe(400);
    expect((await post(port, '/api/diff-reject', {})).status).toBe(400);
  });

  test('SSE: diffStatus event broadcast carries pending diffs', async () => {
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
              if (events.some((e) => e.event === 'diffStatus')) {
                req.destroy();
                resolve();
              }
            }
          });
        }
      );
      req.on('error', (err) => {
        if (events.some((e) => e.event === 'diffStatus')) resolve();
        else reject(err);
      });
      req.end();
    });

    await new Promise((r) => setTimeout(r, 150));
    server.broadcastDiffStatus(
      [{
        id: 'diff-1', status: 'pending', filePath: 'src/a.ts', toolId: 'tool_1',
        timestamp: Date.now(), conversationId: 'conv_test_1'
      }],
      false,
      []
    );
    await sse;

    const ev = events.find((e) => e.event === 'diffStatus');
    expect(ev).toBeDefined();
    expect(ev!.data.pendingDiffs[0].id).toBe('diff-1');
    expect(ev!.data.pendingDiffs[0]).not.toHaveProperty('originalContent');
    expect(ev!.data.allProcessed).toBe(false);

    // 终结结算推送（finalized 透传）
    const events2: Array<{ event: string; data: any }> = [];
    const sse2 = new Promise<void>((resolve2, reject2) => {
      const req2 = http.request(
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
              events2.push({ event, data: parsed });
              const ds = events2.find((e) => e.event === 'diffStatus');
              if (ds && ds.data.finalized && ds.data.finalized.length > 0) {
                req2.destroy();
                resolve2();
              }
            }
          });
        }
      );
      req2.on('error', (err) => {
        if (events2.some((e) => e.event === 'diffStatus')) resolve2();
        else reject2(err);
      });
      req2.end();
    });
    await new Promise((r) => setTimeout(r, 150));
    server.broadcastDiffStatus([], true, [{ id: 'diff-1', status: 'accepted' }]);
    await sse2;
    const ev2 = events2.find((e) => e.event === 'diffStatus');
    expect(ev2).toBeDefined();
    expect(ev2!.data.finalized).toEqual([{ id: 'diff-1', status: 'accepted' }]);
    expect(ev2!.data.allProcessed).toBe(true);
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
