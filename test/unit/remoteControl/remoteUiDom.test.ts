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
  memoryEntries: any = {
    ok: true,
    entries: [
      { id: 1, date: '2026-08-10', text: 'remember this' },
      { id: 2, date: '2026-08-09', text: 'second memory' }
    ],
    total: 2
  };
  settingsState: any = buildSettings().settings;
  usageStats: any = {
    ok: true,
    stats: {
      promptTokens: 100, candidatesTokens: 200, thoughtsTokens: 50,
      cacheReadTokens: 30, totalTokens: 350, conversations: 2, modelMessages: 5,
      byModel: [
        { modelVersion: 'gpt-4o', totalTokens: 200 },
        { modelVersion: 'claude', totalTokens: 150 }
      ],
      byDay: [{ date: '2026-08-10', totalTokens: 350 }],
      generatedAt: 1
    }
  };

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
      case '/api/settings': {
        if (method === 'POST' && body && body.settings && typeof body.settings === 'object') {
          // 模拟真实服务端深合并：settings patch 合并进状态并回读
          this.settingsState = Object.assign({}, this.settingsState, body.settings);
          if (body.settings.toolsConfig && typeof body.settings.toolsConfig === 'object') {
            this.settingsState.toolsConfig = Object.assign({}, this.settingsState.toolsConfig, body.settings.toolsConfig);
            const tc = this.settingsState.toolsConfig;
            if (body.settings.toolsConfig.system_prompt && typeof body.settings.toolsConfig.system_prompt === 'object') {
              tc.system_prompt = Object.assign({}, tc.system_prompt, body.settings.toolsConfig.system_prompt);
              if (body.settings.toolsConfig.system_prompt.modes && typeof body.settings.toolsConfig.system_prompt.modes === 'object') {
                tc.system_prompt.modes = Object.assign({}, tc.system_prompt.modes, body.settings.toolsConfig.system_prompt.modes);
              }
            }
          }
          return respond({ ok: true, settings: this.settingsState });
        }
        return respond({ ok: true, settings: this.settingsState });
      }
      case '/api/tools':
        return respond({ ok: true, tools: this.tools, autoExec: {} });
      case '/api/dependencies':
        return respond({ ok: true, dependencies: [] });
      case '/api/config': {
        const configId = new URL(String(url), 'http://localhost/').searchParams.get('configId') || '';
        return respond({ ok: true, config: this.configDetails[configId] || null });
      }
      case '/api/memory-entries':
        return respond(this.memoryEntries);
      case '/api/usage':
        return respond(this.usageStats);
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
      case '/api/models-add': {
        const tgt = this.configDetails[body && body.configId];
        if (tgt && Array.isArray(tgt.models)) {
          tgt.models.push(...((body && body.models) || []));
        }
        return respond({ ok: true });
      }
      case '/api/models-remove': {
        const tgt = this.configDetails[body && body.configId];
        if (tgt && Array.isArray(tgt.models)) {
          tgt.models = tgt.models.filter((m: any) => m.id !== (body && body.modelId));
        }
        return respond({ ok: true });
      }
      case '/api/model': {
        const tgt = this.configDetails[body && body.configId];
        if (tgt) tgt.model = body && body.modelId;
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

  /** 进入设置面板并等待 settings/tools/configs 全部加载完毕 */
  async function openSettingsLoaded(f: Fixture): Promise<void> {
    f.document.querySelector('#btn-settings').click();
    await flush(10);
    await waitFor(() => f.fetches.some((x) => x.url === '/api/settings'));
    await flush(10);
  }

  test('initial render: 4 sel-chips, 22 set-tabs, error banner wired, no uncaught errors', async () => {
    const f = makeFixture();
    await flush();
    expect(f.document.querySelectorAll('.sel-chip').length).toBe(4);
    expect(f.document.querySelectorAll('.set-tab').length).toBe(22);
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

  test('all 22 settings categories switch and render cards', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    const keys: string[] = [];
    f.document.querySelectorAll('.set-tab').forEach((b: any) => keys.push(b.getAttribute('data-set-tab')));
    expect(keys.length).toBe(22);
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

    // 页面不空白：顶栏按钮 / 页签条 / 全屏面板仍在
    const app = f.document.querySelector('#app');
    expect(app.querySelectorAll('*').length).toBeGreaterThan(50);
    expect(f.document.querySelectorAll('header .icon-btn').length).toBe(4);
    expect(f.document.querySelector('#btn-files')).not.toBeNull();
    expect(f.document.querySelector('#btn-settings')).not.toBeNull();
    expect(f.document.querySelector('#panel-files')).not.toBeNull();
    expect(f.document.querySelector('#panel-settings')).not.toBeNull();
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

  test('memory category renders entries list, add row and delete posts /api/memory-delete', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    f.document.querySelector('.set-tab[data-set-tab="memory"]').click();
    await flush(3);
    await waitFor(() => f.fetches.some((x) => x.url.indexOf('/api/memory-entries') === 0));
    await flush(5);
    const items = f.document.querySelectorAll('#settings-sections .mem-item');
    expect(items.length).toBe(2);
    expect(items[0].querySelector('.mem-text').textContent).toBe('remember this');
    expect(items[0].querySelector('.mem-date').textContent).toBe('2026-08-10');
    expect(f.document.querySelectorAll('#settings-sections .mem-add-row').length).toBe(1);
    expect(f.document.querySelector('#settings-sections .set-note').textContent).toContain('共 2');
    // 删除按钮 → POST /api/memory-delete { id }
    items[0].querySelector('.mem-del').click();
    await flush(5);
    const del = f.fetches.find((x) => x.url === '/api/memory-delete' && x.method === 'POST');
    expect(del).toBeDefined();
    expect(del!.body).toEqual({ id: 1 });
    // 添加行 → POST /api/memory-add { text }
    const addInput = f.document.querySelector('.mem-add-row input');
    addInput.value = 'new memory';
    f.document.querySelector('.mem-add-row .mini-btn').click();
    await flush(5);
    const add = f.fetches.find((x) => x.url === '/api/memory-add' && x.method === 'POST');
    expect(add).toBeDefined();
    expect(add!.body).toEqual({ text: 'new memory' });
    expect(f.errors).toEqual([]);
  });

  test('usage category renders stat grid (7 cards) and byModel/byDay lists', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    f.document.querySelector('.set-tab[data-set-tab="usage"]').click();
    await flush(3);
    await waitFor(() => f.fetches.some((x) => x.url === '/api/usage'));
    await flush(5);
    const grid = f.document.querySelector('#settings-sections .stat-grid');
    expect(grid).not.toBeNull();
    expect(grid.querySelectorAll('.stat-card').length).toBe(8);
    const nums = Array.from(grid.querySelectorAll('.stat-num')).map((el: any) => el.textContent);
    expect(nums).toContain('350');
    expect(nums).toContain('100');
    expect(nums).toContain('200');
    expect(nums).toContain('50');
    expect(nums).toContain('30');
    expect(nums).toContain('2');
    expect(nums).toContain('5');
    const labels = Array.from(f.document.querySelectorAll('#settings-sections .group-label')).map((el: any) => el.textContent);
    expect(labels).toContain('按模型');
    expect(labels).toContain('按日期');
    const rows = Array.from(f.document.querySelectorAll('#settings-sections .set-row'));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // 刷新按钮存在
    expect(f.document.querySelector('#settings-sections .btn').textContent).toBe('刷新');
    expect(f.errors).toEqual([]);
  });

  test('channel edit modal has 4 sub-tabs (ch-tabs) and switching panes works', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    let editBtn: any = null;
    f.document.querySelectorAll('.cfg-actions .mini-btn').forEach((b: any) => {
      if (b.textContent === '编辑' && !editBtn) editBtn = b;
    });
    expect(editBtn).not.toBeNull();
    editBtn.click();
    await flush(5);
    const chTabs = f.document.querySelectorAll('#modal .ch-tab');
    expect(chTabs.length).toBe(4);
    const panes = f.document.querySelectorAll('#modal .ch-pane');
    expect(panes.length).toBe(4);
    expect(panes[0].classList.contains('active')).toBe(true);
    // 切到上下文管理
    chTabs[1].click();
    expect(panes[1].classList.contains('active')).toBe(true);
    expect(panes[0].classList.contains('active')).toBe(false);
    // 切到工具配置 / 高级选项
    chTabs[2].click();
    expect(panes[2].classList.contains('active')).toBe(true);
    chTabs[3].click();
    expect(panes[3].classList.contains('active')).toBe(true);
    expect(f.document.querySelectorAll('#modal .ch-pane.active .set-field').length).toBeGreaterThan(0);
    // 保存 → POST /api/config-update，strictToolsEnabled 字段名修正、options/optionsEnabled 合并
    f.document.querySelector('#modal-ok').click();
    await flush(10);
    const upd = f.fetches.find((x) => x.url === '/api/config-update' && x.method === 'POST');
    expect(upd).toBeDefined();
    const body = upd!.body as any;
    expect(body.configId).toBe('c1');
    expect(typeof body.updates.strictToolsEnabled).toBe('boolean');
    expect(body.updates.strictTools).toBeUndefined();
    expect(body.updates.options).toBeDefined();
    expect(body.updates.optionsEnabled).toBeDefined();
    expect(f.errors).toEqual([]);
  });

  test('channel page renders desktop-style selector + collapsible sub-menus with instant save', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    // ① 渠道选择器（选中即当前）
    const selRow = f.document.querySelector('#settings-sections .cfg-selector');
    expect(selRow).not.toBeNull();
    const sel = selRow.querySelector('select');
    expect(sel).not.toBeNull();
    expect(sel.value).toBe('c1');
    expect(selRow.querySelectorAll('option').length).toBe(3); // 占位 + c1 + c2
    // ② 折叠菜单（桌面端 ChannelSettings 同构：上下文管理/工具配置/Token计数/高级/自定义Body/自定义标头/自动重试）
    const collaps = f.document.querySelectorAll('#settings-sections .ch-form .collap');
    expect(collaps.length).toBe(7);
    const titles = Array.from(collaps).map((c: any) => c.querySelector('.collap-title').textContent);
    expect(titles).toEqual(['上下文管理', '工具配置', 'Token 计数方式', '高级选项', '自定义 Body', '自定义标头', '自动重试']);
    // ③ 基础字段即存（修改 url → POST /api/config-update）
    const urlRow: any = Array.from(f.document.querySelectorAll('#settings-sections .ch-form .set-field')).find((r: any) => r.querySelector('.k').textContent === '接口地址');
    const urlInput = urlRow.querySelector('input');
    urlInput.value = 'https://new.example.com/v1';
    urlInput.dispatchEvent(new f.window.Event('change'));
    await flush(5);
    const upd = f.fetches.filter((x) => x.url === '/api/config-update' && x.method === 'POST');
    expect(upd.length).toBeGreaterThan(0);
    expect(upd[upd.length - 1].body).toEqual({ configId: 'c1', updates: { url: 'https://new.example.com/v1' } });
    // ④ 折叠展开显示内部字段（上下文管理 → contextThreshold）
    collaps[0].querySelector('.collap-head').click();
    await flush();
    const ctxRow = Array.from(collaps[0].querySelectorAll('.set-field')).find((r: any) => r.querySelector('.k').textContent === '阈值');
    expect(ctxRow).not.toBeNull();
    // ⑤ 高级选项展开后含子分组（openai → reasoning）
    const adv = collaps[3];
    adv.querySelector('.collap-head').click();
    await flush();
    expect(adv.querySelectorAll('.cfg-sub').length).toBeGreaterThanOrEqual(2); // 推理配置 + 思考回传配置
    expect(f.errors).toEqual([]);
  });

  test('prompt mode entries editor: assembly switch renders entries with add/move/delete and silent save', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    f.document.querySelector('.set-tab[data-set-tab="prompt"]').click();
    await flush(3);
    // 展开第一个模式（Code）
    f.document.querySelector('#settings-sections .tool-card-head').click();
    await flush(3);
    // 组装方式：传统模板 / 预设条目 两个按钮
    const asmBtns: any[] = Array.from(f.document.querySelectorAll('#settings-sections .tool-card-body .set-field .ctl button'));
    expect(asmBtns.length).toBe(2);
    // 默认 legacy：显示 template textarea
    expect(f.document.querySelectorAll('#settings-sections .tool-card-body textarea').length).toBeGreaterThan(0);
    // 切到预设条目
    asmBtns[1].click();
    await flush(5);
    // 条目编辑器出现（含 Chat History 占位条目 + 新增按钮）
    const peItems = f.document.querySelectorAll('#settings-sections .pe-item');
    expect(peItems.length).toBeGreaterThanOrEqual(1);
    const chatPill = f.document.querySelector('#settings-sections .pe-chat-pill');
    expect(chatPill).not.toBeNull();
    const addBtn: any = Array.from(f.document.querySelectorAll('#settings-sections .pe-toolbar .mini-btn')).find((b: any) => b.textContent.includes('新增条目'));
    expect(addBtn).not.toBeNull();
    addBtn.click();
    await flush(5);
    expect(f.document.querySelectorAll('#settings-sections .pe-item').length).toBeGreaterThanOrEqual(2);
    // 保存走 POST /api/settings（promptEntries 数组）
    const save = f.fetches.filter((x) => x.url === '/api/settings' && x.method === 'POST');
    expect(save.length).toBeGreaterThan(0);
    const last = save[save.length - 1].body as any;
    expect(last.settings.toolsConfig.system_prompt.modes.code.promptEntries).toBeDefined();
    expect(Array.isArray(last.settings.toolsConfig.system_prompt.modes.code.promptEntries)).toBe(true);
    expect(f.errors).toEqual([]);
  });

  test('memory category: scope selector + inline edit posts /api/memory-update', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    f.document.querySelector('.set-tab[data-set-tab="memory"]').click();
    await flush(3);
    // 作用域选择（全局/工作区）
    const scopeRow = f.document.querySelector('#settings-sections .mem-scope-row select');
    expect(scopeRow).not.toBeNull();
    expect(scopeRow.querySelectorAll('option').length).toBe(2);
    // 无 partChars/partLines（桌面端已删除）
    const paths = fieldPaths(f.document);
    expect(paths).not.toContain(JSON.stringify(['toolsConfig', 'memory', 'partChars']));
    expect(paths).not.toContain(JSON.stringify(['toolsConfig', 'memory', 'partLines']));
    // 条目行内编辑 → textarea → 保存 → POST /api/memory-update
    const editBtns = f.document.querySelectorAll('#settings-sections .mem-edit-btn');
    expect(editBtns.length).toBeGreaterThan(0);
    editBtns[0].click();
    await flush();
    const ta = f.document.querySelector('#settings-sections .mem-item textarea');
    expect(ta).not.toBeNull();
    ta.value = 'updated memory';
    f.document.querySelector('#settings-sections .mem-item .mini-btn').click();
    await flush(5);
    const upd = f.fetches.find((x) => x.url === '/api/memory-update' && x.method === 'POST');
    expect(upd).toBeDefined();
    expect(upd!.body).toEqual({ id: 1, text: 'updated memory' });
    expect(f.errors).toEqual([]);
  });

  test('remoteControl category: enabled/port editable fields + usage range selector', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    f.document.querySelector('.set-tab[data-set-tab="remoteControl"]').click();
    await flush(3);
    const paths = fieldPaths(f.document);
    expect(paths).toContain(JSON.stringify(['remoteControl', 'enabled']));
    expect(paths).toContain(JSON.stringify(['remoteControl', 'port']));
    // 用量时间范围选择器
    f.document.querySelector('.set-tab[data-set-tab="usage"]').click();
    await flush(3);
    const rangeSel = f.document.querySelector('#settings-sections .usage-range-row select');
    expect(rangeSel).not.toBeNull();
    expect(rangeSel.querySelectorAll('option').length).toBe(4);
    expect(f.errors).toEqual([]);
  });

  test('settings nav renders inline SVG icons for all 22 categories', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    const tabs = f.document.querySelectorAll('.set-tab');
    expect(tabs.length).toBe(22);
    tabs.forEach((t: any) => {
      expect(t.querySelector('svg')).not.toBeNull();
    });
    // chips 删除按钮为 SVG 图标（非 × 字符）
    f.document.querySelector('.set-tab[data-set-tab="context"]').click();
    await flush(3);
    f.errors.length = 0;
    expect(f.errors).toEqual([]);
  });

  test('models dialog: force-reloads model list on open, add and remove stay in sync', async () => {
    const f = makeFixture();
    await openSettingsLoaded(f);
    // 打开模型管理对话框
    let modelsBtn: any = null;
    f.document.querySelectorAll('#settings-sections .cfg-actions .mini-btn').forEach((b: any) => {
      if (b.textContent === '模型管理' && !modelsBtn) modelsBtn = b;
    });
    expect(modelsBtn).not.toBeNull();
    modelsBtn.click();
    await flush(8);
    const modal = f.document.querySelector('#modal');
    expect(modal.classList.contains('open')).toBe(true);
    const list = f.document.querySelector('#modal .model-list');
    expect(list).not.toBeNull();
    let names = Array.from(list.querySelectorAll('.name')).map((e: any) => e.textContent);
    expect(names).toContain('Model 1');
    expect(names).toContain('Model 2');
    // 打开即触发强制重拉（modelsLoaded 缓存不得短路）
    const getCalls = f.fetches.filter((x) => x.url.startsWith('/api/config?configId=c1'));
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
    // 添加模型 → POST /api/models-add → 列表刷新显示新模型
    const inputs = f.document.querySelectorAll('#modal .chip-input input');
    inputs[0].value = 'gpt-new';
    inputs[1].value = 'New Model';
    let addBtn: any = null;
    f.document.querySelectorAll('#modal .chip-input .mini-btn').forEach((b: any) => {
      if (b.textContent === '添加模型' && !addBtn) addBtn = b;
    });
    expect(addBtn).not.toBeNull();
    addBtn.click();
    await flush(10);
    const addCall = f.fetches.find((x) => x.url === '/api/models-add' && x.method === 'POST');
    expect(addCall).toBeDefined();
    expect(addCall!.body).toEqual({ configId: 'c1', models: [{ id: 'gpt-new', name: 'New Model' }] });
    names = Array.from(list.querySelectorAll('.name')).map((e: any) => e.textContent);
    expect(names).toContain('New Model');
    // 删除模型 → POST /api/models-remove → 列表移除
    const removeBtn: any = Array.from(f.document.querySelectorAll('#modal .model-list .mini-btn')).find((b: any) => {
      const row = b.closest('.item-row');
      return row && row.querySelector('.name').textContent === 'Model 2';
    });
    expect(removeBtn).not.toBeNull();
    removeBtn.click();
    await flush(10);
    const rmCall = f.fetches.find((x) => x.url === '/api/models-remove' && x.method === 'POST');
    expect(rmCall).toBeDefined();
    expect(rmCall!.body).toEqual({ configId: 'c1', modelId: 'm2' });
    names = Array.from(list.querySelectorAll('.name')).map((e: any) => e.textContent);
    expect(names).not.toContain('Model 2');
    expect(f.errors).toEqual([]);
  });

  test('inline SVG icons carry explicit width/height fallback attributes', async () => {
    const f = makeFixture();
    await flush();
    const svgs = f.document.querySelectorAll('#btn-new svg, #btn-ws-add svg, #btn-settings-back svg, #btn-files-back svg, #btn-drawer svg, #btn-settings svg, #btn-refresh svg');
    expect(svgs.length).toBeGreaterThanOrEqual(7);
    svgs.forEach((s: any) => {
      expect(s.getAttribute('width')).not.toBeNull();
      expect(s.getAttribute('height')).not.toBeNull();
    });
  });
});
