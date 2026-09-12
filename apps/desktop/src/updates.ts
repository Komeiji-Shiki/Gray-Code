import { app, shell } from 'electron';
import type { PlatformApplication } from '../../server/src/application';
import { compareVersions, extractNightlyVersionFromName, stripVersionPrefix } from '../../../shared/updateVersion';
const releasesPage = 'https://github.com/Komeiji-Shiki/Gray-Code/releases';
interface Release { tag_name: string; name: string; body: string; html_url: string; prerelease: boolean; draft: boolean; assets: Array<{ name: string }> }
function releaseVersion(release: Release): string | null {
  if (typeof release.tag_name !== 'string') return null;
  const version = stripVersionPrefix(release.tag_name);
  if (/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(version)) return version;
  return /^nightly(?:-\d{8})?$/.test(version) ? extractNightlyVersionFromName(release.name) : null;
}
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
      // 发布时间不一定按版本号排列；只比较当前渠道中带桌面包的明确版本。
      const candidates = releases.flatMap(release => {
        const version = releaseVersion(release);
        if (!version || release.draft || !nightly && (release.prerelease || version.split('+', 1)[0].includes('-'))) return [];
        if (!Array.isArray(release.assets) || !release.assets.some(asset => /graycode/i.test(asset.name)
          && /desktop|win32|windows|setup/i.test(asset.name) && /\.(zip|exe)$/i.test(asset.name))) return [];
        return [{ release, version }];
      }).sort((a, b) => compareVersions(b.version, a.version));
      const latest = candidates[0];
      if (!latest) this.status = { state: 'unavailable', message: '尚未找到当前渠道中版本号明确的独立桌面版发行包。' };
      else {
        const { release, version } = latest;
        this.status = compareVersions(version, app.getVersion()) > 0
          ? { state: 'updateAvailable', update: { version, tagName: release.tag_name, name: release.name, body: release.body, manualInstall: true } }
          : { state: 'upToDate', message: '未发现版本号更高的独立桌面版发行包。' };
      }
    } catch (error) { this.status = { state: 'error', message: `桌面更新检查失败：${String(error)}` }; }
    return { status: this.status, currentVersion: app.getVersion(), manualInstall: true };
  }
  async open() { await shell.openExternal(releasesPage); return { success: true, manual: true, message: '已打开桌面版发布页面，请下载发行包并在退出应用后替换。' }; }
}
