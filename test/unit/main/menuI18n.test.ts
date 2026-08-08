/**
 * menuI18n.test.ts - 主进程菜单/对话框文案字典一致性测试
 *
 * 覆盖：三语言（zh-CN / en / ja）条目完整性、语言归一化映射、
 * 缺失键回退行为（与前后端 t() 的缺失回退语义一致）。
 */

import { menuLabel, resolveMenuLang, menuI18nCompleteness } from '../../../electron-app/src/menu-i18n';

describe('menu-i18n 字典完整性', () => {
  it('全部菜单 key 在 zh-CN / en / ja 三种语言下都有非空文案', () => {
    const { missing } = menuI18nCompleteness();
    expect(missing).toEqual([]);
  });

  it('常见菜单 key 的三语言文案正确', () => {
    expect(menuLabel('menuFile', 'zh-CN')).toBe('文件');
    expect(menuLabel('menuFile', 'en')).toBe('File');
    expect(menuLabel('menuFile', 'ja')).toBe('ファイル');
    expect(menuLabel('openWorkspaceFolder', 'zh-CN')).toBe('打开工作区文件夹…');
    expect(menuLabel('selectAll', 'en')).toBe('Select All');
    expect(menuLabel('developerTools', 'ja')).toBe('開発者ツール');
  });

  it('缺失 key 原样返回（与 t() 缺失回退行为一致，不抛异常）', () => {
    expect(menuLabel('menu.doesNotExist', 'zh-CN')).toBe('menu.doesNotExist');
  });
});

describe('resolveMenuLang 语言归一化', () => {
  it('精确匹配三种语言', () => {
    expect(resolveMenuLang('zh-CN')).toBe('zh-CN');
    expect(resolveMenuLang('en')).toBe('en');
    expect(resolveMenuLang('ja')).toBe('ja');
  });

  it('zh 系 / ja 系 / 其它 locale 归一到对应语言', () => {
    expect(resolveMenuLang('zh-TW')).toBe('zh-CN');
    expect(resolveMenuLang('zh')).toBe('zh-CN');
    expect(resolveMenuLang('ja-JP')).toBe('ja');
    expect(resolveMenuLang('de-DE')).toBe('en');
    expect(resolveMenuLang('fr')).toBe('en');
  });

  it('空值/未定义回退英文（与缺失 locale 的保守策略一致）', () => {
    expect(resolveMenuLang('')).toBe('en');
    expect(resolveMenuLang(undefined)).toBe('en');
  });

  it('auto 由调用方回退后再归一：本函数对 auto 回退英文（防御）', () => {
    expect(resolveMenuLang('auto')).toBe('en');
  });
});
