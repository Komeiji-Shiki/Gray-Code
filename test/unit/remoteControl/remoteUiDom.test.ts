/**
 * 远程控制移动端 UI DOM 交互测试（V4，jsdom）
 *
 * 用 jsdom（runScripts: 'dangerously'）加载 renderRemoteControlUiHtml('zh-CN') 自包含页面，
 * 在 window 上桩 fetch / EventSource，覆盖：
 * - 初始渲染：四选择器 chip × 4、设置页分类页签 × 20、error-banner 就位、无未捕获异常；
 * - 四选择器弹层：点击 chip → #sheet 打开且有内容 → 选择后 chip 文案联动；
 * - 设置页 20 个分类全部可切换并渲染卡片；
 * - 检查点 / 自动总结分类的字段路径（data-p）与桌面端 SettingsPanel 对齐；
 * - 新增渠道：modal 流程 → POST /api/config-create → 关闭且页面不白屏；
 * - 空闲稳定性：SSE message(complete)/conversations/workspace/bye 后页面完好；
 * - 发送：POST /api/send 携带 configId / promptModeId。
 *
 * 脚本内含 setInterval（SSE 看门狗 / bye 探活）与 setTimeout：测试不等待真实定时器，
 * 全部用微任务 flush + 轮询小函数断言；每个用例结束 window.close() 释放 jsdom 定时器。
 */

import { renderRemoteControlUiHtml } from '../../../backend/modules/remoteControl/remoteControlUi';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsdomLib = require('jsdom') as any;
const { JSDOM, VirtualConsole } = jsdomLib;

/** 桩 EventSource：不自动连接，测试手动 emit('open'/'hello'/'message'/...) */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2;
  url: string;
  readyState = 0;
  onopen: any = null;
  onerror: any = null;
  private handlers: Record<string, Array<(ev: any) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: any) => void): void {
    (this.handlers[type] = this.handlers[type] || []).push(fn);
  }
  emit(type: string, data?: unknown): void {
    if (type === 'open') {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
      return;
    }
    if (type === 'error') {
      if (this.onerror) this.onerror({});
      return;
    }
    const ev = { type, data: data === undefined ? undefined : JSON.stringify(data) };
    (this.handlers[type] || []).forEach((fn) => fn(ev));
  }
  close(): void {
    this.readyState = 2;
  }
}

/** 完整真实形状的设置（含 toolsConfig.checkpoint/summarize/memory/subagents/...） */
function buildSettings(): any {
  return {
    ok: true,
    settings: {
      checkForUpdates: true,
      maxToolIterations: 200,
      defaultToolMode: 'function_call',
      activeChannelId: 'c1',
      ui: {
        language: 'zh-CN',
        theme: 'auto',
        workspaceBehavior: 'restore',
        sound: { enabled: true, volume: 80 },
        appearance: { smoothStreaming: 'balanced', selectionContextEnabled: true, tpsBarEnabled: false }
      },
      proxy: { enabled: true, url: 'http://***@127.0.0.1:7890', insecureSkipTlsVerify: false },
      toolsConfig: {
        generate_image: {
          apiKey: '********', url: 'http://127.0.0.1:7860', model: 'flux',
          enableAspectRatio: true, enableImageSize: false,
          maxBatchTasks: 4, maxImagesPerTask: 2, returnImageToAI: true
        },
        token_count: { gemini: { enabled: true, apiKey: '********', baseUrl: '', model: '' } },
        apply_diff: { format: 'unified', autoSave: false, autoSaveDelay: 3000, diffGuardEnabled: true, autoApplyWithoutDiffView: false },
        read_file: { allowOutsideWorkspace: false },
        write_file: { allowOutsideWorkspace: false },
        execute_command: { defaultShell: 'auto', defaultTimeoutMs: 60000 },
        search_in_files: { excludePatterns: ['node_modules'] },
        sandbox: {
          enabled: true, allowedLanguages: ['python', 'javascript'],
          defaultTimeout: 30000, maxOutputLines: 100, cleanupTempDir: true
        },
        system_prompt: {
          modes: { code: { id: 'code', name: 'Code' }, plan: { id: 'plan', name: 'Plan' } },
          currentModeId: 'code',
          customPrefix: '', customSuffix: '',
          dynamicTemplateEnabled: false, dynamicTemplate: ''
        },
        context_awareness: {
          includeWorkspaceFiles: true, maxFileDepth: 3, includeOpenTabs: true, maxOpenTabs: 10,
          includeActiveEditor: true, ignorePatterns: [],
          diagnostics: {
            enabled: true, includeSeverities: ['error', 'warning'],
            workspaceOnly: true, openFilesOnly: false,
            maxDiagnosticsPerFile: 100, maxFiles: 10
          }
        },
        memory: { enabled: true, wakeLines: 3, entryChars: 2000, partChars: 10000, partLines: 50 },
        summarize: {
          summarizePrompt: 'Summarize the conversation',
          autoSummarizePrompt: 'Auto summary',
          keepRecentRounds: 3,
          keepRecentTokens: '20%',
          useSeparateModel: false,
          summarizeChannelId: 'c1',
          summarizeModelId: '',
          maxAutoSummarizeAttemptsPerTurn: 2,
          summarizeMaxInputRatio: 0.2
        },
        checkpoint: {
          enabled: true,
          maxCheckpoints: 5,
          messageCheckpoint: {
            beforeMessages: ['user'],
            afterMessages: ['model'],
            modelOuterLayerOnly: false,
            mergeUnchangedCheckpoints: true
          },
          beforeTools: ['apply_diff', 'write_file'],
          afterTools: ['execute_command'],
          exclusion: {
            enabledProfiles: {
              logs: true, aiModels: false, datasets: true, caches: true,
              pythonVenvs: false, buildArtifacts: true, largeMedia: false, archives: false
            },
            maxFileSizeBytes: 104857600,
            customPatterns: ['dist/**']
          }
        },
        subagents: {
          maxConcurrentAgents: 2,
          failureModeAfterRetries: 'fail_parent_tool',
          generalWorkerEnabled: true,
          defaultMaxIterations: -1,
          defaultMaxRuntime: -1
        },
        skills: { skills: [] },
        pinned_files: { pinnedFiles: ['src/a.ts'] }
      },
      storagePath: { customDataPath: '', migrationStatus: 'none' },
      remoteControl: { enabled: true, port: 17532 }
    }
  };
}

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

/** jsdom 页面夹具：fetch 桩（按路径返回 canned 响应）+ EventSource 桩 + 错误收集 */
class Fixture {
  dom: any;
  window: any;
  document: any;
  errors: unknown[] = [];
  fetches: FetchCall[] = [];

  status: any = {
    ok: true, appVersion: '1.7.10dev', running: true, activeChannelId: 'c1',
    workspaceUri: 'file:///C:/ws', workspaceName: 'ws', lang: 'zh-CN'
  };
  configs: any[] = [
    {
      id: 'c1', name: 'A', model: 'm1', type: 'openai', enabled: true,
      options: { reasoning: { effort: 'high' } }, optionsEnabled: { reasoning: true }
    },
    {
      id: 'c2', name: 'B', model: 'm2', type: 'anthropic', enabled: false,
      options: {}, optionsEnabled: {}
    }
  ];
  configDetails: Record<string, any> = {
    c1: {
      id: 'c1', name: 'A', model: 'm1', type: 'openai', enabled: true,
      url: 'https://api.openai.com/v1', apiKey: '********',
      options: { reasoning: { effort: 'high' } }, optionsEnabled: { reasoning: true },
      models: [
        { id: 'm1', name: 'Model 1' },
        { id: 'm2', name: 'Model 2' }
      ]
    },
    c2: {
      id: 'c2', name: 'B', model: 'm2', type: 'anthropic', enabled: false,
      url: 'https://api.anthropic.com', apiKey: '********',
      options: {}, optionsEnabled: {},
      models: [{ id: 'm3', name: 'Model 3' }]
    }
  };
  modes: any[] = [
    { id: 'code', name: 'Code', icon: 'symbol-method' },
    { id: 'plan', name: 'Plan', icon: 'list-unordered' }
  ];
  currentModeId = 'code';
  tools: any[] = [
    { name: 'read_file', description: 'Read files', enabled: true, category: 'file' },
    { name: 'write_file', description: 'Write files', enabled: true, category: 'file' }
  ];

  constructor() {
    const vc = new VirtualConsole();
    vc.on('jsdomError', (err: unknown) => { this.errors.push(err); });
    this.dom = new JSDOM(renderRemoteControlUiHtml('zh-CN'), {
      runScripts: 'dangerously',
      url: 'http://localhost/',
      virtualConsole: vc,
      beforeParse: (w: any) => {
        w.fetch = (url: string, init?: any) => this.handleFetch(url, init);
        w.EventSource = FakeEventSource;
      }
    });
    this.window = this.dom.window;
    this.document = this.dom.window.document;
  }

  handleFetch(url: string, init?: any): Promise<any> {
    const method = (init && init.method) || 'GET';
    const path = String(url).split('?')[0];
    let body: any;
    try {
      body = init && typeof init.body === 'string' ? JSON.parse(init.body) : (init && init.body);
    } catch {
      body = init && init.body;
    }
    this.fetches.push({ url: String(url), method, body });
    const respond = (data: any): Promise<any> =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
    switch (path) {
      case '/api/status':
        return respond(this.status);
      case '/api/configs':
        return respond({ ok: true, configs: this.configs });
      case '/api/prompt-modes':
        return respond({ ok: true, modes: this.modes, currentModeId: this.currentModeId });
      case '/api/conversations':
        return respond({ ok: true, conversations: [], total: 0, hasMore: false, offset: 0, limit: 30 });
      case '/api/settings':
        return respond(buildSettings());
      case '/api/tools':
        return respond({ ok: true, tools: this.tools, autoExec: {} });
      case '/api/dependencies':
        return respond({ ok: true, dependencies: [] });
      case '/api/config': {
        const configId = new URL(String(url), 'http://localhost/').searchParams.get('configId') || '';
        return respond({ ok: true, config: this.configDetails[configId] || null });
      }
      case '/api/messages':
        return respond({ ok: true, messages: [], total: 0, hasMore: false, offset: 0 });
      case '/api/config-create':
        return respond({ ok: true, configId: 'ch_new' });
      case '/api/config-update': {
        // 模拟真实服务端：思考强度等更新落到渠道配置上（后续 loadConfigs 重新同步）
        const target = this.configs.find((c: any) => c.id === (body && body.configId));
        const updates = body && body.updates;
        if (target && updates && typeof updates === 'object') {
          if (updates.options && typeof updates.options === 'object') {
            target.options = Object.assign({}, target.options, updates.options);
          }
          if (updates.optionsEnabled && typeof updates.optionsEnabled === 'object') {
            target.optionsEnabled = Object.assign({}, target.optionsEnabled, updates.optionsEnabled);
          }
        }
        return respond({ ok: true });
      }
      case '/api/send':
        return respond({ ok: true, conversationId: (body && body.conversationId) || 'conv_new', streamId: 'remote_1' });
      default:
        return respond({ ok: true });
    }
  }

  close(): void {
    try { this.dom.window.close(); } catch { /* already closed */ }
  }
}

/** 等待微任务链落定（真实 0ms 定时器，多轮排空 promise 链） */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 轮询等待条件成立（不等待真实看门狗定时器） */
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 收集当前渲染的全部 data-p 路径（JSON 字符串形式） */
function fieldPaths(doc: any): string[] {
  const out: string[] = [];
  doc.querySelectorAll('.set-field').forEach((el: any) => {
    const raw = el.getAttribute('data-p');
    if (raw) {
      try { JSON.parse(raw); } catch { return; }
      out.push(raw);
    }
  });
  return out;
}

function fieldElByPath(doc: any, path: string[]): any {
  const raw = JSON.stringify(path);
  let found: any = null;
  doc.querySelectorAll('.set-field').forEach((el: any) => {
    if (el.getAttribute('data-p') === raw) found = el;
  });
  if (!found) throw new Error('field not found: ' + raw);
  return found;
}

let fixtures: Fixture[] = [];

beforeEach(() => {
  fixtures = [];
  FakeEventSource.instances = [];
});

afterEach(() => {
  fixtures.forEach((f) => f.close());
  fixtures = [];
});

describe('remote UI DOM (jsdom)', () => {
  function makeFixture(): Fixture {
    const f = new Fixture();
    fixtures.push(f);
    return f;
  }

  /** 进入设置页并等待 settings/tools/configs 全部加载完毕 */
  async function openSettingsLoaded(f: Fixture): Promise<void> {
    f.document.querySelector('[data-tab="settings"]').click();
    await flush(10);
    await waitFor(() => f.fetches.some((x) => x.url === '/api/settings'));
    await flush(10);
  }

  test('initial render: 4 sel-chips, 20 set-tabs, error banner wired, no uncaught errors', async () => {
    const f = makeFixture();
    await flush();
    expect(f.document.querySelectorAll('.sel-chip').length).toBe(4);
    expect(f.document.querySelectorAll('.set-tab').length).toBe(20);
    expect(f.document.querySelector('#error-banner')).not.toBeNull();
    expect(f.document.querySelector('#app').children.length).toBeGreaterThan(0);
    expect(f.document.querySelector('#empty-text').textContent.length).toBeGreaterThan(0);
    expect(f.errors).toEqual([]);
  });

  test('four selector sheets open with content and update chips on selection', async () => {
    const f = makeFixture();
    await flush();
    const chips = () => f.document.querySelectorAll('.sel-chip');
    const valueOf = (idx: number): string => chips()[idx].querySelector('.sel-value').textContent;
    const openSheet = async (idx: number): Promise<any> => {
      chips()[idx].click();
      await flush();
      expect(f.document.querySelector('#sheet').classList.contains('open')).toBe(true);
      const list = f.document.querySelector('#sheet-list');
      expect(list.children.length).toBeGreaterThan(0);
      return list;
    };
    const pickItem = async (label: string): Promise<void> => {
      const list = f.document.querySelector('#sheet-list');
      const items = list.querySelectorAll('.sheet-item');
      let target: any = null;
      for (const it of items) {
        const first = it.querySelector('span');
        if (first && first.textContent === label) { target = it; break; }
      }
      expect(target).not.toBeNull();
      target.click();
      await flush();
    };

    // 模式：Code(选中)/Plan → 选 Plan
    let list = await openSheet(0);
    expect(list.querySelectorAll('.sheet-item').length).toBe(2);
    await pickItem('Plan');
    expect(valueOf(0)).toBe('Plan');

    // 渠道：A(选中)/B → 选 B 再切回 A（模型选择依赖 c1）
    list = await openSheet(1);
    expect(list.querySelectorAll('.sheet-item').length).toBe(2);
    await pickItem('B');
    expect(valueOf(1)).toBe('B');
    await openSheet(1);
    await pickItem('A');
    expect(valueOf(1)).toBe('A');

    // 模型：Auto + Model 1 + Model 2 → 选 Model 2
    list = await openSheet(2);
    expect(list.querySelectorAll('.sheet-item').length).toBe(3);
    await pickItem('Model 2');
    expect(valueOf(2)).toBe('Model 2');

    // 思考强度：openai 选项 → 选 low
    list = await openSheet(3);
    expect(list.querySelectorAll('.sheet-item').length).toBeGreaterThan(3);
    await pickItem('low');
    expect(valueOf(3)).toBe('low');

    expect(f.errors).toEqual([]);
  });

  test('all 20 settings categories switch and render cards', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    const keys: string[] = [];
    f.document.querySelectorAll('.set-tab').forEach((b: any) => keys.push(b.getAttribute('data-set-tab')));
    expect(keys.length).toBe(20);
    for (const key of keys) {
      const btn = f.document.querySelector('.set-tab[data-set-tab="' + key + '"]');
      expect(btn).not.toBeNull();
      btn.click();
      await flush(3);
      const sections = f.document.querySelector('#settings-sections');
      expect(sections).not.toBeNull();
      expect(sections.querySelectorAll('.card').length).toBeGreaterThan(0);
    }
    // 切回渠道分类仍可渲染（往返不坏）
    f.document.querySelector('.set-tab[data-set-tab="channel"]').click();
    await flush(3);
    expect(f.document.querySelectorAll('#settings-sections .card').length).toBeGreaterThan(0);
    expect(f.errors).toEqual([]);
  });

  test('checkpoint category renders field paths under toolsConfig.checkpoint', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    f.document.querySelector('.set-tab[data-set-tab="checkpoint"]').click();
    await flush(5);
    const paths = fieldPaths(f.document);
    for (const p of [
      ['toolsConfig', 'checkpoint', 'enabled'],
      ['toolsConfig', 'checkpoint', 'maxCheckpoints'],
      ['toolsConfig', 'checkpoint', 'messageCheckpoint', 'beforeMessages'],
      ['toolsConfig', 'checkpoint', 'messageCheckpoint', 'afterMessages'],
      ['toolsConfig', 'checkpoint', 'messageCheckpoint', 'modelOuterLayerOnly'],
      ['toolsConfig', 'checkpoint', 'messageCheckpoint', 'mergeUnchangedCheckpoints'],
      ['toolsConfig', 'checkpoint', 'beforeTools'],
      ['toolsConfig', 'checkpoint', 'afterTools'],
      ['toolsConfig', 'checkpoint', 'exclusion', 'enabledProfiles'],
      ['toolsConfig', 'checkpoint', 'exclusion', 'maxFileSizeBytes'],
      ['toolsConfig', 'checkpoint', 'exclusion', 'customPatterns']
    ]) {
      expect(paths).toContain(JSON.stringify(p));
    }
    // 值回填：enabled 勾选、maxCheckpoints=5、排除类别 logs 勾选 / aiModels 未勾选
    expect(fieldElByPath(f.document, ['toolsConfig', 'checkpoint', 'enabled']).querySelector('input').checked).toBe(true);
    expect(fieldElByPath(f.document, ['toolsConfig', 'checkpoint', 'maxCheckpoints']).querySelector('input').value).toBe('5');
    const profiles = fieldElByPath(f.document, ['toolsConfig', 'checkpoint', 'exclusion', 'enabledProfiles']).querySelectorAll('input[type=checkbox]');
    expect(profiles.length).toBe(8);
    expect(profiles[0].checked).toBe(true);   // logs
    expect(profiles[1].checked).toBe(false);  // aiModels
    expect(f.errors).toEqual([]);
  });

  test('summarize category renders field paths under toolsConfig.summarize', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    f.document.querySelector('.set-tab[data-set-tab="summarize"]').click();
    await flush(5);
    const paths = fieldPaths(f.document);
    for (const p of [
      ['toolsConfig', 'summarize', 'summarizePrompt'],
      ['toolsConfig', 'summarize', 'autoSummarizePrompt'],
      ['toolsConfig', 'summarize', 'keepRecentRounds'],
      ['toolsConfig', 'summarize', 'keepRecentTokens'],
      ['toolsConfig', 'summarize', 'useSeparateModel'],
      ['toolsConfig', 'summarize', 'summarizeChannelId'],
      ['toolsConfig', 'summarize', 'summarizeModelId'],
      ['toolsConfig', 'summarize', 'maxAutoSummarizeAttemptsPerTurn'],
      ['toolsConfig', 'summarize', 'summarizeMaxInputRatio']
    ]) {
      expect(paths).toContain(JSON.stringify(p));
    }
    // ratio 回填：0.2 → 20（5-95 百分比）
    expect(fieldElByPath(f.document, ['toolsConfig', 'summarize', 'summarizeMaxInputRatio']).querySelector('input').value).toBe('20');
    // configSelect 选项来自已加载的渠道
    const channelSel = fieldElByPath(f.document, ['toolsConfig', 'summarize', 'summarizeChannelId']).querySelector('select');
    expect(channelSel.querySelectorAll('option').length).toBe(3); // 占位 + c1 + c2
    expect(channelSel.value).toBe('c1');
    expect(f.errors).toEqual([]);
  });

  test('add channel: modal flow posts /api/config-create, closes modal, page stays alive', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    const addBtn = f.document.querySelector('.add-channel-btn');
    expect(addBtn).not.toBeNull();
    addBtn.click();
    await flush();
    const modal = f.document.querySelector('#modal');
    expect(modal.classList.contains('open')).toBe(true);
    expect(f.document.querySelector('#modal-title').textContent).toBe('新增渠道');
    const nameInput = f.document.querySelector('#modal-body input[type="text"]');
    expect(nameInput).not.toBeNull();
    nameInput.value = 'My Channel';
    f.document.querySelector('#modal-ok').click();
    await flush(10);
    const create = f.fetches.find((x) => x.url === '/api/config-create' && x.method === 'POST');
    expect(create).toBeDefined();
    expect(create!.body).toEqual({ type: 'gemini', name: 'My Channel' });
    expect(modal.classList.contains('open')).toBe(false);
    // 回归：操作后页面仍有内容（不白屏）
    const app = f.document.querySelector('#app');
    expect(app.innerHTML.length).toBeGreaterThan(500);
    expect(f.document.querySelectorAll('#settings-sections .card').length).toBeGreaterThan(0);
    expect(f.errors).toEqual([]);
  });

  test('idle stability: SSE message/conversations/workspace/bye leave page intact', async () => {
    const f = makeFixture();
    await flush();
    await waitFor(() => FakeEventSource.instances.length >= 1);
    const es = FakeEventSource.instances[0];

    es.emit('hello', {
      ok: true, appVersion: '1.7.10dev', activeChannelId: 'c1',
      activeConversationId: 'conv1', activeConversationTitle: 'Test',
      workspaceUri: 'file:///C:/ws', workspaceName: 'ws', lang: 'zh-CN'
    });
    await flush(10);
    expect(f.document.querySelectorAll('#conv-tabs .tab').length).toBeGreaterThan(0);

    // 完整 chunk + complete 终结块（真实 streamChunkBatch 形状）
    es.emit('message', {
      type: 'streamChunkBatch',
      conversationId: 'conv1',
      data: [
        { conversationId: 'conv1', streamId: 's1', type: 'chunk', chunk: 'hello ' },
        { conversationId: 'conv1', streamId: 's1', type: 'complete', content: 'hello world' }
      ]
    });
    await flush(10);

    es.emit('conversations');
    await flush(5);

    es.emit('workspace', { workspaceUri: 'file:///D:/ws2', workspaceName: 'ws2' });
    await flush(5);
    expect(f.document.querySelector('#ws-name').textContent).toBe('ws2');

    es.emit('bye');
    await flush(5);
    expect(f.document.querySelector('#send').disabled).toBe(true);
    expect(f.document.querySelector('#status').textContent).toBe('远程控制已关闭');

    // 页面不空白：顶栏/页签条/底部导航仍在
    const app = f.document.querySelector('#app');
    expect(app.querySelectorAll('*').length).toBeGreaterThan(50);
    expect(f.document.querySelectorAll('#tabbar button').length).toBe(3);
    expect(f.errors).toEqual([]);
  });

  test('send posts /api/send with configId and promptModeId', async () => {
    const f = makeFixture();
    await flush();
    await waitFor(() => FakeEventSource.instances.length >= 1);
    FakeEventSource.instances[0].emit('hello', {
      ok: true, appVersion: '1.7.10dev', activeChannelId: 'c1',
      activeConversationId: 'conv1', activeConversationTitle: 'Test',
      workspaceUri: 'file:///C:/ws', workspaceName: 'ws', lang: 'zh-CN'
    });
    await flush(10);
    const input = f.document.querySelector('#input');
    input.value = 'hello';
    // 真实用户流：input 事件触发 updateSendBtn 解除禁用后再点击
    input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
    await flush(2);
    f.document.querySelector('#send').click();
    await flush(10);
    if (!f.fetches.some((x) => x.url === '/api/send' && x.method === 'POST')) {
      console.log('[DEBUG] errors:', JSON.stringify(f.errors.map((e) => String(e))));
      console.log('[DEBUG] fetches:', JSON.stringify(f.fetches.map((x) => x.url + ':' + x.method)));
      console.log('[DEBUG] send disabled:', f.document.querySelector('#send').disabled, 'tabs:', f.document.querySelectorAll('#conv-tabs .tab').length);
    }
    const send = f.fetches.find((x) => x.url === '/api/send' && x.method === 'POST');
    expect(send).toBeDefined();
    expect(send!.body).toEqual({
      text: 'hello',
      configId: 'c1',
      promptModeId: 'code',
      conversationId: 'conv1'
    });
    expect(f.errors).toEqual([]);
  });
});
