import { migrateLimCodeExport } from '../../../../backend/modules/settings/legacyExport';
import { branchRetentionDays } from '../conversations/retention';
import type { BackgroundImageSummary } from './images';
import type { PlatformApplication } from '../application';
import type { ProductSettingsDraft } from './product';
import type { GlobalSettings } from '../../../../backend/modules/settings/types';
import type { ChannelConfig } from '../../../../backend/modules/config/types';
import type { McpServerConfig } from '../../../../backend/modules/mcp/types';
import { createMcpSettingsDraft } from '../mcp/settings';

/** 导入先更新统一草稿，确认保存时沿用原设置事务和系统密钥服务。 */
export class SettingsTransfer {
  constructor(private readonly app: PlatformApplication) {}
  async export(draft: ProductSettingsDraft, userOnly = false) {
    const channelConfigs = await draft.configs.listConfigs();
    for (const channel of channelConfigs) if (channel.apiKey === '••••••••') channel.apiKey = (await this.app.product.channel(channel.id))?.apiKey ?? '';
    const credentials: Record<string, string> = {};
    const references = new Set([...this.app.settings.snapshot().credentialIds, ...Object.keys(draft.credentials)]);
    for (const reference of references) {
      const value = Object.hasOwn(draft.credentials, reference) ? draft.credentials[reference] : await this.app.settings.credential(reference);
      if (typeof value === 'string') credentials[reference] = value;
    }
    const backgrounds: Array<BackgroundImageSummary & { dataUrl: string }> = [];
    for (const image of await this.app.images.list()) {
      const original = await this.app.images.get(image.id);
      if (original) backgrounds.push({ ...image, dataUrl: `data:${original.mimeType};base64,${Buffer.from(original.bytes).toString('base64')}` });
    }
    return { format: 'graycode-platform', version: 1, exportedAt: Date.now(), settings: draft.app,
      branchRetentionDays: draft.value.branchRetentionDays, features: draft.settings.getSettings(), channelConfigs, mcpServers: await draft.mcp.listServerConfigs(), credentials, backgrounds, skills: await this.app.skills.export(draft, userOnly) };
  }
  async import(draft: ProductSettingsDraft, input: unknown, replaceUserPreferences = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置文件必须是 JSON 对象。');
    const data = structuredClone(input) as Record<string, any>;
    migrateLimCodeExport(data);
    if (data.format && (data.format !== 'graycode-platform' || data.version !== 1)) throw new Error('不支持此设置文件版本。');
    if (data.branchRetentionDays !== undefined) { draft.value.branchRetentionDays = branchRetentionDays(data.branchRetentionDays); draft.dirty = true; }
    const errors: string[] = [];
    const imported = { vscodeSettings: false, channelConfigs: 0, mcpServers: 0, skills: 0 };
    if (replaceUserPreferences) {
      if (data.format !== 'graycode-platform' || !data.settings) throw new Error('便携配置格式无效。');
      // 便携副本代表完整配置，已删除的渠道、MCP 和导入技能不能被旧本机副本补回来。
      draft.value.channels = []; draft.value.mcpServers = []; draft.value.importedSkills = [];
    }
    // 保留本机账号和工作区授权；设置导入不隐式替换部署的认证身份。
    if (data.format === 'graycode-platform' && data.settings) {
      const { accounts, bindings, workspaces, botGuestAccountId, ...preferences } = data.settings;
      draft.app = { ...draft.app, ...preferences, accounts: draft.app.accounts, bindings: draft.app.bindings, workspaces: draft.app.workspaces };
      Object.assign(draft.credentials, data.credentials ?? {});
    }
    const exportedFeatures = data.features ?? data.globalSettings;
    if (exportedFeatures) {
      const { storagePath, ...features } = exportedFeatures;
      await draft.settings.updateSettings(features as Partial<GlobalSettings>); imported.vscodeSettings = true;
    }
    if (data.vscodeSettings && typeof data.vscodeSettings === 'object') {
      const allowed = new Set(['toolsConfig', 'ui', 'toolsEnabled', 'toolAutoExec', 'maxToolIterations', 'defaultToolMode', 'activeChannelId', 'lastReadAnnouncementVersion', 'checkForUpdates', 'updateChannel', 'proxy']);
      const values: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data.vscodeSettings)) {
        const name = key.replace(/^graycode\./, ''); if (allowed.has(name)) values[name] = value;
      }
      if (Object.keys(values).length) { await draft.settings.updateSettings(values as Partial<GlobalSettings>); imported.vscodeSettings = true; }
    }
    if (!exportedFeatures && !data.vscodeSettings && !data.channelConfigs && !data.format && data.branchRetentionDays === undefined)
      throw new Error('没有识别到 GrayCode 设置或渠道配置。');
    for (const channel of (data.channelConfigs ?? []) as ChannelConfig[]) {
      if (!channel || typeof channel.id !== 'string' || !channel.type) { errors.push('跳过没有标识或类型的渠道。'); continue; }
      try {
        // 正式导入接口同步缓存和草稿，并保持旧版覆盖导入的整体替换语义。
        await draft.configs.importConfig(channel, { overwrite: true });
        imported.channelConfigs++;
      } catch (error) { errors.push('渠道「' + (channel.name || channel.id) + '」：' + (error as Error).message); }
    }
    for (const server of (data.mcpServers ?? []) as McpServerConfig[]) {
      const existing = draft.value.mcpServers?.findIndex(item => item.id === server.id) ?? -1;
      draft.value.mcpServers ??= [];
      if (existing < 0) draft.value.mcpServers.push(structuredClone(server)); else draft.value.mcpServers[existing] = structuredClone(server);
      imported.mcpServers++;
    }
    if (imported.mcpServers || replaceUserPreferences) { draft.mcp = createMcpSettingsDraft(draft.value, () => { draft.dirty = true; }); await draft.mcp.initialize(); }
    for (const image of data.backgrounds ?? []) {
      const restored = await this.app.images.add(image, replaceUserPreferences ? image.id : undefined);
      if (draft.app.appearance.backgroundImage === image.url) draft.app.appearance.backgroundImage = restored.url;
    }
    for (const skill of data.skills ?? []) {
      try {
        const value = this.app.skills.stageImport(draft, skill);
        const values = new Map((draft.value.importedSkills ?? []).map(item => [item.id, item]));
        values.set(value.id, value); draft.value.importedSkills = [...values.values()];
        await draft.settings.setSkillEnabled(value.id, value.enabled, value);
        imported.skills++;
      } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    if (replaceUserPreferences && !errors.length) {
      const retained = new Set((data.backgrounds ?? []).map((image: BackgroundImageSummary) => image.id));
      for (const image of await this.app.images.list()) if (!retained.has(image.id)) await this.app.images.remove(image.id);
    }
    draft.dirty = true;
    return { success: errors.length === 0, imported, errors, draft: true };
  }
}
