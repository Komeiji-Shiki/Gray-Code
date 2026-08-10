/**
 * 远程控制移动端 UI 模板完整性测试
 *
 * 校验 renderRemoteControlUiHtml 输出的自包含页面：
 * - 三语言（zh-CN/en/ja）均能渲染，文案键集合一致且无空值；
 * - 内嵌 T 文案 JSON 可解析（JSON.stringify + \u003c 转义不破坏结构）；
 * - 页面包含三个页签与关键 API 端点（与 RemoteControlServer 路由保持一致）；
 * - 无外部资源依赖（零外链）与 script/style 闭合结构完整。
 */

import { renderRemoteControlUiHtml, UI_TEXTS } from '../../../backend/modules/remoteControl/remoteControlUi';

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
  '/api/model',
  '/api/send',
  '/api/cancel',
  '/api/retry',
  '/api/delete-message',
  '/api/tool-confirm',
  '/api/rename',
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
