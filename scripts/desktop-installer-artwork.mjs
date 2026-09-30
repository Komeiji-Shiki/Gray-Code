import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { loadBackendPacks } from './i18n-sync.mjs';

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
/** 安装器尚未读取用户主题，使用固定品牌底图；实际进度由原生安装器负责。 */
export async function createDesktopInstallerArtwork({ version, icon, output, language = 'zh-CN' }) {
  const locale = language.startsWith('ja') ? 'ja' : language.startsWith('en') ? 'en' : 'zh-CN';
  const labels = loadBackendPacks()[locale].desktop.installerArtwork;
  const mark = await sharp(Buffer.from((await readFile(icon, 'utf8')).replaceAll('currentColor', '#c7c3bd'))).resize(148, 148).png().toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="360" viewBox="0 0 680 360">
<rect width="680" height="360" fill="#19191b"/><rect x=".5" y=".5" width="679" height="359" fill="none" stroke="#343437"/>
<path d="M40 80V48H72 M608 312H640V280" fill="none" stroke="#c9927c" stroke-width="2"/>
<path d="M440 72V264 M40 280H640" fill="none" stroke="#343437"/>
<g font-family="Segoe UI,Microsoft YaHei,Yu Gothic,Arial,sans-serif"><text x="48" y="116" fill="#a9a6a2" font-size="12" letter-spacing="2">${escape(labels.tagline)}</text>
<text x="46" y="175" fill="#e9e6e0" font-size="48" font-weight="600">GrayCode</text>
<text x="48" y="214" fill="#b5b0aa" font-size="14">${escape(labels.intro)}</text>
<text x="48" y="313" fill="#b5b0aa" font-size="12">${escape(labels.progress)}</text>
<text x="624" y="309" text-anchor="end" fill="#b5b0aa" font-size="12">${escape(version)}</text></g>
<image x="478" y="74" width="148" height="148" href="data:image/png;base64,${mark.toString('base64')}"/>
</svg>`;
  await mkdir(path.dirname(output), { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(output);
  return output;
}
