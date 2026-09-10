import { branchRetentionDays } from '../conversations/retention';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { MigrationIssue, MigrationReport } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ProductSettingsDraft } from '../settings/product';
import { SettingsTransfer } from '../settings/transfer';
import { jsonToConfig } from '../../../../backend/modules/mcp/jsonConfig';
import { validateMcpConfigurations } from '../mcp/settings';

export interface ConfigurationFile { id: string; path: string; fingerprint: string; label: string; saved: boolean }
export interface PendingConfigurationImport { id: string; source: string; path: string; fingerprint: string; reportId: string }
export interface ConfigurationReport extends MigrationReport {
  runtimeAssets?: { imported: string[]; skipped: string[] };
  activity?: { imported: string[]; skipped: string[] };
  operationId: string; configurationFiles?: ConfigurationFile[];
  memory?: { imported: string[]; skipped: string[] }; skills?: { imported: string[]; skipped: string[] };
}
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const candidates = [{ path: 'settings.json', label: '旧版应用设置' }, { path: 'settings/settings.json', label: '旧版文件设置' }, { path: 'mcp/servers.json', label: 'MCP 服务器配置' }, { path: 'branches.config.json', label: '分支保留配置' }];

/** 配置与历史分开交付：复制到共享设置草稿，经统一保存后才标记已经导入。 */
export class ConfigurationMigration {
  constructor(private readonly app: PlatformApplication) {}
  private async read(source: string, relative: string) {
    if (!candidates.some(item => item.path === relative)) throw new Error('不是可识别的旧配置文件。');
    const file = path.join(source, relative); const actual = await fs.realpath(file);
    const contained = path.relative(source, actual);
    if (path.isAbsolute(contained) || /^\.\.([\\/]|$)/.test(contained) || !(await fs.lstat(file)).isFile()) throw new Error('旧配置必须是所选目录内的普通文件。');
    const before = await fs.stat(actual);
    if (before.size > 32 * 1024 * 1024) throw new Error('旧配置文件超过 32 MiB。');
    const bytes = await fs.readFile(actual); const after = await fs.stat(actual);
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('读取期间旧配置发生变化，请重新导入。');
    const value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('旧配置文件必须是 JSON 对象。');
    return { value, fingerprint: digest(bytes), file };
  }
  private payload(relative: string, value: Record<string, any>) {
    if (relative === 'branches.config.json') return { branchRetentionDays: branchRetentionDays(value.retentionDays) };
    if (relative === 'mcp/servers.json') {
      const raw = value.mcpServers ?? value.servers;
      if (!raw || typeof raw !== 'object') throw new Error('MCP 配置缺少服务器列表。');
      const servers = Array.isArray(raw) ? raw : Object.entries(raw).map(([id, item]) => jsonToConfig(id, item as any));
      validateMcpConfigurations(servers);
      return { mcpServers: servers, globalSettings: {} };
    }
    return value.format || value.channelConfigs || value.vscodeSettings || value.features || value.globalSettings ? value : { globalSettings: value };
  }
  async inspect(source: string, signal: AbortSignal) {
    const files: ConfigurationFile[] = []; const consumed: string[] = []; const issues: MigrationIssue[] = [];
    for (const candidate of candidates) {
      signal.throwIfAborted();
      try {
        if (candidate.path === 'settings.json') {
          try { await fs.access(path.join(source, 'settings.meta.json')); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        const captured = await this.read(source, candidate.path); this.payload(candidate.path, captured.value);
        const id = digest(`${process.platform === 'win32' ? source.toLowerCase() : source}\0${candidate.path}`);
        const previous = await this.app.storage.getRecord('migration-configurations', id) as PendingConfigurationImport | null;
        files.push({ id, path: candidate.path, fingerprint: captured.fingerprint, label: candidate.label,
          saved: previous?.fingerprint === captured.fingerprint });
        // 已识别的配置在报告中单独列出；未保存时整份报告仍不能完成。
        consumed.push(captured.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push({ path: path.join(source, candidate.path), code: 'CORRUPT_DATA', message: String(error) });
      }
    }
    return { files, consumed, issues, importedUnits: files.filter(file => file.saved).length };
  }
  async stage(actorId: string, reportId: string, fileId: string, draft: ProductSettingsDraft) {
    this.app.requireOwner(actorId);
    const report = await this.app.storage.getRecord('migration-reports', reportId) as ConfigurationReport | null;
    const file = report?.configurationFiles?.find(file => file.id === fileId);
    if (!report || !file) throw new Error('迁移报告中没有此配置文件。');
    const captured = await this.read(report.source, file.path);
    if (captured.fingerprint !== file.fingerprint) throw new Error('旧配置已经改变，请重新运行目录导入后再选择。');
    const candidate = await this.app.product.draft(draft);
    const result = await new SettingsTransfer(this.app).import(candidate, this.payload(file.path, captured.value));
    if (!result.success) throw new Error(result.errors.join('；'));
    const pending = new Map((candidate.value.pendingConfigurationImports ?? []).map(item => [item.id, item]));
    pending.set(file.id, { id: file.id, source: report.source, path: file.path, fingerprint: file.fingerprint, reportId });
    candidate.value.pendingConfigurationImports = [...pending.values()];
    return { draft: candidate, result: { success: true, imported: result.imported, pendingSave: true } };
  }
  async latest(actorId: string): Promise<ConfigurationReport | null> {
    this.app.requireOwner(actorId);
    const marker = await this.app.storage.getRecord('migration-latest', actorId) as { operationId: string } | null;
    return marker ? this.report(actorId, marker.operationId) : null;
  }
  async report(actorId: string, id: string): Promise<ConfigurationReport> {
    this.app.requireOwner(actorId);
    const report = await this.app.storage.getRecord('migration-reports', id) as ConfigurationReport | null;
    if (!report) throw new Error('迁移报告不存在。');
    for (const file of report.configurationFiles ?? []) {
      const marker = await this.app.storage.getRecord('migration-configurations', file.id) as PendingConfigurationImport | null;
      file.saved = marker?.fingerprint === file.fingerprint;
    }
    return this.complete(report);
  }
  complete(report: ConfigurationReport): ConfigurationReport {
    if (!report.configurationFiles?.length) return report;
    const saved = report.configurationFiles.filter(file => file.saved).length;
    const imported = report.imported.length + report.skipped.length + saved + (report.memory?.imported.length ?? 0) +
      (report.memory?.skipped.length ?? 0) + (report.runtimeAssets?.imported.length ?? 0) + (report.runtimeAssets?.skipped.length ?? 0) + (report.activity?.imported.length ?? 0) + (report.activity?.skipped.length ?? 0) + (report.skills?.imported.length ?? 0) + (report.skills?.skipped.length ?? 0);
    return { ...report, readyForCutover: !report.issues.length && !report.pendingArtifacts.length && saved === report.configurationFiles.length && imported > 0 };
  }
}
