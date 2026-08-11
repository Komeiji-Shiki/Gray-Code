/**
 * 远程控制 UI 渲染冒烟测试（V4）
 *
 * 校验 renderRemoteControlUiHtml 输出的自包含页面脚本语法有效：
 * - 脚本可用 Function 构造器解析（防模板转义泄漏导致运行时 SyntaxError）；
 * - 模板插值仅出现在预期位置（无意外 ${ 泄漏）。
 */
import { renderRemoteControlUiHtml } from '../../../backend/modules/remoteControl/remoteControlUi';

describe('remote UI smoke', () => {
  test('renders and script parses as valid JS', () => {
    const html = renderRemoteControlUiHtml('zh-CN');
    expect(html.length).toBeGreaterThan(100000);
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const script = m![1];
    expect(() => new Function(script)).not.toThrow();
    expect(script).not.toContain('\\${');
  });

  test('uiLang interpolation works for all languages', () => {
    for (const lang of ['zh-CN', 'en', 'ja']) {
      const html = renderRemoteControlUiHtml(lang);
      expect(html).toContain('<html lang="' + lang + '">');
    }
  });
});
