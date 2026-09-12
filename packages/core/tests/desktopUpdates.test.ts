import { app, shell } from 'electron';
import { DesktopUpdates } from '../../../apps/desktop/src/updates';

jest.mock('electron', () => ({ app: { getVersion: jest.fn() }, shell: { openExternal: jest.fn().mockResolvedValue(undefined) } }));

describe('桌面版更新识别', () => {
  let updateChannel: 'stable' | 'nightly';
  let updates: DesktopUpdates;
  let fetchMock: jest.SpyInstance;
  const release = (version: string, extras: Record<string, unknown> = {}) => ({
    tag_name: version, name: version, body: '更新说明', draft: false, prerelease: false,
    assets: [{ name: 'GrayCode-win32-x64.zip' }], ...extras,
  });
  beforeEach(() => {
    updateChannel = 'stable';
    (app.getVersion as jest.Mock).mockReturnValue('2.0.0-pre');
    updates = new DesktopUpdates({ product: { runtimeSettings: () => ({ getSettings: () => ({ checkForUpdates: true, updateChannel }) }) } } as any);
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => { fetchMock.mockRestore(); jest.clearAllMocks(); });
  const respond = (releases: unknown[]) => fetchMock.mockImplementation(async () => new Response(JSON.stringify(releases)));

  test('同号正式版可更新预览版，构建元数据不影响比较', async () => {
    respond([release('v2.0.0+build.2')]);
    expect((await updates.get()).status).toMatchObject({ state: 'updateAvailable', update: { version: '2.0.0+build.2', tagName: 'v2.0.0+build.2' } });
    (app.getVersion as jest.Mock).mockReturnValue('2.0.0+build.1');
    expect((await updates.check()).status.state).toBe('upToDate');
  });

  test('稳定渠道跳过预发布、草稿和仅有扩展资产的版本，并选择最高桌面版本', async () => {
    respond([release('v2.0.1'), release('v2.3.0-pre', { prerelease: true }), release('v2.4.0-pre'),
      release('v2.5.0', { draft: true }), release('v2.6.0', { assets: [{ name: 'graycode-2.6.0.vsix' }] }), release('v2.1.0')]);
    expect((await updates.check()).status.update.version).toBe('2.1.0');
  });

  test('预览渠道按数字标识符比较预发布，不受发布列表顺序影响', async () => {
    updateChannel = 'nightly'; (app.getVersion as jest.Mock).mockReturnValue('2.0.0-rc.2');
    respond([release('v2.0.0-rc.3', { prerelease: true }), release('v2.0.0-rc.10', { prerelease: true })]);
    expect((await updates.check()).status.update.version).toBe('2.0.0-rc.10');
  });

  test('固定 nightly 标签读取真实构建版本，沿用仓库的夜间版排序规则', async () => {
    updateChannel = 'nightly'; (app.getVersion as jest.Mock).mockReturnValue('2.0.0');
    respond([release('nightly', { name: 'GrayCode v2.0.0-nightly.20260912', prerelease: true })]);
    expect((await updates.check()).status.update).toMatchObject({ version: '2.0.0-nightly.20260912', tagName: 'nightly' });
  });

  test('没有明确版本的桌面资产报告不可用，网络错误单独报告', async () => {
    updateChannel = 'nightly'; respond([release('nightly', { name: 'GrayCode Nightly', prerelease: true })]);
    expect((await updates.check()).status.state).toBe('unavailable');
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    expect((await updates.check()).status).toMatchObject({ state: 'error', message: expect.stringContaining('503') });
  });

  test('打开发布页面继续使用手动下载流程', async () => {
    expect(await updates.open()).toMatchObject({ success: true, manual: true });
    expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/Komeiji-Shiki/Gray-Code/releases');
  });
});
