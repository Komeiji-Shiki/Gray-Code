import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { SkillExportData } from '../../../../backend/modules/settings/SettingsExporter';
import type { PlatformApplication } from '../application';

export interface SkillResourceFile { path: string; data: string; sha256: string; executable?: boolean }
export interface SkillBundle { version: 1; files: SkillResourceFile[] }
export interface PlatformSkillExport extends SkillExportData { resources?: SkillBundle }
export interface SavedPlatformSkill extends SkillExportData { bundleId?: string }
const maxBundleBytes = 32 * 1024 * 1024;
const maxBundleFiles = 2048;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function resourcePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\\') || value.split('/').some(part =>
    !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('技能资源包含不支持或越界的路径。');
  return value;
}

/** 资源包是数据；导入时不执行脚本，也不展开到现有用户技能目录。 */
export function validateSkillBundle(value: unknown): SkillBundle {
  const input = value as SkillBundle;
  if (!input || input.version !== 1 || !Array.isArray(input.files) || input.files.length > maxBundleFiles)
    throw new Error('技能资源包格式无效或文件数量超过 2048。');
  const names = new Set<string>();
  let bytes = 0;
  const files = input.files.map(file => {
    const name = resourcePath(file?.path);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`技能资源路径重复：${name}`);
    names.add(key);
    if (typeof file.data !== 'string' || file.data.length > Math.ceil(maxBundleBytes / 3) * 4)
      throw new Error(`技能资源编码无效：${name}`);
    const content = Buffer.from(file.data, 'base64');
    if (content.toString('base64') !== file.data) throw new Error(`技能资源编码无效：${name}`);
    bytes += content.length;
    if (bytes > maxBundleBytes) throw new Error('单个技能的资源总量超过 32 MiB。');
    if (digest(content) !== file.sha256) throw new Error(`技能资源校验失败：${name}`);
    return { path: name, data: file.data, sha256: file.sha256, ...(file.executable === true ? { executable: true } : {}) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const name of names) {
    const parts = name.split('/');
    while (parts.length > 1) { parts.pop(); if (names.has(parts.join('/'))) throw new Error('技能资源的文件和目录路径冲突。'); }
  }
  if (!names.has('skill.md')) throw new Error('技能资源包缺少 SKILL.md。');
  return { version: 1, files };
}

export const skillBundleId = (bundle: SkillBundle) => digest(JSON.stringify(bundle));

export async function collectSkillBundle(directory: string): Promise<SkillBundle> {
  const root = await fs.realpath(directory);
  const files: SkillResourceFile[] = [];
  let bytes = 0;
  async function visit(relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = resourcePath(relative ? `${relative}/${entry.name}` : entry.name);
      if (entry.isSymbolicLink()) throw new Error(`技能包含符号链接，无法完整打包：${name}`);
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!entry.isFile()) throw new Error(`技能包含不支持的文件：${name}`);
      const file = await fs.open(path.join(root, name), 'r');
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size + bytes > maxBundleBytes || files.length >= maxBundleFiles)
          throw new Error('单个技能超过 32 MiB 或 2048 个文件的打包限制。');
        const content = await file.readFile();
        const after = await file.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`导出期间技能文件发生变化，请重试：${name}`);
        bytes += content.length;
        files.push({ path: name, data: content.toString('base64'), sha256: digest(content), ...(before.mode & 0o111 ? { executable: true } : {}) });
      } finally { await file.close(); }
    }
  }
  await visit('');
  return validateSkillBundle({ version: 1, files });
}

export class SkillBundleStore {
  private readonly materializing = new Map<string, Promise<string>>();
  constructor(private readonly app: PlatformApplication) {}
  async read(id: string): Promise<SkillBundle> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('技能资源标识无效。');
    const bundle = await this.app.storage.getRecord('skill-bundles', id) as SkillBundle | null;
    if (!bundle) throw new Error('技能附属资源不存在，请重新导入原设置文件。');
    return bundle;
  }
  materialize(id: string): Promise<string> {
    const running = this.materializing.get(id);
    if (running) return running;
    const operation = this.restore(id).catch(error => { this.materializing.delete(id); throw error; });
    this.materializing.set(id, operation);
    return operation;
  }
  private async restore(id: string): Promise<string> {
    const bundle = validateSkillBundle(await this.read(id));
    if (skillBundleId(bundle) !== id) throw new Error('技能资源包标识与内容不一致。');
    const parent = path.join(this.app.storage.directory, 'skill-resources');
    const destination = path.join(parent, id);
    // 本次服务启动后首次读取时确认已恢复文件的内容，避免把后来修改的脚本当作导入原件。
    try {
      let unchanged = !(await fs.lstat(destination)).isSymbolicLink();
      for (const file of unchanged ? bundle.files : []) {
        const target = path.join(destination, file.path);
        const real = await fs.realpath(target);
        const relative = path.relative(await fs.realpath(destination), real);
        if (path.isAbsolute(relative) || /^\.\.([\\/]|$)/.test(relative) || digest(await fs.readFile(target)) !== file.sha256) unchanged = false;
      }
      if (unchanged) return destination;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // 新目录完整写好后才发布；已有修改保留为独立版本，不覆盖用户编辑。
    await fs.mkdir(parent, { recursive: true });
    const temporary = path.join(parent, `${id}-${randomUUID()}`);
    await fs.mkdir(temporary);
    for (const file of bundle.files) {
      const target = path.join(temporary, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
    }
    try { await fs.rename(temporary, destination); return destination; }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      return temporary;
    }
  }
}
