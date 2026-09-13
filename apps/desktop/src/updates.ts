import { app, shell } from 'electron';
import type { PlatformApplication } from '../../server/src/application';
import { compareVersions, extractNightlyVersionFromName, stripVersionPrefix } from '../../../shared/updateVersion';
import type { DesktopInstaller } from './installer';
const releasesPage = 'https://github.com/Komeiji-Shiki/Gray-Code/releases';
interface Release { tag_name: string; name: string; body: string; html_url: string; prerelease: boolean; draft: boolean; assets: Array<{ name: string; browser_download_url?: string }> }
function releaseVersion(release: Release): string | null {
  if (typeof release.tag_name !== 'string') return null;
  const version = stripVersionPrefix(release.tag_name);
  if (/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(version)) return version;
  return /^nightly(?:-\d{8})?$/.test(version) ? extractNightlyVersionFromName(release.name) : null;
}
export class DesktopUpdates {
  private status: Record<string, any> = { state: 'idle' };
  private source?: { url: string; version: string };
  constructor(private readonly application: PlatformApplication, private readonly installer?: DesktopInstaller) {}
  private async result() {
    const installation = await this.installer?.status();
    return { status: this.status, currentVersion: app.getVersion(), runtime: 'desktop', installation, manualInstall: !this.source || installation?.kind !== 'installed' };
  }
  async get() {
    const settings = this.application.product.runtimeSettings().getSettings();
    if (this.status.state === 'idle' && settings.checkForUpdates) await this.check();
    return this.result();
  }
  async check() {
    this.source = undefined;
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
        const manifest = release.assets.find(asset => asset.name === 'releases.win-x64.json');
        if (manifest?.browser_download_url) {
          const address = new URL(manifest.browser_download_url);
          if (address.origin === 'https://github.com' && address.pathname.startsWith('/Komeiji-Shiki/Gray-Code/releases/download/')
            && address.pathname.endsWith('/releases.win-x64.json'))
            this.source = { url: address.href.slice(0, address.href.lastIndexOf('/') + 1), version };
        }
        this.status = compareVersions(version, app.getVersion()) > 0
          ? { state: 'updateAvailable', update: { version, tagName: release.tag_name, name: release.name, body: release.body, manualInstall: !this.source } }
          : { state: 'upToDate', message: '未发现版本号更高的独立桌面版发行包。' };
      }
    } catch (error) { this.status = { state: 'error', message: `桌面更新检查失败：${String(error)}` }; }
    return this.result();
  }
  async prepare(refresh = false) {
    if (refresh || this.status.state === 'idle') await this.check();
    if (this.status.state === 'error') throw new Error(this.status.message);
    if (this.status.state === 'upToDate') return { success: true, alreadyUpToDate: true };
    if (!this.source || (await this.installer?.status())?.kind !== 'installed') return this.open();
    return this.installer!.prepare(this.source.url, this.source.version);
  }
  async open() { await shell.openExternal(releasesPage); return { success: true, manual: true, message: '已打开桌面版发布页面，请下载发行包并在退出应用后替换。' }; }
}
