import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { MigrationIssue } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { SkillsRuntime } from '../../../../backend/modules/skills/SkillsRuntime';
import { collectSkillBundle, skillBundleId } from './bundles';

export interface SkillImportReport { imported: string[]; skipped: string[]; consumed: string[]; issues: MigrationIssue[] }

/** 仅处理选定旧存储中的 skills 目录，不扫描用户目录或其他工作区。 */
export async function importLegacySkills(app: PlatformApplication, actorId: string, root: string, signal: AbortSignal): Promise<SkillImportReport> {
  app.requireOwner(actorId);
  const report: SkillImportReport = { imported: [], skipped: [], consumed: [], issues: [] };
  const directory = path.join(root, 'skills');
  let entries;
  try {
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('技能目录是符号链接，未读取外部来源。');
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report.issues.push({ path: directory, code: 'IO_ERROR', message: String(error) });
    return report;
  }
  const parser = new SkillsRuntime({ globalStoragePath: root, includeUserSkills: false });
  for (const entry of entries) {
    signal.throwIfAborted();
    const source = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) { report.issues.push({ path: source, code: 'IO_ERROR', message: '技能包含符号链接，未读取外部来源。' }); continue; }
    if (!entry.isDirectory()) continue;
    try {
      if (!SkillsRuntime.validateSkillId(entry.name)) throw new Error('技能目录名称不符合原技能格式。');
      const bundle = await collectSkillBundle(source);
      signal.throwIfAborted();
      const markdown = bundle.files.find(file => file.path.toLowerCase() === 'skill.md')!;
      const skill = parser.parseSkillText(entry.name, Buffer.from(markdown.data, 'base64').toString('utf8'), path.join(source, markdown.path), 'legacy');
      if (!skill) throw new Error('SKILL.md 的名称、说明或正文格式无法解析。');
      const bundleId = skillBundleId(bundle);
      const draft = await app.product.draft();
      const existing = draft.value.importedSkills?.find(item => item.id === skill.id);
      if (existing?.bundleId) {
        if (existing.bundleId !== bundleId) throw new Error('新版已经存在同名的不同技能，未覆盖；可通过设置导入明确替换。');
        report.skipped.push(skill.id);
      } else {
        if (existing && (existing.content !== skill.content || existing.description !== skill.description)) throw new Error('同名技能的正文不同，未覆盖现有导入。');
        const imported = app.skills.stageImport(draft, { ...skill, enabled: existing?.enabled ?? true, resources: bundle });
        draft.value.importedSkills ??= [];
        if (existing) draft.value.importedSkills = draft.value.importedSkills.map(item => item.id === imported.id ? imported : item);
        else draft.value.importedSkills.push(imported);
        // 既有启用配置保留；新发现技能沿用原目录扫描的启用行为。
        if (!draft.settings.getSkills().some(item => item.id === skill.id)) await draft.settings.setSkillEnabled(skill.id, true, imported);
        signal.throwIfAborted();
        await app.product.save(draft);
        report.imported.push(skill.id);
      }
      report.consumed.push(...bundle.files.map(file => path.join(source, file.path)));
    } catch (error) {
      signal.throwIfAborted();
      report.issues.push({ path: source, code: 'CORRUPT_DATA', message: String(error) });
    }
  }
  return report;
}
