/**
 * 远程控制移动端 UI 模板完整性测试（V4）
 *
 * 校验 renderRemoteControlUiHtml 输出的自包含页面：
 * - 三语言（zh-CN/en/ja）均能渲染，文案键集合一致且无空值；
 * - 内嵌 T 文案 JSON 可解析（JSON.stringify + \u003c 转义不破坏结构）；
 * - 页面包含三个页签与关键 API 端点（与 RemoteControlServer 路由保持一致）；
 * - V4 错误边界：HTML 含 error-banner 元素，脚本所有 $('id') 引用都能在 HTML 找到；
 * - V4 i18n 契约：脚本中 t('...') / t: / renderSimpleSection / secCard / labelKey
 *   引用的全部 key 在 UI_TEXTS 三语言中都存在；
 * - 无外部资源依赖（零外链）与 script/style 闭合结构完整。
 */

import { renderRemoteControlUiHtml, UI_TEXTS } from '../../../backend/modules/remoteControl/remoteControlUi';

/** 从渲染产物中取出内嵌脚本文本 */
function scriptOf(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  return m ? m[1] : '';
}

/** 收集脚本中引用的全部 i18n key（t('...') / { t: '...' } / renderSimpleSection / secCard / labelKey） */
function i18nKeysOf(script: string): Set<string> {
  const keys = new Set<string>();
  const collect = (re: RegExp): void => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(script)) !== null) keys.add(m[1]);
  };
  // (?<=^|[^A-Za-z0-9_]) 排除 split('|') 与 toast('...') 的误匹配（t 前有词字符）
  collect(/(?:^|[^A-Za-z0-9_])t\('([^']+)'\)/g);
  collect(/\bt: '([^']+)'/g);
  collect(/renderSimpleSection\('([^']+)'/g);
  collect(/secCard\('([^']+)'/g);
  collect(/labelKey: '([^']+)'/g);
  return keys;
}

/** 服务器 handleRequest 支持的端点（路由白名单，模板引用的端点必须落在此集合内） */
const SERVER_ENDPOINTS = new Set([
  '/api/status',
  '/api/conversations',
  '/api/messages',
  '/api/workspace',
  '/api/workspaces',
  '/api/workspace-switch',
  '/api/files',
  '/api/file',
  '/api/open-file',
  '/api/configs',
  '/api/config',
  '/api/config-create',
  '/api/config-update',
  '/api/config-delete',
  '/api/model',
  '/api/models-add',
  '/api/models-remove',
  '/api/models-get',
  '/api/prompt-modes',
  '/api/send',
  '/api/cancel',
  '/api/retry',
  '/api/delete-message',
  '/api/tool-confirm',
  '/api/rename',
  '/api/workspace-add',
  '/api/workspace-remove',
  '/api/conversation-delete',
  '/api/edit-message',
  '/api/reroll',
  '/api/fs',
  '/api/settings',
  '/api/tools',
  '/api/dependencies',
  '/api/channel-toggle',
  '/api/channel-active',
  '/api/remote-action',
  '/api/stream'
]);

describe('remoteControlUi', () => {
  test('renders for all supported languages', () => {
    for (const lang of ['zh-CN', 'en', 'ja']) {
      const html = renderRemoteControlUiHtml(lang);
      expect(html).toContain('<html lang="' + lang + '">');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html.length).toBeGreaterThan(10000);
    }
  });

  test('falls back to zh-CN for unsupported languages', () => {
    const html = renderRemoteControlUiHtml('fr');
    expect(html).toContain('<html lang="zh-CN">');
    expect(renderRemoteControlUiHtml(null)).toContain('<html lang="zh-CN">');
  });

  test('UI_TEXTS key sets are identical across all languages with non-empty values', () => {
    const langs = Object.keys(UI_TEXTS) as Array<keyof typeof UI_TEXTS>;
    expect(langs).toEqual(['zh-CN', 'en', 'ja']);
    const keys = Object.keys(UI_TEXTS['zh-CN']).sort();
    for (const lang of langs) {
      expect(Object.keys(UI_TEXTS[lang]).sort()).toEqual(keys);
      for (const key of keys) {
        expect(UI_TEXTS[lang][key as keyof typeof UI_TEXTS['zh-CN']].length).toBeGreaterThan(0);
      }
    }
  });

  test('embedded T texts JSON is parseable (no broken escaping)', () => {
    const html = renderRemoteControlUiHtml('en');
    const match = html.match(/var T = (\{.*?\});\n/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]);
    expect(parsed.tabChat).toBe('Chat');
    expect(parsed.approve).toBe('Approve');
  });

  test('template contains all three tabs', () => {
    const html = renderRemoteControlUiHtml('en');
    expect(html).toContain('data-tab="chat"');
    expect(html).toContain('data-tab="files"');
    expect(html).toContain('data-tab="settings"');
  });

  test('template contains conversation tab strip (multi-conversation) and settings pagination', () => {
    const html = renderRemoteControlUiHtml('en');
    // 会话页签条（多对话并行）
    expect(html).toContain('id="tabs-bar"');
    expect(html).toContain('id="conv-tabs"');
    expect(html).toContain('function renderTabsBar()');
    expect(html).toContain('function newChatTab()');
    expect(html).toContain('function closeTab(key)');
    // 设置分页：分类页签条 + 20 个分类（对齐桌面端 SettingsPanel 侧栏）
    expect(html).toContain('id="settings-tabs"');
    expect(html).toContain('function renderSettingsTabs()');
    expect(html).toContain('var SETTINGS_CATEGORIES');
    expect(html).toContain("{ key: 'channel', labelKey: 'secChannel' }");
    expect(html).toContain("{ key: 'remoteControl', labelKey: 'secRemote' }");
    expect(html).toContain("{ key: 'dependencies', labelKey: 'secDeps' }");
    expect((html.match(/\{ key: '[A-Za-z]+', labelKey: '/g) || []).length).toBe(20);
    // 输入区渠道/模型选择（桌面端 ChannelSelector 同款）
    expect(html).toContain('id="composer-meta"');
    expect(html).toContain('function renderComposerMeta()');
    expect(html).toContain('id="sheet-model-mode"');
  });

  test('HTML contains error-banner element (V4 error boundary is wired)', () => {
    const html = renderRemoteControlUiHtml('zh-CN');
    expect(html).toContain('<div id="error-banner" hidden></div>');
  });

  test("every $('id') reference in script resolves to an element in the HTML", () => {
    const html = renderRemoteControlUiHtml('zh-CN');
    const script = scriptOf(html);
    const refs = new Set<string>();
    let m: RegExpExecArray | null;
    const reRef = /\$\('([^']+)'\)/g;
    while ((m = reRef.exec(script)) !== null) refs.add(m[1]);
    const ids = new Set<string>();
    const reId = /id="([^"]+)"/g;
    while ((m = reId.exec(html)) !== null) ids.add(m[1]);
    expect(refs.size).toBeGreaterThan(20);
    for (const ref of refs) {
      expect(ids.has(ref)).toBe(true);
    }
  });

  test('all i18n keys referenced by script exist in UI_TEXTS for every language', () => {
    const langs = Object.keys(UI_TEXTS) as Array<keyof typeof UI_TEXTS>;
    const script = scriptOf(renderRemoteControlUiHtml('zh-CN'));
    const keys = i18nKeysOf(script);
    expect(keys.size).toBeGreaterThan(100);
    for (const lang of langs) {
      const dict = new Set(Object.keys(UI_TEXTS[lang]));
      const missing = [...keys].filter((k) => !dict.has(k));
      expect(missing).toEqual([]);
    }
  });

  test('template contains global [hidden] override (fix: loading overlay blocked conversation)', () => {
    const html = renderRemoteControlUiHtml('zh-CN');
    // 关键修复回归：author 样式 display:flex 覆盖 hidden 属性的历史故障——
    // #messages/#empty/#file-viewer 必须被 [hidden] 全局规则兜底压掉
    expect(html).toContain('[hidden] { display: none !important; }');
    // 三者自身仍是 flex 容器（可见时布局不变）
    expect(html).toContain('#messages {');
    expect(html).toContain('#empty {');
    expect(html).toContain('#file-viewer {');
  });

  test('streamChunkBatch array handling present (batched chunks must not be dropped)', () => {
    const html = renderRemoteControlUiHtml('zh-CN');
    expect(html).toContain('var chunks = Array.isArray(d) ? d : [d];');
    expect(html).toContain('chunks.forEach(function (c) { processChunk(c, tab); });');
  });

  test('new settings i18n keys exist in all languages', () => {
    const langs = Object.keys(UI_TEXTS) as Array<keyof typeof UI_TEXTS>;
    for (const lang of langs) {
      expect(UI_TEXTS[lang].secChannel.length).toBeGreaterThan(0);
      expect(UI_TEXTS[lang].secRemote.length).toBeGreaterThan(0);
      expect(UI_TEXTS[lang].loadMore.length).toBeGreaterThan(0);
      expect(UI_TEXTS[lang].closeTab.length).toBeGreaterThan(0);
      expect(UI_TEXTS[lang].emptyNewChat.length).toBeGreaterThan(0);
      expect(UI_TEXTS[lang].modelSelect.length).toBeGreaterThan(0);
    }
  });

  test('send button icon is injected at boot (icon must never be missing)', () => {
    const html = renderRemoteControlUiHtml('en');
    // 发送键初始必须渲染图标：脚本内置发送/停止 SVG 常量，并在 boot 时立即调用
    expect(html).toContain('var ICON_SEND = \'<svg');
    expect(html).toContain('var ICON_STOP = \'<svg');
    expect(html).toContain('function renderSendIcon()');
    expect(html).toContain('renderSendIcon();');
  });

  test('template contains conversation drawer and message action sheet', () => {
    const html = renderRemoteControlUiHtml('en');
    expect(html).toContain('id="drawer"');
    expect(html).toContain('id="drawer-list"');
    expect(html).toContain('id="action-sheet"');
    expect(html).toContain('id="btn-drawer"');
  });

  test('every API endpoint referenced in template exists on server route whitelist', () => {
    const html = renderRemoteControlUiHtml('en');
    const refs = new Set<string>();
    const re = /\/api\/[a-z-]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      refs.add(m[0]);
    }
    refs.add('/api/stream');
    for (const ref of refs) {
      expect(SERVER_ENDPOINTS.has(ref)).toBe(true);
    }
  });

  test('zero external dependencies: no http(s) links to third parties in page assets', () => {
    const html = renderRemoteControlUiHtml('zh-CN');
    // 允许的链接仅限 markdown 渲染出的示例与同源 API 调用；页面自身不得加载外站资源
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('href="http');
  });

  test('script/style blocks are well-formed', () => {
    const html = renderRemoteControlUiHtml('zh-CN');
    const scriptTags = html.split('<script>').length - 1;
    const scriptCloses = html.split('</script>').length - 1;
    const styleTags = html.split('<style>').length - 1;
    const styleCloses = html.split('</style>').length - 1;
    expect(scriptTags).toBe(1);
    expect(scriptCloses).toBe(1);
    expect(styleTags).toBe(1);
    expect(styleCloses).toBe(1);
  });

  test('UI texts injection escapes < to prevent HTML injection via translations', () => {
    // texts 序列化时 `<` 被替换为 \u003c；页面里不应出现从 T 注入的原始 `<`
    const html = renderRemoteControlUiHtml('en');
    const tBlock = html.match(/var T = \{.*?\};/);
    expect(tBlock![0]).not.toContain('"<');
    expect(tBlock![0]).not.toContain('</');
  });
});
