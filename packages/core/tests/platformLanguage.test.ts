import * as i18n from '../../../backend/i18n';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

const descriptions = (app: PlatformApplication) => Object.fromEntries(app.tools.declarations().map(tool => [tool.name, tool.description]));

function expectLanguage(app: PlatformApplication, language: 'zh-CN' | 'en') {
  const tools = descriptions(app);
  const english = language === 'en';
  expect(i18n.getActualLanguage()).toBe(language);
  expect(i18n.t('modules.diff.previewNotFound')).toBe(english
    ? 'The change preview is unavailable. Refresh the current task.'
    : '修改预览不存在，请刷新当前任务。');
  expect(tools.read_file).toContain(english ? 'Read one or more files' : '读取工作区中的一个或多个文件');
  expect(tools.write_file).toContain(english ? 'Create a new file' : '创建新文件');
  expect(tools.get_symbols).toContain(english ? 'Get a symbol outline' : '获取一个或多个文件的符号提纲');
  expect(tools.office_read).toContain(english ? 'Read local Word' : '读取本地 Word');
  expect(tools.crop_image).toContain(english ? 'Crop using' : '裁切');
  expect(tools.execute_command).toContain(english ? 'Use terminal_task' : '返回的 taskId 交给 terminal_task');
  expect(tools.read_skill).toContain(english
    ? 'Read the full content of a skill available to the current task by name.'
    : '按名称读取当前任务可用技能的完整正文');
  expect(app.tools.declarations().find(tool => tool.name === 'read_skill')).toMatchObject({
    parameters: { properties: { name: { description: english
      ? 'Skill name; omit it to list skills available to the current task.'
      : '技能名称；省略时列出当前可用技能。' } } },
  });
  return tools;
}

afterEach(() => { jest.restoreAllMocks(); i18n.setLanguage('zh-CN'); i18n.setDetectedLanguage('zh-CN'); });

test('公共夹具保持空库，未传 locale 的平台启动沿用默认检测语言', async () => {
  const f = await fixture();
  expect(await f.store.getRecord('product-settings', 'main')).toBeNull();
  await f.store.close();
  const detected = jest.spyOn(i18n, 'setDetectedLanguage');
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  try {
    expect(detected).not.toHaveBeenCalled();
    expectLanguage(app, 'zh-CN');
  } finally { await app.close(); await f.cleanup(); }
});

test('启动按宿主 locale 检测语言，重启时已保存的语言优先于宿主语言', async () => {
  const f = await fixture(); await f.store.close();
  let app = await PlatformApplication.open({ dataDirectory: f.data, locale: 'en-US' });
  try {
    expect(i18n.getLanguage()).toBe('auto'); expectLanguage(app, 'en');
    const draft = await app.product.draft(); await draft.settings.updateUISettings({ language: 'en' });
    await app.product.save(draft);
    await app.close();
    app = await PlatformApplication.open({ dataDirectory: f.data, locale: 'zh-CN' });
    expect(i18n.getLanguage()).toBe('en'); expectLanguage(app, 'en');
  } finally { await app.close(); await f.cleanup(); }
});

test('保存语言先同步译文和工具说明，同语言保存保持仅随语言变化的工具实例', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data, locale: 'zh-CN' });
  try {
    const chinese = expectLanguage(app, 'zh-CN');
    const captured = app.tools.catalog(['read_file', 'get_symbols', 'office_read', 'read_skill']);
    const setLanguage = jest.spyOn(i18n, 'setLanguage');
    const published: Array<{ language: string; readFile: string }> = [];
    app.subscribe(event => {
      if (event.type === 'settings.changed') published.push({ language: i18n.getActualLanguage(), readFile: descriptions(app).read_file });
    });
    const changeLanguage = async (language: 'zh-CN' | 'en') => {
      const draft = await app.product.draft(); await draft.settings.updateUISettings({ language });
      await app.product.save(draft);
    };
    await changeLanguage('en');
    const english = expectLanguage(app, 'en');
    expect(published.at(-1)).toEqual({ language: 'en', readFile: english.read_file });
    expect(captured.declarations.find(tool => tool.name === 'read_file')?.description).toBe(chinese.read_file);
    const unchanged = app.tools.catalog(['read_file', 'get_symbols', 'office_read', 'read_skill']);
    setLanguage.mockClear();
    await changeLanguage('en');
    expect(setLanguage).not.toHaveBeenCalled();
    const current = app.tools.catalog(['read_file', 'get_symbols', 'office_read', 'read_skill']);
    for (const name of unchanged.entries.keys()) expect(current.entries.get(name)?.tool).toBe(unchanged.entries.get(name)?.tool);
    await changeLanguage('zh-CN');
    expect(setLanguage).toHaveBeenCalledWith('zh-CN');
    expectLanguage(app, 'zh-CN');
    expect(published.at(-1)).toEqual({ language: 'zh-CN', readFile: chinese.read_file });
  } finally { await app.close(); await f.cleanup(); }
});
