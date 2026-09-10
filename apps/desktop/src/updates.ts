import { app, shell } from 'electron';
import type { PlatformApplication } from '../../server/src/application';
const releasesPage = 'https://github.com/Komeiji-Shiki/Gray-Code/releases';
interface Release { tag_name: string; name: string; body: string; html_url: string; prerelease: boolean; draft: boolean; assets: Array<{ name: string }> }
export class DesktopUpdates {
  private status: Record<string, any> = { state: 'idle' };
  constructor(private readonly application: PlatformApplication) {}
  async get() {
    const settings = this.application.product.runtimeSettings().getSettings();
    if (this.status.state === 'idle' && settings.checkForUpdates) await this.check();
    return { status: this.status, currentVersion: app.getVersion(), runtime: 'desktop', manualInstall: true };
  }
  async check() {
    try {
      const nightly = this.application.product.runtimeSettings().getSettings().updateChannel === 'nightly';
      const response = await fetch('https://api.github.com/repos/Komeiji-Shiki/Gray-Code/releases?per_page=30', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GrayCode-Desktop' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
      const releases = await response.json() as Release[];
      const release = releases.find(item => !item.draft && (nightly || !item.prerelease) && Array.isArray(item.assets) &&
        item.assets.some(asset => /graycode/i.test(asset.name) && /desktop|win32|windows|setup/i.test(asset.name) && /\.(zip|exe)$/i.test(asset.name)));
      if (!release) this.status = { state: 'unavailable', message: '尚未找到独立桌面版发行包。当前试用版可继续使用。' };
      else {
        const current = app.getVersion().match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
        const version = release.tag_name.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
        const newer = !!version && !!current && version.some((value, index) => value > current[index] && version.slice(0, index).every((prefix, offset) => prefix === current[offset]));
        this.status = newer ? { state: 'updateAvailable', update: { version: release.tag_name, name: release.name, body: release.body, manualInstall: true } }
          : { state: 'upToDate', message: '未发现版本号更高的独立桌面版发行包。' };
      }
    } catch (error) { this.status = { state: 'error', message: `桌面更新检查失败：${String(error)}` }; }
    return { status: this.status, currentVersion: app.getVersion(), manualInstall: true };
  }
  async open() { await shell.openExternal(releasesPage); return { success: true, manual: true, message: '已打开桌面版发布页面，请下载发行包并在退出应用后替换。' }; }
}
